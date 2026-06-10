/**
 * Domain contracts for PantryDeal. These mirror the PRD "Data contracts"
 * section, with two documented extensions (see docs/DECISIONS.md D2/D3):
 * `FlyerItem.size` and the richer `Match`/`StoreBasket` shapes.
 */

export type Category =
  | 'protein'
  | 'produce'
  | 'dairy'
  | 'pantry'
  | 'spice'
  | 'grain'
  | 'bakery'
  | 'other';

/** A single recipe ingredient with a normalized required quantity in grams. */
export interface Ingredient {
  name: string;
  qtyGrams: number;
  category: Category;
  substitutes: string[];
  /**
   * The ingredient as written in the source recipe, with the cut/form preserved
   * (e.g. "chicken thighs" when `name` was canonicalized to "chicken"). Display-
   * only: matching still uses `name`, but this lets the UI flag honestly when the
   * cheapest matched product is a different cut/form than the shopper asked for.
   */
  asWritten?: string;
}

/** A parsed recipe: a dish name plus its ingredient list. */
export interface Recipe {
  dish: string;
  servings: number;
  ingredients: Ingredient[];
}

/** A flyer deal as returned by a FlyerClient. `size` (D2) enables price-per-gram. */
export interface FlyerItem {
  name: string;
  rawPrice: string;
  /** e.g. "1.5 kg", "454 g", "500 ml". Optional; required for non-weight prices. */
  size?: string;
  merchant: string;
  storeIds: string[];
  validFrom: string;
  validTo: string;
  sku?: string;
}

/** A physical store branch. */
export interface Store {
  storeId: string;
  merchant: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** Populated by the store locator once an origin is known. */
  distanceKm?: number;
}

/** What a FlyerClient returns for a postal code. */
export interface FlyerData {
  stores: Store[];
  items: FlyerItem[];
}

export type MatchStatus = 'MATCHED' | 'UNMATCHED';

/**
 * The result of matching one ingredient against a store's flyer items.
 * A MATCHED result always carries a numeric pricePerGram and lineCost (D3);
 * an UNMATCHED ingredient is retained, never dropped.
 */
export interface Match {
  ingredient: Ingredient;
  item: FlyerItem | null;
  pricePerGram: number | null;
  status: MatchStatus;
  neededGrams: number;
  lineCost: number | null;
}

/** A per-store basket: every recipe ingredient appears exactly once in `matches`. */
export interface StoreBasket {
  store: Store;
  matches: Match[];
  matchedCount: number;
  totalIngredients: number;
  /** matchedCount / totalIngredients, 0..1 */
  coverage: number;
  /** Sum of matched line costs, in dollars. */
  total: number;
  /**
   * Estimated cost to buy the WHOLE recipe here: matched items at their sale
   * price plus an estimated regular price for ingredients not on sale here but
   * available on sale elsewhere. This is the ranking key (docs/DECISIONS.md D12),
   * so a store can't look cheapest merely by missing an expensive staple.
   */
  projectedTotal: number;
}

/** Final pipeline output. */
export interface PipelineResult {
  recipe: Recipe;
  rankedStores: StoreBasket[];
  cheapest: StoreBasket | null;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Pluggable geocoder. The fixture/static impl is tested; live ones are not. */
export interface Geocoder {
  geocodePostal(postal: string): Promise<LatLng>;
}

/** Pluggable flyer source. FixtureFlyerClient is tested; BackflippClient is not. */
export interface FlyerClient {
  getDeals(postal: string): Promise<FlyerData>;
}

/** Pluggable recipe parser. StaticRecipeParser is tested; Gemini-backed is not. */
export interface RecipeParser {
  /** Parse a free-text dinner into a recipe, optionally scaled to `servings`. */
  parse(dinner: string, servings?: number): Promise<Recipe>;
}

/**
 * The matching decision for the pipeline: does this flyer item satisfy this
 * ingredient? The default is deterministic lexical stem-subset matching; live
 * mode injects an LLM-backed strategy that fully decides (so it can both approve
 * semantically-valid items lexical matching would miss and reject lexical-but-
 * wrong ones). Precomputed async, queried synchronously per (ingredient, item).
 */
export interface CandidateMatcher {
  matches(ingredient: Ingredient, item: FlyerItem): boolean;
}

/** The normalized price-per-gram of a flyer item, with the reasoning that produced it. */
export interface NormalizedPrice {
  pricePerGram: number;
  effectivePrice: number;
  grams: number;
  basis: string;
}
