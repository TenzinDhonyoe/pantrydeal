/**
 * GeminiRecipeParser — LIVE recipe parser over the Google Gemini API
 * (generativelanguage.googleapis.com). Reads GEMINI_API_KEY (or GOOGLE_API_KEY)
 * from the environment (docs/DECISIONS.md D9). Uses a responseSchema so Gemini
 * returns structured JSON directly. Never exercised by the test suite; the
 * deterministic StaticRecipeParser remains the tested default.
 */
import type { Category, Recipe, RecipeParser } from '../core/types.js';
import { recordUsage, type WithUsage } from './geminiUsage.js';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
/** LLM calls are slow; cap them so a hung upstream can't stall forever (P2). */
const FETCH_TIMEOUT_MS = 30_000;

const CATEGORIES: Category[] = [
  'protein',
  'produce',
  'dairy',
  'pantry',
  'spice',
  'grain',
  'bakery',
  'other',
];

const SYSTEM_INSTRUCTION = `You convert a free-text dinner request into a structured grocery recipe.
Use the GENERAL grocery search term a shopper would type — a canonical, singular
noun — not an over-specific cut or form. Prefer "chicken" over "chicken thigh",
"cream" over "heavy cream", "tomato" over "tomato puree", "olive oil" over
"extra-virgin olive oil". Do NOT include amounts in the name ("tomato", not
"2 diced tomatoes"). Normalize every quantity to grams for the given servings
(assume 4 if unspecified).
For "substitutes", give ONLY other names for the SAME food (e.g. "coriander" for
cilantro, "scallion" for green onion) or its common processed forms — NEVER a
different food used as a cooking swap (do not list vinegar/lime under lemon, or
coconut milk/yogurt under cream). Use [] if there is no true alias.`;

// Gemini structured-output schema (a subset of OpenAPI 3 Schema).
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

export interface GeminiRecipeOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiRecipeParser implements RecipeParser {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiRecipeOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY (or GOOGLE_API_KEY) is not set (required for --live recipe parsing).',
      );
    }
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async parse(dinner: string, servings?: number): Promise<Recipe> {
    const url = `${BASE_URL}/${this.model}:generateContent`;
    const ask = servings
      ? `${dinner}\n\nScale every ingredient quantity for exactly ${servings} servings.`
      : dinner;
    // AbortController-based timeout (P2); the signal is threaded through fetchImpl
    // so the test injection seam is preserved. clearTimeout in finally disarms it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: ask }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Gemini request timed out after ${FETCH_TIMEOUT_MS}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini request failed (${res.status}). ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as GeminiResponse;
    recordUsage('recipe', body);
    if (body.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${body.promptFeedback.blockReason}`);
    }
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) {
      throw new Error('Gemini returned an empty response.');
    }
    const recipe = JSON.parse(text) as Recipe;
    // Defensive sanitization (B7): a malformed LLM response could otherwise inject
    // empty-named or zero/NaN-gram ingredients that produce NaN line costs in
    // ranking. Mirror recipeUrl.ts: normalize the name, coerce grams to a finite
    // number, guard the category, lowercase substitutes, then drop unusable rows.
    recipe.ingredients = (recipe.ingredients ?? [])
      .map((i) => ({
        name: String(i.name ?? '').trim().toLowerCase(), // canonical table key
        qtyGrams: Number(i.qtyGrams) || 0,
        category: (CATEGORIES.includes(i.category) ? i.category : 'other') as Category,
        substitutes: Array.isArray(i.substitutes) ? i.substitutes.map((s) => String(s).toLowerCase()) : [],
      }))
      .filter((i) => i.name && i.qtyGrams > 0);
    if (recipe.ingredients.length === 0) {
      throw new Error('Gemini returned a recipe with no usable ingredients.');
    }
    return recipe;
  }
}
