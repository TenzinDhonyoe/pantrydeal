# PantryDeal for Prediabetes — Affordable Plan Adherence

**Status:** DRAFT for dietician review · not yet built
**Author:** product + engineering, via `/plan-ceo-review` (2026-06)
**Audience:** Part 1-3 are written for a dietician/clinical reviewer. Part 4-8 are for engineering.

> This document describes a planned product. No clinical content here has been
> verified yet. The sections marked **[CONFIRM]** are exactly the decisions we
> need a credentialed dietician to review before anything ships to a patient.

---

## 1. The problem we are solving

Dieticians told us the single biggest reason prediabetic patients fail to follow
their food plans is **affordability**. The plan is sound; the patient cannot
sustain the cost of the compliant foods, so they revert to cheaper, higher
glycemic eating, and blood sugar drifts the wrong way.

Lifestyle change (diet + activity) can cut progression from prediabetes to type 2
diabetes substantially, but only if the patient actually adheres. Cost is a
documented adherence barrier. **We want to remove the cost barrier so the plan
gets followed.**

Who this is for:
- **Primary user:** a person with prediabetes trying to eat to their plan on a budget.
- **Primary champion:** the dietician who wrote the plan and is frustrated it is not followed.

## 2. What the product does

The patient enters: their **weekly grocery budget**, how many **people** they are
feeding, their **postal code**, and any **dietary restrictions** (allergies,
vegetarian, cultural preferences). The app produces:

1. **A week of meals** that meet prediabetes-appropriate nutrition targets (Part 3).
2. **An affordable shopping plan** for those meals, priced on **current local
   flyer deals** across nearby stores, with the real out-of-pocket cost.
3. **Budget fit:** total vs. their budget, and if it is over, a one-tap "swap a
   meal" that re-picks a cheaper compliant option.
4. **The savings made honestly:** real pack prices, leftovers, and which deals
   were used.

The key idea: **we minimize cost only inside the nutrition guardrails.** A cheap
white-rice or sugary-cereal deal can never win over a compliant choice. Price is
optimized second; nutrition compliance is the hard constraint, first.

## 3. Clinical approach — FOR DIETICIAN REVIEW

This is the part we need you to verify. Everything here is a proposed starting
point based on general prediabetes guidance, not a clinical decision we are
qualified to finalize.

### 3a. Nutrition targets (proposed defaults) **[CONFIRM]**
These are enforced in code as **hard rejects**: any meal or day outside the bound
is never shown. Values are computed **per serving** (see 3e for scaling). Each
row states the unit (per-meal / per-day) and an exact bound the engine checks; the
"~" values are the dietician's call.

| Target | Unit | Enforced bound (proposed) | Notes |
|---|---|---|---|
| Carbohydrate | per main meal | 45-60 g inclusive **[CONFIRM]** | "consistent carbohydrate" style |
| Carbohydrate | per snack | ≤ 20 g **[CONFIRM]** | |
| Fiber | per day | ≥ 28 g **[CONFIRM]** | legumes, whole grains, non-starchy veg |
| Added sugar | per day | ≤ 25 g (ceiling) **[CONFIRM]** | "prefer none" is guidance text, the 25 g is enforced |
| Glycemic load | per main meal | ≤ 20 (low/medium) **[CONFIRM]** | needs a threshold to be checkable, or drop it |
| Lean protein | per main meal | present, ≥ ~20 g **[CONFIRM]** | |
| Saturated fat | per day | < 10% of calories **[CONFIRM]** | |
| Sodium | per day | < 2300 mg **[CONFIRM]** | does NOT account for CKD (see 3f) |
| Plate method | per main meal | ~½ non-starchy veg, ¼ lean protein, ¼ whole grain | shapes recipes, not hard-checked |

**Energy / calories and weight loss.** Progression from prediabetes is reduced
mostly by modest weight loss (~5-7%), which needs an energy target. v1 does **not**
set or enforce a calorie target on its own — that is a per-patient clinical
decision. We propose the dietician supplies a daily calorie target per patient
(v2, see 3f); v1 ships the macro/quality guardrails above and is explicit that it
is not a weight-loss program by itself. **Is that the right boundary?**

These defaults are **global** in v1 (same for every user). Per-patient adjustment
needs storage and a dietician interface, which is v2 (see Part 9). **Are these
global defaults safe as a starting point?**

### 3b. High-glycemic blocklist (never selected, even on sale) **[CONFIRM]**
Proposed: white bread, white rice (prefer brown/parboiled/long-grain converted),
sugary breakfast cereals, regular soda, fruit juice, instant mashed potatoes,
candy, pastries, sweetened yogurt. **Is this list right? What is missing or too strict?**

This blocklist applies to the **actual product the shopper would buy**, not just
the recipe name. When the deal engine matches a recipe ingredient to a real flyer
product, that product must pass the blocklist (and 3f allergens) before it can be
chosen. A cheap "whole grain" bread that is actually refined does not qualify.

### 3c. How we keep substitutions safe **[CONFIRM]**
When a meal is too expensive, v1 uses **whole-meal swap only**: replace the meal
with a different recipe that also passes every target. Simple and safe.

The finer "exchange-list swap" (swap one item for another in the same diabetic
exchange group) is **deferred to v2** — it needs a verified exchange mapping that
is its own clinical surface, for marginal extra savings. Do you agree whole-meal
swap is the right v1, and should every swap be labeled "suggested, confirm with
your dietician"?

### 3d. Where nutrition numbers come from (the load-bearing rule) **[CONFIRM]**
The hard validator is only trustworthy if it checks **real** nutrition values, not
values an AI made up. So:
1. Every recipe's macros (carbs/fiber/added sugar/protein/glycemic load) are
   **computed from a recognized nutrition database against the ingredient list** —
   never accepted from an AI's self-report. The validator validates reality.
2. The **vetted core (~25-30 recipes) is reviewed and signed off by a dietician**
   before it can reach a patient. Sign-off is recorded as an `approved` flag per
   recipe; the app only serves approved recipes to patients (drafts stay behind the
   DRAFT banner).
3. **AI-generated recipes never reach a patient un-reviewed.** See Part 6 for how
   the AI layer is constrained.
What is your preferred nutrition database, and your preferred sign-off workflow?

### 3e. Scaling to "people" **[CONFIRM]**
Nutrition targets are validated **per serving** for one person. The `people` input
only scales quantities and pack pricing; it never changes whether a serving passes
the targets. So a plan for 4 is the same per-person plan, bought in larger amounts.

### 3f. What v1 does NOT clinically account for **[CONFIRM]**
v1 does not adjust for comorbidities or medications (e.g. chronic kidney disease
changes sodium/protein/potassium limits; some medications interact with diet). The
safety mechanism for these is the **dietician's per-patient override** (v2). Until
then, the DRAFT banner and dietician sign-off are the gate. **Is that acceptable,
or must a specific comorbidity be handled in v1?**

## 4. Safety and scope boundaries (non-negotiable)

- **Not medical advice.** The app presents general prediabetes-oriented meal
  ideas and pricing. It carries a persistent "educational, not medical advice,
  review with your dietician/doctor" banner.
- **The dietician is the authority.** Their plan, their targets, their sign-off
  override everything the app generates. We never make a clinical call the
  dietician has not approved.
- **Hard constraints, enforced in code.** Nutrition rules are a gate, not a
  suggestion. Allergies and restrictions are hard filters that price can never
  override. Allergen tags come from the recipe's ingredient list (via the same
  nutrition/ingredient database, 3d) and are checked against the **actual matched
  product**, so a cheaper substitute can never smuggle in an allergen.
- **Until a dietician signs off the content, the app shows a "DRAFT clinical
  content" banner** and is for internal/dietician review only, not patient use.

## 5. What already exists (reused, not rebuilt)

The pricing engine is built and tested today:
- Recipe → ingredients → match to **real Flipp flyer deals** near a postal code.
- A **two-store optimizer** that buys each ingredient at its best-value store,
  using **real pack prices** (whole packs, leftovers shown), and only suggests a
  second store when it saves more than ~$5 (the worth-it bar).

The new product prices its generated meals through this exact engine: the pricing
spine is reused as-is. The genuinely new and hardest work — the nutrition
validator, the curated library + dietician sign-off, the meal planner, and the
gated AI layer — is still ahead. Product matches feed through the 3b/3f filters
before selection, so the deal engine can never substitute a non-compliant product.

## 6. Architecture (new pieces)

```
budget + people + postal + restrictions
        │
        ▼
  meal planner ──► picks a week from:
        │            • vetted recipe library (trusted core)
        │            • AI-generated recipes (variety, prefs, cuisine)
        │                   │
        │                   ▼
        │            HARD nutrition validator  ◄── every recipe must pass
        │            (targets + blocklist + allergies)
        ▼
  existing deal engine (recipe → local deals → 2-store real-price plan)
        ▼
  week view + affordable shopping plan + budget fit + safe swaps
```

New code:
- `core/nutrition.ts` — targets + the hard validator. Deterministic, fully tested.
  Macros are computed from the nutrition database against the ingredient list (3d),
  so the validator checks real values, never AI-claimed ones.
- `core/recipeLibrary.ts` — the ~25-30 vetted, dietician-signed recipes (an
  `approved` flag per recipe gates patient exposure).
- `core/mealPlan.ts` — choose a week that satisfies daily targets and fits the
  budget, minimizing cost via the existing optimizer. Tested.
- `integrations/geminiMeals.ts` — AI variety, tightly constrained (untested layer).

### How the AI layer stays safe
The AI is the failure surface, so it is fenced in:
1. It may only **recombine vetted ingredients and templates** (cuisine, swaps,
   prefs), not invent free-form recipes from nothing.
2. Its output macros are **recomputed from the nutrition database** against the
   ingredient list — the AI's own numbers are ignored.
3. The result must pass the **same hard validator** as vetted recipes.
4. AI recipes are **not served to patients until a dietician approves them** (same
   `approved` gate as the core). Pre-approval, they appear only in the
   dietician-facing review queue.
This means nothing AI-authored reaches a patient on validator-pass alone — a human
clinician is always in the loop before patient exposure.

### Two paths that must be defined
- **No affordable compliant plan exists** (budget too low for the deals
  available): we show the **cheapest fully-compliant plan we can build** and state
  the honest gap ("this week's compliant plan is $X, $Y over your budget"). We
  **never** relax a nutrition guardrail to hit a budget.
- **AI output fails validation or is empty:** drop it and fall back to the vetted
  core, which is always sufficient to fill a week on its own.

## 7. Decisions locked (from the CEO review)

| # | Decision | Choice |
|---|---|---|
| 1 | The real problem | Affordable adherence to a dietician's prediabetes plan |
| 2 | Optimization objective | Minimize cost **subject to** nutrition constraints |
| 3 | Product shape | Generate an affordable compliant week within a budget |
| 4 | Recipe sourcing | Hybrid: vetted core + AI variety, all gated by the validator |
| 5 | Channel / trust | The dietician defines compliant; we never practice medicine |

## 8. Open questions for the dietician

1. Are the Part 3a enforced bounds safe as global defaults to start?
2. Is the energy/weight-loss boundary right — dietician supplies a per-patient
   calorie target (v2), v1 ships macro/quality guardrails only (3a)?
3. Is the Part 3b high-glycemic blocklist right? Missing or too strict?
4. Whole-meal swap for v1, exchange-list deferred to v2 — agree (3c)?
5. Preferred nutrition database and recipe sign-off workflow (3d)?
6. Is "no comorbidity/medication adjustment in v1, handled by your per-patient
   override later" acceptable, or must a specific condition (e.g. CKD) be in v1 (3f)?
7. Should glycemic load be an enforced target (and at what threshold), or dropped (3a)?
8. Anything clinically important this plan is missing?

## 9. NOT in scope (v1)

- **Per-patient target overrides** — v1 ships global defaults (3a). Per-patient
  targets and a per-patient calorie goal need storage + a dietician interface, so
  they move to v2 with the dashboard.
- Blood-glucose tracking, a dietician dashboard / patient accounts, insurance or
  SNAP/EBT integration, grocery delivery.
- A full automated nutrition database integration beyond what we need to compute
  macros for the curated set and validate AI output (we may start with a fixed
  nutrition table for the vetted ingredients).
- Exchange-list swaps (3c) and comorbidity/medication adjustment (3f).

## 10. Risks

- **Clinical content is unverified until sign-off.** Mitigation: draft banner,
  dietician review gate, recognized nutrition data source.
- **AI-generated recipes are the failure surface.** Mitigations, layered: the AI
  may only recombine vetted ingredients/templates; macros are recomputed from the
  nutrition database (never AI-claimed); output passes the same hard validator; and
  no AI recipe reaches a patient without a dietician's `approved` sign-off. A
  numeric-pass alone is never enough to expose AI content to a patient.
- **A matched product may differ nutritionally from the recipe's ingredient.**
  Mitigation: the blocklist and allergen filters (3b/3f) apply to the actual
  matched product, not just the recipe name.
- **Flyer match accuracy / coverage varies** (known limitation of the deal
  engine). Mitigation: we price what we can confidently match and show real
  products so the choice is checkable; budget fit is honest about gaps.
- **Affordability is necessary but not sufficient for adherence.** We are
  removing one barrier (cost), not all of them.
