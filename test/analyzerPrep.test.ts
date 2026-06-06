import { describe, it, expect } from 'vitest';
import {
  lexicalCandidates,
  buildBatchPlan,
  coverageOf,
  belowFloor,
  classificationKey,
  MAX_CANDIDATES,
  COVERAGE_FLOOR,
} from '../src/core/analyzerPrep.js';
import type { FlyerItem, Ingredient } from '../src/core/types.js';

function item(name: string, rawPrice = '$1.99', size?: string): FlyerItem {
  return {
    name,
    rawPrice,
    size,
    merchant: 'Test',
    storeIds: ['s1'],
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
  };
}

function ing(name: string, substitutes: string[] = []): Ingredient {
  return { name, qtyGrams: 100, category: 'other', substitutes };
}

describe('lexicalCandidates', () => {
  it('returns indices of priced items sharing a stem with the ingredient', () => {
    const items = [
      item('Boneless Chicken Breast'),
      item('Salted Butter'),
      item('Fresh Tomatoes'),
    ];
    expect(lexicalCandidates(ing('chicken'), items)).toEqual([0]);
    expect(lexicalCandidates(ing('tomato'), items)).toEqual([2]);
  });

  it('matches via substitutes too', () => {
    const items = [item('Fresh Coriander Bunch')];
    expect(lexicalCandidates(ing('cilantro', ['coriander']), items)).toEqual([0]);
  });

  it('skips items with no rawPrice (unpriceable cannot be a candidate)', () => {
    const items = [item('Chicken Thigh', ''), item('Chicken Breast', '$5.99')];
    expect(lexicalCandidates(ing('chicken'), items)).toEqual([1]);
  });

  it('ranks more shared stems first, then shorter names', () => {
    const items = [
      item('Green Onion Bunch'), // shares "onion"
      item('Onion'), // shares "onion", shorter
      item('Red Onion Family Pack Value'), // shares "onion", longest
    ];
    // "onion" ingredient: all share 1 stem -> ordered by name length ascending.
    expect(lexicalCandidates(ing('onion'), items)).toEqual([1, 0, 2]);
  });

  it('caps the candidate list at maxCandidates', () => {
    const items = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => item(`Chicken ${i}`));
    expect(lexicalCandidates(ing('chicken'), items)).toHaveLength(MAX_CANDIDATES);
    expect(lexicalCandidates(ing('chicken'), items, 5)).toHaveLength(5);
  });

  it('returns empty when nothing shares a stem', () => {
    expect(lexicalCandidates(ing('saffron'), [item('Chicken Breast')])).toEqual([]);
  });

  it('returns empty for an ingredient with no usable name (no head noun)', () => {
    expect(lexicalCandidates(ing('   '), [item('Chicken Breast')])).toEqual([]);
  });
});

describe('buildBatchPlan', () => {
  it('lists each flyer item once, tagged with every ingredient it can match', () => {
    const ingredients = [ing('onion'), ing('green onion')];
    const items = [item('Green Onion Bunch'), item('Yellow Onion')];
    const plan = buildBatchPlan(ingredients, items);

    // Both ingredients had candidates.
    expect(plan.ingredientHasCandidates).toEqual([true, true]);

    // "Green Onion Bunch" (item 0) is a candidate for BOTH ingredients -> one entry, two tags.
    const greenOnion = plan.candidates.find((c) => c.itemIndex === 0)!;
    expect(greenOnion.ingredientIndices.sort()).toEqual([0, 1]);

    // "Yellow Onion" (item 1) shares the "onion" stem with both ingredients
    // (high-recall lexical pass; the LLM does the precise split later).
    const yellowOnion = plan.candidates.find((c) => c.itemIndex === 1)!;
    expect(yellowOnion.ingredientIndices.sort()).toEqual([0, 1]);

    // Deduplicated: two flyer items -> two candidate entries (not three).
    expect(plan.candidates).toHaveLength(2);
  });

  it('keeps candidates sorted by item index', () => {
    const ingredients = [ing('rice'), ing('bread')];
    const items = [item('White Bread'), item('Basmati Rice'), item('Brown Rice')];
    const plan = buildBatchPlan(ingredients, items);
    expect(plan.candidates.map((c) => c.itemIndex)).toEqual([0, 1, 2]);
  });

  it('marks ingredients with no candidates as not matchable', () => {
    const ingredients = [ing('chicken'), ing('saffron')];
    const items = [item('Chicken Breast')];
    const plan = buildBatchPlan(ingredients, items);
    expect(plan.ingredientHasCandidates).toEqual([true, false]);
    expect(plan.candidates).toHaveLength(1);
  });

  it('produces an empty plan when nothing is priceable', () => {
    const plan = buildBatchPlan([ing('chicken')], [item('Chicken', '')]);
    expect(plan.candidates).toEqual([]);
    expect(plan.ingredientHasCandidates).toEqual([false]);
  });
});

describe('coverageOf', () => {
  const had = [true, true, true, false]; // 3 matchable, 1 not

  it('is the fraction of matchable ingredients that got a match', () => {
    expect(coverageOf(new Set([0, 1, 2]), had)).toBe(1);
    expect(coverageOf(new Set([0]), had)).toBeCloseTo(1 / 3);
    expect(coverageOf(new Set(), had)).toBe(0);
  });

  it('ignores matches to non-matchable ingredients', () => {
    // index 3 had no candidates; a stray match there must not inflate coverage.
    expect(coverageOf(new Set([0, 3]), had)).toBeCloseTo(1 / 3);
  });

  it('returns 1 when nothing was matchable (no work, not a failure)', () => {
    expect(coverageOf(new Set(), [false, false])).toBe(1);
    expect(coverageOf(new Set(), [])).toBe(1);
  });
});

describe('lexicalCandidates head-noun gate (option F)', () => {
  it('drops items that share only a modifier, not the head noun', () => {
    const items = [item('Olive Oil 1 L'), item('Black Olives'), item('Canola Oil')];
    const idxs = lexicalCandidates(ing('olive oil'), items);
    expect(idxs).toContain(0); // olive oil — head "oil"
    expect(idxs).not.toContain(1); // black olives — shares "olive" but not head "oil"
  });

  it('still keeps true foods via the head noun', () => {
    const items = [item('Boneless Skinless Chicken Breast'), item('Heavy Whipping Cream'), item('Roma Tomatoes')];
    expect(lexicalCandidates(ing('chicken'), items)).toContain(0);
    expect(lexicalCandidates(ing('cream'), items)).toContain(1);
    expect(lexicalCandidates(ing('tomato'), items)).toContain(2);
  });

  it('matches via a substitute head noun', () => {
    const items = [item('Fresh Coriander Bunch')];
    expect(lexicalCandidates(ing('cilantro', ['coriander']), items)).toEqual([0]);
  });
});

describe('classificationKey', () => {
  it('is stable across ingredient case for the same item + window', () => {
    const a = { ...item('Salted Butter', '$4.99', '454 g'), sku: 'X1', validTo: '2026-06-10' };
    expect(classificationKey('butter', a)).toBe(classificationKey('Butter', { ...a }));
  });

  it('changes when the flyer rotates (validTo differs)', () => {
    const a = { ...item('Salted Butter'), sku: 'X1', validTo: '2026-06-10' };
    const b = { ...a, validTo: '2026-06-17' };
    expect(classificationKey('butter', a)).not.toBe(classificationKey('butter', b));
  });

  it('falls back to the item name when sku is absent', () => {
    expect(classificationKey('butter', item('Generic Butter'))).toContain('generic butter');
  });
});

describe('belowFloor', () => {
  it('triggers fallback strictly below the floor', () => {
    expect(belowFloor(0)).toBe(true);
    expect(belowFloor(COVERAGE_FLOOR - 0.01)).toBe(true);
    expect(belowFloor(COVERAGE_FLOOR)).toBe(false);
    expect(belowFloor(1)).toBe(false);
  });

  it('respects a custom floor', () => {
    expect(belowFloor(0.5, 0.6)).toBe(true);
    expect(belowFloor(0.5, 0.4)).toBe(false);
  });
});
