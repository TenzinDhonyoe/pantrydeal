/**
 * Price one recipe against a set of stores' flyer items, reusing the existing
 * matcher → ranker → two-store optimizer. Pure, so the meal planner can price many
 * recipes against a single flyer pull without any network (docs/DECISIONS.md D16).
 */
import type { CandidateMatcher, FlyerItem, Ingredient, Store } from './types.js';
import { buildBasket, rankStores } from './rank.js';
import { optimizePlan, type OptimizeOptions, type ShoppingPlan } from './optimize.js';

/** Items a given store carries (its storeId is in the item's storeIds). */
function itemsForStore(store: Store, items: FlyerItem[]): FlyerItem[] {
  return items.filter((item) => item.storeIds.includes(store.storeId));
}

/**
 * Build the cheapest realistic shopping plan for one recipe's ingredients across
 * the given stores. `realOnSale + estRegularGaps` (plan.fullTotal) is the figure
 * the meal planner ranks weeks on.
 */
export function priceRecipe(
  ingredients: Ingredient[],
  stores: Store[],
  items: FlyerItem[],
  matcher?: CandidateMatcher,
  options?: OptimizeOptions,
): ShoppingPlan {
  const baskets = stores.map((store) =>
    buildBasket(store, ingredients, itemsForStore(store, items), matcher),
  );
  return optimizePlan(ingredients, rankStores(baskets), options);
}
