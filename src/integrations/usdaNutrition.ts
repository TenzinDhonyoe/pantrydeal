/**
 * UsdaNutritionClient — LIVE lookup against USDA FoodData Central (FDC).
 * Reads USDA_FDC_API_KEY from the environment. This is used at CURATION time to
 * resolve/verify the local nutrition table (src/core/nutritionTable.ts), NOT on
 * the per-patient validation path (docs/DECISIONS.md D15): the safety gate must
 * stay deterministic and offline, and the fuzzy ingredient->FDC name match must
 * be human-checked once rather than trusted live per request. Never exercised by
 * the test suite.
 *
 * Usage (a curation script, not the server):
 *   const c = new UsdaNutritionClient();
 *   const n = await c.lookup('lentils, cooked');  // -> per-100g macros + fdcId
 * A human reviews the match before it lands in nutritionTable.ts.
 */
import type { IngredientNutrition } from '../core/nutritionTable.js';

const SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';

// FDC nutrient numbers.
const NUTRIENT = { carbs: '205', fiber: '291', addedSugar: '539', protein: '203' } as const;

interface FdcNutrient {
  nutrientNumber?: string;
  value?: number;
}
interface FdcFood {
  fdcId?: number;
  description?: string;
  foodNutrients?: FdcNutrient[];
}
interface FdcSearchResponse {
  foods?: FdcFood[];
}

export interface UsdaResolved extends IngredientNutrition {
  fdcId: number;
  description: string;
}

export interface UsdaOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class UsdaNutritionClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UsdaOptions = {}) {
    const apiKey = options.apiKey ?? process.env.USDA_FDC_API_KEY;
    if (!apiKey) {
      throw new Error('USDA_FDC_API_KEY is not set (required to refresh the nutrition table).');
    }
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Resolve an ingredient query to per-100g macros from the top FDC match. */
  async lookup(query: string): Promise<UsdaResolved | null> {
    const url =
      `${SEARCH_URL}?api_key=${encodeURIComponent(this.apiKey)}` +
      `&query=${encodeURIComponent(query)}&pageSize=1&dataType=Foundation,SR%20Legacy`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`USDA FDC request failed (${res.status}) for "${query}".`);
    }
    const body = (await res.json()) as FdcSearchResponse;
    const food = body.foods?.[0];
    if (!food?.fdcId) return null;

    const get = (num: string): number => {
      const n = food.foodNutrients?.find((x) => x.nutrientNumber === num);
      return typeof n?.value === 'number' ? n.value : 0;
    };
    return {
      fdcId: food.fdcId,
      description: food.description ?? query,
      carbsG: get(NUTRIENT.carbs),
      fiberG: get(NUTRIENT.fiber),
      addedSugarG: get(NUTRIENT.addedSugar),
      proteinG: get(NUTRIENT.protein),
      source: `usda:${food.fdcId}`,
    };
  }
}
