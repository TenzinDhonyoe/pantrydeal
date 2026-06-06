/**
 * Two-store shopping optimizer (docs/DECISIONS.md D13/D14). Given the per-store
 * baskets the pipeline already produced, work out the cheapest realistic way to
 * actually buy the recipe: the best single store, the best pair of stores, and
 * whether a second stop saves enough to be worth suggesting.
 *
 * Store choice uses cost-per-portion (fair across pack sizes); the totals shown
 * are REAL pack prices (what you pay at the till). We never assert a trip is
 * "worth it" — Flipp gives no distances — we just surface the dollars saved and
 * let the shopper decide.
 */
import type { FlyerItem, Ingredient, Store, StoreBasket } from './types.js';
import { planPurchase, type PurchasePlan } from './purchase.js';

/** Markup over the dearest sale price used to estimate an off-sale price. */
const REGULAR_MARKUP = 1.25;
/** A price counts as a "good deal" at or below this fraction of the week's median. */
const GOOD_DEAL_FRACTION = 0.85;

export interface PlanItem {
  ingredient: string;
  neededGrams: number;
  item: FlyerItem;
  pricePerGram: number;
  portionCost: number;
  realCost: number;
  packPrice: number | null;
  packGrams: number | null;
  unitsNeeded: number;
  leftoverGrams: number;
  basis: 'weight' | 'pack';
  goodDeal: boolean;
}

export interface Trip {
  store: Store;
  items: PlanItem[];
  realSubtotal: number;
}

export interface ShoppingPlan {
  trips: Trip[];
  storeCount: number;
  /** Real pack cost of the on-sale items you'd buy across the chosen trips. */
  realOnSale: number;
  /** Estimated regular price for recipe items not on sale at the chosen stores. */
  estRegularGaps: number;
  /** realOnSale + estRegularGaps — the full-recipe figure used for ranking. */
  fullTotal: number;
  /** The best single-store option, for the "skip the 2nd trip" comparison. */
  oneStore: { store: Store; fullTotal: number; coverage: number } | null;
  /** Saving of the chosen plan vs the best single store (0 when we kept to one store). */
  savingsVsOneStore: number;
  /** What a second stop *could* save (may be below the worth-it bar). */
  secondStopSavings: number;
  /** Estimated savings on the on-sale items vs buying them at regular price. */
  savingsVsRegular: number;
  /** Ingredients on sale somewhere, but not at a chosen store. */
  onSaleElsewhere: string[];
  /** Ingredients no store has on sale this week. */
  neverOnSale: string[];
  bestDeals: PlanItem[];
  coverage: number;
  totalIngredients: number;
}

export interface OptimizeOptions {
  /** Max stores in a plan (1 or 2). Default 2. */
  maxStores?: number;
  /** Only suggest a second store when it saves at least this many dollars. Default 5. */
  worthItBar?: number;
  /** Largest pack we'll treat as a sensible consumer purchase, in grams. Default 11000 (11 kg). */
  maxPackGrams?: number;
}

interface Offer {
  pricePerGram: number;
  plan: PurchasePlan;
  item: FlyerItem;
}

interface Candidate {
  ids: string[];
  cost: number;
  assignment: Map<string, { storeId: string; offer: Offer }>;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Build per-store, per-ingredient purchase offers from the matched baskets. */
function buildOffers(
  baskets: StoreBasket[],
  maxPackGrams: number,
): Map<string, { store: Store; offers: Map<string, Offer> }> {
  const byStore = new Map<string, { store: Store; offers: Map<string, Offer> }>();
  for (const basket of baskets) {
    const offers = new Map<string, Offer>();
    for (const m of basket.matches) {
      if (m.status !== 'MATCHED' || m.item === null || m.pricePerGram === null) continue;
      const plan = planPurchase(m.item.rawPrice, m.item.size, m.neededGrams);
      if (!plan) continue;
      // Pack-size sanity: a 22 kg foodservice onion sack is not a consumer pack,
      // even if it's the best price per kg. Skip absurd packs (docs/DECISIONS.md D17).
      if (plan.packGrams !== null && plan.packGrams > maxPackGrams) continue;
      offers.set(m.ingredient.name, { pricePerGram: m.pricePerGram, plan, item: m.item });
    }
    byStore.set(basket.store.storeId, { store: basket.store, offers });
  }
  return byStore;
}

/** Assign each ingredient to the best-value store within a set; null if none has it. */
function assign(
  ingredientNames: string[],
  storeIds: string[],
  byStore: Map<string, { store: Store; offers: Map<string, Offer> }>,
): Map<string, { storeId: string; offer: Offer }> {
  const out = new Map<string, { storeId: string; offer: Offer }>();
  for (const name of ingredientNames) {
    let best: { storeId: string; offer: Offer } | null = null;
    for (const storeId of storeIds) {
      const offer = byStore.get(storeId)?.offers.get(name);
      if (!offer) continue;
      if (best === null || offer.pricePerGram < best.offer.pricePerGram) {
        best = { storeId, offer };
      }
    }
    if (best) out.set(name, best);
  }
  return out;
}

/**
 * Full-recipe cost for a store set: real pack cost of covered ingredients plus
 * an estimated regular price for on-sale ingredients the set doesn't cover.
 * Ingredients on sale nowhere are excluded (no price data), so they don't tilt
 * the single-vs-pair comparison.
 */
function fullCost(
  assignment: Map<string, { storeId: string; offer: Offer }>,
  onSaleNames: string[],
  regularEst: Map<string, number>,
): number {
  let total = 0;
  for (const name of onSaleNames) {
    const a = assignment.get(name);
    total += a ? a.offer.plan.realCost : (regularEst.get(name) ?? 0);
  }
  return total;
}

export function optimizePlan(
  ingredients: Ingredient[],
  baskets: StoreBasket[],
  options: OptimizeOptions = {},
): ShoppingPlan {
  const maxStores = options.maxStores ?? 2;
  const worthItBar = options.worthItBar ?? 5;
  const maxPackGrams = options.maxPackGrams ?? 11000;
  const names = ingredients.map((i) => i.name);
  const byStore = buildOffers(baskets, maxPackGrams);
  const storeIds = [...byStore.keys()];

  // Per-ingredient market stats across all stores that have it on sale.
  const regularEst = new Map<string, number>();
  const medianPpg = new Map<string, number>();
  const onSaleNames: string[] = [];
  const neverOnSale: string[] = [];
  for (const name of names) {
    const offers: Offer[] = [];
    for (const id of storeIds) {
      const o = byStore.get(id)!.offers.get(name);
      if (o) offers.push(o);
    }
    if (offers.length === 0) {
      neverOnSale.push(name);
      continue;
    }
    onSaleNames.push(name);
    regularEst.set(name, Math.max(...offers.map((o) => o.plan.realCost)) * REGULAR_MARKUP);
    medianPpg.set(name, median(offers.map((o) => o.pricePerGram)));
  }

  // Best single store and best pair, scored on full-recipe cost.
  let best: Candidate | null = null;
  let bestSingle: Candidate | null = null;
  const evaluate = (ids: string[]): Candidate => {
    const a = assign(onSaleNames, ids, byStore);
    const cost = fullCost(a, onSaleNames, regularEst);
    return { ids, cost, assignment: a };
  };
  for (const id of storeIds) {
    const cand = evaluate([id]);
    if (bestSingle === null || cand.cost < bestSingle.cost) bestSingle = cand;
  }
  best = bestSingle;
  if (maxStores >= 2) {
    for (let i = 0; i < storeIds.length; i += 1) {
      for (let j = i + 1; j < storeIds.length; j += 1) {
        const cand = evaluate([storeIds[i]!, storeIds[j]!]);
        if (best === null || cand.cost < best.cost) best = cand;
      }
    }
  }

  // Empty world: no stores at all.
  if (bestSingle === null || best === null) {
    return {
      trips: [],
      storeCount: 0,
      realOnSale: 0,
      estRegularGaps: 0,
      fullTotal: 0,
      oneStore: null,
      savingsVsOneStore: 0,
      savingsVsRegular: 0,
      onSaleElsewhere: [],
      secondStopSavings: 0,
      neverOnSale,
      bestDeals: [],
      coverage: 0,
      totalIngredients: ingredients.length,
    };
  }

  // Only commit to two stores when the saving clears the bar.
  const secondStopSavings = Math.max(0, bestSingle.cost - best.cost);
  const chosen = best.ids.length > 1 && secondStopSavings >= worthItBar ? best : bestSingle;

  // Build the per-ingredient plan items for the chosen stores.
  const itemsByStore = new Map<string, PlanItem[]>();
  let realOnSale = 0;
  let savingsVsRegular = 0;
  const coveredNames = new Set<string>();
  for (const name of onSaleNames) {
    const a = chosen.assignment.get(name);
    if (!a) continue;
    coveredNames.add(name);
    const need = ingredients.find((i) => i.name === name)!.qtyGrams;
    const med = medianPpg.get(name)!;
    const planItem: PlanItem = {
      ingredient: name,
      neededGrams: need,
      item: a.offer.item,
      pricePerGram: a.offer.pricePerGram,
      portionCost: a.offer.plan.portionCost,
      realCost: a.offer.plan.realCost,
      packPrice: a.offer.plan.packPrice,
      packGrams: a.offer.plan.packGrams,
      unitsNeeded: a.offer.plan.unitsNeeded,
      leftoverGrams: a.offer.plan.leftoverGrams,
      basis: a.offer.plan.basis,
      goodDeal: a.offer.pricePerGram <= GOOD_DEAL_FRACTION * med,
    };
    realOnSale += planItem.realCost;
    savingsVsRegular += Math.max(0, (regularEst.get(name) ?? planItem.realCost) - planItem.realCost);
    const list = itemsByStore.get(a.storeId) ?? [];
    list.push(planItem);
    itemsByStore.set(a.storeId, list);
  }

  const trips: Trip[] = chosen.ids
    .filter((id) => (itemsByStore.get(id)?.length ?? 0) > 0)
    .map((id) => {
      const items = itemsByStore.get(id)!;
      return {
        store: byStore.get(id)!.store,
        items,
        realSubtotal: items.reduce((s, it) => s + it.realCost, 0),
      };
    })
    .sort((a, b) => b.realSubtotal - a.realSubtotal);

  const estRegularGaps = onSaleNames
    .filter((n) => !coveredNames.has(n))
    .reduce((s, n) => s + (regularEst.get(n) ?? 0), 0);

  const onSaleElsewhere = onSaleNames.filter((n) => !coveredNames.has(n));
  const bestDeals = trips
    .flatMap((t) => t.items)
    .filter((it) => it.goodDeal)
    .sort((a, b) => a.pricePerGram - b.pricePerGram)
    .slice(0, 3);

  const oneStore = {
    store: byStore.get(bestSingle.ids[0]!)!.store,
    fullTotal: bestSingle.cost,
    coverage: bestSingle.assignment.size,
  };

  return {
    trips,
    storeCount: trips.length,
    realOnSale,
    estRegularGaps,
    fullTotal: realOnSale + estRegularGaps,
    oneStore,
    savingsVsOneStore: Math.max(0, bestSingle.cost - chosen.cost),
    secondStopSavings,
    savingsVsRegular,
    onSaleElsewhere,
    neverOnSale,
    bestDeals,
    coverage: coveredNames.size,
    totalIngredients: ingredients.length,
  };
}
