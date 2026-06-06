import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { normalizePrice, parseSizeToGrams } from '../src/core/normalize.js';

const here = dirname(fileURLToPath(import.meta.url));

interface GoldenCase {
  rawPrice: string;
  size?: string;
  expected: number;
}
const golden = JSON.parse(
  readFileSync(join(here, 'fixtures', 'prices.golden.json'), 'utf8'),
) as { cases: GoldenCase[] };

describe('normalizePrice golden cases', () => {
  it('has at least 20 cases', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of golden.cases) {
    const label = `${c.rawPrice}${c.size ? ` @ ${c.size}` : ''}`;
    it(`maps "${label}" to ${c.expected} per gram (+/-2%)`, () => {
      const result = normalizePrice(c.rawPrice, c.size);
      expect(result).not.toBeNull();
      const ppg = result!.pricePerGram;
      const tolerance = Math.abs(c.expected) * 0.02;
      expect(ppg).toBeGreaterThan(c.expected - tolerance);
      expect(ppg).toBeLessThan(c.expected + tolerance);
    });
  }
});

describe('parseSizeToGrams', () => {
  it('parses simple weights and volumes', () => {
    expect(parseSizeToGrams('1.5 kg')).toBeCloseTo(1500, 5);
    expect(parseSizeToGrams('500g')).toBeCloseTo(500, 5);
    expect(parseSizeToGrams('454 g')).toBeCloseTo(454, 5);
    expect(parseSizeToGrams('2 lb')).toBeCloseTo(907.18474, 3);
    expect(parseSizeToGrams('12 oz')).toBeCloseTo(340.1942775, 3);
    expect(parseSizeToGrams('750 ml')).toBeCloseTo(750, 5);
    expect(parseSizeToGrams('1 l')).toBeCloseTo(1000, 5);
  });

  it('parses multipacks', () => {
    expect(parseSizeToGrams('2 x 200 g')).toBeCloseTo(400, 5);
    expect(parseSizeToGrams('4x125g')).toBeCloseTo(500, 5);
  });

  it('returns null for unknown / missing sizes', () => {
    expect(parseSizeToGrams(undefined)).toBeNull();
    expect(parseSizeToGrams('each')).toBeNull();
    expect(parseSizeToGrams('1 dozen')).toBeNull();
    expect(parseSizeToGrams('')).toBeNull();
  });
});

describe('normalizePrice branches', () => {
  it('handles per-weight without size', () => {
    const r = normalizePrice('$3.49/lb');
    expect(r?.pricePerGram).toBeCloseTo(3.49 / 453.59237, 8);
    expect(r?.basis).toContain('per-weight');
  });

  it('handles $/100g and $/kg', () => {
    expect(normalizePrice('$0.99/100g')?.pricePerGram).toBeCloseTo(0.0099, 8);
    expect(normalizePrice('$12.99/kg')?.pricePerGram).toBeCloseTo(0.01299, 8);
  });

  it('handles multi-buy with size', () => {
    const r = normalizePrice('2/$5', '500 g');
    expect(r?.pricePerGram).toBeCloseTo(0.005, 8);
    expect(r?.basis).toContain('multi-buy');
  });

  it('handles plain/each/pack with size', () => {
    const r = normalizePrice('$8.99 family pack', '1.5 kg');
    expect(r?.pricePerGram).toBeCloseTo(8.99 / 1500, 8);
    expect(r?.basis).toContain('unit');
  });

  it('returns null when undeterminable', () => {
    expect(normalizePrice('')).toBeNull();
    expect(normalizePrice('$1.29 ea')).toBeNull(); // no size -> no grams
    expect(normalizePrice('2/$5')).toBeNull(); // multi-buy needs size
    expect(normalizePrice('BOGO free', 'each')).toBeNull();
  });
});
