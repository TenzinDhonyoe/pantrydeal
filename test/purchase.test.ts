import { describe, it, expect } from 'vitest';
import { planPurchase } from '../src/core/purchase.js';

const LB = 453.59237;

describe('planPurchase', () => {
  it('by-weight: buy exactly what you need, no leftover', () => {
    const p = planPurchase('$2.99/lb', undefined, 600)!;
    expect(p.basis).toBe('weight');
    expect(p.unitsNeeded).toBe(1);
    expect(p.leftoverGrams).toBe(0);
    expect(p.realCost).toBeCloseTo((2.99 / LB) * 600, 6);
    expect(p.realCost).toBeCloseTo(p.portionCost, 8); // weight: real == portion
    expect(p.packGrams).toBeNull();
  });

  it('fixed pack, exact fit: one pack, no leftover', () => {
    const p = planPurchase('$4.99', '454 g', 454)!;
    expect(p.basis).toBe('pack');
    expect(p.unitsNeeded).toBe(1);
    expect(p.realCost).toBeCloseTo(4.99, 6);
    expect(p.leftoverGrams).toBeCloseTo(0, 6);
    expect(p.packGrams).toBe(454);
    expect(p.packPrice).toBeCloseTo(4.99, 6);
  });

  it('fixed pack, needs multiple packs', () => {
    const p = planPurchase('$4.99', '454 g', 600)!;
    expect(p.unitsNeeded).toBe(2); // ceil(600 / 454)
    expect(p.realCost).toBeCloseTo(9.98, 6);
    expect(p.leftoverGrams).toBeCloseTo(2 * 454 - 600, 6);
    expect(p.portionCost).toBeLessThan(p.realCost); // portion << what you pay
  });

  it('big bag, tiny need: one pack, lots of leftover', () => {
    const p = planPurchase('$9.99', '4 kg', 300)!;
    expect(p.unitsNeeded).toBe(1);
    expect(p.realCost).toBeCloseTo(9.99, 6);
    expect(p.leftoverGrams).toBeCloseTo(3700, 6);
  });

  it('multi-buy is treated as a pack', () => {
    const p = planPurchase('2/$5', '500 g', 250)!;
    expect(p.basis).toBe('pack');
    expect(p.packPrice).toBeCloseTo(2.5, 6); // $5 for 2 -> $2.50 each
    expect(p.realCost).toBeCloseTo(2.5, 6);
    expect(p.leftoverGrams).toBeCloseTo(250, 6);
    expect(p.portionCost).toBeCloseTo((2.5 / 500) * 250, 6);
  });

  it('returns null when unpriceable or zero need', () => {
    expect(planPurchase('', undefined, 100)).toBeNull();
    expect(planPurchase('$1.29 ea', undefined, 100)).toBeNull(); // no size
    expect(planPurchase('$4.99', '454 g', 0)).toBeNull();
  });
});
