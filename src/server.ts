#!/usr/bin/env node
/**
 * PantryDeal web server: serves the single-page UI and a small JSON API that
 * runs the exact same pipeline as the CLI. API keys are read from the server
 * environment and never sent to the browser.
 *
 *   npm run serve        # dev (tsx)
 *   node dist/server.js  # built
 *
 * PORT (default 3000) configures the listen port.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join, normalize, sep } from 'node:path';
import {
  NoRecipeError,
  optimizePlan,
  planPurchase,
  computeRecipeNutrition,
  nutritionForMatched,
  lowerCarbSwaps,
  validateRecipe,
  describeSubstitution,
  type PipelineResult,
  type PlanItem,
  type Recipe,
  type Substitution,
} from './core/index.js';
import {
  search,
  liveAvailable,
  planPrediabetesWeek,
  priceRecipeFromSource,
  type MealPricing,
  type WeekResult,
} from './runner.js';

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** Hard cap on request bodies (S3): JSON API payloads are tiny, so 64 KiB is plenty. */
const MAX_BODY_BYTES = 64 * 1024; // 65536

/**
 * Best-effort, per-process in-memory rate limit (S4). Keyed by client IP, this
 * is a fixed-window guard intended for the localhost / single-instance posture
 * — it is NOT a substitute for a real edge limiter behind a load balancer.
 * Applied only to the live POST /api/* endpoints (which can burn API credits),
 * never to static files or /api/config.
 */
const RATE_LIMIT_MAX = 30; // requests …
const RATE_LIMIT_WINDOW_MS = 60_000; // … per 60s window, per IP
const rateHits = new Map<string, number[]>();

/** Sentinel thrown by readBody when a request body exceeds MAX_BODY_BYTES (S3). */
export class PayloadTooLargeError extends Error {
  override readonly name = 'PayloadTooLargeError';
  constructor() {
    super('Request body too large.');
  }
}

/**
 * Record a hit for `ip` and report whether it is now over the limit. Old
 * timestamps outside the window are pruned on each call so the map stays small.
 * Returns true when the request should be allowed, false when it must be 429'd.
 */
export function rateLimitAllow(ip: string, now: number = Date.now()): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateHits.get(ip) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  rateHits.set(ip, recent);
  return recent.length <= RATE_LIMIT_MAX;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * Buffer the request body, capped at MAX_BODY_BYTES (S3). We accumulate chunk
 * lengths as we go and bail the moment the running total exceeds the cap —
 * destroying the stream so we stop consuming — by throwing PayloadTooLargeError.
 * Handlers translate that sentinel into an HTTP 413.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Stop consuming the stream and signal "too large" to the caller.
      req.destroy();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Shared catch translation for the body-read step: 413 over-cap, else 400 bad JSON. */
function sendBodyError(res: ServerResponse, err: unknown): void {
  if (err instanceof PayloadTooLargeError) {
    sendJson(res, 413, { error: 'Request body too large.' });
    return;
  }
  sendJson(res, 400, { error: 'Invalid JSON body.' });
}

/**
 * Shape one plan item for the UI. `sub` (when the matched product is a different
 * cut/form than the shopper wrote) lets the UI flag the substitution honestly
 * instead of silently showing, say, drumsticks for "chicken thighs".
 */
function itemDto(it: PlanItem, sub?: Substitution | null) {
  return {
    ingredient: it.ingredient,
    neededGrams: it.neededGrams,
    product: it.item.name,
    rawPrice: it.item.rawPrice,
    pricePerGram: it.pricePerGram,
    realCost: it.realCost,
    portionCost: it.portionCost,
    packPrice: it.packPrice,
    packGrams: it.packGrams,
    unitsNeeded: it.unitsNeeded,
    leftoverGrams: Math.round(it.leftoverGrams),
    basis: it.basis,
    goodDeal: it.goodDeal,
    // Only surface when a genuinely different cut/form was substituted.
    ...(sub && sub.verdict === 'different' ? { requestedAs: sub.requestedAs, differentForm: true } : {}),
  };
}

/**
 * Build the UI response around the two-store shopping plan (D13/D14): the real
 * cheapest way to actually buy the recipe, plus where else the misses are on
 * sale and what's not on sale anywhere.
 */
/**
 * Resolve the cut/form verdict for every plan item (layered, cheapest first —
 * see core/substitution.ts). The deterministic layers settle most pairs free;
 * the lexically-ambiguous remainder goes to ONE batched, cached FormJudge call.
 * If the judge is unavailable or fails, ambiguous resolves to 'different' (the
 * honest default: over-warn rather than silently pass off a wrong cut).
 */
async function resolveSubstitutions(
  recipe: Recipe,
  items: PlanItem[],
): Promise<Map<PlanItem, Substitution>> {
  const asWrittenByName = new Map(recipe.ingredients.map((i) => [i.name, i.asWritten]));
  const out = new Map<PlanItem, Substitution>();
  const ambiguous: Array<{ item: PlanItem; sub: Substitution }> = [];

  for (const it of items) {
    const sub = describeSubstitution(asWrittenByName.get(it.ingredient), it.ingredient, it.item.name);
    if (!sub) continue;
    if (sub.verdict === 'ambiguous') ambiguous.push({ item: it, sub });
    else out.set(it, sub);
  }

  if (ambiguous.length > 0 && liveAvailable()) {
    try {
      const { FormJudge } = await import('./integrations/formJudge.js');
      const verdicts = await new FormJudge().judge(
        ambiguous.map(({ sub }) => ({ requestedAs: sub.requestedAs, matched: sub.matched })),
      );
      ambiguous.forEach(({ item, sub }, i) => {
        // null (judge failed) falls back to 'different' — honest over silent.
        out.set(item, { ...sub, verdict: verdicts[i] === true ? 'same' : 'different' });
      });
      return out;
    } catch {
      // fall through to the honest default below
    }
  }
  for (const { item, sub } of ambiguous) out.set(item, { ...sub, verdict: 'different' });
  return out;
}

async function toResponse(result: PipelineResult, postal: string, includeStaples = false) {
  const { recipe, rankedStores } = result;
  // Default: assume tiny pantry/spice amounts are on hand (honest pricing).
  // includeStaples: the shopper has nothing — price every ingredient.
  const plan = optimizePlan(recipe.ingredients, rankedStores, { assumeStaples: !includeStaples });

  // Cut/form honesty flags, resolved once for all items across the trips.
  const subs = await resolveSubstitutions(recipe, plan.trips.flatMap((t) => t.items));
  const subFor = (it: PlanItem) => subs.get(it) ?? null;

  // For ingredients on sale elsewhere (not at the chosen stores), point the
  // shopper at the cheapest other store by real pack cost.
  const elsewhereFor = (name: string) => {
    let best: { store: string; realCost: number; product: string } | null = null;
    for (const b of rankedStores) {
      const m = b.matches.find((x) => x.ingredient.name === name && x.status === 'MATCHED' && x.item);
      if (!m || !m.item) continue;
      const p = planPurchase(m.item.rawPrice, m.item.size, m.neededGrams);
      if (!p) continue;
      if (best === null || p.realCost < best.realCost) {
        best = { store: b.store.name, realCost: p.realCost, product: m.item.name };
      }
    }
    return best;
  };

  return {
    postal,
    recipe: {
      dish: recipe.dish,
      servings: recipe.servings,
      ingredients: recipe.ingredients.map((i) => ({ name: i.name, qtyGrams: i.qtyGrams })),
    },
    plan: {
      storeCount: plan.storeCount,
      coverage: plan.coverage,
      totalIngredients: plan.totalIngredients,
      realOnSale: plan.realOnSale,
      estRegularGaps: plan.estRegularGaps,
      fullTotal: plan.fullTotal,
      savingsVsOneStore: plan.savingsVsOneStore,
      secondStopSavings: plan.secondStopSavings,
      savingsVsRegular: plan.savingsVsRegular,
      oneStore: plan.oneStore
        ? { name: plan.oneStore.store.name, merchant: plan.oneStore.store.merchant, fullTotal: plan.oneStore.fullTotal }
        : null,
      trips: plan.trips.map((t) => ({
        store: t.store.name,
        merchant: t.store.merchant,
        address: t.store.address,
        distanceKm: t.store.distanceKm,
        realSubtotal: t.realSubtotal,
        items: t.items.map((it) => itemDto(it, subFor(it))),
      })),
      bestDeals: plan.bestDeals.map((d) => ({ ingredient: d.ingredient, product: d.item.name, store: d.item.merchant })),
      onSaleElsewhere: plan.onSaleElsewhere.map((name) => ({ ingredient: name, ...(elsewhereFor(name) ?? {}) })),
      neverOnSale: plan.neverOnSale,
      // Pantry staples assumed on hand (empty when includeStaples was true).
      staples: plan.staples,
      staplesCount: plan.staples.length,
      fullTotalWithStaples: plan.fullTotalWithStaples,
    },
  };
}

/**
 * The prediabetes "blood-sugar lens" for an imported recipe (CEO plan 2026-06-09).
 * Per-serving carbs/fiber/protein over the ingredients we can match to the table
 * (most web recipes contain un-tabled items, so this is an honest partial estimate),
 * a gentle plain-language read, lower-carb swaps, and — only when every ingredient
 * is known — the prediabetes pass/amber verdict. Null when nothing matched.
 *
 * Coverage gate: with fewer than 3 matched ingredients or under 60% coverage the
 * macro estimate is junk (a noodle dish read "1g carb / Lower-carb" off one known
 * ingredient), so we return a LIMITED shape — no numbers, no read, no verdict —
 * just honest coverage plus the swaps, which don't need macro data.
 * Exported for testing.
 */
export function healthLensDto(recipe: Recipe) {
  // Per-serving math uses the recipe's own yield, not the shopper headcount.
  const partial = nutritionForMatched(recipe.ingredients, recipe.servings);
  if (!partial) return null;
  const { nutrition, matched, total, missing } = partial;

  const coverage = matched / total;
  if (matched < 3 || coverage < 0.6) {
    return {
      limited: true as const,
      matched,
      total,
      coverageNote: `We only recognize ${matched} of ${total} ingredients — not enough for a reliable blood-sugar estimate.`,
      swaps: lowerCarbSwaps(recipe.ingredients),
    };
  }

  const carbsG = Math.round(nutrition.carbsG);
  const fiberG = Math.round(nutrition.fiberG);
  const proteinG = Math.round(nutrition.proteinG);

  // Gentle, non-judgmental read keyed off the carb load (DRAFT targets, D15).
  const read =
    carbsG > 60
      ? 'Higher-carb — a smaller starch portion or extra non-starchy veg eases the spike.'
      : carbsG > 30
        ? 'Moderate carbs — pairing with protein and fiber helps keep blood sugar steady.'
        : 'Lower-carb — a gentle choice for steady blood sugar.';

  // Full prediabetes verdict only when we have data for every ingredient.
  const fullCoverage = missing.length === 0;
  const verdict = fullCoverage ? validateRecipe(recipe) : null;

  return {
    limited: false as const,
    perServing: { carbsG, fiberG, proteinG },
    matched,
    total,
    coverageNote:
      missing.length > 0 ? `Estimate based on ${matched} of ${total} ingredients we could match.` : null,
    read,
    swaps: lowerCarbSwaps(recipe.ingredients),
    verdict: verdict ? { fits: verdict.ok, notes: verdict.violations } : null,
  };
}

/** Lightweight dish entry: menu + per-serving nutrition so the health value is visible. */
function mealDto(m: MealPricing) {
  const n = computeRecipeNutrition(m.recipe.ingredients, m.recipe.servings);
  return {
    dish: m.recipe.dish,
    servings: m.recipe.servings,
    ingredients: m.recipe.ingredients.map((i) => ({ name: i.name, qtyGrams: i.qtyGrams })),
    nutrition: n.ok
      ? { carbsG: Math.round(n.nutrition.carbsG), fiberG: Math.round(n.nutrition.fiberG), proteinG: Math.round(n.nutrition.proteinG) }
      : null,
  };
}

function toWeekResponse(result: WeekResult, postal: string, people: number) {
  const { week, cart } = result;
  return {
    postal,
    people,
    budget: week.budget,
    days: week.days,
    total: week.total,
    withinBudget: week.withinBudget,
    overBy: week.overBy,
    shortfall: week.shortfall,
    meals: result.meals.map(mealDto),
    // The single pooled weekly shopping cart.
    cart: {
      realOnSale: cart.realOnSale,
      estRegularGaps: cart.estRegularGaps,
      fullTotal: cart.fullTotal,
      savingsVsRegular: cart.savingsVsRegular,
      coverage: cart.coverage,
      totalIngredients: cart.totalIngredients,
      storeCount: cart.storeCount,
      trips: cart.trips.map((t) => ({
        store: t.store.name,
        merchant: t.store.merchant,
        address: t.store.address,
        distanceKm: t.store.distanceKm,
        realSubtotal: t.realSubtotal,
        items: t.items.map((it) => itemDto(it)),
      })),
      neverOnSale: cart.neverOnSale,
      // Pantry staples assumed on hand (empty when includeStaples was true).
      staples: cart.staples,
      staplesCount: cart.staples.length,
      fullTotalWithStaples: cart.fullTotalWithStaples,
    },
  };
}

/** Shared 422 mapping for a bad postal code (matched by name — see zippopotam.ts). */
function sendPostalNotFound(res: ServerResponse, err: unknown): boolean {
  if (err instanceof Error && err.name === 'PostalNotFoundError') {
    sendJson(res, 422, { error: err.message, code: 'PostalNotFoundError' });
    return true;
  }
  return false;
}

export async function handlePlanWeek(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postal?: string; people?: number; budget?: number; days?: number; live?: boolean; restrictions?: string[]; exclude?: string[]; includeStaples?: boolean };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return sendBodyError(res, err);
  }
  const postal = (body.postal ?? '').trim();
  const budget = Number(body.budget);
  if (!postal || !Number.isFinite(budget) || budget <= 0) {
    return sendJson(res, 400, { error: 'A postal code and a positive weekly budget are required.' });
  }
  const people = body.people != null ? Number(body.people) : undefined;
  if (people !== undefined && (!Number.isFinite(people) || people <= 0)) {
    return sendJson(res, 400, { error: 'People must be a positive number.' });
  }
  const live = Boolean(body.live);
  if (live && !liveAvailable()) {
    return sendJson(res, 400, { error: 'Live mode needs GEMINI_API_KEY set on the server. Try Sample data instead.' });
  }
  try {
    const result = await planPrediabetesWeek({
      postal,
      people,
      budget,
      days: body.days != null ? Number(body.days) : undefined,
      live,
      restrictions: Array.isArray(body.restrictions) ? body.restrictions : undefined,
      exclude: Array.isArray(body.exclude) ? body.exclude : undefined,
      includeStaples: Boolean(body.includeStaples),
    });
    sendJson(res, 200, toWeekResponse(result, postal, people ?? 4));
  } catch (err) {
    // A bad postal code is the user's to fix → 422 with the safe message.
    if (sendPostalNotFound(res, err)) return;
    // S2: log the real cause server-side, return a generic message so vendor /
    // upstream error bodies (e.g. Gemini error text) never leak to the client.
    const e = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[plan-week] unhandled error: ${e.stack ?? e.message}\n`);
    sendJson(res, 500, { error: 'Something went wrong planning that week. Please try again.' });
  }
}

export async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postal?: string; dinner?: string; people?: number; live?: boolean; includeStaples?: boolean };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return sendBodyError(res, err);
  }

  const postal = (body.postal ?? '').trim();
  const dinner = (body.dinner ?? '').trim();
  if (!postal || !dinner) {
    return sendJson(res, 400, { error: 'Both a postal code and a dinner are required.' });
  }
  const people = body.people != null ? Number(body.people) : undefined;
  if (people !== undefined && (!Number.isFinite(people) || people <= 0)) {
    return sendJson(res, 400, { error: 'People must be a positive number.' });
  }
  const live = Boolean(body.live);
  if (live && !liveAvailable()) {
    return sendJson(res, 400, {
      error: 'Live mode needs GEMINI_API_KEY set on the server. Try Sample data instead.',
    });
  }

  try {
    const result = await search({ postal, dinner, people, live });
    sendJson(res, 200, await toResponse(result, postal, Boolean(body.includeStaples)));
  } catch (err) {
    // A bad postal code is the user's to fix → 422 with the safe message.
    if (sendPostalNotFound(res, err)) return;
    // NoRecipeError is a safe, user-facing domain error → 422 with its message.
    // Off live, point at the web UI's own escape hatch (the core message no
    // longer mentions the CLI's --live flag).
    if (err instanceof NoRecipeError) {
      const message = live ? err.message : err.message + ' Switch the data source to Live to price any dish.';
      return sendJson(res, 422, { error: message });
    }
    // S2: any other failure → log the real cause server-side, return a generic
    // message so vendor / upstream error bodies never leak to the client.
    const e = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`[search] unhandled error: ${e.stack ?? e.message}\n`);
    sendJson(res, 500, { error: 'Something went wrong running that search. Please try again.' });
  }
}

export async function handleRecipe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postal?: string; url?: string; text?: string; people?: number; includeStaples?: boolean };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return sendBodyError(res, err);
  }

  const postal = (body.postal ?? '').trim();
  const url = (body.url ?? '').trim();
  const text = (body.text ?? '').trim();
  if (!postal) return sendJson(res, 400, { error: 'A postal code is required.' });
  if (!url && !text) {
    return sendJson(res, 400, { error: 'Enter a recipe URL or paste the ingredients.' });
  }
  // The Recipe view is inherently live: it needs Gemini to read the recipe.
  if (!liveAvailable()) {
    return sendJson(res, 400, {
      error: 'Recipe import needs GEMINI_API_KEY set on the server.',
    });
  }
  const people = body.people != null ? Number(body.people) : undefined;
  if (people !== undefined && (!Number.isFinite(people) || people <= 0)) {
    return sendJson(res, 400, { error: 'People must be a positive number.' });
  }

  try {
    const { result, source } = await priceRecipeFromSource({ postal, url, text, people });
    sendJson(res, 200, {
      ...(await toResponse(result, postal, Boolean(body.includeStaples))),
      health: healthLensDto(result.recipe),
      source,
    });
  } catch (err) {
    // Map the named parser errors to honest statuses + messages (no silent failures).
    const e = err instanceof Error ? err : new Error(String(err));
    const userFacing = new Set([
      'InvalidUrlError',
      'BlockedHostError',
      'FetchFailedError',
      'NoRecipeFoundError',
      'PostalNotFoundError',
    ]);
    if (userFacing.has(e.name)) {
      const status = e.name === 'BlockedHostError' ? 400 : 422;
      return sendJson(res, status, { error: e.message, code: e.name });
    }
    // Unmapped failure (e.g. Backflipp/geocoder down): log the real cause
    // server-side, return a generic message so vendor/internal strings don't leak.
    process.stderr.write(`[recipe] unhandled error: ${e.stack ?? e.message}\n`);
    sendJson(res, 500, { error: 'Something went wrong pricing that recipe. Please try again.' });
  }
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = (req.url ?? '/').split('?')[0]!;
  const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(WEB_DIR, rel);
  // S5: require the resolved path to be WEB_DIR itself or strictly under it
  // (WEB_DIR + path separator). A bare startsWith(WEB_DIR) would also accept a
  // sibling like "<WEB_DIR>-secret"; the trailing `sep` closes that bypass.
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

/**
 * Top-level request handler. Exported so tests can drive it with fake
 * IncomingMessage / ServerResponse objects without binding a port.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? '/').split('?')[0];
  // S4: throttle the three live POST /api/* endpoints (those that can burn API
  // credits) per client IP. Static files and /api/config are deliberately exempt.
  if (req.method === 'POST' && (url === '/api/search' || url === '/api/plan-week' || url === '/api/recipe')) {
    const ip = req.socket?.remoteAddress ?? 'unknown';
    if (!rateLimitAllow(ip)) {
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
      });
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
      return;
    }
  }
  if (req.method === 'POST' && url === '/api/search') {
    void handleSearch(req, res);
    return;
  }
  if (req.method === 'POST' && url === '/api/plan-week') {
    void handlePlanWeek(req, res);
    return;
  }
  if (req.method === 'POST' && url === '/api/recipe') {
    void handleRecipe(req, res);
    return;
  }
  if (req.method === 'GET' && url === '/api/config') {
    sendJson(res, 200, { liveAvailable: liveAvailable() });
    return;
  }
  if (req.method === 'GET') {
    void serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed');
}

const server = createServer(handleRequest);

// Only bind a port when run as the entry point (npm run serve / node dist/server.js).
// Importing this module (e.g. from tests) must NOT start listening.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    process.stdout.write(
      `PantryDeal web UI running at http://localhost:${PORT}  (live mode ${liveAvailable() ? 'available' : 'disabled — set GEMINI_API_KEY'})\n`,
    );
  });
}
