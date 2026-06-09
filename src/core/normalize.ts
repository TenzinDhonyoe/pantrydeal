/**
 * Price normalization: a raw flyer price string (+ optional size) -> price per gram.
 * See docs/DECISIONS.md D2/D3/D4.
 */
import type { NormalizedPrice } from './types.js';

const GRAMS_PER_LB = 453.59237;
const GRAMS_PER_OZ = 28.349523125;
const GRAMS_PER_KG = 1000;

/** Map a unit token to grams. Returns null for unknown units. */
function unitToGrams(unit: string): number | null {
  switch (unit.toLowerCase()) {
    case 'kg':
    case 'kilogram':
    case 'kilograms':
      return GRAMS_PER_KG;
    case 'g':
    case 'gram':
    case 'grams':
      return 1;
    case 'lb':
    case 'lbs':
    case 'pound':
    case 'pounds':
      return GRAMS_PER_LB;
    case 'oz':
    case 'ounce':
    case 'ounces':
      return GRAMS_PER_OZ;
    // D4: liquid volumes approximate 1 ml = 1 g.
    case 'ml':
    case 'milliliter':
    case 'millilitre':
      return 1;
    case 'l':
    case 'liter':
    case 'litre':
      return GRAMS_PER_KG;
    default:
      return null;
  }
}

/**
 * Parse a size string into grams.
 *  - "1.5 kg", "500g", "454 g", "12 oz", "2 lb", "750 ml", "1 l"
 *  - multipack: "2 x 200 g", "4x125g" -> multiplied
 * Returns null if no weight/volume can be parsed.
 */
export function parseSizeToGrams(size: string | undefined): number | null {
  if (!size) return null;
  const cleaned = size.toLowerCase().trim();

  // Multipack form: "<count> x <amount> <unit>"
  const multi = cleaned.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (multi) {
    const count = Number(multi[1]);
    const amount = Number(multi[2]);
    const grams = unitToGrams(multi[3]!);
    if (grams !== null && count > 0 && amount > 0) {
      return count * amount * grams;
    }
  }

  // Simple form: "<amount> <unit>"
  const simple = cleaned.match(/(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (simple) {
    const amount = Number(simple[1]);
    const grams = unitToGrams(simple[2]!);
    if (grams !== null && amount > 0) {
      return amount * grams;
    }
  }

  return null;
}

/**
 * Promotional marketing words that, on a string with NO dollar amount, mean the
 * first bare number is a campaign detail ("save 3", "3 days only", "buy 2 get 1")
 * rather than a price. Whole-word, case-insensitive. Kept deliberately narrow so
 * legit bare prices ("1.29 ea", "0.99 each") still parse.
 */
const PROMO_WORDS = [
  'save', 'off', 'free', 'days', 'day only', 'buy', 'get', 'win', 'bonus', 'points', 'spend', 'earn',
];

/** Pull the first dollar amount out of a string, e.g. "$8.99 family pack" -> 8.99. */
function firstDollarAmount(s: string): number | null {
  const m = s.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (m) return Number(m[1]);
  // Guard the bare-number fallback: a promo string with no "$" (e.g. "save 3",
  // "3 days only") is not a price — its first number would corrupt ranking.
  if (PROMO_WORDS.some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i').test(s))) {
    return null;
  }
  // bare number fallback, e.g. "1.29 ea"
  const bare = s.match(/(\d+(?:\.\d+)?)/);
  return bare ? Number(bare[1]) : null;
}

/**
 * Normalize a price into price-per-gram. Resolution order:
 *  1. Explicit per-weight pricing ("$3.49/lb", "$12.99/kg", "$0.99/100g") — self-describing.
 *  2. Multi-buy ("2/$5", "10/$10") — unit price = total / count, then needs size.
 *  3. Plain / each / pack ("$8.99 family pack", "$1.29 ea") — total price, needs size.
 *
 * Returns null when price-per-gram cannot be determined (e.g. an "each" item with no size).
 */
export function normalizePrice(
  rawPrice: string,
  size?: string,
): NormalizedPrice | null {
  if (!rawPrice) return null;
  const text = rawPrice.toLowerCase().trim();

  // 1. Per-weight: "$3.49/lb", "$0.99 / 100 g", "$12.99/kg"
  const perWeight = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-z]+)/);
  if (perWeight) {
    const price = Number(perWeight[1]);
    const qty = perWeight[2] ? Number(perWeight[2]) : 1;
    const gramsPerUnit = unitToGrams(perWeight[3]!);
    if (gramsPerUnit !== null && qty > 0) {
      const grams = qty * gramsPerUnit;
      const pricePerGram = price / grams;
      return {
        pricePerGram,
        effectivePrice: price,
        grams,
        basis: `per-weight: $${price} per ${qty === 1 ? '' : qty}${perWeight[3]}`.replace('  ', ' '),
      };
    }
  }

  // 2. Multi-buy: "2/$5", "10/$10"
  const multiBuy = text.match(/(\d+)\s*\/\s*\$\s*(\d+(?:\.\d+)?)/);
  if (multiBuy) {
    const count = Number(multiBuy[1]);
    const total = Number(multiBuy[2]);
    const grams = parseSizeToGrams(size);
    if (count > 0 && grams !== null) {
      const unitPrice = total / count;
      return {
        pricePerGram: unitPrice / grams,
        effectivePrice: unitPrice,
        grams,
        basis: `multi-buy: ${count} for $${total} ($${unitPrice.toFixed(2)} each over ${grams} g)`,
      };
    }
  }

  // 3. Plain / each / pack: needs a size to give grams.
  const price = firstDollarAmount(text);
  const grams = parseSizeToGrams(size);
  if (price !== null && grams !== null) {
    return {
      pricePerGram: price / grams,
      effectivePrice: price,
      grams,
      basis: `unit: $${price} over ${grams} g`,
    };
  }

  return null;
}
