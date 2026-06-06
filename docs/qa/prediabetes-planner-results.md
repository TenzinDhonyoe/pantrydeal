# QA: Prediabetes Affordable Week Planner — actual outputs

What this captures: the real output of `POST /api/plan-week` (the prediabetes
planner) on 2026-06, in both Sample (offline fixtures) and Live (real Flipp deals
near a Toronto postal) mode. Goal of this doc: judge whether the **results** are
actually useful for a prediabetic patient trying to afford their plan, and feed it
to a product review. The UI is deliberately ignored here — this is about the
substance of what the tool tells a patient to buy and spend.

The planner today: 4 vetted recipes, each nutrition-validated, each priced
independently through the two-store deal optimizer, then the cheapest N picked
within a budget.

---

## Output 1 — Sample, M8Y, $75 budget, 5 days
**Week total: $61.03 of $75 — WITHIN (4 dinners, 1 short of the 5 requested)**

- **Salmon, quinoa & spinach** — $9.31 · 2/6 on sale · 1 store
  - bell pepper: $1.32 — Bell Peppers @ $6.59/kg [200g]
  - olive oil: $7.99 — Extra Virgin Olive Oil @ $7.99/kg [1× 1000g, 970g left]
  - NOT on sale anywhere: salmon, quinoa, chickpeas, spinach
- **Turkey & black bean tacos** — $11.36 · 3/7 on sale · 1 store
  - turkey: $2.64 — **Chicken Thighs Value Pack** @ $6.59/kg [400g] 🔥   ← wrong food
  - tomato: $1.29 — Crushed Tomatoes [1× 796g, 596g left]
  - onion: $2.99 — Cooking Onions [1× 1360g, 1240g left]
  - NOT on sale anywhere: black beans, whole wheat tortilla
- **Chicken & barley bowl** — $17.82 · 4/6 on sale · 1 store
  - chicken: $3.30 — Chicken Thighs Value Pack @ $6.59/kg [500g] 🔥
  - broccoli: $1.75 — Broccoli Crowns; carrot: $1.99 [1× 907g, 707g left]; garlic: $0.79 [1× 100g, 80g left]
  - NOT on sale anywhere: barley
- **Tofu vegetable stir-fry with brown rice** — $22.55 · 4/7 on sale · 1 store
  - tofu: $4.61 — **Chicken Thighs Value Pack** @ $6.59/kg [700g] 🔥   ← vegetarian dish priced with chicken
  - broccoli, carrot, onion priced; NOT on sale anywhere: brown rice

## Output 2 — Sample, M5V, $50 budget, 3 days, restriction = vegetarian
**Week total: $22.55 of $50 — WITHIN (1 dinner, 2 short)**

- **Tofu vegetable stir-fry with brown rice** — $22.55 · 4/7 on sale
  - tofu: $4.61 — **Chicken Thighs Value Pack** 🔥   ← the ONE "vegetarian" meal recommends chicken
  - (all 3 meat recipes correctly filtered out, leaving only 1 recipe → 2 short)

## Output 3 — Live (real Flipp), M8Y 3N5, $75 budget, 5 days
**Week total: $199.94 of $75 — OVER by $124.94 (4 dinners)**

- **Chicken & barley bowl** — $26.50 · 4/6 on sale
  - chicken → Fresh Whole Chicken ($5.98); broccoli → Fresh Broccoli Crowns ($2.44)
  - carrot → ORGANIC RAINBOW CARROT **CHIPS**, 340 G ($2.99); olive oil → PC Splendido Olive Oil 1 L ($8.99)
  - not on sale anywhere: barley
- **Salmon, quinoa & spinach** — $53.81 · 3/6 on sale
  - salmon → Atlantic Salmon Fillet ($19.98); spinach → Bunch Spinach ($2.49); olive oil → Bertolli EVOO 460 mL ($6.99)
  - not on sale anywhere: chickpeas
- **Turkey & black bean tacos** — $53.82 · 3/7 on sale
  - whole wheat tortilla → Casa Mendosa Tortillas 640g ($3.99)
  - onion → **Medium Cooking Onion 50Lb ($24.00)**   ← a 22 kg restaurant sack for one recipe
  - turkey → PC Ground Chicken/Turkey 454 g ($6.49)
- **Tofu vegetable stir-fry with brown rice** — $65.82 · 3/7 on sale
  - onion → **Medium Cooking Onion 50Lb ($24.00)**   ← again, second 22 kg sack
  - carrot → Organic Rainbow Carrot Chips 340 G ($2.99); olive oil → PC Splendido 1 L ($8.99)

---

## QA verdict: NOT useful yet

The nutrition gate, the per-deal pricing, and the honest budget reporting work.
But as a thing you would hand a prediabetic patient, the output is not usable, for
concrete and fixable reasons. Ranked by severity:

### Severity 1 — actively wrong / unsafe
1. **Wrong-food substitution leaks meat into vegetarian meals.** The tofu recipe
   carries `substitutes: ['chicken']`, so the matcher prices tofu with "Chicken
   Thighs." The vegetarian plan (Output 2) literally recommends buying chicken.
   This is a trust-destroying, ethically bad bug. Root cause: recipe substitutes
   are used for price matching without respecting the dish's own identity or the
   patient's restriction.
2. **Absurd pack sizes.** Live matched onion to a "50 Lb" (22 kg) restaurant sack
   at $24 because it has the best price-per-kg. The shopper "needs" 120 g. This
   happened twice ($48 of onions). The optimizer chases unit price with no sanity
   cap on pack size vs. need.
3. **Snack/processed items pass as whole foods.** "Carrot chips" matched as
   "carrot." For prediabetes this matters — a processed snack is not the vegetable.

### Severity 2 — makes the core promise (affordability) look broken
4. **No cross-recipe pooling.** Each recipe is priced independently, so shared
   staples are bought once per recipe: olive oil as a full bottle in 3 meals, two
   separate 50 lb onion sacks, etc. This is the main reason live came out $199.94
   vs a $75 budget. A real week's shopping list pools ingredients.
5. **Estimated-regular inflation.** Misses (barley, quinoa, chickpeas, brown rice)
   are charged dearest-sale × 1.25, stacking across meals.

### Severity 3 — too thin to be a product
6. **Library too small (4 recipes).** Asking for 5 days yields "1 short"; the
   vegetarian filter leaves a single meal ("2 short"). No variety, no repeat-week
   protection, weak support for any restriction.
7. **Sample coverage is low** because the demo fixture doesn't stock the
   prediabetes staples (salmon, quinoa, barley, tofu, beans). Live finds them, so
   this is a fixture artifact, not a core flaw.

### What is genuinely good
- Nutrition validation holds (every shown meal passed the carb/fiber/sugar/protein
  gate and the blocklist).
- Real pack prices + leftovers are honest ("buy 1 L olive oil, 970 g left").
- Budget fit is reported truthfully, including being over.
- Live matching found real, sensible primary items (Fresh Whole Chicken, Atlantic
  Salmon Fillet, ground turkey, broccoli crowns).

---

## After the four fixes (re-QA)

The CEO review chose "harden the current shape." Four fixes shipped: same-food
matching (dropped cooking substitutes + snack/meat guard), pack-size sanity cap,
cross-recipe pooling (one weekly cart priced once), and the library grown 4 → 12.

### Severity-1 (unsafe) — FIXED
- **Vegetarian plan, M5V, $60:** menu is Egg & black bean scramble, Tofu & edamame
  bowl, Lentil & mushroom stew, Tofu stir-fry. **Zero meat.** (Was: recommended chicken.)
- **tofu / carrot:** tofu no longer maps to "Chicken Thighs"; "carrot chips" is
  rejected as a snack. Verified in unit tests.

### Severity-2 (budget credibility) — PARTLY FIXED
- **Pooling works.** Sample M8Y $75, 5 days: one cart, **$25.26, within budget**,
  olive oil bought once (was 3×).
- **Pack sanity works.** Live M8Y 3N5: the 50 lb / 22 kg onion sack is gone.
- **But live is still over budget** ($169 of $90). New root causes, not the old
  double-counting:
  1. **Estimated-regular inflation dominates.** Only 6 of 20 weekly ingredients are
     on sale; the other 14 are charged dearest-sale × 1.25. With prediabetes staples
     (lentils, beans, tofu, eggs, quinoa) rarely on flyer, the *estimate* drives the
     total, not real deals.
  2. **Large-but-legal packs.** An 8 lb (3.6 kg) carrot bag at $15.98 passes the 11 kg
     cap but is ~4× a week's need. We buy cheapest-per-kg, not smallest-sufficient.

### Severity-3 (depth) — IMPROVED
- 5-day weeks now fill (12 recipes). Vegetarian still 1 short (only 4 veg recipes) —
  add ~2 more to fully cover restricted weeks.

### New verdict
Sample is genuinely useful and dietician-showable. Live is **safe and honest but
still over budget**, because the affordability number is dominated by (1) an
estimated regular price for the many off-sale staples and (2) oversized packs. The
next product lever is not more recipes — it is **the regular-price model and
smallest-sufficient-pack selection**, so the headline budget number reflects what a
shopper would really pay.

## Open question for product review
Is "cheapest compliant dinners, priced from flyer deals" even the right shape for a
prediabetic patient on a dietician's plan, or does affordability-driven adherence
need something different (pooled weekly cart, pantry-staple awareness, portion/
serving realism, cost-per-serving, and a much larger compliant recipe set)?
