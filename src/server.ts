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
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';
import {
  NoRecipeError,
  optimizePlan,
  planPurchase,
  computeRecipeNutrition,
  nutritionForMatched,
  lowerCarbSwaps,
  validateRecipe,
  type PipelineResult,
  type PlanItem,
  type Recipe,
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Shape one plan item for the UI. */
function itemDto(it: PlanItem) {
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
  };
}

/**
 * Build the UI response around the two-store shopping plan (D13/D14): the real
 * cheapest way to actually buy the recipe, plus where else the misses are on
 * sale and what's not on sale anywhere.
 */
function toResponse(result: PipelineResult, postal: string) {
  const { recipe, rankedStores } = result;
  const plan = optimizePlan(recipe.ingredients, rankedStores);

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
        items: t.items.map(itemDto),
      })),
      bestDeals: plan.bestDeals.map((d) => ({ ingredient: d.ingredient, product: d.item.name, store: d.item.merchant })),
      onSaleElsewhere: plan.onSaleElsewhere.map((name) => ({ ingredient: name, ...(elsewhereFor(name) ?? {}) })),
      neverOnSale: plan.neverOnSale,
    },
  };
}

/**
 * The prediabetes "blood-sugar lens" for an imported recipe (CEO plan 2026-06-09).
 * Per-serving carbs/fiber/protein over the ingredients we can match to the table
 * (most web recipes contain un-tabled items, so this is an honest partial estimate),
 * a gentle plain-language read, lower-carb swaps, and — only when every ingredient
 * is known — the prediabetes pass/amber verdict. Null when nothing matched.
 */
function healthLensDto(recipe: Recipe) {
  // Per-serving math uses the recipe's own yield, not the shopper headcount.
  const partial = nutritionForMatched(recipe.ingredients, recipe.servings);
  if (!partial) return null;
  const { nutrition, matched, total, missing } = partial;
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
        items: t.items.map(itemDto),
      })),
      neverOnSale: cart.neverOnSale,
    },
  };
}

async function handlePlanWeek(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postal?: string; people?: number; budget?: number; days?: number; live?: boolean; restrictions?: string[]; exclude?: string[] };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
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
    });
    sendJson(res, 200, toWeekResponse(result, postal, people ?? 4));
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postal?: string; dinner?: string; people?: number; live?: boolean };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
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
    sendJson(res, 200, toResponse(result, postal));
  } catch (err) {
    const message = err instanceof NoRecipeError ? err.message : (err as Error).message;
    sendJson(res, err instanceof NoRecipeError ? 422 : 500, { error: message });
  }
}

async function handleRecipe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postal?: string; url?: string; text?: string; people?: number };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
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
    sendJson(res, 200, { ...toResponse(result, postal), health: healthLensDto(result.recipe), source });
  } catch (err) {
    // Map the named parser errors to honest statuses + messages (no silent failures).
    const e = err as Error;
    const userFacing = new Set([
      'InvalidUrlError',
      'BlockedHostError',
      'FetchFailedError',
      'NoRecipeFoundError',
    ]);
    if (userFacing.has(e.name)) {
      const status = e.name === 'BlockedHostError' ? 400 : 422;
      return sendJson(res, status, { error: e.message, code: e.name });
    }
    sendJson(res, 500, { error: e.message });
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = (req.url ?? '/').split('?')[0]!;
  const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) {
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

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
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
});

server.listen(PORT, () => {
  process.stdout.write(
    `PantryDeal web UI running at http://localhost:${PORT}  (live mode ${liveAvailable() ? 'available' : 'disabled — set GEMINI_API_KEY'})\n`,
  );
});
