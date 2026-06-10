import { describe, it, expect } from 'vitest';
import { describeSubstitution } from '../src/core/substitution.js';

describe('describeSubstitution', () => {
  it('returns null when no original term was written', () => {
    expect(describeSubstitution(undefined, 'chicken', 'Fresh Chicken Leg')).toBeNull();
    expect(describeSubstitution('', 'chicken', 'Fresh Chicken Leg')).toBeNull();
  });

  it('returns null when the original is no more specific than the canonical name', () => {
    expect(describeSubstitution('chicken', 'chicken', 'Fresh Chicken Leg')).toBeNull();
    // plural / casing differences fold away via stemming
    expect(describeSubstitution('Chickens', 'chicken', 'Whole Chicken')).toBeNull();
  });

  it('flags a different cut: chicken thighs matched to drumsticks/legs', () => {
    const s = describeSubstitution('chicken thighs', 'chicken', 'Fresh Chicken Leg');
    expect(s).toEqual({ requestedAs: 'chicken thighs', matched: 'Fresh Chicken Leg', differentForm: true });
  });

  it('does NOT flag when the product honors the requested cut', () => {
    const s = describeSubstitution('chicken thighs', 'chicken', 'Boneless Skinless Chicken Thighs');
    expect(s).not.toBeNull();
    expect(s!.differentForm).toBe(false);
  });

  it('matches the requested cut despite extra qualifiers (bone-in)', () => {
    // specifier {bone, in, thigh}; product carries "thigh" -> honored
    const s = describeSubstitution('bone-in chicken thighs', 'chicken', 'Chicken Thighs Value Pack');
    expect(s!.differentForm).toBe(false);
  });

  it('ignores bare quantity tokens in the written term', () => {
    const s = describeSubstitution('2 chicken breasts', 'chicken', 'Chicken Breast 1 kg');
    expect(s!.differentForm).toBe(false); // "breast" is honored; "2" is dropped
  });

  it('flags a different form for non-meat items too (heavy vs whipping cream)', () => {
    const s = describeSubstitution('heavy cream', 'cream', 'Whipping Cream 35%');
    expect(s).toEqual({ requestedAs: 'heavy cream', matched: 'Whipping Cream 35%', differentForm: true });
  });
});
