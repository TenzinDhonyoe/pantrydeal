# PantryDeal v0 — PRD

## Problem
Given my postal code and a free-text dinner request, return the single
nearby store where I can buy that recipe's ingredients cheapest using
current grocery flyer deals.

## In scope (v0)
- Free-text dinner -> structured recipe (ingredients w/ qty + unit + category)
- Flyer deal lookup per ingredient via a FlyerClient interface
- Ingredient -> flyer-item matching (retrieve candidates + LLM rerank)
- Unit/price normalization to price-per-gram
- Nearest-store geocoding (postal/lat-long -> store branches)
- Single-store basket cost ranking; return cheapest store

## Out of scope (v0)
Multi-store optimization, web/iOS UI, auth, persistence, live network in tests.

## Architecture (src/core, pure + testable)
- recipe.ts      dinner string -> Ingredient[] (Claude API)
- flyer.ts       FlyerClient interface; BackflippClient (live, unofficial),
                 FixtureFlyerClient (loads test/fixtures/flyers/*.json)
- matcher.ts     Ingredient + FlyerItem[] -> best match | UNMATCHED (never drop)
- normalize.ts   raw price string -> pricePerGram
- stores.ts      postal/coords -> nearby store branches (Google Places, mockable)
- rank.ts        matched basket -> stores ranked by total cost
- pipeline.ts    orchestrates the above

## Data contracts
Ingredient { name, qtyGrams, category, substitutes[] }
FlyerItem  { name, rawPrice, merchant, storeIds[], validFrom, validTo, sku? }
Match      { ingredient, item | null, pricePerGram | null, status }

## Accuracy philosophy
Real match accuracy is unverifiable without ground truth, so correctness is
defined by fixture tests, not live data. Unmatched ingredients are ALWAYS
surfaced explicitly, never silently dropped. Flipp access is unofficial and
fragile; it lives behind FlyerClient and is never hit in tests.

## Acceptance criteria
See docs/GOAL-PROMPT.md (the /goal condition).