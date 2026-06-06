/**
 * GeminiAnalyzer — LIVE flyer analyzer (the PRD's "retrieve candidates + LLM
 * rerank", done right).
 *
 * Primary path (docs/ARCHITECTURE.md §5 option B): build ONE deduplicated candidate
 * universe across all ingredients and make a SINGLE batched Gemini call, instead of
 * one focused call per ingredient. This collapses the fixed system-instruction +
 * HTTP overhead from N× to 1× and sends each flyer item's text once even when it is
 * a candidate for several ingredients.
 *
 *   recipe + items ─▶ buildBatchPlan() ─▶ 1 Gemini call ─▶ assignments
 *                                              │ (error / coverage < floor)
 *                                              ▼
 *                                     per-ingredient fallback (mapPool)
 *
 * Resilience: the single call is all-or-nothing, so if it throws, returns malformed
 * JSON, or covers fewer than COVERAGE_FLOOR of the matchable ingredients (a sign it
 * misfired or conflated ingredients), we fall back to the original, slower one-call-
 * per-ingredient path. Correctness wins over the token saving.
 *
 * All candidate selection / dedup / coverage logic is the pure, tested core
 * (core/analyzerPrep.ts); this file owns only the HTTP calls. Each ACCEPTED item
 * also carries a clean unit price + grams read out of OCR-mangled Flipp text. The
 * tested core then prices and ranks. Reads GEMINI_API_KEY. Never tested (D11).
 */
import type { CandidateMatcher, FlyerItem, Ingredient, Recipe } from '../core/types.js';
import {
  buildBatchPlan,
  lexicalCandidates,
  coverageOf,
  belowFloor,
  classificationKey,
  type BatchPlan,
  type BatchCandidate,
  type ClassificationDecision,
} from '../core/analyzerPrep.js';
import { LruCache, isFresh } from '../core/cache.js';
import { recordUsage, type WithUsage } from './geminiUsage.js';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const CONCURRENCY = 5;

/**
 * Process-lifetime classification cache (option D), shared across requests. Keyed by
 * (ingredient, sku|name, validTo); a rotated flyer is a fresh key so stale prices
 * never leak. Lost on restart by design (safe). Bounded LRU.
 */
const sharedClassificationCache = new LruCache<ClassificationDecision>(5000);

/** Shared ACCEPT/REJECT food-identity rules + price/grams extraction contract. */
const FOOD_RULES = `The candidate names and prices are real and often OCR-mangled.

ACCEPT an item only if it is the SAME FOOD as the ingredient:
- the ingredient in any brand, size, form, or state (fresh / frozen / canned /
  jarred / dried), e.g. "Fresh Lemons", "PC Lemons 2 lb", bottled lemon juice
  all satisfy "lemon"; crushed / strained / diced tomatoes / passata / tomato
  paste satisfy "tomato"; whipping / table / heavy cream satisfy "cream";
- a different cut of the SAME animal for meat, e.g. any chicken cut
  (breast/thigh/drumstick) satisfies "chicken";
- an exact alias, e.g. cilantro = coriander, scallion = green onion.

REJECT anything that is a DIFFERENT food, even if it could substitute in a recipe:
vinegar or lime is NOT lemon; coconut milk, yogurt, sour cream, cream cheese, or
ice cream is NOT cream; margarine is NOT butter; tofu or fish is NOT chicken;
ketchup or a tomato-flavoured snack is NOT tomato; turkey is NOT chicken; soft
drinks, juice blends, and candy are never produce. A wrong match is MUCH worse
than no match — when in doubt, REJECT.

For each ACCEPTED candidate also extract:
- "unitPriceDollars": price for one sellable unit ("2/$5" -> 2.50; "$1.79/100g"
  -> 1.79; "$4.99" -> 4.99).
- "quantityGrams": grams that price covers; read the size and FIX obvious OCR
  errors ("1 56 ML" -> 156, "454 G" -> 454, "1.36 KG" -> 1360, "/100g" -> 100,
  "/lb" -> 454, "/kg" -> 1000). Treat ml as grams.
Omit a candidate entirely if it is not a real match or you cannot price it.`;

const SYSTEM_INSTRUCTION = `You decide which candidate flyer items ARE the given grocery ingredient — the
same food a shopper would buy to obtain that ingredient. ${FOOD_RULES}`;

const BATCH_SYSTEM_INSTRUCTION = `You match candidate flyer items to a list of grocery ingredients. Each candidate
lists the ingredient number(s) it MIGHT be ("could match"). Assign a candidate ONLY
to one of its listed ingredient numbers, and ONLY if it is truly that same food.
${FOOD_RULES}`;

/** Per-ingredient response: indices are positions in that ingredient's candidate list. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    accepted: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          unitPriceDollars: { type: 'number' },
          quantityGrams: { type: 'number' },
        },
        required: ['index', 'unitPriceDollars', 'quantityGrams'],
      },
    },
  },
};

/** Batched response: ingredientIndex into the recipe, candidateIndex into the numbered prompt list. */
const BATCH_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    accepted: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ingredientIndex: { type: 'integer' },
          candidateIndex: { type: 'integer' },
          unitPriceDollars: { type: 'number' },
          quantityGrams: { type: 'number' },
        },
        required: ['ingredientIndex', 'candidateIndex', 'unitPriceDollars', 'quantityGrams'],
      },
    },
  },
  required: ['accepted'],
};

interface GeminiResponse extends WithUsage {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}
interface AcceptedItem {
  index: number;
  unitPriceDollars: number;
  quantityGrams: number;
}
interface AcceptResult {
  accepted?: AcceptedItem[];
}
interface BatchAccepted {
  ingredientIndex: number;
  /** Position in the numbered candidate list of the prompt (NOT the global items[] index). */
  candidateIndex: number;
  unitPriceDollars: number;
  quantityGrams: number;
}
interface BatchResult {
  accepted?: BatchAccepted[];
}

/** A normalized assignment ready to apply: global item index + the ingredient it satisfies. */
interface Assignment {
  itemIndex: number;
  ingredientName: string;
  unitPriceDollars: number;
  quantityGrams: number;
}

export interface GeminiAnalyzerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Override the classification cache (option D); defaults to a shared process-wide LRU. */
  classificationCache?: LruCache<ClassificationDecision>;
  /** Clock for cache-freshness checks; defaults to the real clock. */
  now?: () => Date;
}

export interface AnalyzerOutput {
  items: FlyerItem[];
  matcher: CandidateMatcher;
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export class GeminiAnalyzer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: LruCache<ClassificationDecision>;
  private readonly now: () => Date;

  constructor(options: GeminiAnalyzerOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set (required for --live analysis).');
    }
    this.apiKey = apiKey;
    // Option H: the analyzer is the bulk token consumer, so it can point at a cheaper
    // tier (GEMINI_ANALYZER_MODEL) independently of the recipe parser (GEMINI_MODEL).
    this.model =
      options.model ?? process.env.GEMINI_ANALYZER_MODEL ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cache = options.classificationCache ?? sharedClassificationCache;
    this.now = options.now ?? (() => new Date());
  }

  /** POST one generateContent request and return the parsed JSON text payload. */
  private async generate(
    label: string,
    systemInstruction: string,
    prompt: string,
    responseSchema: unknown,
  ): Promise<string> {
    const url = `${BASE_URL}/${this.model}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: 0 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini analysis failed for ${label} (${res.status}). ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as GeminiResponse;
    recordUsage(`analyzer:${label}`, body);
    return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  }

  /** SINGLE batched call over the whole deduplicated candidate universe. */
  private async acceptBatch(recipe: Recipe, plan: BatchPlan, items: FlyerItem[]): Promise<Assignment[]> {
    if (plan.candidates.length === 0) return [];

    const ingredientList = recipe.ingredients.map((ing, i) => `${i}. ${ing.name}`).join('\n');
    const candidateList = plan.candidates
      .map((c, local) => {
        const it = items[c.itemIndex]!;
        const size = it.size ? ` | size: ${it.size}` : '';
        return `${local}. "${it.name}" | price: ${it.rawPrice}${size} | could match: ${c.ingredientIndices.join(', ')}`;
      })
      .join('\n');
    const prompt = `Ingredients:\n${ingredientList}\n\nCandidates:\n${candidateList}`;

    const text = await this.generate('batch', BATCH_SYSTEM_INSTRUCTION, prompt, BATCH_RESPONSE_SCHEMA);
    const parsed = JSON.parse(text) as BatchResult;

    // Map candidate-universe positions back to global item indices, and keep only
    // assignments to an ingredient the item was actually a candidate for.
    const out: Assignment[] = [];
    for (const a of parsed.accepted ?? []) {
      const cand = plan.candidates[a.candidateIndex];
      if (!cand) continue;
      if (!cand.ingredientIndices.includes(a.ingredientIndex)) continue;
      const ingredient = recipe.ingredients[a.ingredientIndex];
      if (!ingredient) continue;
      out.push({
        itemIndex: cand.itemIndex,
        ingredientName: ingredient.name,
        unitPriceDollars: a.unitPriceDollars,
        quantityGrams: a.quantityGrams,
      });
    }
    return out;
  }

  /** Per-ingredient call (the fallback path), over that ingredient's candidates only. */
  private async acceptFor(ingredient: Ingredient, candidateIdx: number[], items: FlyerItem[]): Promise<Assignment[]> {
    if (candidateIdx.length === 0) return [];
    const list = candidateIdx
      .map((idx, local) => {
        const it = items[idx]!;
        return `${local}. "${it.name}" | price: ${it.rawPrice}${it.size ? ` | size: ${it.size}` : ''}`;
      })
      .join('\n');
    const prompt = `Ingredient: ${ingredient.name}\n\nCandidates:\n${list}`;

    const text = await this.generate(ingredient.name, SYSTEM_INSTRUCTION, prompt, RESPONSE_SCHEMA);
    const parsed = JSON.parse(text) as AcceptResult;
    return (parsed.accepted ?? [])
      .filter((a) => a.index >= 0 && a.index < candidateIdx.length)
      .map((a) => ({
        itemIndex: candidateIdx[a.index]!,
        ingredientName: ingredient.name,
        unitPriceDollars: a.unitPriceDollars,
        quantityGrams: a.quantityGrams,
      }));
  }

  /** Original one-call-per-ingredient path, used when the batched call is untrustworthy. */
  private async fallbackPerIngredient(recipe: Recipe, items: FlyerItem[]): Promise<Assignment[]> {
    if (process.env.PANTRYDEAL_DEBUG) {
      process.stderr.write('[batch] coverage below floor or call failed — falling back to per-ingredient\n');
    }
    const perIngredient = await mapPool(recipe.ingredients, CONCURRENCY, (ingredient) =>
      this.acceptFor(ingredient, lexicalCandidates(ingredient, items), items),
    );
    return perIngredient.flat();
  }

  /** Apply accepted assignments onto a copy of the items, returning the assignment map. */
  private applyAssignments(assignments: Assignment[], enriched: FlyerItem[]): Map<FlyerItem, string> {
    const assignment = new Map<FlyerItem, string>();
    for (const a of assignments) {
      if (a.unitPriceDollars > 0 && a.quantityGrams > 0) {
        const item = enriched[a.itemIndex]!;
        if (process.env.PANTRYDEAL_DEBUG) {
          process.stderr.write(`[match] ${a.ingredientName} <- "${item.name}" ($${a.unitPriceDollars}/${a.quantityGrams}g)\n`);
        }
        item.rawPrice = `$${a.unitPriceDollars}`;
        item.size = `${a.quantityGrams} g`;
        assignment.set(item, a.ingredientName.toLowerCase());
      }
    }
    return assignment;
  }

  /** Split candidates into cached (fresh) decisions vs a reduced plan needing the LLM. */
  private splitCache(recipe: Recipe, plan: BatchPlan, items: FlyerItem[]): { cached: Assignment[]; reduced: BatchPlan } {
    const now = this.now();
    const cached: Assignment[] = [];
    const reducedCandidates: BatchCandidate[] = [];

    for (const c of plan.candidates) {
      const item = items[c.itemIndex]!;
      const fresh = isFresh(item.validTo, now);
      const undecided: number[] = [];
      for (const ingIdx of c.ingredientIndices) {
        const ingredient = recipe.ingredients[ingIdx]!;
        const hit = fresh ? this.cache.get(classificationKey(ingredient.name, item)) : undefined;
        if (hit === undefined) {
          undecided.push(ingIdx);
        } else if (hit.accept && hit.unitPriceDollars && hit.quantityGrams) {
          cached.push({
            itemIndex: c.itemIndex,
            ingredientName: ingredient.name,
            unitPriceDollars: hit.unitPriceDollars,
            quantityGrams: hit.quantityGrams,
          });
        }
        // a cached reject is decided -> simply excluded from the LLM call.
      }
      if (undecided.length > 0) reducedCandidates.push({ itemIndex: c.itemIndex, ingredientIndices: undecided });
    }
    return {
      cached,
      reduced: { candidates: reducedCandidates, ingredientHasCandidates: plan.ingredientHasCandidates },
    };
  }

  /** Persist the LLM's decision for every (item, ingredient) pair it was asked about. */
  private writeCache(recipe: Recipe, reduced: BatchPlan, items: FlyerItem[], llm: Assignment[]): void {
    const now = this.now();
    const accepted = new Map<string, Assignment>();
    for (const a of llm) accepted.set(`${a.itemIndex} ${a.ingredientName.toLowerCase()}`, a);

    for (const c of reduced.candidates) {
      const item = items[c.itemIndex]!;
      if (!isFresh(item.validTo, now)) continue; // only cache deals whose freshness we can later prove
      for (const ingIdx of c.ingredientIndices) {
        const ingredient = recipe.ingredients[ingIdx]!;
        const key = classificationKey(ingredient.name, item);
        const hit = accepted.get(`${c.itemIndex} ${ingredient.name.toLowerCase()}`);
        if (hit && hit.unitPriceDollars > 0 && hit.quantityGrams > 0) {
          this.cache.set(key, { accept: true, unitPriceDollars: hit.unitPriceDollars, quantityGrams: hit.quantityGrams });
        } else {
          this.cache.set(key, { accept: false });
        }
      }
    }
  }

  async prepare(recipe: Recipe, allItems: FlyerItem[]): Promise<AnalyzerOutput> {
    const enriched: FlyerItem[] = allItems.map((it) => ({ ...it }));
    const plan = buildBatchPlan(recipe.ingredients, enriched);
    // Option D: serve fresh cached decisions; only the undecided pairs reach the LLM.
    // A full cache hit means the reduced plan is empty and no Gemini call is made.
    const { cached, reduced } = this.splitCache(recipe, plan, enriched);

    let assignments: Assignment[];
    try {
      const llm = await this.acceptBatch(recipe, reduced, enriched);

      // Judge the batch call on ITS OWN slice: the ingredients only it could still
      // resolve (undecided in the reduced plan, with no cached accept). Combined
      // coverage would let a warm cache mask a misfired batch, and its wrong REJECTs
      // would then be cached and replayed until the flyer rotates.
      const ingredientIndex = new Map(recipe.ingredients.map((ing, i) => [ing.name, i]));
      const matchedBy = (assigned: Assignment[]): Set<number> => {
        const matched = new Set<number>();
        for (const a of assigned) {
          if (a.unitPriceDollars > 0 && a.quantityGrams > 0) {
            const i = ingredientIndex.get(a.ingredientName);
            if (i !== undefined) matched.add(i);
          }
        }
        return matched;
      };
      const cachedMatched = matchedBy(cached);
      const llmOnlyHasCandidates = recipe.ingredients.map(() => false);
      for (const c of reduced.candidates) {
        for (const ingIdx of c.ingredientIndices) {
          if (!cachedMatched.has(ingIdx)) llmOnlyHasCandidates[ingIdx] = true;
        }
      }
      const coverage = coverageOf(matchedBy(llm), llmOnlyHasCandidates);
      if (belowFloor(coverage)) {
        assignments = await this.fallbackPerIngredient(recipe, enriched);
      } else {
        // Only persist decisions from a batch call we trust (coverage >= floor);
        // caching a misfired batch's rejects would replay them on every request.
        this.writeCache(recipe, reduced, enriched, llm);
        assignments = [...cached, ...llm];
      }
    } catch {
      assignments = await this.fallbackPerIngredient(recipe, enriched);
    }

    const assignment = this.applyAssignments(assignments, enriched);
    const matcher: CandidateMatcher = {
      matches: (ingredient: Ingredient, item: FlyerItem): boolean =>
        assignment.get(item) === ingredient.name.toLowerCase(),
    };
    return { items: enriched, matcher };
  }
}
