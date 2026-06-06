import { describe, it, expect } from 'vitest';
import { selectWeek, swapMeal, poolIngredients, type PricedRecipe } from '../src/core/mealPlan.js';
import type { Ingredient, Recipe } from '../src/core/types.js';

function r(dish: string): Recipe {
  return { dish, servings: 4, ingredients: [] };
}
function priced(dish: string, realCost: number): PricedRecipe {
  return { recipe: r(dish), realCost };
}

describe('selectWeek', () => {
  const candidates = [
    priced('A', 12),
    priced('B', 8),
    priced('C', 20),
    priced('D', 5),
    priced('E', 15),
  ];

  it('picks the cheapest `days` distinct recipes', () => {
    const plan = selectWeek(candidates, { budget: 100, days: 3 });
    expect(plan.meals.map((m) => m.recipe.dish)).toEqual(['D', 'B', 'A']); // 5, 8, 12
    expect(plan.total).toBe(25);
    expect(plan.withinBudget).toBe(true);
    expect(plan.overBy).toBe(0);
  });

  it('reports over budget honestly without dropping a meal', () => {
    const plan = selectWeek(candidates, { budget: 20, days: 3 });
    expect(plan.total).toBe(25); // still the cheapest 3
    expect(plan.withinBudget).toBe(false);
    expect(plan.overBy).toBe(5);
    expect(plan.meals).toHaveLength(3);
  });

  it('dedupes by dish so a meal is not planned twice', () => {
    const dupes = [priced('A', 5), priced('A', 6), priced('B', 9)];
    const plan = selectWeek(dupes, { budget: 100, days: 5 });
    expect(plan.meals.map((m) => m.recipe.dish)).toEqual(['A', 'B']);
    expect(plan.shortfall).toBe(3); // wanted 5, only 2 distinct
  });

  it('defaults to 5 days', () => {
    const plan = selectWeek(candidates, { budget: 100 });
    expect(plan.days).toBe(5);
    expect(plan.meals).toHaveLength(5);
  });
});

describe('poolIngredients', () => {
  function ing(name: string, qtyGrams: number): Ingredient {
    return { name, qtyGrams, category: 'other', substitutes: [] };
  }
  function recipe(ings: Ingredient[]): Recipe {
    return { dish: 'r', servings: 4, ingredients: ings };
  }

  it('sums grams for ingredients shared across recipes', () => {
    const pooled = poolIngredients([
      recipe([ing('olive oil', 30), ing('chicken', 500)]),
      recipe([ing('olive oil', 30), ing('rice', 600)]),
      recipe([ing('Olive Oil', 20), ing('tofu', 700)]),
    ]);
    const byName = Object.fromEntries(pooled.map((p) => [p.name.toLowerCase(), p.qtyGrams]));
    expect(byName['olive oil']).toBe(80); // 30 + 30 + 20, case-insensitive
    expect(byName['chicken']).toBe(500);
    expect(pooled).toHaveLength(4); // olive oil, chicken, rice, tofu
  });
});

describe('swapMeal', () => {
  it('re-picks the week excluding a swapped-out dish', () => {
    const candidates = [priced('A', 5), priced('B', 8), priced('C', 9)];
    const plan = swapMeal(candidates, 'A', { budget: 100, days: 2 });
    expect(plan.meals.map((m) => m.recipe.dish)).toEqual(['B', 'C']);
  });
});
