# PantryDeal v0 — Decisions Log

The PRD (`docs/PRD.md`) is authoritative but leaves several points ambiguous.
Each decision below resolves an ambiguity so the build could proceed.

## D1 — LLM / live integrations live OUTSIDE `src/core`
The PRD says `recipe.ts` uses the Claude API and `matcher.ts` does "LLM rerank",
but the acceptance criteria require `src/core` to have ≥90% statement coverage
with **zero** network access in tests. Network/LLM code can't be deterministically
covered offline. **Decision:** `src/core` contains only pure, deterministic logic
plus interfaces (`FlyerClient`, `Geocoder`, `RecipeParser`). Live/LLM implementations
(`BackflippClient`, `GooglePlacesGeocoder`, Claude-backed recipe parser) live in
`src/integrations/` and are NOT exercised by tests. The default, fully-tested recipe
parser is a deterministic recipe book (`StaticRecipeParser`).

## D2 — `FlyerItem` gains an optional `size` field
Price-per-gram is underdetermined from a price string alone: `"$8.99 family pack"`
has no weight. Real Flipp item records carry a `size` field. **Decision:** extend the
PRD `FlyerItem` contract with optional `size` (e.g. `"1.5 kg"`, `"454 g"`, `"500 ml"`).
The normalizer uses `rawPrice` + `size` to produce `pricePerGram`. Per-weight prices
(`"$3.49/lb"`, `"$/kg"`, `"$/100g"`) are self-describing and ignore `size`.

## D3 — A matched item MUST have a numeric `pricePerGram`
If a candidate flyer item cannot be normalized to a numeric `pricePerGram` (e.g. an
"each" item with no weight), it is **not** an eligible match. If no candidate for an
ingredient normalizes, the ingredient is flagged `UNMATCHED`. This guarantees criterion 5
("every matched item has a numeric pricePerGram") and the never-drop invariant.

## D4 — Liquid volumes approximate 1 ml = 1 g
For v0, `ml`/`l` sizes are treated as grams (water density). Adequate for milk, cream,
oil at this accuracy. Documented as a known limitation in the README.

## D5 — Ranking: coverage first, then basket total
A store missing the recipe's expensive ingredients would look artificially "cheapest"
if we ranked on matched-cost alone. **Decision:** rank stores by `coverage`
(matched ingredients / total) **descending**, then by matched-basket `total` ascending,
then nearest store, then store name. The cheapest store = the top of that ranked list.
Unmatched ingredients are always retained in the basket and surfaced.

## D6 — Matching is deterministic stem-subset matching
Ingredient and item names are tokenized and stemmed (simple plural folding). An item
matches an ingredient if every stem of the ingredient name (or of one of its
`substitutes`) is present in the item's stems. Among matching items in a store, the one
with the lowest `pricePerGram * qtyGrams` line cost wins. No LLM in the tested path
(see D1). Known match-accuracy ceiling documented in the README.

## D7 — Unknown dinners throw a typed error
The v0 deterministic parser has a fixed recipe book. A free-text dinner that matches no
recipe throws `NoRecipeError` rather than returning an empty recipe. The Claude-backed
parser (`src/integrations`) would generalize but is out of the tested path.

## D8 — CLI defaults to fixtures; `--live` opts into the network
`npx pantrydeal --postal M8Y --dinner "butter chicken"` runs on `FixtureFlyerClient` +
`StaticGeocoder` by default (offline, deterministic). `--live` (or `PANTRYDEAL_LIVE=1`)
goes fully online. Default search radius is 25 km.

## D9 — Live stack is Gemini + keyless Backflipp + keyless Zippopotam
The user supplies Gemini credits, not Google Places / Anthropic keys. **Decision:** the
default `--live` stack is `GeminiRecipeParser` (reads `GEMINI_API_KEY`, structured output
via Gemini `responseSchema`), `BackflippClient` (Flipp, **keyless**), and
`ZippopotamGeocoder` (api.zippopotam.us, **keyless**). So live mode needs only a Gemini
key. `ClaudeRecipeParser` and `GooglePlacesGeocoder` remain in `src/integrations` as
optional alternatives but are not wired into the CLI. In live mode the CLI parses the
recipe **first**, then seeds the Backflipp search with the recipe's own ingredient names
and substitutes so the returned deals are relevant (and the recipe is parsed only once).

## D10 — Backflipp realities: full-postal padding + merchant-as-store
Verified against the live endpoint: (a) `items/search` rejects a 3-char FSA and requires
a full 6-char postal, so a bare FSA is padded to `"<FSA> 1A1"` (format-valid; Flipp keys
off the FSA). (b) Items carry `merchant_name`/`merchant_id` but **no per-store
coordinates**; Flipp already returns flyers local to the postal's FSA, so each merchant is
treated as one nearby store stamped at the geocoded postal location (distance ≈ 0, so
coverage/total drive ranking). (c) Price is reconstructed from `current_price` +
`post_price_text` (per-weight, e.g. `/lb 13.21/kg`) or `sale_story` (multi-buy); a size is
also extracted from the item name (e.g. `"LACTANTIA BUTTER, 454 G"`) so per-each prices
become priceable. Items that still can't be priced per gram are surfaced UNMATCHED (D3).

## D11 — Gemini reranker is an optional MatchFilter, not a core rewrite
The PRD calls for "retrieve candidates + LLM rerank", but the core matcher must stay
deterministic and fully tested. **Decision:** core `matchIngredient`/`matchBasket`/
`buildBasket`/`runPipeline` gained an optional `MatchFilter` (a synchronous
`isAllowed(ingredient, item)` predicate). Default behaviour is unchanged (no filter →
identical to before), so all existing tests pass untouched; the new branch is covered by
added unit + pipeline tests. The live `GeminiMatcher` (`src/integrations`) precomputes the
filter with ONE batched Gemini call: it gathers each ingredient's lexical candidates, asks
Gemini to keep only the names that genuinely are that grocery product (rejecting
"ice cream" for "cream", "chicken wieners" for "chicken"), and exposes the approved set as
the filter. It is wired into `--live` and never exercised by tests.

## D12 — Rank by projected WHOLE-recipe cost, not matched-only total
Ranking by matched-items total (D5) rewarded a store for *missing* expensive
staples: a shop with only cheap items on sale showed the lowest total and "won",
even though you'd pay regular price for the chicken it lacks. **Decision:** each
basket gets a `projectedTotal` = matched sale prices + an estimated regular price
for ingredients not on sale here but on sale somewhere (the dearest sale price
seen for that ingredient × `REGULAR_PRICE_MARKUP` = 1.25). Stores rank by
`projectedTotal` ascending (then coverage, nearest, name). Ingredients nobody has
on sale add nothing (a wash across all stores). This makes "cheapest store" mean
cheapest for the whole recipe. The matched-only `total` and `coverage` are still
shown. This refines D5; the live analyzer (D11) is what makes matches accurate
enough for the projection to be meaningful.

## D13 — Real pack prices, not pro-rated fictions (purchase.ts)
A CEO review (`/plan-ceo-review`) found the old headline ("cart total $8.49") was a
fiction: it pro-rated each ingredient to the exact grams the recipe needs, but you
can't buy 600 g of a $9.99 bag. **Decision:** `planPurchase` models what you actually
pay. By-weight deals (`$2.99/lb`) let you buy exactly what you need (no leftover).
Fixed packs (`$4.99 / 454 g`) force whole packs: buy `ceil(need / pack)` of them,
pay the pack-sum, keep the leftover. `realCost` is the till price; `portionCost` (the
old pro-rated number) survives only as the fair basis for comparing stores across
different pack sizes.

## D14 — Two-store optimizer, honest about "worth the trip" (optimize.ts)
The single-store frame fought the use case (flyer-flipping is multi-store). **Decision:**
`optimizePlan` finds the cheapest realistic plan over ≤2 stores: each ingredient routes
to the best cost-per-portion store in the chosen set; the headline total is the REAL
pack-price sum (D13) plus an estimated regular price for on-sale items the plan misses.
It scores every single store and every pair (≤~780 combos, trivial), and only suggests a
second stop when it saves at least `worthItBar` (default $5). We never assert a trip is
"worth it" — Flipp gives no real store distances — we surface the dollars saved and the
shopper decides. A "good deal" flag marks a price at/below 0.85× the week's median for
that item (relative to this week's stores, not historical). Built as a layer ON TOP of
the existing pipeline, so the CLI and core ranking (D5/D12) are unchanged.
