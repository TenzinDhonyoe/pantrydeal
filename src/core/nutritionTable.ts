/**
 * Per-ingredient nutrition, per 100 g (as typically eaten / cooked where noted).
 * This is the local, versioned cache that the validator reads — the source of
 * record is USDA FoodData Central, resolved at curation time and spot-checked,
 * NOT called live on the per-patient path (docs/DECISIONS.md D15). Macros for any
 * recipe (vetted or AI) are summed from this table, never trusted from an LLM.
 *
 * `addedSugarG` is added sugar only (0 for whole foods); naturally occurring
 * sugars in produce/dairy are not counted against the added-sugar target.
 * `source` records provenance: 'seed' = hand-entered draft pending USDA verify;
 * 'usda:<fdcId>' once resolved.
 */
export interface IngredientNutrition {
  /** per 100 g */
  carbsG: number;
  fiberG: number;
  addedSugarG: number;
  proteinG: number;
  source: string;
}

export const NUTRITION_TABLE: Record<string, IngredientNutrition> = {
  // grains / starches (cooked unless noted)
  'brown rice': { carbsG: 23, fiberG: 1.8, addedSugarG: 0, proteinG: 2.6, source: 'seed' },
  barley: { carbsG: 28, fiberG: 3.8, addedSugarG: 0, proteinG: 2.3, source: 'seed' },
  quinoa: { carbsG: 21, fiberG: 2.8, addedSugarG: 0, proteinG: 4.4, source: 'seed' },
  oats: { carbsG: 66, fiberG: 11, addedSugarG: 0, proteinG: 17, source: 'seed' }, // dry
  'whole wheat tortilla': { carbsG: 44, fiberG: 6, addedSugarG: 1, proteinG: 8, source: 'seed' },
  'sweet potato': { carbsG: 20, fiberG: 3, addedSugarG: 0, proteinG: 1.6, source: 'seed' },

  // legumes
  lentils: { carbsG: 20, fiberG: 8, addedSugarG: 0, proteinG: 9, source: 'seed' },
  'black beans': { carbsG: 24, fiberG: 9, addedSugarG: 0, proteinG: 9, source: 'seed' },
  chickpeas: { carbsG: 27, fiberG: 8, addedSugarG: 0, proteinG: 9, source: 'seed' },

  // proteins (cooked)
  chicken: { carbsG: 0, fiberG: 0, addedSugarG: 0, proteinG: 31, source: 'seed' },
  turkey: { carbsG: 0, fiberG: 0, addedSugarG: 0, proteinG: 27, source: 'seed' },
  salmon: { carbsG: 0, fiberG: 0, addedSugarG: 0, proteinG: 20, source: 'seed' },
  tofu: { carbsG: 2, fiberG: 0.9, addedSugarG: 0, proteinG: 8, source: 'seed' },
  egg: { carbsG: 1.1, fiberG: 0, addedSugarG: 0, proteinG: 13, source: 'seed' },
  'greek yogurt': { carbsG: 3.6, fiberG: 0, addedSugarG: 0, proteinG: 10, source: 'seed' },

  // non-starchy vegetables
  broccoli: { carbsG: 7, fiberG: 2.6, addedSugarG: 0, proteinG: 2.8, source: 'seed' },
  spinach: { carbsG: 3.6, fiberG: 2.2, addedSugarG: 0, proteinG: 2.9, source: 'seed' },
  'bell pepper': { carbsG: 6, fiberG: 2.1, addedSugarG: 0, proteinG: 1, source: 'seed' },
  onion: { carbsG: 9, fiberG: 1.7, addedSugarG: 0, proteinG: 1.1, source: 'seed' },
  garlic: { carbsG: 33, fiberG: 2.1, addedSugarG: 0, proteinG: 6, source: 'seed' },
  tomato: { carbsG: 3.9, fiberG: 1.2, addedSugarG: 0, proteinG: 0.9, source: 'seed' },
  'canned tomatoes': { carbsG: 4, fiberG: 1, addedSugarG: 0, proteinG: 1, source: 'seed' },
  carrot: { carbsG: 10, fiberG: 2.8, addedSugarG: 0, proteinG: 0.9, source: 'seed' },
  zucchini: { carbsG: 3, fiberG: 1, addedSugarG: 0, proteinG: 1.2, source: 'seed' },
  cauliflower: { carbsG: 5, fiberG: 2, addedSugarG: 0, proteinG: 1.9, source: 'seed' },
  avocado: { carbsG: 9, fiberG: 7, addedSugarG: 0, proteinG: 2, source: 'seed' },

  // more proteins (cooked)
  beef: { carbsG: 0, fiberG: 0, addedSugarG: 0, proteinG: 26, source: 'seed' }, // lean ground
  shrimp: { carbsG: 0, fiberG: 0, addedSugarG: 0, proteinG: 24, source: 'seed' },
  edamame: { carbsG: 10, fiberG: 5, addedSugarG: 0, proteinG: 11, source: 'seed' },
  'cottage cheese': { carbsG: 3.4, fiberG: 0, addedSugarG: 0, proteinG: 11, source: 'seed' },

  // more non-starchy vegetables
  kale: { carbsG: 9, fiberG: 3.6, addedSugarG: 0, proteinG: 4.3, source: 'seed' },
  mushroom: { carbsG: 3.3, fiberG: 1, addedSugarG: 0, proteinG: 3.1, source: 'seed' },
  'green beans': { carbsG: 7, fiberG: 3.4, addedSugarG: 0, proteinG: 1.8, source: 'seed' },
  peas: { carbsG: 14, fiberG: 5, addedSugarG: 0, proteinG: 5, source: 'seed' },

  // fats / aromatics (small quantities)
  'olive oil': { carbsG: 0, fiberG: 0, addedSugarG: 0, proteinG: 0, source: 'seed' },
  cumin: { carbsG: 44, fiberG: 11, addedSugarG: 0, proteinG: 18, source: 'seed' },
  'chili powder': { carbsG: 50, fiberG: 35, addedSugarG: 0, proteinG: 13, source: 'seed' },
};

/** Ingredient names known to the table (canonical, lowercase). */
export function knownIngredient(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NUTRITION_TABLE, name.toLowerCase());
}
