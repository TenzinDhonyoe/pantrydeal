/**
 * FormJudge — the LLM tail of the layered cut/form substitution check
 * (src/core/substitution.ts). The deterministic layers resolve most pairs for
 * free; only lexically-AMBIGUOUS pairs ("extra-virgin olive oil" vs "OLIVE OIL,
 * 1 L") reach this judge. Cost posture:
 *   - ONE batched call per request covering every ambiguous pair (usually 0-2);
 *   - the cheapest model tier (GEMINI_FORM_MODEL ?? analyzer ?? recipe model);
 *   - answers cached for the process lifetime keyed by (requested, product) —
 *     form equivalence is timeless (no flyer validTo), so repeats are free.
 * On ANY failure the caller falls back to 'different' (the honest default: better
 * to over-warn than to silently pass off a wrong cut). Never throws.
 */
import { LruCache, cacheKey } from '../core/cache.js';
import { recordUsage, type WithUsage } from './geminiUsage.js';

// The cheapest live alias (verified against the API; 'gemini-3.5-flash-lite' does not exist).
const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const FETCH_TIMEOUT_MS = 10_000;

/** Process-lifetime verdict cache: (requestedAs, productName) -> sameForm. */
const sharedFormCache = new LruCache<boolean>(2000);

const SYSTEM = `You judge grocery substitutions. For each pair, a recipe asked for a specific
ingredient ("requested") and a store flyer matched a product ("matched"). Answer
sameForm=true ONLY if the matched product is the same specific cut / form /
variety the shopper asked for. Brand, package size, and price never matter.
Fresh vs frozen vs canned matters ONLY if the shopper specified a state. A
different cut of the same animal (thigh vs drumstick), a different grind or fat
level the shopper specified, or a different variety (brown vs white rice) is
sameForm=false. True aliases are the same food: whipping cream IS heavy cream,
scallions ARE green onions. When genuinely unsure, answer false.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          sameForm: { type: 'boolean' },
        },
        required: ['index', 'sameForm'],
      },
    },
  },
  required: ['judgments'],
};

interface GeminiResponse extends WithUsage {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export interface FormPair {
  requestedAs: string;
  matched: string;
}

export interface FormJudgeOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Override the verdict cache; defaults to a shared process-wide LRU. */
  cache?: LruCache<boolean>;
}

export class FormJudge {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: LruCache<boolean>;

  constructor(options: FormJudgeOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set (required for form judging).');
    this.apiKey = apiKey;
    this.model =
      options.model ??
      process.env.GEMINI_FORM_MODEL ??
      process.env.GEMINI_ANALYZER_MODEL ??
      process.env.GEMINI_MODEL ??
      DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cache = options.cache ?? sharedFormCache;
  }

  /**
   * Judge each pair: true = same form, false = different, null = unknown (the
   * call failed — callers apply their own fallback). Cached pairs are answered
   * without any network; a single batched call covers the rest.
   */
  async judge(pairs: FormPair[]): Promise<Array<boolean | null>> {
    const results: Array<boolean | null> = pairs.map((p) => {
      const hit = this.cache.get(cacheKey('form', p.requestedAs, p.matched));
      return hit === undefined ? null : hit;
    });

    const pending = pairs
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => results[i] === null);
    if (pending.length === 0) return results;

    const list = pending
      .map(({ p }, local) => `${local}. requested: "${p.requestedAs}" | matched: "${p.matched}"`)
      .join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${BASE_URL}/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: `Pairs:\n${list}` }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return results; // unresolved pairs stay null
      const body = (await res.json()) as GeminiResponse;
      recordUsage('form-judge', body);
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const parsed = JSON.parse(text) as { judgments?: Array<{ index: number; sameForm: boolean }> };
      for (const j of parsed.judgments ?? []) {
        const entry = pending[j.index];
        if (!entry || typeof j.sameForm !== 'boolean') continue;
        results[entry.i] = j.sameForm;
        this.cache.set(cacheKey('form', entry.p.requestedAs, entry.p.matched), j.sameForm);
      }
      return results;
    } catch {
      return results; // judge unavailable — unresolved pairs stay null
    } finally {
      clearTimeout(timer);
    }
  }
}
