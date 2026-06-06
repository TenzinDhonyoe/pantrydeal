/**
 * Basket assembly + store ranking. Ranking is coverage-first, then total cost
 * (docs/DECISIONS.md D5), so a store that merely lacks the recipe's expensive
 * ingredients cannot masquerade as the cheapest.
 */
import type { CandidateMatcher, FlyerItem, Ingredient, Store, StoreBasket } from './types.js';
import { matchBasket } from './matcher.js';

/** Build a StoreBasket for one store from a recipe's ingredients and the store's items. */
export function buildBasket(
  store: Store,
  ingredients: Ingredient[],
  items: FlyerItem[],
  matcher?: CandidateMatcher,
): StoreBasket {
  const matches = matchBasket(ingredients, items, matcher);
  const matchedCount = matches.filter((m) => m.status === 'MATCHED').length;
  const total = matches.reduce((sum, m) => sum + (m.lineCost ?? 0), 0);
  const totalIngredients = ingredients.length;

  return {
    store,
    matches,
    matchedCount,
    totalIngredients,
    coverage: totalIngredients === 0 ? 0 : matchedCount / totalIngredients,
    total,
    // Filled in by rankStores once cross-store reference prices are known.
    projectedTotal: total,
  };
}

/** Markup applied to the best sale price to estimate an off-sale "regular" price. */
export const REGULAR_PRICE_MARKUP = 1.25;

/**
 * Estimate a per-gram "regular" reference price for each ingredient from the
 * deals seen across all stores: the most expensive sale price observed for it,
 * marked up. Ingredients nobody has on sale get no reference (a wash everywhere).
 */
function referencePricePerGram(baskets: StoreBasket[]): Map<string, number> {
  const maxPpg = new Map<string, number>();
  for (const basket of baskets) {
    for (const m of basket.matches) {
      if (m.status === 'MATCHED' && m.pricePerGram !== null) {
        const prev = maxPpg.get(m.ingredient.name) ?? 0;
        if (m.pricePerGram > prev) maxPpg.set(m.ingredient.name, m.pricePerGram);
      }
    }
  }
  const ref = new Map<string, number>();
  for (const [name, ppg] of maxPpg) ref.set(name, ppg * REGULAR_PRICE_MARKUP);
  return ref;
}

/**
 * Compute each basket's projected full-recipe cost (matched sale prices +
 * estimated regular price for unmatched-but-available ingredients), then rank by
 * it ascending — so the cheapest store is the one that's genuinely cheapest for
 * the WHOLE recipe, not one that skips an expensive staple (docs/DECISIONS.md
 * D12). Ties break by higher coverage, then nearest store, then name.
 */
export function rankStores(baskets: StoreBasket[]): StoreBasket[] {
  const ref = referencePricePerGram(baskets);
  const projected = baskets.map((basket) => {
    let projectedTotal = basket.total;
    for (const m of basket.matches) {
      if (m.status === 'UNMATCHED') {
        const refPpg = ref.get(m.ingredient.name);
        if (refPpg !== undefined) projectedTotal += refPpg * m.neededGrams;
      }
    }
    return { ...basket, projectedTotal };
  });

  return projected.sort((a, b) => {
    if (a.projectedTotal !== b.projectedTotal) return a.projectedTotal - b.projectedTotal;
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    const da = a.store.distanceKm ?? Infinity;
    const db = b.store.distanceKm ?? Infinity;
    if (da !== db) return da - db;
    return a.store.name.localeCompare(b.store.name);
  });
}
