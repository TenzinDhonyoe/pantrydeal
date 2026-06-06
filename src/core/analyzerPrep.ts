/**
 * analyzerPrep — pure, deterministic preparation logic for the LIVE Gemini flyer
 * analyzer (docs/ARCHITECTURE.md §5 option B). Lives in core/ so it is covered by
 * the tested suite; the GeminiAnalyzer integration keeps only the HTTP call (D1).
 *
 * The job: turn a recipe + a store's flyer items into ONE deduplicated candidate
 * universe for a single batched LLM call, instead of one call per ingredient.
 *
 *   recipe.ingredients ─┐
 *                       ├─▶ lexicalCandidates() per ingredient (high-recall stem match)
 *   flyer items ────────┘
 *                       └─▶ buildBatchPlan() ─▶ each flyer item appears ONCE, tagged
 *                                               with every ingredient it could match
 *
 * After the LLM returns assignments we score coverage; if it falls below the floor
 * (a sign the single big call went wrong) the analyzer falls back to per-ingredient
 * calls. coverageOf()/belowFloor() are the pure decision the fallback hangs on.
 */
import { stem, tokenize } from './matcher.js';
import { cacheKey } from './cache.js';
import type { FlyerItem, Ingredient } from './types.js';

/** Max lexical candidates kept per ingredient before the LLM sees them (option F). */
export const MAX_CANDIDATES = 12;

/**
 * Fraction of *matchable* ingredients the batched call must cover before we trust
 * it. Below this we assume the single call misfired and fall back. An ingredient
 * with zero lexical candidates is not "matchable" and never counts against us.
 */
export const COVERAGE_FLOOR = 0.3;

function stemSet(text: string): Set<string> {
  return new Set(tokenize(text).map(stem));
}

/** Stem of the HEAD noun (last token) of a phrase — "olive oil" -> "oil", "green onion" -> "onion". */
function headStem(text: string): string | undefined {
  const toks = tokenize(text);
  return toks.length ? stem(toks[toks.length - 1]!) : undefined;
}

/**
 * Lexical candidates for one ingredient (option F: head-noun gated). An item
 * qualifies only if it shares the HEAD noun of the ingredient name or one of its
 * substitutes — so "Black Olives" no longer matches "olive oil" (shares "olive" but
 * not the head "oil"), while "Chicken Thigh" still matches "chicken". Qualifiers are
 * ranked by total shared stems (richer overlap first), then by shorter name. Still
 * high recall on true foods; the LLM does the final precise rejection.
 */
export function lexicalCandidates(
  ingredient: Ingredient,
  items: FlyerItem[],
  maxCandidates = MAX_CANDIDATES,
): number[] {
  const want = new Set<string>(stemSet(ingredient.name));
  const heads = new Set<string>();
  const ownHead = headStem(ingredient.name);
  if (ownHead) heads.add(ownHead);
  for (const sub of ingredient.substitutes) {
    for (const s of stemSet(sub)) want.add(s);
    const h = headStem(sub);
    if (h) heads.add(h);
  }

  const scored: Array<{ idx: number; shared: number; len: number }> = [];
  items.forEach((item, idx) => {
    if (!item.rawPrice) return;
    const itemStems = stemSet(item.name);
    // Gate: must share a head noun, not merely an incidental modifier.
    let hasHead = false;
    for (const h of heads) if (itemStems.has(h)) { hasHead = true; break; }
    if (!hasHead) return;
    let shared = 0;
    for (const w of want) if (itemStems.has(w)) shared += 1;
    scored.push({ idx, shared, len: item.name.length });
  });
  scored.sort((a, b) => b.shared - a.shared || a.len - b.len);
  return scored.slice(0, maxCandidates).map((s) => s.idx);
}

/** A cached same-food decision for one (ingredient, flyer item) pair (option D). */
export interface ClassificationDecision {
  accept: boolean;
  unitPriceDollars?: number;
  quantityGrams?: number;
}

/**
 * Cache key for a classification decision: identical ingredient + identical flyer
 * item (by sku, else name) + the deal's validity window. Including validTo means a
 * rotated flyer (new validTo) is a cache miss, so a stale price is never reused.
 */
export function classificationKey(ingredientName: string, item: FlyerItem): string {
  return cacheKey('cls', ingredientName, item.sku ?? item.name, item.validTo);
}

/** One entry in the deduplicated candidate universe sent to the batched LLM call. */
export interface BatchCandidate {
  /** Index into the original items[] array. */
  itemIndex: number;
  /** Indices into recipe.ingredients[] this item is a lexical candidate for. */
  ingredientIndices: number[];
}

export interface BatchPlan {
  /** Each flyer item that is a candidate for >=1 ingredient, listed exactly once. */
  candidates: BatchCandidate[];
  /** Per-ingredient: did it have ANY lexical candidate? Drives the coverage denominator. */
  ingredientHasCandidates: boolean[];
}

/**
 * Build the deduplicated candidate universe for a batched analyzer call. A flyer
 * item that is a candidate for several ingredients (e.g. an onion listing matching
 * both "onion" and "green onion") appears once, tagged with all of them — so its
 * text is sent (and billed) a single time, not once per ingredient (waste #2).
 */
export function buildBatchPlan(ingredients: Ingredient[], items: FlyerItem[]): BatchPlan {
  // itemIndex -> the ingredient indices it is a candidate for, preserving item order.
  const byItem = new Map<number, number[]>();
  const ingredientHasCandidates = ingredients.map(() => false);

  ingredients.forEach((ingredient, ingIdx) => {
    const idxs = lexicalCandidates(ingredient, items);
    if (idxs.length > 0) ingredientHasCandidates[ingIdx] = true;
    for (const itemIdx of idxs) {
      const tags = byItem.get(itemIdx);
      if (tags) tags.push(ingIdx);
      else byItem.set(itemIdx, [ingIdx]);
    }
  });

  const candidates: BatchCandidate[] = [...byItem.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([itemIndex, ingredientIndices]) => ({ itemIndex, ingredientIndices }));

  return { candidates, ingredientHasCandidates };
}

/**
 * Coverage of a batched result: matched matchable-ingredients / matchable-ingredients.
 * Returns 1 when nothing was matchable (no candidates at all → nothing to cover, so
 * the call did not "fail"). `matchedIngredientIndices` is the set of ingredient
 * indices the LLM successfully assigned at least one priced item to.
 */
export function coverageOf(
  matchedIngredientIndices: Set<number>,
  ingredientHasCandidates: boolean[],
): number {
  const matchable = ingredientHasCandidates.filter(Boolean).length;
  if (matchable === 0) return 1;
  let covered = 0;
  ingredientHasCandidates.forEach((had, idx) => {
    if (had && matchedIngredientIndices.has(idx)) covered += 1;
  });
  return covered / matchable;
}

/** True when a batched result is too sparse to trust (triggers per-ingredient fallback). */
export function belowFloor(coverage: number, floor = COVERAGE_FLOOR): boolean {
  return coverage < floor;
}
