/**
 * RecipeUrlParser — turn an arbitrary recipe URL (or pasted recipe text) into a
 * structured Recipe for the live pricing pipeline (CEO plan 2026-06-09, Approach C).
 *
 *   url ─┬─ schema.org/Recipe JSON-LD present? ─► clean ingredient lines (free, exact)
 *        ├─ no JSON-LD                          ─► bounded page text
 *        └─ fetch blocked / failed              ─► throws; caller offers the paste box
 *   pasted text ────────────────────────────────► the text itself
 *                                  │
 *                                  ▼
 *                Gemini normalizes the content into the canonical {name, grams,
 *                category} grocery Recipe (reuses the same naming rules + guards
 *                as GeminiRecipeParser, but a DIFFERENT prompt — this extracts
 *                from page content, it does not invent a recipe from a dish name).
 *
 * SECURITY: the URL is user-supplied and fetched server-side — an SSRF surface.
 * assertPublicUrl() allows only http/https and blocks private / loopback /
 * link-local / cloud-metadata hosts; fetches are redirect:'manual' (each hop
 * re-validated), time out fast, cap the body, and send no credentials.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Category, Recipe } from '../core/types.js';
import { recordUsage, type WithUsage } from './geminiUsage.js';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 2_000_000; // 2 MB cap on the fetched page
const MAX_TEXT_CHARS = 100_000; // bounded text sent to Gemini (token cost)
const MAX_REDIRECTS = 3;

const CATEGORIES: Category[] = ['protein', 'produce', 'dairy', 'pantry', 'spice', 'grain', 'bakery', 'other'];

export class InvalidUrlError extends Error {
  override name = 'InvalidUrlError';
}
export class BlockedHostError extends Error {
  override name = 'BlockedHostError';
}
export class FetchFailedError extends Error {
  override name = 'FetchFailedError';
}
export class NoRecipeFoundError extends Error {
  override name = 'NoRecipeFoundError';
}

/** What the parser produced + which path it took (for observability). */
export interface ParsedRecipe {
  recipe: Recipe;
  source: 'json-ld' | 'gemini-text' | 'paste';
}

// --- SSRF guard ------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // be conservative
  const [a, b] = p as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // link-local + ULA
  if (s.startsWith('::ffff:')) return isPrivateIPv4(s.slice(7)); // IPv4-mapped
  return false;
}

/**
 * Resolve the host and reject anything that isn't a public http/https address.
 * Throws InvalidUrlError for malformed/non-http URLs and BlockedHostError for
 * private/loopback/link-local/metadata targets.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidUrlError('That does not look like a valid link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedHostError('Only http and https links are supported.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new BlockedHostError('We can’t open that link.');
  }
  let addrs;
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new FetchFailedError('We couldn’t reach that site.');
  }
  for (const { address, family } of addrs) {
    const priv = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
    if (priv) throw new BlockedHostError('We can’t open that link.');
  }
  return url;
}

/**
 * Fetch a public page, re-validating every redirect hop and capping the body.
 *
 * SSRF posture: assertPublicUrl() resolves the host and rejects private /
 * loopback / link-local / metadata targets before each hop, redirects are manual
 * (never auto-followed to an unvetted host), no credentials are sent, and the
 * body is time- and size-bounded. Residual limitation: a determined active
 * DNS-rebinding attacker (sub-second TTL flip between this lookup and the
 * kernel's connect resolution) could still slip through — fully closing that
 * needs connect-time IP pinning via a custom undici dispatcher, deferred to keep
 * undici out of the dependency set. Acceptable for this app's threat model.
 */
async function fetchPage(rawUrl: string, fetchImpl: typeof fetch): Promise<string> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current); // re-validate each hop (redirect SSRF defense)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/html', 'user-agent': 'PantryDeal/1.0 (+recipe importer)' },
        });
      } catch {
        throw new FetchFailedError('We couldn’t reach that site.');
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new FetchFailedError('We couldn’t read that page.');
        current = new URL(loc, url).toString();
        continue; // finally clears this hop's timer
      }
      if (!res.ok) throw new FetchFailedError(`We couldn’t read that page (${res.status}).`);

      // Read with a hard byte cap so a huge page can't exhaust memory. The timer
      // stays armed through the read, so a slow-drip body aborts at the deadline.
      const reader = res.body?.getReader();
      if (!reader) return (await res.text()).slice(0, MAX_BODY_BYTES);
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.length;
            if (total > MAX_BODY_BYTES) {
              await reader.cancel();
              break;
            }
            chunks.push(value);
          }
        }
      } catch {
        throw new FetchFailedError('That page took too long to read.');
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchFailedError('That link redirected too many times.');
}

// --- JSON-LD (schema.org/Recipe) -------------------------------------------

interface JsonLdRecipe {
  name?: string;
  recipeYield?: unknown;
  recipeIngredient?: unknown;
  ingredients?: unknown;
}

/** Pull schema.org/Recipe ingredient lines + name + yield from a page's JSON-LD. */
export function extractJsonLdRecipe(html: string): { name?: string; yield?: number; lines: string[] } | null {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue; // malformed JSON-LD block — skip, try the next
    }
    const recipe = findRecipeNode(data);
    if (!recipe) continue;
    const raw = recipe.recipeIngredient ?? recipe.ingredients;
    const lines = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
    if (lines.length === 0) continue;
    return { name: typeof recipe.name === 'string' ? recipe.name : undefined, yield: parseYield(recipe.recipeYield), lines };
  }
  return null;
}

/** Walk a JSON-LD value (object, @graph array, or array) for a node typed Recipe. */
function findRecipeNode(data: unknown): JsonLdRecipe | null {
  const isRecipe = (t: unknown): boolean =>
    t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
  const visit = (node: unknown): JsonLdRecipe | null => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const found = visit(n);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (isRecipe(obj['@type'])) return obj as JsonLdRecipe;
      if (Array.isArray(obj['@graph'])) return visit(obj['@graph']);
    }
    return null;
  };
  return visit(data);
}

function parseYield(y: unknown): number | undefined {
  if (typeof y === 'number' && y > 0) return Math.round(y);
  if (Array.isArray(y)) return parseYield(y[0]);
  if (typeof y === 'string') {
    const m = y.match(/\d+/);
    if (m) {
      const n = Number(m[0]);
      if (n > 0) return n;
    }
  }
  return undefined;
}

/** Strip a full HTML page down to bounded visible-ish text for the Gemini fallback. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

// --- Gemini extraction ------------------------------------------------------

const EXTRACT_SYSTEM = `You extract a grocery shopping recipe from supplied recipe content (either a list
of ingredient lines or the text of a recipe web page). Output ONLY the ingredients
a shopper would BUY, using the GENERAL grocery search term — a canonical, singular
noun. Prefer "chicken" over "chicken thigh", "cream" over "heavy cream", "olive oil"
over "extra-virgin olive oil". Do NOT put amounts in the name. Convert every quantity
to total grams for the whole recipe (assume the recipe's stated yield, or 4 servings
if none). Ignore water, salt, pepper, and pantry items with no meaningful cost only
if they have no quantity; otherwise include them. For "substitutes", give ONLY other
names for the SAME food (e.g. "coriander" for cilantro), never a different food used
as a cooking swap. Use [] when there is no true alias. If the content is not a recipe
or has no ingredients, return an empty ingredients array.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    dish: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qtyGrams: { type: 'number' },
          category: { type: 'string', enum: CATEGORIES },
          substitutes: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'qtyGrams', 'category', 'substitutes'],
      },
    },
  },
  required: ['dish', 'servings', 'ingredients'],
};

interface GeminiResponse extends WithUsage {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
}

export interface RecipeUrlParserOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class RecipeUrlParser {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RecipeUrlParserOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set (required for recipe import).');
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Parse a recipe from a URL or pasted text. Exactly one of url/text is used:
   * pasted text wins (skips the fetch entirely — the always-works fallback).
   */
  async parse(input: { url?: string; text?: string; servings?: number }): Promise<ParsedRecipe> {
    const text = input.text?.trim();
    if (text) {
      const recipe = await this.extract(text, input.servings, 'paste');
      return { recipe, source: 'paste' };
    }

    const url = input.url?.trim();
    if (!url) throw new InvalidUrlError('Enter a recipe URL or paste the ingredients.');

    const html = await fetchPage(url, this.fetchImpl); // throws Invalid/Blocked/Fetch errors
    const jsonLd = extractJsonLdRecipe(html);
    if (jsonLd) {
      const content = `Recipe: ${jsonLd.name ?? 'recipe'}\nServes: ${jsonLd.yield ?? input.servings ?? 4}\nIngredients:\n${jsonLd.lines.join('\n')}`;
      const recipe = await this.extract(content, jsonLd.yield ?? input.servings, 'json-ld', jsonLd.name);
      return { recipe, source: 'json-ld' };
    }

    const recipe = await this.extract(htmlToText(html), input.servings, 'gemini-text');
    return { recipe, source: 'gemini-text' };
  }

  /** One Gemini call: content -> canonical Recipe. Reuses geminiRecipe's guards. */
  private async extract(content: string, servings: number | undefined, label: string, fallbackName?: string): Promise<Recipe> {
    const ask = servings
      ? `${content}\n\nScale every ingredient quantity for exactly ${servings} servings.`
      : content;
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: EXTRACT_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: ask }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
        }),
      });
    } catch {
      // Network error reaching Gemini — recoverable, point the user at paste.
      throw new FetchFailedError('We couldn’t reach the recipe reader. Try again, or paste the ingredients.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new FetchFailedError(`Recipe extraction failed (${res.status}). ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as GeminiResponse;
    recordUsage(`recipe-url:${label}`, body);
    if (body.promptFeedback?.blockReason) {
      throw new NoRecipeFoundError('We couldn’t read that recipe. Try pasting the ingredients.');
    }
    const out = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!out) throw new NoRecipeFoundError('We couldn’t find a recipe there. Try pasting the ingredients.');

    let recipe: Recipe;
    try {
      recipe = JSON.parse(out) as Recipe;
    } catch {
      // Gemini returned non-JSON (e.g. truncated output) — recoverable.
      throw new NoRecipeFoundError('We couldn’t read that recipe. Try pasting the ingredients.');
    }
    recipe.ingredients = (recipe.ingredients ?? []).map((i) => ({
      name: String(i.name ?? '').trim().toLowerCase(), // canonical table key
      qtyGrams: Number(i.qtyGrams) || 0,
      category: (CATEGORIES.includes(i.category) ? i.category : 'other') as Category,
      substitutes: Array.isArray(i.substitutes) ? i.substitutes.map((s) => String(s).toLowerCase()) : [],
    })).filter((i) => i.name && i.qtyGrams > 0);

    if (recipe.ingredients.length === 0) {
      throw new NoRecipeFoundError('We couldn’t find a recipe there. Try pasting the ingredients.');
    }
    recipe.dish = (recipe.dish || fallbackName || 'Your recipe').trim();
    // When we asked Gemini to scale grams to `servings`, the per-serving divisor
    // MUST be that same number — Gemini often reports the recipe's natural yield
    // in its `servings` field, which would make the health lens off by a factor.
    recipe.servings = servings && servings > 0 ? servings : Number(recipe.servings) > 0 ? Number(recipe.servings) : 4;
    return recipe;
  }
}
