import { describe, it, expect } from 'vitest';
import { optimizePlan } from '../src/core/optimize.js';
import { buildBasket } from '../src/core/rank.js';
import type { FlyerItem, Ingredient, Store, StoreBasket } from '../src/core/types.js';

function store(storeId: string, name: string): Store {
  return { storeId, merchant: name, name, address: '', lat: 0, lng: 0, distanceKm: 0 };
}
function ing(name: string, qtyGrams: number): Ingredient {
  return { name, qtyGrams, category: 'other', substitutes: [] };
}
function item(name: string, rawPrice: string, size: string | undefined, storeId: string): FlyerItem {
  return { name, rawPrice, size, merchant: storeId, storeIds: [storeId], validFrom: '', validTo: '' };
}
function basket(s: Store, ingredients: Ingredient[], items: FlyerItem[]): StoreBasket {
  return buildBasket(s, ingredients, items);
}

describe('optimizePlan', () => {
  it('chooses two stores when the second stop clears the worth-it bar', () => {
    const ings = [ing('chicken', 600), ing('rice', 300)];
    const A = store('A', 'StoreA');
    const B = store('B', 'StoreB');
    // A: cheap chicken, dear rice. B: dear chicken, cheap rice bag.
    const aItems = [item('Chicken', '$2.00/lb', undefined, 'A'), item('Rice', '$20.00', '1 kg', 'A')];
    const bItems = [item('Chicken', '$9.00/lb', undefined, 'B'), item('Rice', '$5.00', '4 kg', 'B')];

    const plan = optimizePlan(ings, [basket(A, ings, aItems), basket(B, ings, bItems)]);

    expect(plan.storeCount).toBe(2);
    expect(plan.trips).toHaveLength(2);
    expect(plan.savingsVsOneStore).toBeGreaterThanOrEqual(5);
    // each ingredient routed to its cheapest-per-gram store
    const where = (name: string) => plan.trips.find((t) => t.items.some((i) => i.ingredient === name))!.store.storeId;
    expect(where('chicken')).toBe('A');
    expect(where('rice')).toBe('B');
    // trips sorted by real subtotal, descending
    expect(plan.trips[0]!.realSubtotal).toBeGreaterThanOrEqual(plan.trips[1]!.realSubtotal);
    // chicken at $2/lb is well below the cross-store median -> good deal
    const chicken = plan.trips.flatMap((t) => t.items).find((i) => i.ingredient === 'chicken')!;
    expect(chicken.goodDeal).toBe(true);
    expect(plan.bestDeals.some((d) => d.ingredient === 'chicken')).toBe(true);
  });

  it('keeps one store when a second stop saves too little', () => {
    const ings = [ing('chicken', 600), ing('ginger', 20)];
    const A = store('A', 'StoreA');
    const B = store('B', 'StoreB');
    // A has cheap chicken; ginger only at B and only ~$0.50 cheaper than A's regular est.
    const aItems = [item('Chicken', '$2.00/lb', undefined, 'A')];
    const bItems = [item('Ginger', '$0.50', '100 g', 'B')];

    const plan = optimizePlan(ings, [basket(A, ings, aItems), basket(B, ings, bItems)], { worthItBar: 5 });

    expect(plan.storeCount).toBe(1);
    expect(plan.savingsVsOneStore).toBe(0);
    expect(plan.secondStopSavings).toBeGreaterThan(0);
    expect(plan.onSaleElsewhere).toContain('ginger'); // on sale at B, but we kept to A
  });

  it('flags ingredients nobody has on sale', () => {
    const ings = [ing('chicken', 600), ing('saffron', 2)];
    const A = store('A', 'StoreA');
    const plan = optimizePlan(ings, [basket(A, ings, [item('Chicken', '$2.00/lb', undefined, 'A')])]);
    expect(plan.neverOnSale).toEqual(['saffron']);
    expect(plan.coverage).toBe(1);
    expect(plan.totalIngredients).toBe(2);
  });

  it('reports real pack cost and leftovers, not pro-rated', () => {
    const ings = [ing('rice', 300)];
    const A = store('A', 'StoreA');
    const plan = optimizePlan(ings, [basket(A, ings, [item('Basmati Rice', '$9.99', '4 kg', 'A')])]);
    const rice = plan.trips[0]!.items[0]!;
    expect(rice.realCost).toBeCloseTo(9.99, 6); // whole bag
    expect(rice.leftoverGrams).toBeCloseTo(3700, 6);
    expect(plan.realOnSale).toBeCloseTo(9.99, 6);
  });

  it('respects maxStores = 1 (never suggests a second store)', () => {
    const ings = [ing('chicken', 600), ing('rice', 300)];
    const A = store('A', 'StoreA');
    const B = store('B', 'StoreB');
    const aItems = [item('Chicken', '$2.00/lb', undefined, 'A')];
    const bItems = [item('Rice', '$5.00', '4 kg', 'B')];
    const plan = optimizePlan(ings, [basket(A, ings, aItems), basket(B, ings, bItems)], { maxStores: 1 });
    expect(plan.storeCount).toBe(1);
  });

  it('skips absurd foodservice pack sizes (50 lb sack)', () => {
    const ings = [ing('onion', 120)];
    const A = store('A', 'A');
    // a 22.7 kg onion sack is cheapest per kg but not a consumer pack
    const plan = optimizePlan(ings, [basket(A, ings, [item('Onion Sack', '$24.00', '22680 g', 'A')])]);
    expect(plan.coverage).toBe(0); // disqualified
    expect(plan.neverOnSale).toEqual(['onion']);

    // a normal pack is fine
    const ok = optimizePlan(ings, [basket(A, ings, [item('Cooking Onions', '$2.99', '1.36 kg', 'A')])]);
    expect(ok.coverage).toBe(1);
  });

  it('handles an empty world', () => {
    const plan = optimizePlan([ing('chicken', 600)], []);
    expect(plan.storeCount).toBe(0);
    expect(plan.trips).toEqual([]);
    expect(plan.fullTotal).toBe(0);
    expect(plan.oneStore).toBeNull();
    expect(plan.neverOnSale).toEqual(['chicken']);
  });

  it('computes a median across an odd number of stores', () => {
    const ings = [ing('onion', 150)];
    const stores = [
      basket(store('A', 'A'), ings, [item('Onion', '$1.00', '1 kg', 'A')]),
      basket(store('B', 'B'), ings, [item('Onion', '$2.00', '1 kg', 'B')]),
      basket(store('C', 'C'), ings, [item('Onion', '$3.00', '1 kg', 'C')]),
    ];
    const plan = optimizePlan(ings, stores);
    // cheapest onion (A) wins; median of 3 ppgs is B's price, A is below 0.85*median
    const onion = plan.trips[0]!.items[0]!;
    expect(onion.item.merchant).toBe('A');
    expect(onion.goodDeal).toBe(true);
  });
});
