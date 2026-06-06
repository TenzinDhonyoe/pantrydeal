# PantryDeal — Architecture & Token-Cost Plan

> Status: living document. Authored to (a) capture the full system architecture and
> (b) define a plan to cut LLM (Gemini) token cost in live mode.
> Companion specs: `docs/PRD.md` (authoritative product spec), `docs/DECISIONS.md`
> (ambiguity log, referenced below as D1–D17).

---

## 1. What the system does

Two products share one core engine:

1. **PantryDeal search** (`/api/search`, CLI): given a **postal code** + **free-text
   dinner** + **people**, return the single nearby store where the recipe's
   ingredients are cheapest from current grocery flyer deals.
2. **Prediabetes affordable weekly planner** (`/api/plan-week`, `web/planner.html`):
   given a **postal code** + **weekly budget** + **household size** + dietary
   **restrictions**, build a nutrition-validated week of dinners within budget and
   price one pooled shopping cart.

Both run in two modes:

| Mode | Recipe | Flyers | Geocoding | LLM cost |
| --- | --- | --- | --- | --- |
| **Fixture (default)** | `StaticRecipeParser` (recipe book) | `FixtureFlyerClient` (local JSON) | `StaticGeocoder` (table) | **zero** |
| **Live (`--live`)** | `GeminiRecipeParser` | `BackflippClient` (Flipp, keyless) | `ZippopotamGeocoder` (keyless) | **all the cost is here** |

Only Gemini needs a key (`GEMINI_API_KEY`). Flyer + geocoding sources are keyless.

---

## 2. Module map

```
src/
  cli.ts                 CLI entry (arg parse → runner.search → render table)
  server.ts              HTTP server: static UI + /api/search, /api/plan-week, /api/config
  runner.ts              ★ wiring: builds fixture-or-live deps, runs pipeline + planner
  core/                  pure, deterministic, ≥90% tested — NO network, NO LLM
    types.ts             domain contracts + injected interfaces
    pipeline.ts          parse → flyers → nearby stores → baskets → rank
    recipe.ts            StaticRecipeParser + NoRecipeError
    recipeBook.ts        v0 recipe data (~12 dishes)
    recipeLibrary.ts     PREDIABETES_RECIPES (planner candidate dishes)
    flyer.ts             FlyerClient iface + FixtureFlyerClient
    matcher.ts           lexical stem-subset matcher; tokenize()/stem() exports
    normalize.ts         raw price (+size) → price-per-gram   ← deterministic OCR/price math
    purchase.ts          planPurchase: pack math (units needed, leftover, real cost)
    rank.ts              buildBasket + rankStores (coverage, projected total)
    optimize.ts          optimizePlan: two-store split (D13/D14)
    stores.ts            Geocoder iface, haversine, resolveNearbyStores, StaticGeocoder
    nutrition.ts         computeRecipeNutrition + validateRecipe (hard gate)
    nutritionTable.ts    per-ingredient macro table (source of truth for macros)
    mealPlan.ts          selectWeek (budget-bounded weekly selection)
    recipePricing.ts     priceRecipe, poolIngredients, sameFoodMatcher
  integrations/          LIVE, untested, isolated behind core interfaces (D1)
    geminiRecipe.ts      ★ LLM: dinner → structured Recipe                 (1 call/search)
    geminiAnalyzer.ts    ★ LLM: per-ingredient flyer matching + price OCR  (N calls/request)
    geminiMeals.ts       ★ LLM: planner "AI variety" review queue (unapproved)
    backflipp.ts         Flipp unofficial flyer source (keyless)
    zippopotam.ts        OSM postal geocoder (keyless)
    googlePlaces.ts      alt geocoder (GOOGLE_PLACES_KEY) — not on default live path
    claudeRecipe.ts      alt recipe parser (ANTHROPIC_API_KEY) — not on default live path
web/                     vanilla SPA: index.html/app.js (search), planner.html/planner.js
```

`★` = touches the Gemini API and therefore the token bill.

---

## 3. Pipeline (search)

```
dinner ─▶ recipeParser.parse ───────────────▶ Recipe (ingredients[] in grams)
postal ─▶ flyerClient.getDeals ─────────────▶ FlyerData (stores[], items[])
       ─▶ resolveNearbyStores (haversine) ──▶ nearby stores within radius
                                            ─▶ buildBasket per store (matcher decides
                                               ingredient→item; normalize prices/gram)
                                            ─▶ rankStores (coverage, then projectedTotal)
                                            ─▶ cheapest store + optimizePlan two-store split
```

Every `core` stage is pure and deterministic; `RecipeParser`, `FlyerClient`,
`Geocoder`, and `CandidateMatcher` are injected, so the whole pipeline runs offline
against fixtures in tests (D1). **Correctness is defined by fixtures, never by live
data.**

### Live wiring (`runner.ts → buildLiveDeps`)

1. `GeminiRecipeParser.parse(dinner, people)` → `Recipe`  — **1 Gemini call**
2. `BackflippClient({ terms = ingredient names + substitutes }).getDeals(postal)` →
   real flyer items (one HTTP call per search term, deduped) — no LLM
3. `GeminiAnalyzer.prepare(recipe, items)` → for **each ingredient**: take ≤30 lexical
   candidates, ask Gemini to keep only true same-food matches and extract a clean
   `unitPriceDollars` + `quantityGrams` — **N Gemini calls (N = ingredient count),
   concurrency 5**
4. Tested core prices + ranks the enriched items.

### Live wiring (planner, `runner.ts → resolveFlyerContext`)

The planner builds a synthetic "pantry" recipe whose ingredients are the **union of
every term across every candidate recipe** in `PREDIABETES_RECIPES` (after
restriction filtering), then runs `GeminiAnalyzer.prepare` over it — i.e. **one
Gemini call per distinct term across the whole candidate set (typically 30–50)**,
*before* `selectWeek` has narrowed down which ~5 dishes are actually chosen.

---

## 4. Token economics (where the cost is)

All Gemini calls go to `…/v1beta/models/${model}:generateContent` with
`responseSchema` + `temperature 0`. Cost per request, by call site:

| Call site | Calls per user request | Fixed prefix re-sent each call | Variable payload |
| --- | --- | --- | --- |
| `geminiRecipe` | 1 | system instr. ~280 tok | dinner string (tiny) |
| `geminiAnalyzer` (search) | **N = #ingredients (~9–12)** | system instr. **~430 tok** + JSON schema | ≤30 candidates × ~20 tok ≈ 600 tok |
| `geminiAnalyzer` (planner) | **30–50 (one per union term)** | same ~430 tok + schema | candidates per term |
| `geminiMeals` (planner variety) | 1 (optional) | full `NUTRITION_TABLE` key list in system prompt | — |

**The dominant waste is structural, not payload-level:**

1. **Fixed-prefix amplification.** The ~430-token system instruction + response
   schema are *byte-identical* on every analyzer call, yet re-sent 9–50× per
   request. That fixed prefix is the majority of analyzer input tokens.
2. **No cross-call dedup.** A flyer item that is a candidate for several ingredients
   (e.g. an "onion" listing matching both `onion` and `green onion`) is classified
   once *per ingredient*, paying for the same item text repeatedly.
3. **Planner over-fetches.** Analysis runs over the **full** candidate-term universe
   before `selectWeek` picks ~5 dishes; terms belonging to never-picked dishes are
   analyzed (and paid for) for nothing.
4. **LLM does deterministic work.** The analyzer asks the model to extract
   `unitPriceDollars` + `quantityGrams` — but `core/normalize.ts` +
   `backflipp.buildRawPrice/extractSize` already do exactly this deterministically
   for most items. Paying output tokens (and schema complexity) for math we can do
   locally.
5. **No result reuse.** Identical dinners and identical flyer items (same store, same
   flyer validity window) are re-analyzed on every request — a web app sees the same
   popular dinners and the same weekly flyers constantly.
6. **Recipe LLM always fires in live mode**, even for dishes already in the static
   recipe book.

> Rough shape today: a single live search ≈ **10–13 Gemini calls**; a live
> plan-week ≈ **30–50 calls**, each carrying the full fixed prefix. The fixed prefix
> alone is paid ~10–50× per request.

---

## 5. Token-cost reduction plan — LOCKED (post eng-review)

Reviewed via `/plan-eng-review` on 2026-06-06. Scope decision: **implement the full
set in one pass, EXCEPT E (dropped).** None of this changes fixture-mode behaviour
(still zero LLM). Per the test decision below, all new *decision logic* lives in pure
`core/` functions (tested ≥90%); `integrations/` keeps only HTTP wiring.

### Locked decisions

| # | Decision | Rationale |
| --- | --- | --- |
| **B** | **Single batched call**, all ingredients, deduped candidate universe — **with a per-ingredient fallback** if the call errors or returns implausibly low coverage. | Cheapest/fastest; fallback contains the all-or-nothing + conflation risk. |
| **D** | **In-memory LRU**, keyed *including* `validTo`. No disk. | Resets on restart = safe; `validTo` in the key makes stale prices impossible. |
| **E** | **Dropped — keep LLM price/gram extraction.** | Local-first could parse OCR-mangled sizes wrong *without failing* (`"1 56 ML"`→56g), silently degrading the accuracy live mode advertises. Not worth the output-token saving. |
| Tests | **Extract pure logic into `core/`.** | Preserves the "correctness defined by fixtures" invariant (D1); the bug-prone logic (TTL, dedup, batch grouping, candidate scoring) gets real coverage. |

### Step 0 (land first, even within the one PR): measurement
Log `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`,
`cachedContentTokenCount`) per Gemini call behind `PANTRYDEAL_DEBUG`. Without a
baseline you cannot attribute any saving. This is the first commit.

### A. Cache the fixed prefix (Gemini context caching) — ✅ satisfied by construction
The system instruction is sent as a stable, separate `systemInstruction` block (never
interleaved with variable content), so **implicit** prefix caching on 2.5+ models
applies automatically — no code to add. The measurement step logs
`cachedContentTokenCount` so you can confirm it's actually hitting. **Deliberately
NOT building explicit `cachedContents`** (cache-handle lifecycle + min-token
thresholds) — once B collapsed the fan-out to one call, A's within-request value is
near-zero, so explicit caching would be over-engineering for a side project. Revisit
only if the usage logs show the implicit cache isn't applying.

### B. Single batched analyzer call (with fallback) — ✅ DONE
Pure `core/analyzerPrep.ts` (100% covered): `buildBatchPlan(ingredients, items)`
builds one candidate list where each flyer item appears once tagged with the
ingredient indices it's a candidate for; `coverageOf`/`belowFloor` decide whether to
trust the result. `GeminiAnalyzer.acceptBatch` makes one Gemini call returning
`{ingredientIndex, itemIndex, unitPriceDollars, quantityGrams}` assignments.
**Resilience (shipped):** if the call throws, returns malformed JSON, or covers fewer
than `COVERAGE_FLOOR` (0.3) of the *matchable* ingredients, it falls back to the
per-ingredient `mapPool` path. The LLM still extracts price+grams (E dropped).
Tests: `test/analyzerPrep.test.ts` (15 cases). Integration (`acceptBatch`/`acceptFor`
HTTP) untested by invariant (D11).

### C. Static-first recipe parsing — ✅ DONE
`runner.parseRecipeLive` tries `StaticRecipeParser` first and calls
`GeminiRecipeParser` (lazy-imported) only on `NoRecipeError`. Saves the recipe LLM
call for the dishes the book covers.

### D. Result caching (in-memory LRU, validTo-keyed) — ✅ DONE
Pure tested `core/cache.ts` (`LruCache`, `cacheKey`, `isFresh`) + tested
`classificationKey` in `core/analyzerPrep.ts`. Two process-lifetime LRUs:
- recipe (`runner.ts`): `(dinner, people, model)` → `Recipe`.
- item classification (`geminiAnalyzer.ts`): `(ingredient, sku||name, validTo)` →
  `{accept, price?, grams?}`. `splitCache` serves fresh hits before the LLM call and
  drops decided pairs; `writeCache` persists every decision the LLM made. A **full
  cache hit makes zero Gemini calls.** `isFresh` (validTo in the key) guarantees a
  rotated flyer is a miss, so a stale price can never be served. Process-memory only.

### F. Tighter candidate pre-filter — ✅ DONE
`core/analyzerPrep.lexicalCandidates` now **head-noun gated**: an item must share the
head noun of the ingredient name or a substitute, not merely an incidental modifier
("Black Olives" no longer matches "olive oil"). Cap lowered 30→12. Tests in
`test/analyzerPrep.test.ts` assert true foods (chicken/cream/tomato/coriander) still
survive the gate — the recall guardrail.

### G. Lazy planner pricing — ✅ DONE
`runner.resolveLivePlannerContext`: one keyless Backflipp pull, a **free lexical
pricing pass** to rank candidate dishes, then Gemini analysis only on the
**shortlist's** terms (≈ days×3 cheapest dishes) instead of every candidate term.
Offline planning (`resolveFixtureContext`) is unchanged (no LLM). Removes waste #3.

### H. Model tiering — ✅ DONE
`GeminiAnalyzer` reads `GEMINI_ANALYZER_MODEL` (falling back to `GEMINI_MODEL`), so
the bulk item-matching can run on a cheaper tier while recipe parsing stays on the
default. Documented in `.env.example`. Measure with Step 0 before trusting a cheaper
tier's accuracy.

---

## 5a. Test plan (coverage the implementation must ship with)

New logic lives in `core/`, so it falls under the ≥90% suite. Required new tests:

```
core/cache.ts (new)
  cacheKey()        ├ [★★★] recipe key stable across whitespace/case; people/model vary it
  isFresh()         ├ [★★★] now<validTo fresh; now>validTo stale; missing validTo treated stale
  LRU eviction      └ [★★★] bound respected; LRU order; stale entry purged on read
core/analyzerPrep.ts (new — extracted from geminiAnalyzer)
  dedupeCandidates()├ [★★★] item candidate for 2 ingredients appears once, tagged with both
  groupForBatch()   ├ [★★ ] (kept for fallback path) chunking ≤ cap, order preserved
  scoreCandidates() └ [★★★] head-noun match kept; "any shared stem" junk dropped; recall floor
core/recipe.ts
  static-first      └ [★★★] book hit → no parser call; miss → NoRecipeError path (C)
core/rank or pricing
  coverage-floor    └ [★★★] batched-result-below-floor signal triggers fallback (B resilience)
integrations/ (UNTESTED by design — D1): only fetch() wiring, JSON shape mapping

GOLDEN GUARDRAIL: existing test/fixtures/cases/*.json must still pass unchanged —
they are the regression net proving F's filter and B's batching didn't drop matches.
```

`COVERAGE TARGET: 100% of new core/ branches. Integrations stay untested by invariant.`

## 5b. Failure modes (new codepaths)

| Codepath | Realistic failure | Test? | Error handling | User sees |
| --- | --- | --- | --- | --- |
| B single batched call | Gemini returns malformed/partial JSON or conflates two ingredients | yes (coverage-floor test) | **fallback to per-ingredient** | correct result, slower (no silent wrong match) |
| B single batched call | call throws (rate limit / 5xx) | yes | fallback path | correct result, slower |
| D item cache | stale price served after flyer rotates | yes (`isFresh`) | `validTo` in key → miss → re-fetch | fresh price |
| D recipe cache | two dinners normalize to same key | yes (`cacheKey`) | people+model in key; normalize is conservative | correct recipe |
| F candidate filter | over-aggressive filter drops a real match | yes (golden guardrail) | recall floor fails CI | — (caught pre-merge) |
| A implicit cache | cache silently not applied (model/SDK quirk) | n/a (perf only) | none needed — correctness unaffected | same result, higher cost (visible in Step 0 metrics) |

**No critical gaps:** every new failure mode has either a test + fallback or is
cost-only (not correctness). The one that *would* have been critical — E's silent
wrong grams — was removed by dropping E.

## 5c. NOT in scope (considered, deferred)

- **E (local-first pricing)** — dropped; silent-wrong-grams risk outweighs token saving.
- **Disk-persisted cache** — in-memory LRU chosen; revisit only if a long-lived
  server shows cross-restart hit rate matters.
- **Coupons** (Flipp manufacturer coupons) — pre-existing limitation, unrelated.
- **Swapping Gemini for a cheaper provider wholesale** — H (tiering) covers the cheap
  path without a migration; full provider swap is a separate decision.
- **Caching at the Backflipp HTTP layer** — flyer fetch is keyless/non-token; not a
  cost lever. Skipped.

## 5d. Parallelization

Two independent lanes once Step 0 (measurement) lands:
- **Lane A (analyzer):** B + F + H — all in `core/analyzerPrep.ts` + `geminiAnalyzer.ts`. Sequential within the lane (shared files).
- **Lane B (caching + recipe):** A + C + D — `core/cache.ts`, `core/recipe.ts`, `runner.ts` wiring.
- **Then:** G (planner) depends on both (uses batched analyzer + cache). Land last.

Conflict flag: both lanes touch `runner.ts` wiring — merge that file carefully or
serialize the final wiring commit.

---

## 6. Key design invariants (don't break these)

- **Core is pure & offline-tested.** No network/LLM in `src/core`; correctness is
  defined by fixtures (D1). All live integrations sit behind injected interfaces.
- **Unmatched ingredients are surfaced, never dropped** (search and planner).
- **Nutrition is a hard gate** in the planner: AI macro claims are ignored and
  recomputed from `nutritionTable`; AI-generated meals are an *unapproved* review
  queue (`geminiMeals`), never auto-served to patients (D15).
- **Ranking is by projected whole-recipe cost** (D12), so a store can't win by
  lacking an expensive staple.
- **API keys stay server-side**; the browser only learns `liveAvailable`.
- **Backflipp is unofficial/unstable** (D1/D10) — never depended on in tests.
```
