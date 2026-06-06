/**
 * Ingredient -> flyer-item matching. Deterministic stem-subset matching
 * (docs/DECISIONS.md D6). Every ingredient yields exactly one Match; an
 * ingredient with no eligible candidate is flagged UNMATCHED, never dropped (D3).
 */
import type { CandidateMatcher, FlyerItem, Ingredient, Match } from './types.js';
import { normalizePrice } from './normalize.js';

const STOPWORDS = new Set([
  'fresh',
  'frozen',
  'boneless',
  'skinless',
  'family',
  'pack',
  'value',
  'large',
  'small',
  'organic',
  'pure',
  'extra',
  'the',
  'of',
  'and',
  'with',
  'each',
  'ea',
  'size',
  'bag',
  'box',
  'can',
  'jar',
]);

/** Lowercase, strip punctuation, drop stopwords, split into tokens. */
export function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Fold a token to a crude singular stem (plural-insensitive matching). */
export function stem(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('es') && token.length > 3) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 2) return token.slice(0, -1);
  return token;
}

function stems(name: string): Set<string> {
  return new Set(tokenize(name).map(stem));
}

/** Does every stem of `needle` appear in `haystack`? Empty needle never matches. */
function isSubset(needle: Set<string>, haystack: Set<string>): boolean {
  if (needle.size === 0) return false;
  for (const s of needle) {
    if (!haystack.has(s)) return false;
  }
  return true;
}

/**
 * Whether a flyer item satisfies an ingredient: the ingredient's name OR any of
 * its substitutes must be a stem-subset of the item's name.
 */
export function itemMatchesIngredient(item: FlyerItem, ingredient: Ingredient): boolean {
  const itemStems = stems(item.name);
  if (isSubset(stems(ingredient.name), itemStems)) return true;
  return ingredient.substitutes.some((sub) => isSubset(stems(sub), itemStems));
}

/** The default matching strategy: deterministic lexical stem-subset matching. */
export const lexicalMatcher: CandidateMatcher = {
  matches: (ingredient, item) => itemMatchesIngredient(item, ingredient),
};

// Processed / snack forms that are not the whole food (carrot chips != carrot).
const PROCESSED_SNACK = new Set([
  'chip', 'chips', 'crisp', 'crisps', 'snack', 'snacks', 'candy', 'cracker', 'crackers',
  'cookie', 'cookies', 'fries', 'juice', 'soda', 'pop', 'popcorn', 'flavoured', 'flavored',
  'breaded', 'nuggets', 'wieners', 'sausage', 'sausages',
]);
const MEAT_WORDS = ['chicken', 'turkey', 'beef', 'pork', 'fish', 'salmon', 'shrimp', 'bacon', 'ham'];
const MEAT_INGREDIENTS = new Set(['chicken', 'turkey', 'beef', 'pork', 'fish', 'salmon', 'shrimp']);

/**
 * A stricter matcher for health plans (docs/DECISIONS.md D17): it accepts only
 * what a base matcher accepts AND that is the SAME FOOD — never a processed/snack
 * form (carrot chips), and never a meat product for a non-meat ingredient
 * (Chicken Thighs for tofu). Wraps any base matcher (default lexical); for live
 * mode wrap the Gemini matcher so the guard applies on top of semantic matching.
 */
export function sameFoodMatcher(base: CandidateMatcher = lexicalMatcher): CandidateMatcher {
  return {
    matches(ingredient, item) {
      if (!base.matches(ingredient, item)) return false;
      const tokens = new Set(
        item.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/),
      );
      for (const t of tokens) if (PROCESSED_SNACK.has(t)) return false;
      const ingIsMeat = MEAT_INGREDIENTS.has(ingredient.name.toLowerCase());
      const name = item.name.toLowerCase();
      const itemLooksMeat = MEAT_WORDS.some((w) => name.includes(w));
      if (!ingIsMeat && itemLooksMeat) return false;
      return true;
    },
  };
}

/**
 * Find the cheapest eligible match for one ingredient among the given items.
 * Eligible = the matcher accepts the (ingredient, item) pair AND the price
 * normalizes to a numeric pricePerGram (D3). The matcher defaults to lexical
 * matching; live mode injects an LLM-backed strategy (docs/DECISIONS.md D11).
 */
export function matchIngredient(
  ingredient: Ingredient,
  items: FlyerItem[],
  matcher: CandidateMatcher = lexicalMatcher,
): Match {
  let best: { item: FlyerItem; pricePerGram: number; lineCost: number } | null = null;

  for (const item of items) {
    if (!matcher.matches(ingredient, item)) continue;
    const normalized = normalizePrice(item.rawPrice, item.size);
    if (!normalized) continue; // not eligible: cannot price it
    const lineCost = normalized.pricePerGram * ingredient.qtyGrams;
    if (best === null || lineCost < best.lineCost) {
      best = { item, pricePerGram: normalized.pricePerGram, lineCost };
    }
  }

  if (best === null) {
    return {
      ingredient,
      item: null,
      pricePerGram: null,
      status: 'UNMATCHED',
      neededGrams: ingredient.qtyGrams,
      lineCost: null,
    };
  }

  return {
    ingredient,
    item: best.item,
    pricePerGram: best.pricePerGram,
    status: 'MATCHED',
    neededGrams: ingredient.qtyGrams,
    lineCost: best.lineCost,
  };
}

/** Match every recipe ingredient against a store's items. Never drops an ingredient. */
export function matchBasket(
  ingredients: Ingredient[],
  items: FlyerItem[],
  matcher: CandidateMatcher = lexicalMatcher,
): Match[] {
  return ingredients.map((ing) => matchIngredient(ing, items, matcher));
}
