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

/**
 * Ingredients whose name CONTAINS a swap key as a word but should never trigger
 * it: a sweet potato is already the recommended swap (not a white potato), and
 * sugar-snap / snap peas are a green vegetable, not the sweetener "sugar".
 * Substring matching alone produced false advice like "swap your sweet potato for
 * a sweet potato" or "use less sugar" on sugar snap peas.
 */
const NEVER_SWAP = [/\bsweet potato/, /\bsugar snap/, /\bsnap pea/];

/** Match a key only as a whole word, so "bread" misses "shortbread"/"gingerbread". */
function matchesKey(name: string, key: string): boolean {
  return new RegExp(`(^|[^a-z])${key}([^a-z]|$)`, 'i').test(name);
}

/**
 * Suggest lower-carb swaps for any recipe ingredient that matches the curated
 * map. Word-boundary matching (not substring) avoids false hits like
 * "flourless"→flour. At most one suggestion per ingredient, longest key wins
 * ("white rice" over "rice"), and each distinct suggestion is shown once.
 */
export function lowerCarbSwaps(
  ingredients: ReadonlyArray<{ name: string }>,
  table: Record<string, string> = LOWER_CARB_SWAPS,
): CarbSwap[] {
  // Longest key first so "white rice" matches before the generic "rice".
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const out: CarbSwap[] = [];
  const seen = new Set<string>();
  for (const ing of ingredients) {
    const n = ing.name.toLowerCase();
    if (NEVER_SWAP.some((re) => re.test(n))) continue;
    const key = keys.find((k) => matchesKey(n, k));
    if (!key) continue;
    const suggestion = table[key]!;
    if (seen.has(suggestion)) continue;
    seen.add(suggestion);
    out.push({ ingredient: ing.name, suggestion });
  }
  return out;
}
