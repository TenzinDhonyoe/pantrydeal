import { describe, it, expect } from 'vitest';
import { buildBasket, rankStores, REGULAR_PRICE_MARKUP } from '../src/core/rank.js';
import type { FlyerItem, Ingredient, Match, Store, StoreBasket } from '../src/core/types.js';

function store(storeId: string, name: string, distanceKm?: number): Store {
  return { storeId, merchant: 'M', name, address: '', lat: 0, lng: 0, distanceKm };
}
function ing(name: string, qtyGrams: number): Ingredient {
  return { name, qtyGrams, category: 'other', substitutes: [] };
}
function item(name: string, rawPrice: string, size?: string): FlyerItem {
  return { name, rawPrice, size, merchant: 'M', storeIds: ['s'], validFrom: '', validTo: '' };
}

function matched(name: string, grams: number, ppg: number): Match {
  return {
    ingredient: ing(name, grams),
    item: item(name, '$1', `${grams} g`),
    pricePerGram: ppg,
    status: 'MATCHED',
    neededGrams: grams,
    lineCost: ppg * grams,
  };
}
function unmatched(name: string, grams: number): Match {
  return {
    ingredient: ing(name, grams),
    item: null,
    pricePerGram: null,
    status: 'UNMATCHED',
    neededGrams: grams,
    lineCost: null,
  };
}
function basketWith(name: string, matches: Match[], distanceKm?: number): StoreBasket {
  const matchedCount = matches.filter((m) => m.status === 'MATCHED').length;
  const total = matches.reduce((s, m) => s + (m.lineCost ?? 0), 0);
  return {
    store: store(name, name, distanceKm),
    matches,
    matchedCount,
    totalIngredients: matches.length,
    coverage: matches.length === 0 ? 0 : matchedCount / matches.length,
    total,
    projectedTotal: total,
  };
}

describe('buildBasket', () => {
  it('computes coverage and total, retaining unmatched ingredients', () => {
    const ingredients = [ing('rice', 300), ing('saffron', 1)];
    const items = [item('Basmati Rice', '$9.99', '4 kg')];
    const basket = buildBasket(store('s', 'Shop'), ingredients, items);
    expect(basket.totalIngredients).toBe(2);
    expect(basket.matchedCount).toBe(1);
    expect(basket.coverage).toBeCloseTo(0.5, 6);
    expect(basket.matches).toHaveLength(2);
    expect(basket.total).toBeCloseTo((9.99 / 4000) * 300, 6);
  });

  it('reports zero coverage for an empty recipe', () => {
    const basket = buildBasket(store('s', 'Shop'), [], []);
    expect(basket.coverage).toBe(0);
    expect(basket.total).toBe(0);
  });
});

describe('rankStores', () => {
  it('penalizes a store that misses an expensive staple (projected full basket)', () => {
    // Store A has chicken + onion on sale. Store B only has onion (cheaper onion),
    // so its matched total is tiny — but it would cost more for the WHOLE recipe.
    const a = basketWith('A', [matched('chicken', 600, 0.013), matched('onion', 150, 0.003)]);
    const b = basketWith('B', [unmatched('chicken', 600), matched('onion', 150, 0.002)]);
    expect(b.total).toBeLessThan(a.total); // naive matched-total would pick B

    const ranked = rankStores([b, a]);
    expect(ranked[0]!.store.name).toBe('A'); // projected total picks the real winner
    // B's projection adds an estimated regular price for the missing chicken.
    const rankedB = ranked.find((x) => x.store.name === 'B')!;
    const refChicken = 0.013 * REGULAR_PRICE_MARKUP; // max sale ppg seen, marked up
    expect(rankedB.projectedTotal).toBeCloseTo(b.total + refChicken * 600, 6);
  });

  it('leaves projectedTotal equal to total when nothing is unmatched', () => {
    const a = basketWith('A', [matched('rice', 300, 0.0025)]);
    const ranked = rankStores([a]);
    expect(ranked[0]!.projectedTotal).toBeCloseTo(a.total, 8);
  });

  it('ignores ingredients nobody has on sale (a wash everywhere)', () => {
    const a = basketWith('A', [matched('rice', 300, 0.0025), unmatched('truffle', 5)]);
    const b = basketWith('B', [matched('rice', 300, 0.003), unmatched('truffle', 5)]);
    const ranked = rankStores([b, a]);
    // No reference price for truffle -> no penalty -> cheaper rice wins.
    expect(ranked[0]!.store.name).toBe('A');
  });

  it('breaks projected ties by nearest store, then name', () => {
    const near = basketWith('near', [matched('rice', 300, 0.0025)], 1);
    const far = basketWith('far', [matched('rice', 300, 0.0025)], 5);
    expect(rankStores([far, near])[0]!.store.name).toBe('near');

    const zeta = basketWith('zeta', [matched('rice', 300, 0.0025)]);
    const alpha = basketWith('alpha', [matched('rice', 300, 0.0025)]);
    expect(rankStores([zeta, alpha])[0]!.store.name).toBe('alpha');
  });

  it('does not mutate the input array', () => {
    const input = [basketWith('a', [matched('rice', 300, 0.003)]), basketWith('b', [matched('rice', 300, 0.002)])];
    const copy = [...input];
    rankStores(input);
    expect(input).toEqual(copy);
  });
});
