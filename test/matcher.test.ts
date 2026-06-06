import { describe, it, expect } from 'vitest';
import {
  tokenize,
  stem,
  itemMatchesIngredient,
  matchIngredient,
  matchBasket,
} from '../src/core/matcher.js';
import type { FlyerItem, Ingredient } from '../src/core/types.js';

function item(name: string, rawPrice: string, size?: string): FlyerItem {
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

function ing(name: string, qtyGrams: number, substitutes: string[] = []): Ingredient {
  return { name, qtyGrams, category: 'other', substitutes };
}

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops stopwords', () => {
    expect(tokenize('Boneless Skinless Chicken Breast')).toEqual(['chicken', 'breast']);
    expect(tokenize('Whipping Cream 35%')).toEqual(['whipping', 'cream', '35']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('stem', () => {
  it('folds simple plurals', () => {
    expect(stem('tomatoes')).toBe('tomato');
    expect(stem('onions')).toBe('onion');
    expect(stem('eggs')).toBe('egg');
    expect(stem('berries')).toBe('berry');
  });
  it('leaves non-plurals and short words alone', () => {
    expect(stem('rice')).toBe('rice');
    expect(stem('eggplant')).toBe('eggplant');
    expect(stem('is')).toBe('is');
  });
});

describe('itemMatchesIngredient', () => {
  it('matches by name stem-subset', () => {
    expect(itemMatchesIngredient(item('Roma Tomatoes', '$1/lb'), ing('tomato', 100))).toBe(true);
    expect(itemMatchesIngredient(item('Cooking Onions', '$2'), ing('onion', 100))).toBe(true);
  });
  it('matches multi-word ingredients', () => {
    expect(itemMatchesIngredient(item('Bell Peppers', '$1/lb'), ing('bell pepper', 100))).toBe(true);
    expect(
      itemMatchesIngredient(item('Extra Virgin Olive Oil', '$7', '1 l'), ing('olive oil', 30)),
    ).toBe(true);
  });
  it('matches via substitutes', () => {
    expect(
      itemMatchesIngredient(item('Curry Powder', '$3', '120 g'), ing('garam masala', 10, ['curry powder'])),
    ).toBe(true);
  });
  it('does not match unrelated items', () => {
    expect(itemMatchesIngredient(item('Cheddar Cheese', '$5', '450 g'), ing('chicken', 100))).toBe(false);
    expect(itemMatchesIngredient(item('Eggplant', '$2/lb'), ing('egg', 100))).toBe(false);
  });
});

describe('matchIngredient', () => {
  it('picks the cheapest eligible item by line cost', () => {
    const items = [
      item('Whipping Cream 35%', '$3.99', '473 ml'),
      item('Heavy Cream', '$4.49', '500 ml'),
    ];
    const m = matchIngredient(ing('cream', 200, ['whipping cream', 'heavy cream']), items);
    expect(m.status).toBe('MATCHED');
    expect(m.item?.name).toBe('Whipping Cream 35%');
    expect(typeof m.pricePerGram).toBe('number');
    expect(m.lineCost).toBeCloseTo((3.99 / 473) * 200, 6);
  });

  it('flags UNMATCHED when no item matches', () => {
    const m = matchIngredient(ing('saffron', 1), [item('Cheddar Cheese', '$5', '450 g')]);
    expect(m.status).toBe('UNMATCHED');
    expect(m.item).toBeNull();
    expect(m.pricePerGram).toBeNull();
    expect(m.lineCost).toBeNull();
    expect(m.neededGrams).toBe(1);
  });

  it('skips matching items whose price cannot be normalized (D3)', () => {
    // name matches but no size -> no numeric pricePerGram -> not eligible
    const m = matchIngredient(ing('garlic', 20), [item('Fresh Garlic', '$0.99 ea')]);
    expect(m.status).toBe('UNMATCHED');
  });
});

describe('matchIngredient with a custom CandidateMatcher', () => {
  const items = [item('Whipping Cream 35%', '$3.99', '473 ml'), item('Vanilla Ice Cream', '$2.99', '1 l')];

  it('lets the matcher fully decide (approve/reject independent of lexical)', () => {
    // Default (lexical): the cheaper "Ice Cream" wins for "cream".
    const lexical = matchIngredient(ing('cream', 200), items);
    expect(lexical.item?.name).toBe('Vanilla Ice Cream');

    // A matcher that only accepts whipping cream forces the correct match.
    const matcher = {
      matches: (_i: Ingredient, it: FlyerItem) => /whipping cream/i.test(it.name),
    };
    const filtered = matchIngredient(ing('cream', 200), items, matcher);
    expect(filtered.item?.name).toBe('Whipping Cream 35%');
  });

  it('can approve an item lexical matching would have missed', () => {
    // "chicken" does not lexically match "Fresh Drumsticks", but a smart matcher can.
    const poultry = [item('Fresh Drumsticks', '$2.99/lb')];
    expect(matchIngredient(ing('chicken', 500), poultry).status).toBe('UNMATCHED');
    const semantic = { matches: () => true };
    expect(matchIngredient(ing('chicken', 500), poultry, semantic).item?.name).toBe(
      'Fresh Drumsticks',
    );
  });

  it('flags UNMATCHED when the matcher rejects every candidate', () => {
    const rejectAll = { matches: () => false };
    const m = matchIngredient(ing('cream', 200), items, rejectAll);
    expect(m.status).toBe('UNMATCHED');
  });

  it('matchBasket threads the matcher to every ingredient', () => {
    const rejectAll = { matches: () => false };
    const matches = matchBasket([ing('cream', 200), ing('rice', 300)], items, rejectAll);
    expect(matches.every((m) => m.status === 'UNMATCHED')).toBe(true);
  });
});

describe('sameFoodMatcher (health-plan guard)', () => {
  it('rejects processed/snack forms of a whole food', async () => {
    const { sameFoodMatcher } = await import('../src/core/matcher.js');
    const m = sameFoodMatcher();
    expect(m.matches(ing('carrot', 100), item('Organic Rainbow Carrot Chips', '$2.99', '340 g'))).toBe(false);
    expect(m.matches(ing('carrot', 100), item('Carrots', '$1.99', '2 lb'))).toBe(true);
  });

  it('rejects a meat product for a non-meat ingredient', async () => {
    const { sameFoodMatcher } = await import('../src/core/matcher.js');
    // base matcher forced true (as a lenient/LLM base would), guard must still reject
    const lenient = { matches: () => true };
    const m = sameFoodMatcher(lenient);
    expect(m.matches(ing('tofu', 700), item('Chicken Thighs Value Pack', '$2.99/lb'))).toBe(false);
    expect(m.matches(ing('chicken', 700), item('Chicken Thighs Value Pack', '$2.99/lb'))).toBe(true);
    expect(m.matches(ing('tofu', 700), item('Firm Tofu', '$3.49', '350 g'))).toBe(true);
  });
});

describe('matchBasket', () => {
  it('returns exactly one match per ingredient and never drops any', () => {
    const ingredients = [ing('chicken', 600), ing('saffron', 1), ing('rice', 300)];
    const items = [item('Chicken Breast', '$5.99/lb'), item('Basmati Rice', '$9.99', '4 kg')];
    const matches = matchBasket(ingredients, items);
    expect(matches).toHaveLength(ingredients.length);
    expect(matches.map((m) => m.ingredient.name)).toEqual(['chicken', 'saffron', 'rice']);
    expect(matches.filter((m) => m.status === 'UNMATCHED').map((m) => m.ingredient.name)).toEqual([
      'saffron',
    ]);
  });
});
