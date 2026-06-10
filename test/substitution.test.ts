import { describe, it, expect } from 'vitest';
import { describeSubstitution } from '../src/core/substitution.js';

const verdict = (written: string | undefined, canonical: string, product: string) =>
  describeSubstitution(written, canonical, product)?.verdict ?? null;

describe('describeSubstitution (layered)', () => {
  it('returns null when no original term was written', () => {
    expect(describeSubstitution(undefined, 'chicken', 'Fresh Chicken Leg')).toBeNull();
    expect(describeSubstitution('', 'chicken', 'Fresh Chicken Leg')).toBeNull();
  });

  it('returns null when the original is no more specific than the canonical name', () => {
    expect(describeSubstitution('chicken', 'chicken', 'Fresh Chicken Leg')).toBeNull();
    // plural / casing differences fold away via stemming
    expect(describeSubstitution('Chickens', 'chicken', 'Whole Chicken')).toBeNull();
  });

  // --- layer 2: specifier honored (free) ---

  it("'same' when the product honors the requested cut", () => {
    expect(verdict('chicken thighs', 'chicken', 'Boneless Skinless Chicken Thighs')).toBe('same');
  });

  it("'same' despite extra qualifiers (bone-in) when the cut is honored", () => {
    expect(verdict('bone-in chicken thighs', 'chicken', 'Chicken Thighs Value Pack')).toBe('same');
  });

  it('ignores bare quantity tokens in the written term', () => {
    expect(verdict('2 chicken breasts', 'chicken', 'Chicken Breast 1 kg')).toBe('same');
  });

  // --- synonym folding: true equivalents are NOT substitutions ---

  it("'same' for true aliases: heavy cream vs whipping cream", () => {
    expect(verdict('heavy cream', 'cream', 'Whipping Cream 35%')).toBe('same');
  });

  it("'same' for green onion vs scallion", () => {
    expect(verdict('green onions', 'onion', 'Scallions Bunch')).toBe('same');
  });

  it("'same' for ground beef vs lean/minced wording", () => {
    expect(verdict('ground beef', 'beef', 'Lean Minced Beef')).toBe('same');
  });

  // --- layer 3: conflicting member of a known form group (free, deterministic) ---

  it("'different' for a conflicting poultry cut: thighs vs leg", () => {
    const s = describeSubstitution('chicken thighs', 'chicken', 'Fresh Chicken Leg');
    expect(s).toEqual({ requestedAs: 'chicken thighs', matched: 'Fresh Chicken Leg', verdict: 'different' });
  });

  it("'different' for thighs vs drumsticks", () => {
    expect(verdict('chicken thighs', 'chicken', 'Chicken Drumsticks Family Pack')).toBe('different');
  });

  it("'different' for a conflicting preservation state: fresh vs frozen", () => {
    expect(verdict('fresh basil', 'basil', 'Frozen Basil Cubes')).toBe('different');
  });

  it("'different' for brown rice matched to white rice", () => {
    expect(verdict('brown rice', 'rice', 'White Rice 2 kg')).toBe('different');
  });

  // --- layer 4: lexically unresolvable -> ambiguous (the LLM judge decides) ---

  it("'ambiguous' when the specifier is absent and no group conflicts", () => {
    expect(verdict('extra-virgin olive oil', 'olive oil', 'OLIVE OIL, 1 L')).toBe('ambiguous');
    expect(verdict('chicken thighs', 'chicken', 'Chicken Quarters')).toBe('ambiguous');
  });
});
