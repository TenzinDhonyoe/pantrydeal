/**
 * Turn a priced match into a realistic purchase: what you'd actually pay at the
 * till versus the cost of just the portion the recipe uses. The honest model
 * (docs/DECISIONS.md D13):
 *  - By-weight deals ("$2.99/lb") let you buy exactly what you need — no leftover.
 *  - Fixed packs ("$4.99 / 454 g") force whole packs — you buy ceil(need/pack)
 *    packs and keep the leftover. realCost is the pack-sum; portionCost is the
 *    pro-rated value used to compare stores fairly across pack sizes.
 */
import { normalizePrice } from './normalize.js';

export interface PurchasePlan {
  basis: 'weight' | 'pack';
  pricePerGram: number;
  neededGrams: number;
  /** Pro-rated cost of just the amount used (for fair store comparison). */
  portionCost: number;
  /** Pack size in grams (pack basis only). */
  packGrams: number | null;
  /** Price of one pack (pack basis only). */
  packPrice: number | null;
  /** Packs to buy: 1 for weight, ceil(need / pack) for packs. */
  unitsNeeded: number;
  /** What you actually pay at the till. */
  realCost: number;
  /** Grams left over after the recipe (0 for weight deals). */
  leftoverGrams: number;
}

/** Plan a purchase from a raw price + size + the grams the recipe needs. */
export function planPurchase(
  rawPrice: string,
  size: string | undefined,
  neededGrams: number,
): PurchasePlan | null {
  const n = normalizePrice(rawPrice, size);
  if (!n || neededGrams <= 0) return null;

  const pricePerGram = n.pricePerGram;
  const portionCost = pricePerGram * neededGrams;

  if (n.basis.startsWith('per-weight')) {
    return {
      basis: 'weight',
      pricePerGram,
      neededGrams,
      portionCost,
      packGrams: null,
      packPrice: null,
      unitsNeeded: 1,
      realCost: portionCost,
      leftoverGrams: 0,
    };
  }

  // Fixed pack / multi-buy: you buy whole units of size n.grams at n.effectivePrice.
  const packGrams = n.grams;
  const packPrice = n.effectivePrice;
  const unitsNeeded = Math.max(1, Math.ceil(neededGrams / packGrams));
  return {
    basis: 'pack',
    pricePerGram,
    neededGrams,
    portionCost,
    packGrams,
    packPrice,
    unitsNeeded,
    realCost: unitsNeeded * packPrice,
    leftoverGrams: unitsNeeded * packGrams - neededGrams,
  };
}
