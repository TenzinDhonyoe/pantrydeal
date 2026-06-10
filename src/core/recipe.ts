/**
 * Recipe parsing. The v0 default is a deterministic parser backed by a fixed
 * recipe book (docs/DECISIONS.md D1/D7). A free-text dinner is matched to the
 * best recipe by token overlap; an unmatched dinner throws NoRecipeError.
 * A Claude-backed parser lives in src/integrations and is out of the tested path.
 */
import type { Recipe, RecipeParser } from './types.js';
import { RECIPE_BOOK } from './recipeBook.js';
import { tokenize } from './matcher.js';

/** Thrown when no recipe in the book matches a free-text dinner request. */
export class NoRecipeError extends Error {
  constructor(public readonly dinner: string) {
    super(
      `No recipe found for "${dinner}". The v0 recipe book covers: ` +
        RECIPE_BOOK.map((r) => r.dish).join(', ') +
        '.',
    );
    this.name = 'NoRecipeError';
  }
}

/** Jaccard-style overlap between two token sets, scaled to favour exact dish hits. */
function overlapScore(query: Set<string>, dish: Set<string>): number {
  if (dish.size === 0) return 0;
  let shared = 0;
  for (const t of dish) {
    if (query.has(t)) shared += 1;
  }
  // Fraction of the dish's words covered by the query.
  return shared / dish.size;
}

/**
 * Find the best-matching recipe for a free-text dinner, or null if nothing
 * clears the confidence threshold.
 */
export function findRecipe(dinner: string): Recipe | null {
  const query = new Set(tokenize(dinner));
  if (query.size === 0) return null;

  let best: { recipe: Recipe; score: number } | null = null;
  for (const recipe of RECIPE_BOOK) {
    const score = overlapScore(query, new Set(tokenize(recipe.dish)));
    if (best === null || score > best.score) {
      best = { recipe, score };
    }
  }

  // Require that the whole dish name is covered by the query (score 1.0).
  if (best && best.score >= 1) return best.recipe;
  return null;
}

/**
 * Scale a recipe to a target number of servings: every ingredient quantity is
 * multiplied by servings / recipe.servings (rounded to whole grams). This is
 * what makes the basket cost reflect the amount actually needed.
 */
export function scaleRecipe(recipe: Recipe, servings: number): Recipe {
  if (!Number.isFinite(servings) || servings <= 0) {
    throw new RangeError(`servings must be a positive number, got ${servings}`);
  }
  if (servings === recipe.servings) return recipe;
  const factor = servings / recipe.servings;
  return {
    ...recipe,
    servings,
    ingredients: recipe.ingredients.map((i) => ({
      ...i,
      qtyGrams: Math.max(1, Math.round(i.qtyGrams * factor)),
    })),
  };
}

/** The deterministic, offline recipe parser used by default and in tests. */
export class StaticRecipeParser implements RecipeParser {
  parse(dinner: string, servings?: number): Promise<Recipe> {
    const recipe = findRecipe(dinner);
    if (!recipe) return Promise.reject(new NoRecipeError(dinner));
    return Promise.resolve(servings === undefined ? recipe : scaleRecipe(recipe, servings));
  }
}
