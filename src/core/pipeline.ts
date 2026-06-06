/**
 * The PantryDeal pipeline: dinner + postal -> cheapest single store.
 * Orchestrates recipe parsing, flyer lookup, store geocoding, matching, and
 * ranking. All collaborators are injected interfaces, so the whole pipeline
 * runs offline against fixtures in tests (docs/DECISIONS.md D1).
 */
import type {
  CandidateMatcher,
  FlyerClient,
  FlyerItem,
  Geocoder,
  PipelineResult,
  RecipeParser,
  Store,
} from './types.js';
import { resolveNearbyStores } from './stores.js';
import { buildBasket, rankStores } from './rank.js';

export interface PipelineDeps {
  recipeParser: RecipeParser;
  flyerClient: FlyerClient;
  geocoder: Geocoder;
}

export interface PipelineOptions {
  postal: string;
  dinner: string;
  /** Number of people to cook for; scales recipe quantities (default: recipe's own). */
  servings?: number;
  radiusKm?: number;
  /** Optional matching strategy (defaults to lexical; live mode injects Gemini). */
  matcher?: CandidateMatcher;
}

const DEFAULT_RADIUS_KM = 25;

/** Items applicable to a given store (its storeId appears in the item's storeIds). */
function itemsForStore(store: Store, items: FlyerItem[]): FlyerItem[] {
  return items.filter((item) => item.storeIds.includes(store.storeId));
}

export async function runPipeline(
  deps: PipelineDeps,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { recipeParser, flyerClient, geocoder } = deps;
  const radiusKm = options.radiusKm ?? DEFAULT_RADIUS_KM;

  const recipe = await recipeParser.parse(options.dinner, options.servings);
  const flyerData = await flyerClient.getDeals(options.postal);
  const nearbyStores = await resolveNearbyStores(
    options.postal,
    flyerData.stores,
    geocoder,
    radiusKm,
  );

  const baskets = nearbyStores.map((store) =>
    buildBasket(
      store,
      recipe.ingredients,
      itemsForStore(store, flyerData.items),
      options.matcher,
    ),
  );

  const rankedStores = rankStores(baskets);

  return {
    recipe,
    rankedStores,
    cheapest: rankedStores[0] ?? null,
  };
}
