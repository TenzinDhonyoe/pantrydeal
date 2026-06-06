/**
 * The prediabetes nutrition validator (docs/DECISIONS.md D15). This is the hard
 * gate: a recipe is shown to a patient only if it passes. Macros are computed
 * from the local nutrition table (never from an LLM's self-report), so the gate
 * checks real numbers. All target values are DRAFT defaults pending dietician
 * sign-off; they live as constants so a clinician can adjust them.
 */
import type { Recipe } from './types.js';
import { NUTRITION_TABLE, type IngredientNutrition } from './nutritionTable.js';

export interface NutritionTargets {
  /** Hard ceiling on carbohydrate per main meal (no floor; lower is fine). */
  carbsPerMealMaxG: number;
  /** Minimum fiber per main meal (per-meal proxy for the daily floor). */
  fiberPerMealMinG: number;
  /** Ceiling on ADDED sugar per main meal. */
  addedSugarPerMealMaxG: number;
  /** Lean protein floor per main meal. */
  proteinPerMealMinG: number;
}

/** DRAFT prediabetes targets — every value needs dietician confirmation. */
export const PREDIABETES_TARGETS_DRAFT: NutritionTargets = {
  carbsPerMealMaxG: 60,
  fiberPerMealMinG: 8,
  addedSugarPerMealMaxG: 12,
  proteinPerMealMinG: 20,
};

/**
 * High-glycemic / added-sugar items that are never selected, even on sale. Matched
 * as whole-word tokens against the ingredient name. DRAFT — needs dietician review.
 */
export const HIGH_GI_BLOCKLIST = [
  'white bread',
  'white rice',
  'sugary cereal',
  'soda',
  'juice',
  'instant potato',
  'candy',
  'pastry',
  'sweetened yogurt',
  'sugar',
  'honey',
  'syrup',
  'ketchup',
  'jam',
];

/** Per-serving macros for a recipe. */
export interface RecipeNutrition {
  carbsG: number;
  fiberG: number;
  addedSugarG: number;
  proteinG: number;
}

export type NutritionResult =
  | { ok: true; nutrition: RecipeNutrition }
  | { ok: false; missing: string[] };

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

function lookup(name: string, table: Record<string, IngredientNutrition>): IngredientNutrition | undefined {
  return table[name.toLowerCase()];
}

/**
 * Compute per-serving macros by summing each ingredient's contribution from the
 * table. Returns the ingredients NOT in the table rather than guessing — an
 * un-tabled ingredient means we cannot validate, so the recipe is rejected.
 */
export function computeRecipeNutrition(
  ingredients: ReadonlyArray<{ name: string; qtyGrams: number }>,
  servings: number,
  table: Record<string, IngredientNutrition> = NUTRITION_TABLE,
): NutritionResult {
  const missing = ingredients.filter((i) => !lookup(i.name, table)).map((i) => i.name);
  if (missing.length > 0) return { ok: false, missing };

  let carbsG = 0;
  let fiberG = 0;
  let addedSugarG = 0;
  let proteinG = 0;
  for (const ing of ingredients) {
    const n = lookup(ing.name, table)!;
    const per = ing.qtyGrams / 100;
    carbsG += n.carbsG * per;
    fiberG += n.fiberG * per;
    addedSugarG += n.addedSugarG * per;
    proteinG += n.proteinG * per;
  }
  const d = servings > 0 ? servings : 1;
  return { ok: true, nutrition: { carbsG: carbsG / d, fiberG: fiberG / d, addedSugarG: addedSugarG / d, proteinG: proteinG / d } };
}

/** Is this ingredient name on the high-glycemic / added-sugar blocklist? */
export function isBlocked(name: string, blocklist: string[] = HIGH_GI_BLOCKLIST): boolean {
  const n = name.toLowerCase();
  return blocklist.some((b) => n.includes(b));
}

/** Check per-serving macros against the targets. */
export function validateMeal(
  nutrition: RecipeNutrition,
  targets: NutritionTargets = PREDIABETES_TARGETS_DRAFT,
): ValidationResult {
  const v: string[] = [];
  if (nutrition.carbsG > targets.carbsPerMealMaxG) {
    v.push(`carbs ${nutrition.carbsG.toFixed(0)}g over the ${targets.carbsPerMealMaxG}g ceiling`);
  }
  if (nutrition.fiberG < targets.fiberPerMealMinG) {
    v.push(`fiber ${nutrition.fiberG.toFixed(0)}g under the ${targets.fiberPerMealMinG}g floor`);
  }
  if (nutrition.addedSugarG > targets.addedSugarPerMealMaxG) {
    v.push(`added sugar ${nutrition.addedSugarG.toFixed(0)}g over the ${targets.addedSugarPerMealMaxG}g ceiling`);
  }
  if (nutrition.proteinG < targets.proteinPerMealMinG) {
    v.push(`protein ${nutrition.proteinG.toFixed(0)}g under the ${targets.proteinPerMealMinG}g floor`);
  }
  return { ok: v.length === 0, violations: v };
}

/**
 * The full gate: ingredient coverage (we can price/validate it) AND no blocklisted
 * item AND macros within targets. A recipe must pass this before it can reach a
 * patient, whether it came from the vetted library or the AI layer.
 */
export function validateRecipe(
  recipe: Recipe,
  targets: NutritionTargets = PREDIABETES_TARGETS_DRAFT,
  table: Record<string, IngredientNutrition> = NUTRITION_TABLE,
): ValidationResult {
  const blocked = recipe.ingredients.filter((i) => isBlocked(i.name)).map((i) => i.name);
  const computed = computeRecipeNutrition(recipe.ingredients, recipe.servings, table);
  if (!computed.ok) {
    const v = computed.missing.map((m) => `no nutrition data for "${m}"`);
    if (blocked.length) v.push(`blocklisted: ${blocked.join(', ')}`);
    return { ok: false, violations: v };
  }
  const mealResult = validateMeal(computed.nutrition, targets);
  const violations = [
    ...blocked.map((b) => `blocklisted ingredient: ${b}`),
    ...mealResult.violations,
  ];
  return { ok: violations.length === 0, violations };
}
