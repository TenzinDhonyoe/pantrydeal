/**
 * GeminiMealGenerator — LIVE AI variety for the prediabetes planner, tightly
 * fenced (docs/DECISIONS.md D15, design doc Part 6). The AI is the failure
 * surface, so:
 *   1. It may only use ingredients already in our nutrition table.
 *   2. Its macro claims are IGNORED — macros are recomputed from the table.
 *   3. Every recipe must pass the same hard validateRecipe() as the vetted core.
 *   4. Output is an UNAPPROVED review queue; nothing here reaches a patient until a
 *      dietician approves it. The patient planner only uses the vetted core.
 * Reads GEMINI_API_KEY. Never exercised by the test suite.
 */
import { NUTRITION_TABLE } from '../core/nutritionTable.js';
import { validateRecipe, type ValidationResult } from '../core/nutrition.js';
import type { Recipe } from '../core/types.js';
import { recordUsage, type WithUsage } from './geminiUsage.js';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const ALLOWED = Object.keys(NUTRITION_TABLE);

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    recipes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dish: { type: 'string' },
          servings: { type: 'integer' },
          ingredients: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, qtyGrams: { type: 'number' } },
              required: ['name', 'qtyGrams'],
            },
          },
        },
        required: ['dish', 'servings', 'ingredients'],
      },
    },
  },
  required: ['recipes'],
};

interface GeminiResponse extends WithUsage {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}
interface RawRecipe {
  dish: string;
  servings: number;
  ingredients: Array<{ name: string; qtyGrams: number }>;
}

export interface GeneratedMeal {
  recipe: Recipe;
  validation: ValidationResult;
  /** Always false here: AI recipes need a dietician's sign-off before patient use. */
  approved: false;
}

export interface GeminiMealsOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiMealGenerator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiMealsOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set (required for AI meal variety).');
    }
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Generate up to `count` candidate dinners. Returns ONLY recipes that use known
   * ingredients and pass the hard validator; all are unapproved (review queue).
   */
  async generate(count = 5, cuisine?: string): Promise<GeneratedMeal[]> {
    const system =
      `Create prediabetes-friendly dinner recipes for 4 servings. You MUST use ONLY ` +
      `these ingredients (exact names), in grams: ${ALLOWED.join(', ')}. ` +
      `Favor non-starchy vegetables, lean protein, legumes, and whole grains; keep ` +
      `carbohydrate per serving moderate and fiber high. Do not include any nutrition ` +
      `numbers; we compute those ourselves.`;
    const prompt = `Generate ${count} varied dinners${cuisine ? ` with a ${cuisine} influence` : ''}.`;

    const res = await this.fetchImpl(`${BASE_URL}/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0.6 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini meal generation failed (${res.status}). ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as GeminiResponse;
    recordUsage('meals', body);
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = JSON.parse(text) as { recipes?: RawRecipe[] };

    const out: GeneratedMeal[] = [];
    for (const raw of parsed.recipes ?? []) {
      // Keep only known ingredients; an unknown one means we cannot price/validate it.
      const ingredients = (raw.ingredients ?? [])
        .filter((i) => Object.prototype.hasOwnProperty.call(NUTRITION_TABLE, i.name.toLowerCase()))
        .map((i) => ({ name: i.name.toLowerCase(), qtyGrams: i.qtyGrams, category: 'other' as const, substitutes: [] }));
      if (ingredients.length !== (raw.ingredients ?? []).length || ingredients.length === 0) continue;

      const recipe: Recipe = { dish: raw.dish, servings: raw.servings || 4, ingredients };
      const validation = validateRecipe(recipe); // macros computed from the table, not the AI
      if (validation.ok) out.push({ recipe, validation, approved: false });
    }
    return out;
  }
}
