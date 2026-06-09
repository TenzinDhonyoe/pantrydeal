/**
 * GeminiAnalyzer tests (T2). The analyzer owns the live HTTP call, so it is
 * normally OUTSIDE the suite — but its constructor accepts a `fetchImpl` seam
 * plus an injectable `classificationCache` and `now` clock, which lets us drive
 * the whole prepare() path with a FAKE fetch returning canned Gemini JSON, no
 * network involved.
 *
 * The headline case is the B2 regression: a SINGLE flyer item that the batched
 * response assigns to TWO ingredients must end up matching BOTH. The old
 * `Map<FlyerItem,string>` overwrote the first ingredient; the fix is a
 * `Map<FlyerItem,Set<string>>`.
 */
import { describe, it, expect } from 'vitest';
import { GeminiAnalyzer } from '../src/integrations/geminiAnalyzer.js';
import { LruCache } from '../src/core/cache.js';
import type { ClassificationDecision } from '../src/core/analyzerPrep.js';
import type { FlyerItem, Ingredient } from '../src/core/types.js';

// --- fixtures --------------------------------------------------------------

/** A flyer item with a far-future validity window so it always reads as fresh. */
function item(name: string, rawPrice = '$1.99', size?: string): FlyerItem {
  return {
    name,
    rawPrice,
    size,
    merchant: 'Test',
    storeIds: ['s1'],
    validFrom: '2026-01-01',
    validTo: '2099-12-31',
  };
}

function ing(name: string, substitutes: string[] = []): Ingredient {
  return { name, qtyGrams: 100, category: 'other', substitutes };
}

/** A clock pinned well before the fixtures' validTo, so isFresh() is true. */
const NOW = () => new Date('2026-06-09T00:00:00Z');

/** A fresh, isolated cache per test (so a process-wide LRU can't leak between runs). */
function emptyCache(): LruCache<ClassificationDecision> {
  return new LruCache<ClassificationDecision>(100);
}

/**
 * Build a minimal-but-realistic fake `fetch`. It ignores the request and returns
 * one canned Gemini generateContent response whose single text part is the JSON
 * of `payload` (the shape acceptBatch / acceptFor parse). Records each call.
 */
function fakeFetch(payload: unknown): { fetchImpl: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    state.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, get calls() { return state.calls; } };
}

// --- tests -----------------------------------------------------------------

describe('GeminiAnalyzer.prepare', () => {
  it('B2: one flyer item assigned to TWO ingredients matches BOTH', async () => {
    // "Green Onion Bunch" is a lexical candidate for both "onion" and "green onion"
    // (shares the head noun "onion"), so buildBatchPlan emits it as ONE candidate
    // (candidateIndex 0) tagged with ingredientIndices [0, 1].
    const recipe = {
      dish: 'test',
      servings: 4,
      ingredients: [ing('onion'), ing('green onion')],
    };
    const items = [item('Green Onion Bunch', '$2.49')];

    // Batched response: assign candidate 0 to BOTH ingredient 0 and ingredient 1.
    const { fetchImpl } = fakeFetch({
      accepted: [
        { ingredientIndex: 0, candidateIndex: 0, unitPriceDollars: 2.49, quantityGrams: 200 },
        { ingredientIndex: 1, candidateIndex: 0, unitPriceDollars: 2.49, quantityGrams: 200 },
      ],
    });

    const analyzer = new GeminiAnalyzer({
      apiKey: 'test-key',
      fetchImpl,
      classificationCache: emptyCache(),
      now: NOW,
    });
    const { items: out, matcher } = await analyzer.prepare(recipe, items);

    // The single returned item satisfies BOTH ingredients (the bug being fixed:
    // previously only the SECOND assignment survived, leaving one UNMATCHED).
    expect(matcher.matches(recipe.ingredients[0]!, out[0]!)).toBe(true);
    expect(matcher.matches(recipe.ingredients[1]!, out[0]!)).toBe(true);
  });

  it('happy path: an accepted item is enriched and matches its ingredient', async () => {
    const recipe = {
      dish: 'test',
      servings: 4,
      ingredients: [ing('chicken')],
    };
    const items = [item('Boneless Chicken Breast', '$5.99 / lb', '1 kg')];

    const { fetchImpl } = fakeFetch({
      accepted: [
        { ingredientIndex: 0, candidateIndex: 0, unitPriceDollars: 8.99, quantityGrams: 900 },
      ],
    });

    const analyzer = new GeminiAnalyzer({
      apiKey: 'test-key',
      fetchImpl,
      classificationCache: emptyCache(),
      now: NOW,
    });
    const { items: out, matcher } = await analyzer.prepare(recipe, items);

    // The accepted item carries the LLM's clean unit price + grams (downstream the
    // FixtureFlyerClient consumes these mutated rawPrice/size fields).
    expect(out[0]!.rawPrice).toBe('$8.99');
    expect(out[0]!.size).toBe('900 g');
    expect(matcher.matches(recipe.ingredients[0]!, out[0]!)).toBe(true);

    // The original items[] is not mutated (prepare works on a copy).
    expect(items[0]!.rawPrice).toBe('$5.99 / lb');
  });

  it('an item the batch rejects does not match', async () => {
    const recipe = {
      dish: 'test',
      servings: 4,
      ingredients: [ing('chicken')],
    };
    const items = [item('Boneless Chicken Breast', '$5.99')];

    // Empty acceptance -> coverage 0 -> below floor -> per-ingredient fallback,
    // which we also stub to reject. Net: no match.
    const { fetchImpl } = fakeFetch({ accepted: [] });

    const analyzer = new GeminiAnalyzer({
      apiKey: 'test-key',
      fetchImpl,
      classificationCache: emptyCache(),
      now: NOW,
    });
    const { items: out, matcher } = await analyzer.prepare(recipe, items);

    expect(matcher.matches(recipe.ingredients[0]!, out[0]!)).toBe(false);
  });
});
