/**
 * Lower-carb swap suggestions for the prediabetes Recipe view (CEO plan
 * 2026-06-09, accepted scope). A curated, deterministic map from a common
 * high-carb staple to a gentler alternative. This is deliberately NOT an LLM call
 * (cheap, testable, predictable) and NOT the `Ingredient.substitutes` field —
 * substitutes are same-food aliases (cilantro=coriander), explicitly not cooking
 * swaps. Keys are canonical lowercase names matched as a substring against the
 * recipe's ingredient names; longer keys win ("white rice" beats "rice").
 *
 * DRAFT advice for an ICP managing prediabetes — gentle, not prescriptive, and
 * not medical guidance (same posture as the rest of the nutrition layer, D15).
 */

export interface CarbSwap {
  /** The recipe ingredient this applies to (as it appeared in the recipe). */
  ingredient: string;
  /** Plain-language suggestion shown to the user. */
  suggestion: string;
}

/** Canonical high-carb staple -> gentler-on-blood-sugar suggestion. */
export const LOWER_CARB_SWAPS: Record<string, string> = {
  'white rice': 'try brown rice or cauliflower rice — more fiber, slower sugar release',
  rice: 'brown or cauliflower rice spikes blood sugar less than white rice',
  pasta: 'use half the pasta with extra greens, or a lentil/chickpea pasta',
  spaghetti: 'half the portion plus extra veg, or try a legume-based pasta',
  noodles: 'edamame or shirataki noodles cut the carbs a lot',
  'white bread': 'whole-grain or sourdough releases sugar more slowly',
  bread: 'whole-grain or sourdough is gentler than white bread',
  bagel: 'a thin whole-grain bagel or half a bagel eases the spike',
  tortilla: 'a whole-wheat or low-carb tortilla lowers the carb hit',
  potato: 'sweet potato or cauliflower lowers the glycemic hit',
  potatoes: 'sweet potato or a cauliflower mash lowers the glycemic hit',
  flour: 'swap part of it for almond or whole-wheat flour for more fiber',
  couscous: 'quinoa or bulgur has more fiber and a gentler spike',
  sugar: 'use less, or a non-nutritive sweetener',
  honey: 'use less, or a non-nutritive sweetener',
};

// Longest key first so "white rice" matches before the generic "rice".
const KEYS_BY_LENGTH = Object.keys(LOWER_CARB_SWAPS).sort((a, b) => b.length - a.length);

/**
 * Suggest lower-carb swaps for any recipe ingredient that matches the curated
 * map. At most one suggestion per ingredient, and each distinct suggestion is
 * shown once even if several ingredients map to it.
 */
export function lowerCarbSwaps(
  ingredients: ReadonlyArray<{ name: string }>,
  table: Record<string, string> = LOWER_CARB_SWAPS,
  keysByLength: string[] = KEYS_BY_LENGTH,
): CarbSwap[] {
  const keys = table === LOWER_CARB_SWAPS ? keysByLength : Object.keys(table).sort((a, b) => b.length - a.length);
  const out: CarbSwap[] = [];
  const seen = new Set<string>();
  for (const ing of ingredients) {
    const n = ing.name.toLowerCase();
    const key = keys.find((k) => n.includes(k));
    if (!key) continue;
    const suggestion = table[key]!;
    if (seen.has(suggestion)) continue;
    seen.add(suggestion);
    out.push({ ingredient: ing.name, suggestion });
  }
  return out;
}
