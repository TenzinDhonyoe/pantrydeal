import { describe, it, expect } from 'vitest';
import { priceRecipe } from '../src/core/recipePricing.js';
import type { FlyerItem, Ingredient, Store } from '../src/core/types.js';

function store(storeId: string): Store {
  return { storeId, merchant: storeId, name: storeId, address: '', lat: 0, lng: 0, distanceKm: 0 };
}
function ing(name: string, qtyGrams: number): Ingredient {
  return { name, qtyGrams, category: 'other', substitutes: [] };
}
function item(name: string, rawPrice: string, size: string | undefined, storeId: string): FlyerItem {
  return { name, rawPrice, size, merchant: storeId, storeIds: [storeId], validFrom: '', validTo: '' };
}

describe('priceRecipe', () => {
  it('prices a recipe across stores via the deal optimizer', () => {
    const ings = [ing('chicken', 600), ing('rice', 300)];
    const stores = [store('A'), store('B')];
    const items = [
      item('Chicken Breast', '$2.99/lb', undefined, 'A'),
      item('Basmati Rice', '$9.99', '4 kg', 'B'),
    ];
    const plan = priceRecipe(ings, stores, items);
    expect(plan.neverOnSale).toEqual([]); // both ingredients are on sale somewhere
    expect(plan.realOnSale).toBeGreaterThan(0);
    expect(plan.fullTotal).toBeGreaterThanOrEqual(plan.realOnSale);

    // With no worth-it bar, it uses both stores and covers both ingredients.
    const twoStore = priceRecipe(ings, stores, items, undefined, { worthItBar: 0 });
    expect(twoStore.coverage).toBe(2);
  });

  it('flags ingredients with no deal anywhere', () => {
    const ings = [ing('chicken', 600), ing('saffron', 2)];
    const plan = priceRecipe(ings, [store('A')], [item('Chicken Breast', '$2.99/lb', undefined, 'A')]);
    expect(plan.neverOnSale).toEqual(['saffron']);
    expect(plan.coverage).toBe(1);
  });
});
