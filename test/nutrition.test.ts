import { describe, it, expect } from 'vitest';
import {
  computeRecipeNutrition,
  nutritionForMatched,
  validateMeal,
  validateRecipe,
  isBlocked,
  PREDIABETES_TARGETS_DRAFT,
  type RecipeNutrition,
} from '../src/core/nutrition.js';
import { NUTRITION_TABLE, knownIngredient } from '../src/core/nutritionTable.js';
import { PREDIABETES_RECIPES } from '../src/core/recipeLibrary.js';
import type { Recipe } from '../src/core/types.js';

function recipe(ings: Array<{ name: string; qtyGrams: number }>, servings = 4): Recipe {
  return {
    dish: 'test',
    servings,
    ingredients: ings.map((i) => ({ ...i, category: 'other', substitutes: [] })),
  };
}

describe('nutritionForMatched', () => {
  it('returns null when no ingredient is in the table', () => {
    expect(nutritionForMatched([{ name: 'unicorn meat', qtyGrams: 100 }], 4)).toBeNull();
  });

  it('computes over matched ingredients only and reports coverage', () => {
    // chicken is in the table; "exotic spice blend" is not — estimate uses the 1 match.
    const r = nutritionForMatched(
      [
        { name: 'chicken', qtyGrams: 400 },
        { name: 'exotic spice blend', qtyGrams: 20 },
      ],
      4,
    );
    expect(r).not.toBeNull();
    expect(r!.matched).toBe(1);
    expect(r!.total).toBe(2);
    expect(r!.missing).toEqual(['exotic spice blend']);
    expect(r!.nutrition.proteinG).toBeCloseTo(31, 5); // same as the all-matched chicken case
  });

  it('matches computeRecipeNutrition when every ingredient is known', () => {
    const ings = [
      { name: 'chicken', qtyGrams: 400 },
      { name: 'black beans', qtyGrams: 200 },
    ];
    const partial = nutritionForMatched(ings, 4);
    const full = computeRecipeNutrition(ings, 4);
    expect(partial).not.toBeNull();
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(partial!.missing).toEqual([]);
      expect(partial!.matched).toBe(2);
      expect(partial!.nutrition.carbsG).toBeCloseTo(full.nutrition.carbsG, 5);
    }
  });
});

describe('computeRecipeNutrition', () => {
  it('sums macros from the table and divides by servings', () => {
    // 400 g chicken (31 g protein/100g) over 4 servings = 31 g protein/serving
    const r = computeRecipeNutrition([{ name: 'chicken', qtyGrams: 400 }], 4);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nutrition.proteinG).toBeCloseTo(31, 5);
      expect(r.nutrition.carbsG).toBeCloseTo(0, 5);
    }
  });

  it('rejects (does not guess) when an ingredient is not in the table', () => {
    const r = computeRecipeNutrition([{ name: 'dragonfruit', qtyGrams: 100 }], 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['dragonfruit']);
  });

  it('is case-insensitive and guards servings <= 0', () => {
    const r = computeRecipeNutrition([{ name: 'Chicken', qtyGrams: 100 }], 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nutrition.proteinG).toBeCloseTo(31, 5); // divided by 1, not 0
  });
});

describe('validateMeal', () => {
  const pass: RecipeNutrition = { carbsG: 50, fiberG: 10, addedSugarG: 2, proteinG: 30 };
  it('passes a compliant meal', () => {
    expect(validateMeal(pass).ok).toBe(true);
  });
  it('flags each violation with a message', () => {
    const bad: RecipeNutrition = { carbsG: 80, fiberG: 2, addedSugarG: 20, proteinG: 5 };
    const r = validateMeal(bad);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(4); // carbs, fiber, sugar, protein
    expect(r.violations.join(' ')).toMatch(/carbs/);
    expect(r.violations.join(' ')).toMatch(/protein/);
  });
});

describe('isBlocked', () => {
  it('blocks high-glycemic / added-sugar items', () => {
    expect(isBlocked('White Bread')).toBe(true);
    expect(isBlocked('apple juice')).toBe(true);
    expect(isBlocked('honey')).toBe(true);
    expect(isBlocked('brown rice')).toBe(false);
    expect(isBlocked('lentils')).toBe(false);
  });

  it('matches blocklist entries as whole words, not substrings', () => {
    // False positives the substring match used to flag.
    expect(isBlocked('sugar snap peas')).toBe(false);
    expect(isBlocked('snap peas')).toBe(false);
    expect(isBlocked('lemon juice')).toBe(false);
    // Real blocklist hits still caught.
    expect(isBlocked('sugar')).toBe(true);
    expect(isBlocked('white sugar')).toBe(true);
    expect(isBlocked('apple juice')).toBe(true);
    expect(isBlocked('white bread')).toBe(true);
  });
});

describe('validateRecipe', () => {
  it('rejects a recipe with an un-tabled ingredient (cannot validate)', () => {
    const r = validateRecipe(recipe([{ name: 'unicorn meat', qtyGrams: 100 }]));
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/no nutrition data/);
  });

  it('rejects a recipe containing a blocklisted ingredient', () => {
    const r = validateRecipe(
      recipe([
        { name: 'chicken', qtyGrams: 500 },
        { name: 'white rice', qtyGrams: 600 },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/blocklisted/);
  });

  it('rejects a recipe that busts the carb ceiling', () => {
    // 4 kg cooked brown rice over 1 serving -> way over 60 g carbs
    const r = validateRecipe(recipe([{ name: 'brown rice', qtyGrams: 4000 }], 1));
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/carbs/);
  });
});

describe('PREDIABETES_RECIPES library', () => {
  it('has recipes and every one passes the validator (vetted by construction)', () => {
    expect(PREDIABETES_RECIPES.length).toBeGreaterThan(0);
    for (const r of PREDIABETES_RECIPES) {
      const result = validateRecipe(r);
      expect(result.ok, `${r.dish}: ${result.violations.join('; ')}`).toBe(true);
    }
  });

  it('every library ingredient is in the nutrition table', () => {
    for (const r of PREDIABETES_RECIPES) {
      for (const ing of r.ingredients) {
        expect(knownIngredient(ing.name), `${r.dish} -> ${ing.name}`).toBe(true);
      }
    }
  });
});

describe('targets are present and sane', () => {
  it('exposes adjustable DRAFT targets', () => {
    expect(PREDIABETES_TARGETS_DRAFT.carbsPerMealMaxG).toBeGreaterThan(0);
    expect(Object.keys(NUTRITION_TABLE).length).toBeGreaterThan(20);
  });
});
