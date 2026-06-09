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

/** Per-serving macros over only the table-matched ingredients, plus coverage. */
export interface PartialNutrition {
  nutrition: RecipeNutrition;
  /** How many of the recipe's ingredients we had table data for. */
  matched: number;
  total: number;
  /** Ingredient names with no table data (excluded from the estimate). */
  missing: string[];
}

/**
 * Like computeRecipeNutrition, but tolerant of un-tabled ingredients: it sums
 * ONLY the ingredients we have data for and reports how many that covers. An
 * arbitrary web recipe almost always contains items outside our small table, so
 * the all-or-nothing computeRecipeNutrition would return nothing; this gives an
 * honest "based on N of M ingredients" estimate instead. Returns null when not a
 * single ingredient matched (the caller hides the lens rather than show "0 g").
 */
export function nutritionForMatched(
  ingredients: ReadonlyArray<{ name: string; qtyGrams: number }>,
  servings: number,
  table: Record<string, IngredientNutrition> = NUTRITION_TABLE,
): PartialNutrition | null {
  const matched = ingredients.filter((i) => lookup(i.name, table));
  if (matched.length === 0) return null;
  const computed = computeRecipeNutrition(matched, servings, table);
  if (!computed.ok) return null; // unreachable: every `matched` item is in the table
  const missing = ingredients.filter((i) => !lookup(i.name, table)).map((i) => i.name);
  return { nutrition: computed.nutrition, matched: matched.length, total: ingredients.length, missing };
}

/**
 * Compounds that contain a blocklist word but are clinically benign and must
 * never be blocked: sugar-snap / snap peas are a green vegetable (not the
 * sweetener "sugar"), and lemon/lime juice is an acidifier used in drops, not a
 * sugary fruit juice. Without these, whole-word matching of "sugar"/"juice"
 * would still wrongly gate them (the word "sugar" is present in "sugar snap
 * peas", "juice" in "lemon juice"). Mirrors swaps.ts:NEVER_SWAP.
 */
const NEVER_BLOCK = [/\bsugar snap/, /\bsnap pea/, /\blemon juice/, /\blime juice/];

/** Match a blocklist entry only as a whole word/phrase, not a substring. */
function matchesBlock(name: string, key: string): boolean {
  return new RegExp(`(^|[^a-z])${key}([^a-z]|$)`, 'i').test(name);
}

/**
 * Is this ingredient name on the high-glycemic / added-sugar blocklist? Each entry
 * is matched as a whole word/phrase with word boundaries (same approach as
 * swaps.ts:matchesKey), NOT a substring — so "sugar" blocks "white sugar" but the
 * NEVER_BLOCK exceptions keep clinically benign compounds like "sugar snap peas"
 * and "lemon juice" off the gate. Multi-word entries like "white bread" still
 * match as a phrase.
 */
export function isBlocked(name: string, blocklist: string[] = HIGH_GI_BLOCKLIST): boolean {
  const n = name.toLowerCase();
  if (NEVER_BLOCK.some((re) => re.test(n))) return false;
  return blocklist.some((b) => matchesBlock(n, b));
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
