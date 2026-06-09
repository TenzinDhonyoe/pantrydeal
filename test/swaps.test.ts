import { describe, it, expect } from 'vitest';
import { lowerCarbSwaps } from '../src/core/swaps.js';

describe('lowerCarbSwaps', () => {
  it('returns no swaps for a recipe with no high-carb staples', () => {
    expect(lowerCarbSwaps([{ name: 'chicken' }, { name: 'broccoli' }])).toEqual([]);
  });

  it('suggests a swap for a matched staple', () => {
    const out = lowerCarbSwaps([{ name: 'pasta' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.ingredient).toBe('pasta');
    expect(out[0]!.suggestion).toMatch(/half/i);
  });

  it('prefers the longer, more specific key ("white rice" over "rice")', () => {
    const out = lowerCarbSwaps([{ name: 'white rice' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.suggestion).toBe(
      'try brown rice or cauliflower rice — more fiber, slower sugar release',
    );
  });

  it('matches as a substring (e.g. "jasmine rice" -> rice advice)', () => {
    const out = lowerCarbSwaps([{ name: 'jasmine rice' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.suggestion).toMatch(/rice/i);
  });

  it('shows each distinct suggestion only once', () => {
    // two ingredients map to the same "rice" advice -> deduped to one row
    const out = lowerCarbSwaps([{ name: 'jasmine rice' }, { name: 'basmati rice' }]);
    expect(out).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    expect(lowerCarbSwaps([{ name: 'White Bread' }])).toHaveLength(1);
  });
});
