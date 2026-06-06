import { describe, it, expect } from 'vitest';
import { findRecipe, scaleRecipe, StaticRecipeParser, NoRecipeError } from '../src/core/recipe.js';
import { RECIPE_BOOK } from '../src/core/recipeBook.js';

describe('findRecipe', () => {
  it('finds an exact dish name', () => {
    expect(findRecipe('butter chicken')?.dish).toBe('butter chicken');
  });
  it('finds a dish embedded in a longer request', () => {
    expect(findRecipe('I want spaghetti bolognese for dinner tonight')?.dish).toBe(
      'spaghetti bolognese',
    );
  });
  it('is case-insensitive', () => {
    expect(findRecipe('GRILLED CHEESE')?.dish).toBe('grilled cheese');
  });
  it('returns null for empty / unknown dinners', () => {
    expect(findRecipe('')).toBeNull();
    expect(findRecipe('   ')).toBeNull();
    expect(findRecipe('beef wellington with truffle')).toBeNull();
    expect(findRecipe('chicken')).toBeNull(); // ambiguous, no full dish covered
  });
});

describe('scaleRecipe', () => {
  const base = RECIPE_BOOK.find((r) => r.dish === 'butter chicken')!;

  it('scales every quantity by servings / recipe.servings', () => {
    const scaled = scaleRecipe(base, 8); // base serves 4 -> double
    expect(scaled.servings).toBe(8);
    for (let i = 0; i < base.ingredients.length; i += 1) {
      expect(scaled.ingredients[i]!.qtyGrams).toBe(Math.max(1, Math.round(base.ingredients[i]!.qtyGrams * 2)));
    }
    // original is untouched
    expect(base.servings).toBe(4);
  });

  it('scales down and never drops below 1 gram', () => {
    const scaled = scaleRecipe(base, 1); // quarter
    expect(scaled.servings).toBe(1);
    expect(scaled.ingredients.every((i) => i.qtyGrams >= 1)).toBe(true);
  });

  it('returns the same recipe when servings already match', () => {
    expect(scaleRecipe(base, 4)).toBe(base);
  });

  it('rejects non-positive servings', () => {
    expect(() => scaleRecipe(base, 0)).toThrow(RangeError);
    expect(() => scaleRecipe(base, -3)).toThrow(/positive/);
    expect(() => scaleRecipe(base, Number.NaN)).toThrow(RangeError);
  });
});

describe('StaticRecipeParser', () => {
  const parser = new StaticRecipeParser();

  it('parses every dish in the book', async () => {
    for (const recipe of RECIPE_BOOK) {
      const parsed = await parser.parse(recipe.dish);
      expect(parsed.dish).toBe(recipe.dish);
      expect(parsed.ingredients.length).toBeGreaterThan(0);
      expect(parsed.ingredients.every((i) => i.qtyGrams > 0)).toBe(true);
    }
  });

  it('scales to the requested servings when given', async () => {
    const four = await parser.parse('butter chicken');
    const eight = await parser.parse('butter chicken', 8);
    expect(eight.servings).toBe(8);
    expect(eight.ingredients[0]!.qtyGrams).toBe(four.ingredients[0]!.qtyGrams * 2);
  });

  it('throws NoRecipeError for unknown dinners', async () => {
    await expect(parser.parse('beef wellington')).rejects.toBeInstanceOf(NoRecipeError);
    await expect(parser.parse('beef wellington')).rejects.toThrow(/No recipe found/);
  });

  it('NoRecipeError carries the dinner string', async () => {
    try {
      await parser.parse('foie gras');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NoRecipeError);
      expect((err as NoRecipeError).dinner).toBe('foie gras');
    }
  });
});

describe('RECIPE_BOOK integrity', () => {
  it('has at least 10 recipes with valid ingredients', () => {
    expect(RECIPE_BOOK.length).toBeGreaterThanOrEqual(10);
    for (const r of RECIPE_BOOK) {
      expect(r.servings).toBeGreaterThan(0);
      for (const ing of r.ingredients) {
        expect(ing.name).toMatch(/\S/);
        expect(ing.qtyGrams).toBeGreaterThan(0);
        expect(Array.isArray(ing.substitutes)).toBe(true);
      }
    }
  });
});
