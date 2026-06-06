# PantryDeal

Given a **postal code** and a **free-text dinner request**, PantryDeal returns the
single nearby store where you can buy that recipe's ingredients **cheapest** using
current grocery flyer deals.

```
$ npx pantrydeal --postal M8Y --dinner "butter chicken"

Recipe: butter chicken (serves 4)
Ingredients: chicken, butter, onion, garlic, ginger, tomato, cream, garam masala, rice

Cheapest store: Metro Etobicoke (Metro)  0.7 km
Address: 1530 The Queensway, Etobicoke

Ingredient                 Matched item                       Line cost
------------------------------------------------------------------------------
  chicken (600g)             Boneless Skinless Chicken Breast        $7.92   ($1.32/100g, $5.99/lb)
  butter (60g)               Salted Butter                           $0.66   ($1.10/100g, $4.99)
  ...
------------------------------------------------------------------------------
Basket total (matched): $12.52   coverage 9/9
```

## Setup

Requires Node.js ≥ 20.

```bash
npm install
npm run build      # compile TypeScript to dist/
npm test           # run the Vitest suite (offline, fixtures only)
npm run lint       # ESLint
npm run coverage   # tests + coverage report (src/core is held to ≥90%)
```

Run the CLI without building, in dev:

```bash
npm run cli -- --postal M8Y --dinner "butter chicken"
```

### Web UI

```bash
npm run build
node --env-file=.env dist/server.js      # or: npm run serve  (dev, tsx)
# open http://localhost:3000
```

A single-page app: enter a postal code, a dinner, and the number of people, then
toggle **Sample data** (instant, offline fixtures) or **Live flyers** (real Flipp
deals + Gemini, ~30s). It shows the recipe, the cheapest store with its
ingredient→deal table, and the other nearby stores ranked by projected cost.
`GEMINI_API_KEY` is read from the server environment and never sent to the
browser; if it's unset, the Live toggle is disabled and Sample data still works.
`PORT` (default 3000) sets the listen port. The server reuses the exact same
pipeline as the CLI via `src/runner.ts`.

### CLI options

| Flag | Description |
| --- | --- |
| `--postal <code>` | Postal/ZIP code to search near (e.g. `M8Y`). **Required.** |
| `--dinner "<text>"` | Free-text dinner request (e.g. `"butter chicken"`). **Required.** |
| `--people <n>` | Number of people to cook for; scales all quantities (alias `--servings`). |
| `--live` | Use live data sources instead of fixtures (see below). |
| `--radius <km>` | Search radius in kilometres (default `25`). |
| `--fixture <path>` | Flyer fixture file or directory for offline mode. |
| `-h, --help` | Show help. |

## How it works (pipeline)

```
dinner string ─▶ recipe parser ─▶ Ingredient[]
postal code  ─▶ flyer client   ─▶ FlyerData (stores + items)
             ─▶ geocoder       ─▶ nearby stores (haversine + radius)
                                 ─▶ matcher    (ingredient → flyer item | UNMATCHED)
                                 ─▶ normalizer (raw price → price-per-gram)
                                 ─▶ ranker     (coverage, then basket total)
                                 ─▶ cheapest store
```

Every stage in `src/core` is pure and deterministic, and all collaborators
(`FlyerClient`, `Geocoder`, `RecipeParser`) are injected interfaces, so the whole
pipeline runs offline against fixtures in tests.

## Live vs. fixture toggle

By **default the CLI runs fully offline** against local JSON fixtures
(`FixtureFlyerClient` + `StaticGeocoder` + a fixed recipe book). This is what the
test suite and the example above use — no network, no API keys.

Pass `--live` (or set `PANTRYDEAL_LIVE=1`) to go **fully online**:

| Concern | Fixture (default) | Live (`--live`) |
| --- | --- | --- |
| Flyers | `FixtureFlyerClient` (local JSON) | `BackflippClient` (Flipp, unofficial, **keyless**) |
| Geocoding | `StaticGeocoder` (built-in table) | `ZippopotamGeocoder` (OSM, **keyless**) |
| Recipe parsing | `StaticRecipeParser` (recipe book) | `GeminiRecipeParser` (Google Gemini) |

Live mode needs **only a Gemini API key** — the flyer and geocoding sources are keyless.
The live flow is:

1. The dinner is parsed into general grocery ingredients (e.g. `chicken`, `cream`) —
   from the **offline recipe book first** (free), falling back to **Gemini** only for
   dishes the book doesn't cover. Parsed recipes are cached by `(dinner, people, model)`.
2. **Backflipp** fetches real flyer deals near the postal, seeded with those ingredient names.
3. **Gemini** analyzes the messy flyer items in a **single batched call** over one
   deduplicated candidate set (each flyer item sent once, tagged with the ingredients
   it could be). It keeps only items that are genuinely the *same food* — strict
   matching, so "ice cream" ≠ cream, "vinegar" ≠ lemon — and reads a clean unit price
   + grams out of OCR-mangled text (`"1 56 ML"` → 156 g). If that one call fails or
   covers too few ingredients, it falls back to the older per-ingredient calls. The
   candidate/dedup/coverage logic is the tested core (`src/core/analyzerPrep.ts`).
4. The tested core prices every match per gram and ranks stores by **projected
   whole-recipe cost** (sale prices + estimated regular price for items not on sale here),
   so the "cheapest store" can't win just by lacking an expensive staple.

```bash
export GEMINI_API_KEY=...      # from https://aistudio.google.com/apikey
# optional: export GEMINI_MODEL=gemini-3.5-flash
npx pantrydeal --live --postal "M8Y 3N5" --dinner "beef lasagna" --people 6
```

Give it any dinner and any headcount: Gemini writes the recipe, scales every
quantity to the number of people, and the deal search prices that exact amount.

`ClaudeRecipeParser` (`ANTHROPIC_API_KEY`) and `GooglePlacesGeocoder`
(`GOOGLE_PLACES_KEY`) also ship in `src/integrations/` as drop-in alternatives, but the
default `--live` path above does not use them.

### ⚠️ Unofficial-endpoint fragility warning

`--live` flyer data comes from Flipp's **`backflipp.wishabi.com`** endpoint, which is
**undocumented, unofficial, and unstable**. It can change response shape, rate-limit,
or disappear **without notice**, which would break live mode. It is deliberately
isolated behind the `FlyerClient` interface and is **never exercised by the test
suite** — correctness is defined by fixtures, not live data. Use live mode at your own
risk and do not depend on it in automation.

## Known limitations

- **Coverage gaps.** The offline recipe book is a fixed set of ~12 dishes; an unknown
  dinner throws `NoRecipeError` (live mode would generalize via Claude). The fixture
  flyers cover a handful of Toronto-area stores, not real inventory.
- **Two matching paths.** The tested **offline** core uses deterministic stem-subset
  matching (a shared word is enough, so it can mismatch on noisy names). **Live** mode
  uses the `GeminiAnalyzer` for strict same-food matching + price extraction, which is far
  more accurate but unverifiable (no ground truth) and non-deterministic run-to-run.
  Either way, unmatched ingredients are **always surfaced explicitly, never dropped**.
- **Live coverage depends on what's actually on sale.** Most flyer items per store are
  not your recipe's ingredients, and an item is only counted when it can be priced per
  gram. So a store often has only a few of the recipe's items on sale; the rest are
  estimated at regular price in the projected total. The cheapest store is the one with
  the lowest projected whole-recipe cost, not necessarily the highest coverage.
- **Coupons vs. flyer deals.** "Cheapest store" is computed from flyer *sale prices*.
  Flipp's separate manufacturer **coupons** are not yet applied — a future addition.
- **Unit normalization is approximate.** Liquid volumes are treated as `1 ml = 1 g`,
  and "each"/pack prices require a parseable `size`; items that can't be priced to a
  numeric price-per-gram are excluded from matching (so they never inflate a basket).
- **Single-store only.** v0 finds the cheapest *single* store. No multi-store basket
  splitting, no UI, no auth, no persistence.

## Project layout

```
src/core/          pure, deterministic, fully tested
  types.ts         domain contracts + interfaces
  cache.ts         LruCache + cacheKey + isFresh (live-mode caching, option D)
  analyzerPrep.ts  candidate dedup/scoring + coverage floor for the batched analyzer
  recipe.ts        StaticRecipeParser (recipe book) + NoRecipeError
  recipeBook.ts    the v0 recipe data
  flyer.ts         FlyerClient interface + FixtureFlyerClient
  normalize.ts     raw price (+ size) → price-per-gram
  matcher.ts       ingredient → flyer item | UNMATCHED
  stores.ts        Geocoder interface, haversine, StaticGeocoder
  rank.ts          basket assembly + store ranking
  pipeline.ts      orchestration
src/integrations/  LIVE, untested, isolated behind interfaces
  backflipp.ts     Flipp unofficial flyer source
  googlePlaces.ts  Google geocoding
  claudeRecipe.ts  Anthropic recipe parsing
src/cli.ts         the command-line entry point
test/fixtures/     flyers/, cases/, prices.golden.json
docs/              PRD.md (authoritative spec), DECISIONS.md (ambiguity log)
```

See `docs/DECISIONS.md` for the decisions made where the PRD was ambiguous.
