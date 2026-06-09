/**
 * Shared entry point used by both the CLI and the web server: build the right
 * dependencies (offline fixtures or fully-live Gemini + Backflipp + Zippopotam)
 * and run the pipeline. Keeps API keys server-side and the wiring in one place.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FixtureFlyerClient,
  StaticGeocoder,
  StaticRecipeParser,
  NoRecipeError,
  LruCache,
  cacheKey,
  runPipeline,
  resolveNearbyStores,
  scaleRecipe,
  validateRecipe,
  priceRecipe,
  selectWeek,
  poolIngredients,
  sameFoodMatcher,
  PREDIABETES_RECIPES,
  type CandidateMatcher,
  type FlyerItem,
  type PipelineDeps,
  type PipelineResult,
  type Recipe,
  type RecipeParser,
  type ShoppingPlan,
  type Store,
  type WeekPlan,
} from './core/index.js';

export interface SearchRequest {
  postal: string;
  dinner: string;
  /** Number of people to cook for; scales quantities. */
  people?: number;
  /** Use live sources (Gemini + Backflipp + Zippopotam) instead of fixtures. */
  live?: boolean;
  radiusKm?: number;
  /** Override the flyer fixture path (offline mode only). */
  fixturePath?: string;
  /**
   * A pre-parsed recipe to price directly, skipping recipe parsing (live mode
   * only). Used by the Recipe-from-URL view, which parses the recipe itself.
   */
  recipe?: Recipe;
}

/** The default offline flyer fixtures shipped with the repo. */
export function defaultFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/runner.js (or src/runner.ts) -> repo root -> test/fixtures/flyers
  return join(here, '..', 'test', 'fixtures', 'flyers');
}

/** True when a Gemini key is configured, i.e. live mode is usable. */
export function liveAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
}

/** Process-lifetime recipe cache (option D), keyed by (dinner, people, model). */
const recipeCache = new LruCache<Recipe>(1000);

/**
 * Parse a dinner for live mode (docs/ARCHITECTURE.md §5 C + D): serve from the
 * recipe cache first; on a miss try the offline recipe book (free) and only call
 * Gemini when the dish is not in the book. Cache the result either way so repeat
 * dinners cost nothing.
 */
async function parseRecipeLive(dinner: string, servings: number | undefined): Promise<Recipe> {
  const model = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash';
  const key = cacheKey('recipe', dinner, servings ?? 0, model);
  const cached = recipeCache.get(key);
  if (cached) return cached;

  let recipe: Recipe;
  try {
    recipe = await new StaticRecipeParser().parse(dinner, servings); // C: book first, zero tokens
  } catch (err) {
    if (!(err instanceof NoRecipeError)) throw err;
    const { GeminiRecipeParser } = await import('./integrations/geminiRecipe.js');
    recipe = await new GeminiRecipeParser().parse(dinner, servings);
  }
  recipeCache.set(key, recipe);
  return recipe;
}

interface ResolvedDeps {
  deps: PipelineDeps;
  matcher?: CandidateMatcher;
}

function buildFixtureDeps(fixturePath: string | undefined): ResolvedDeps {
  const deps: PipelineDeps = {
    recipeParser: new StaticRecipeParser(),
    flyerClient: new FixtureFlyerClient(fixturePath ?? defaultFixturePath()),
    geocoder: new StaticGeocoder(),
  };
  return { deps };
}

/**
 * Live mode: parse the recipe with Gemini first, seed the Backflipp flyer search
 * with the recipe's ingredient names, fetch the real deals once, then let
 * GeminiAnalyzer do semantic matching + price/size extraction. The tested core
 * prices and ranks. One keyless ZippopotamGeocoder is shared so flyer stores and
 * the pipeline agree on the postal location.
 */
async function buildLiveDeps(
  dinner: string,
  postal: string,
  servings: number | undefined,
  prebuilt?: Recipe,
): Promise<ResolvedDeps> {
  const [
    { ZippopotamGeocoder },
    { BackflippClient },
    { GeminiAnalyzer },
  ] = await Promise.all([
    import('./integrations/zippopotam.js'),
    import('./integrations/backflipp.js'),
    import('./integrations/geminiAnalyzer.js'),
  ]);

  const geocoder = new ZippopotamGeocoder();
  // A caller (the Recipe-from-URL view) may hand us an already-parsed recipe;
  // otherwise parse it (C + D: book/cache first, Gemini on miss).
  const recipe = prebuilt ?? (await parseRecipeLive(dinner, servings));
  const recipeParser: RecipeParser = { parse: () => Promise.resolve(recipe) };

  const terms = [...new Set(recipe.ingredients.flatMap((i) => [i.name, ...i.substitutes]))];
  const liveData = await new BackflippClient({ geocoder, terms }).getDeals(postal);

  const { items, matcher } = await new GeminiAnalyzer().prepare(recipe, liveData.items);

  const deps: PipelineDeps = {
    recipeParser,
    flyerClient: new FixtureFlyerClient({ stores: liveData.stores, items }),
    geocoder,
  };
  return { deps, matcher };
}

/** Run a full PantryDeal search, choosing live or fixture dependencies. */
export async function search(req: SearchRequest): Promise<PipelineResult> {
  const { deps, matcher } = req.live
    ? await buildLiveDeps(req.dinner, req.postal, req.people, req.recipe)
    : buildFixtureDeps(req.fixturePath);

  return runPipeline(deps, {
    postal: req.postal,
    dinner: req.dinner,
    servings: req.people,
    radiusKm: req.radiusKm,
    matcher,
  });
}

export interface RecipeSourceRequest {
  postal: string;
  url?: string;
  text?: string;
  people?: number;
  radiusKm?: number;
}

export interface RecipeSourceResult {
  result: PipelineResult;
  /** Which parse path produced the recipe (json-ld | gemini-text | paste). */
  source: 'json-ld' | 'gemini-text' | 'paste';
}

/**
 * Recipe-from-URL view (CEO plan 2026-06-09): parse a recipe from a URL or pasted
 * text, then price it through the same live pipeline as everything else. Always
 * live — it needs Gemini to extract the recipe and Backflipp for real deals.
 */
export async function priceRecipeFromSource(req: RecipeSourceRequest): Promise<RecipeSourceResult> {
  const { RecipeUrlParser } = await import('./integrations/recipeUrl.js');
  const { recipe, source } = await new RecipeUrlParser().parse({
    url: req.url,
    text: req.text,
    servings: req.people,
  });
  // Inject the parsed recipe straight into the live pipeline (skips re-parsing).
  const result = await search({
    postal: req.postal,
    dinner: recipe.dish,
    people: req.people,
    live: true,
    radiusKm: req.radiusKm,
    recipe,
  });
  return { result, source };
}

// ---------------------------------------------------------------------------
// Prediabetes affordable weekly planner (docs/designs/prediabetes-affordability-planner.md)
// ---------------------------------------------------------------------------

const DEFAULT_RADIUS_KM = 25;

// Diet exclusion sets for recipeAllowed (B3). Matched case-insensitively as whole
// tokens against ingredient names (see `hasTerm`), so "egg" excludes "egg" but NOT
// "eggplant" (eggplant is vegan), and "fish" doesn't fire on unrelated substrings.
//
// MEAT_FISH: animal flesh — excluded for BOTH vegetarian and vegan. Covers the
// common terms plus everything that appears in src/core/recipeLibrary.ts and
// recipeBook.ts (chicken, turkey, beef, salmon, shrimp live there today).
const MEAT_FISH = [
  'chicken',
  'turkey',
  'beef',
  'pork',
  'lamb',
  'ham',
  'bacon',
  'salmon',
  'fish',
  'shrimp',
  'tuna',
  'cod',
  'sausage',
  'prosciutto',
];

// ANIMAL_PRODUCE: dairy, eggs and other animal by-products — excluded for vegan
// ONLY (vegetarians keep these). NOTE: a bare "milk" token would also exclude
// plant milks like "coconut milk" / "almond milk"; the recipe library currently
// has no such plant-milk ingredient, so whole-word "milk" is safe here. If a
// plant milk is ever added, give it a distinct name or special-case it.
const ANIMAL_PRODUCE = [
  'milk',
  'cream',
  'butter',
  'cheese',
  'parmesan',
  'yogurt',
  'egg',
  'honey',
  'ghee',
  'whey',
];

/**
 * Whole-word (token) containment: true when `term` appears in `text` as a word,
 * not merely as a substring. Guards false positives like "egg" → "eggplant" or
 * "ham" → "graham". Words are delimited by anything that is not a lowercase
 * letter, so multi-word ingredient names ("cottage cheese") still match on
 * "cheese". Both inputs are lowercased by the caller.
 */
function hasTerm(text: string, term: string): boolean {
  return new RegExp(`(^|[^a-z])${term}([^a-z]|$)`).test(text);
}

export interface WeekRequest {
  postal: string;
  people?: number;
  budget: number;
  days?: number;
  live?: boolean;
  /** Allergies / "vegetarian" / "vegan" — hard filters that price can never override. */
  restrictions?: string[];
  /** Dish names to leave out (e.g. after a "swap this dinner"), re-plans the rest. */
  exclude?: string[];
  radiusKm?: number;
}

export interface MealPricing {
  recipe: Recipe;
  plan: ShoppingPlan;
}

export interface WeekResult {
  week: WeekPlan;
  /** ONE pooled shopping plan for the whole week (shared staples bought once). */
  cart: ShoppingPlan;
  meals: MealPricing[];
}

/**
 * A recipe is allowed only if it violates none of the patient's restrictions.
 *
 * Diet handling (B3): "vegetarian" excludes only meat/fish; "vegan" additionally
 * excludes dairy, eggs, honey and other animal by-products. Both use whole-word
 * matching (see `hasTerm`) so "egg" never excludes "eggplant". Any other
 * restriction string falls back to the original substring behaviour (e.g. an
 * allergy like "peanut" excludes any ingredient whose name contains it).
 *
 * Exported so it can be unit-tested directly; it is a pure function.
 */
export function recipeAllowed(recipe: Recipe, restrictions: string[]): boolean {
  return restrictions.every((raw) => {
    const r = raw.trim().toLowerCase();
    if (!r) return true;
    if (r === 'vegetarian' || r === 'vegan') {
      const banned = r === 'vegan' ? [...MEAT_FISH, ...ANIMAL_PRODUCE] : MEAT_FISH;
      return !recipe.ingredients.some((i) => {
        const name = i.name.toLowerCase();
        return banned.some((term) => hasTerm(name, term));
      });
    }
    return !recipe.ingredients.some((i) => i.name.toLowerCase().includes(r));
  });
}

interface FlyerCtx {
  stores: Store[];
  items: FlyerItem[];
  matcher?: CandidateMatcher;
}

/** Offline planner context: fixture stores + items, lexical matching (no LLM). */
async function resolveFixtureContext(postal: string, radiusKm: number): Promise<FlyerCtx> {
  const geocoder = new StaticGeocoder();
  const data = await new FixtureFlyerClient(defaultFixturePath()).getDeals(postal);
  const stores = await resolveNearbyStores(postal, data.stores, geocoder, radiusKm);
  return { stores, items: data.items };
}

/**
 * Live planner context with LAZY pricing (docs/ARCHITECTURE.md §5 option G). The old
 * path ran Gemini analysis over the union of EVERY candidate dish's terms before
 * selection ever happened — paying for dishes that could never be picked. Instead:
 *
 *   1. one keyless Backflipp pull (free) for all terms;
 *   2. a FREE lexical pricing pass to rank candidate dishes by rough cost;
 *   3. Gemini analysis ONLY on the shortlist's terms (the dishes a budget week could
 *      plausibly choose), not the whole candidate set.
 *
 * The shortlist is generous (≈ days×3) so the cheap pass rarely hides a true winner;
 * dishes outside it are still priced, just without enriched flyer data, so selection
 * naturally prefers the analyzed shortlist.
 */
async function resolveLivePlannerContext(
  postal: string,
  candidates: Recipe[],
  days: number,
  radiusKm: number,
): Promise<FlyerCtx> {
  const allTerms = [...new Set(candidates.flatMap((r) => r.ingredients.map((i) => i.name)))];
  const [{ ZippopotamGeocoder }, { BackflippClient }, { GeminiAnalyzer }] = await Promise.all([
    import('./integrations/zippopotam.js'),
    import('./integrations/backflipp.js'),
    import('./integrations/geminiAnalyzer.js'),
  ]);
  const geocoder = new ZippopotamGeocoder();
  const data = await new BackflippClient({ geocoder, terms: allTerms }).getDeals(postal);
  const stores = await resolveNearbyStores(postal, data.stores, geocoder, radiusKm);

  // Pass 1 (free): cheap lexical pricing to shortlist the dishes worth LLM analysis.
  const cheap = sameFoodMatcher(undefined);
  const shortlistSize = Math.min(candidates.length, Math.max(days * 3, days + 4));
  const shortlist = candidates
    .map((recipe) => ({ recipe, cost: priceRecipe(recipe.ingredients, stores, data.items, cheap).fullTotal }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, shortlistSize)
    .map((x) => x.recipe);

  // Pass 2 (Gemini): analyze only the shortlist's terms.
  const terms = [...new Set(shortlist.flatMap((r) => r.ingredients.map((i) => i.name)))];
  const pantry: Recipe = {
    dish: 'pantry',
    servings: 1,
    ingredients: terms.map((name) => ({ name, qtyGrams: 1, category: 'other', substitutes: [] })),
  };
  const { items, matcher } = await new GeminiAnalyzer().prepare(pantry, data.items);
  return { stores, items, matcher };
}

/**
 * Build an affordable, prediabetes-compliant week within a budget. Every recipe is
 * re-validated by the hard nutrition gate, filtered by the patient's restrictions,
 * scaled to the household, and priced through the real deal engine. Nutrition is
 * never relaxed to hit the budget; an over-budget week is surfaced honestly.
 */
export async function planPrediabetesWeek(req: WeekRequest): Promise<WeekResult> {
  const people = req.people ?? 4;
  const days = req.days ?? 5;
  const radiusKm = req.radiusKm ?? DEFAULT_RADIUS_KM;
  const restrictions = req.restrictions ?? [];
  const excluded = new Set((req.exclude ?? []).map((d) => d.toLowerCase()));

  // 1. Compliant, allowed, not-excluded, scaled candidates. Strip cooking substitutes —
  //    they are swaps for the pot, not the grocery shelf, and leaked meat into veg meals (D17).
  const candidates = PREDIABETES_RECIPES
    .filter((r) => validateRecipe(r).ok)
    .filter((r) => recipeAllowed(r, restrictions))
    .filter((r) => !excluded.has(r.dish.toLowerCase()))
    .map((r) => scaleRecipe(r, people))
    .map((r) => ({ ...r, ingredients: r.ingredients.map((i) => ({ ...i, substitutes: [] })) }));

  // 2. Flyer context + same-food guard. Live mode (option G) pre-ranks cheaply and
  //    runs Gemini only on the shortlist; offline uses fixtures with lexical matching.
  const ctx = req.live
    ? await resolveLivePlannerContext(req.postal, candidates, days, radiusKm)
    : await resolveFixtureContext(req.postal, radiusKm);
  const matcher = sameFoodMatcher(ctx.matcher);

  // 3. Price each candidate alone (only to rank which meals to pick).
  const meals: MealPricing[] = candidates.map((recipe) => ({
    recipe,
    plan: priceRecipe(recipe.ingredients, ctx.stores, ctx.items, matcher),
  }));

  // 4. Pick the cheapest compliant week.
  const picked = selectWeek(
    meals.map((m) => ({ recipe: m.recipe, realCost: m.plan.fullTotal })),
    { budget: req.budget, days },
  );

  // 5. Pool the chosen meals into ONE weekly cart and price it once — shared staples
  //    are bought a single time, so the total is what you'd actually pay.
  const chosenMeals = picked.meals.map((p) => meals.find((m) => m.recipe.dish === p.recipe.dish)!);
  const cart = priceRecipe(poolIngredients(chosenMeals.map((m) => m.recipe)), ctx.stores, ctx.items, matcher);

  const week: WeekPlan = {
    ...picked,
    total: cart.fullTotal,
    withinBudget: cart.fullTotal <= req.budget,
    overBy: Math.max(0, cart.fullTotal - req.budget),
  };

  return { week, cart, meals: chosenMeals };
}
