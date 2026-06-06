/**
 * Weekly meal selection under a budget (docs/DECISIONS.md D16). The recipes handed
 * in are already nutrition-validated (the hard gate ran upstream) and already
 * priced through the deal engine (optimizePlan) for the chosen household size. This
 * module's only job is the affordability selection: pick the days' worth of meals
 * that cost the least, report honestly against the budget, and NEVER relax a
 * nutrition guardrail to fit a budget — if the cheapest compliant week is over
 * budget, we show it and state the gap.
 */
import type { Ingredient, Recipe } from './types.js';

/**
 * Pool the ingredients of several recipes into one weekly shopping list, summing
 * grams for repeated ingredients (docs/DECISIONS.md D17). Pricing this once,
 * instead of each recipe alone, stops shared staples (one bottle of oil, one bag
 * of rice) from being bought several times and blowing the budget.
 */
export function poolIngredients(recipes: Recipe[]): Ingredient[] {
  const byName = new Map<string, Ingredient>();
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      const key = ing.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) existing.qtyGrams += ing.qtyGrams;
      else byName.set(key, { ...ing });
    }
  }
  return [...byName.values()];
}

export interface PricedRecipe {
  recipe: Recipe;
  /** Real cost to buy this recipe's ingredients for the configured household, via optimizePlan. */
  realCost: number;
}

export interface WeekPlan {
  meals: PricedRecipe[];
  total: number;
  budget: number;
  withinBudget: boolean;
  /** Dollars over budget (0 if within). */
  overBy: number;
  /** Days requested. */
  days: number;
  /** Requested days minus meals we could actually fill (too few candidates). */
  shortfall: number;
}

export interface SelectOptions {
  budget: number;
  /** Number of dinners to plan. Default 5. */
  days?: number;
}

/**
 * Pick the cheapest `days` distinct compliant recipes. Because every candidate is
 * already compliant, choosing the cheapest N minimizes spend without touching
 * nutrition. If that still exceeds the budget, the plan is returned with the gap
 * surfaced rather than dropping a meal or a guardrail.
 */
export function selectWeek(candidates: PricedRecipe[], options: SelectOptions): WeekPlan {
  const days = options.days ?? 5;
  const budget = options.budget;

  // Cheapest first, one entry per distinct dish.
  const seen = new Set<string>();
  const distinct = [...candidates]
    .sort((a, b) => a.realCost - b.realCost)
    .filter((c) => {
      const key = c.recipe.dish.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const meals = distinct.slice(0, days);
  const total = meals.reduce((s, m) => s + m.realCost, 0);

  return {
    meals,
    total,
    budget,
    withinBudget: total <= budget,
    overBy: Math.max(0, total - budget),
    days,
    shortfall: Math.max(0, days - meals.length),
  };
}

/**
 * Re-pick the week after the shopper swaps out one dinner: exclude the named dish
 * and select again from the rest. Used by the "over budget? swap a meal" action.
 */
export function swapMeal(
  candidates: PricedRecipe[],
  excludeDish: string,
  options: SelectOptions,
): WeekPlan {
  const remaining = candidates.filter((c) => c.recipe.dish.toLowerCase() !== excludeDish.toLowerCase());
  return selectWeek(remaining, options);
}
