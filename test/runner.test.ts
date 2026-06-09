import { describe, it, expect } from 'vitest';
import { recipeAllowed, planPrediabetesWeek } from '../src/runner.js';
import type { Ingredient, Recipe } from '../src/core/types.js';

// Offline-only tests: recipeAllowed is pure, and planPrediabetesWeek runs against
// the shipped fixture flyers + PREDIABETES_RECIPES (live:false), so no network.

function ing(name: string): Ingredient {
  return { name, qtyGrams: 100, category: 'other', substitutes: [] };
}

function recipe(dish: string, names: string[]): Recipe {
  return { dish, servings: 1, ingredients: names.map(ing) };
}

describe('recipeAllowed (B3)', () => {
  it('disallows meat/fish for both vegetarian and vegan', () => {
    const salmonBowl = recipe('salmon bowl', ['salmon', 'rice', 'broccoli']);
    expect(recipeAllowed(salmonBowl, ['vegetarian'])).toBe(false);
    expect(recipeAllowed(salmonBowl, ['vegan'])).toBe(false);
  });

  it('disallows newly-covered meats (lamb, ham, bacon) for vegetarians', () => {
    expect(recipeAllowed(recipe('lamb stew', ['lamb', 'onion']), ['vegetarian'])).toBe(false);
    expect(recipeAllowed(recipe('ham sandwich', ['ham', 'bread']), ['vegetarian'])).toBe(false);
    expect(recipeAllowed(recipe('bacon hash', ['bacon', 'potato']), ['vegetarian'])).toBe(false);
  });

  it('allows dairy/eggs/honey for vegetarian but not vegan', () => {
    const eggDish = recipe('omelette', ['egg', 'spinach']);
    const cheeseDish = recipe('cheese bake', ['cheese', 'broccoli']);
    const honeyDish = recipe('honey carrots', ['honey', 'carrot']);
    for (const r of [eggDish, cheeseDish, honeyDish]) {
      expect(recipeAllowed(r, ['vegetarian'])).toBe(true);
      expect(recipeAllowed(r, ['vegan'])).toBe(false);
    }
  });

  it('allows an all-plant recipe for both diets', () => {
    const plant = recipe('tofu stir fry', ['tofu', 'broccoli', 'rice']);
    expect(recipeAllowed(plant, ['vegetarian'])).toBe(true);
    expect(recipeAllowed(plant, ['vegan'])).toBe(true);
  });

  it('does NOT exclude eggplant under vegan (word-boundary guard)', () => {
    const eggplant = recipe('eggplant curry', ['eggplant', 'tomato', 'rice']);
    expect(recipeAllowed(eggplant, ['vegan'])).toBe(true);
    expect(recipeAllowed(eggplant, ['vegetarian'])).toBe(true);
  });

  it('keeps substring behavior for arbitrary restrictions (e.g. allergies)', () => {
    const peanutDish = recipe('peanut noodles', ['peanut sauce', 'noodles']);
    expect(recipeAllowed(peanutDish, ['peanut'])).toBe(false);
    expect(recipeAllowed(recipe('plain noodles', ['noodles']), ['peanut'])).toBe(true);
  });

  it('ignores empty/whitespace restriction strings', () => {
    expect(recipeAllowed(recipe('x', ['salmon']), ['', '  '])).toBe(true);
  });
});

describe('planPrediabetesWeek offline (T1 smoke)', () => {
  it('returns a structurally-valid week with meals and a cart', async () => {
    const result = await planPrediabetesWeek({
      postal: 'M8Y',
      budget: 100,
      days: 3,
      people: 2,
      live: false,
    });
    expect(result.week).toBeDefined();
    expect(Array.isArray(result.meals)).toBe(true);
    expect(result.meals.length).toBeGreaterThan(0);
    expect(typeof result.cart.fullTotal).toBe('number');
    expect(typeof result.week.withinBudget).toBe('boolean');
  });

  it('produces no animal-product meals under a vegan restriction', async () => {
    const result = await planPrediabetesWeek({
      postal: 'M8Y',
      budget: 100,
      days: 3,
      people: 2,
      live: false,
      restrictions: ['vegan'],
    });
    for (const meal of result.meals) {
      // Each chosen recipe must itself pass the vegan gate.
      expect(recipeAllowed(meal.recipe, ['vegan'])).toBe(true);
    }
  });
});
