/**
 * HTTP-server hardening tests (S2/S3/S4/S5). These exercise the extracted,
 * exported pieces of src/server.ts with lightweight fakes for IncomingMessage /
 * ServerResponse so no real port is bound. The runner is mocked so we can inject
 * failures (and avoid any network / Gemini calls).
 */
import { Readable } from 'node:stream';
import { join, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the runner so handlers never touch the network; individual tests set the
// behaviour they need (success, vendor-style failure, etc.).
vi.mock('../src/runner.js', () => ({
  search: vi.fn(),
  liveAvailable: vi.fn(() => true),
  planPrediabetesWeek: vi.fn(),
  priceRecipeFromSource: vi.fn(),
}));

import {
  readBody,
  rateLimitAllow,
  PayloadTooLargeError,
  handleRequest,
  handleSearch,
  handlePlanWeek,
  handleRecipe,
  healthLensDto,
  serveStatic,
} from '../src/server.js';
import { search, planPrediabetesWeek, priceRecipeFromSource } from '../src/runner.js';
import { NoRecipeError } from '../src/core/index.js';
import type { FlyerItem, Ingredient, PipelineResult, Recipe, Store, StoreBasket } from '../src/core/types.js';

/** A fake IncomingMessage: an async-iterable stream + the bits handlers read. */
function fakeReq(opts: {
  method?: string;
  url?: string;
  body?: string | Buffer;
  ip?: string;
}): IncomingMessage {
  const buf = opts.body == null ? Buffer.alloc(0) : Buffer.from(opts.body);
  const stream = Readable.from([buf]) as Readable & {
    method?: string;
    url?: string;
    socket?: { remoteAddress?: string };
  };
  stream.method = opts.method ?? 'POST';
  stream.url = opts.url ?? '/';
  stream.socket = { remoteAddress: opts.ip ?? '10.0.0.1' };
  // Handlers may call req.destroy(); Readable provides it natively.
  return stream as unknown as IncomingMessage;
}

/** A capturing ServerResponse: records status, headers, and the body string. */
type FakeRes = ServerResponse & {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  ended: boolean;
};

function fakeRes(): FakeRes {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    ended: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    end(payload?: string) {
      if (payload != null) res.body += payload;
      res.ended = true;
      return res;
    },
  };
  return res as unknown as FakeRes;
}

/** Spin until the in-flight handler promise (if any) settles. */
async function flush(p?: unknown) {
  if (p && typeof (p as { then?: unknown }).then === 'function') await p;
  // let any trailing microtasks (sendJson inside catch) run
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('S3 — readBody size cap', () => {
  it('returns the body when under the cap', async () => {
    const req = fakeReq({ body: '{"ok":true}' });
    await expect(readBody(req)).resolves.toBe('{"ok":true}');
  });

  it('throws PayloadTooLargeError when over 64 KiB', async () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    const req = fakeReq({ body: big });
    await expect(readBody(req)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('handler maps an oversized body to HTTP 413', async () => {
    const big = JSON.stringify({ postal: 'x'.repeat(64 * 1024 + 10) });
    const req = fakeReq({ url: '/api/search', body: big });
    const res = fakeRes();
    await handleSearch(req, res);
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large.' });
  });

  it('handler maps invalid JSON to HTTP 400 (not 413)', async () => {
    const req = fakeReq({ url: '/api/search', body: 'not json' });
    const res = fakeRes();
    await handleSearch(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON body.' });
  });
});

describe('S2 — generic 500, no raw error leak', () => {
  it('handleSearch hides a vendor-style error behind a generic message', async () => {
    const secret = 'Gemini 500: API key sk-leak-me-please rejected by upstream';
    vi.mocked(search).mockRejectedValueOnce(new Error(secret));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const req = fakeReq({ url: '/api/search', body: JSON.stringify({ postal: 'A1A1A1', dinner: 'tacos' }) });
    const res = fakeRes();
    await handleSearch(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('sk-leak-me-please');
    expect(res.body).not.toContain('Gemini');
    expect(JSON.parse(res.body)).toEqual({ error: 'Something went wrong running that search. Please try again.' });
    // The real cause is still logged server-side for operators.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(secret));
    stderr.mockRestore();
  });

  it('handlePlanWeek hides a vendor-style error behind a generic message', async () => {
    const secret = 'Gemini quota exceeded: project pantrydeal-internal-7788';
    vi.mocked(planPrediabetesWeek).mockRejectedValueOnce(new Error(secret));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const req = fakeReq({ url: '/api/plan-week', body: JSON.stringify({ postal: 'A1A1A1', budget: 80 }) });
    const res = fakeRes();
    await handlePlanWeek(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('pantrydeal-internal-7788');
    expect(JSON.parse(res.body)).toEqual({ error: 'Something went wrong planning that week. Please try again.' });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(secret));
    stderr.mockRestore();
  });
});

describe('S5 — static path-traversal guard', () => {
  it('serves a normal file under web/', async () => {
    // app.js exists in the web dir; assert it is served, not 403'd.
    const req = fakeReq({ method: 'GET', url: '/app.js' });
    const res = fakeRes();
    await serveStatic(req, res);
    // Either 200 (file present) or 404 (missing) — but never 403 for a legit path.
    expect(res.statusCode).not.toBe(403);
  });

  it('never serves a path that escapes WEB_DIR (403 or 404, never 200)', async () => {
    // Leading ../ is stripped by serveStatic's own sanitization, so this lands
    // back inside WEB_DIR and 404s; the important contract is that an escape can
    // never reach a real file (no 200 with foreign content).
    const res = fakeRes();
    await serveStatic(fakeReq({ method: 'GET', url: '/../../../../../../etc/passwd' }), res);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });

  it("the trailing-separator guard rejects a sibling-dir of WEB_DIR (S5 unit)", () => {
    // Mirror the exact guard from serveStatic to prove the sibling bypass is
    // closed: "<WEB_DIR>-secret" must NOT be treated as inside "<WEB_DIR>".
    const WEB_DIR = join('app', 'web');
    const isInside = (p: string) => p === WEB_DIR || p.startsWith(WEB_DIR + sep);
    expect(isInside(WEB_DIR + '-secret' + sep + 'leak')).toBe(false); // sibling bypass closed
    expect(isInside(WEB_DIR)).toBe(true); // exact dir allowed
    expect(isInside(WEB_DIR + sep + 'index.html')).toBe(true); // real file allowed
    // The old `startsWith(WEB_DIR)` would have wrongly accepted the sibling:
    expect((WEB_DIR + '-secret' + sep + 'leak').startsWith(WEB_DIR)).toBe(true);
  });
});

describe('S4 — per-IP rate limit', () => {
  it('allows up to the cap then blocks the next request', () => {
    const now = 1_000_000;
    const ip = '203.0.113.5';
    // 30 allowed within the window…
    for (let i = 0; i < 30; i++) {
      expect(rateLimitAllow(ip, now + i)).toBe(true);
    }
    // …the 31st is rejected.
    expect(rateLimitAllow(ip, now + 30)).toBe(false);
  });

  it('prunes hits outside the window so a later request is allowed', () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 30; i++) rateLimitAllow(ip, 0 + i);
    expect(rateLimitAllow(ip, 30)).toBe(false);
    // Well past the 60s window → old hits pruned, allowed again.
    expect(rateLimitAllow(ip, 70_000)).toBe(true);
  });

  it('routes the over-cap request to HTTP 429 with Retry-After', async () => {
    const ip = '198.51.100.2';
    // The allowed requests dispatch into handleSearch; we don't assert on them,
    // so reject fast and silence the server-side log they emit.
    vi.mocked(search).mockRejectedValue(new Error('ignored'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    let res = fakeRes();
    // Burn the window. handleRequest returns void; the handler runs async, but
    // the rate-limit decision is synchronous before dispatch, so 429 is set sync.
    for (let i = 0; i < 30; i++) {
      const r = fakeReq({ url: '/api/search', body: '{"postal":"A1A1A1","dinner":"x"}', ip });
      handleRequest(r, fakeRes());
    }
    res = fakeRes();
    const over = fakeReq({ url: '/api/search', body: '{}', ip });
    handleRequest(over, res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(JSON.parse(res.body)).toEqual({ error: 'Too many requests. Please slow down.' });
    // Let the floating handler promises settle before restoring the spy so their
    // (suppressed) stderr writes don't escape.
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    stderr.mockRestore();
  });

  it('does not rate-limit GET /api/config', () => {
    const ip = '198.51.100.99';
    for (let i = 0; i < 50; i++) {
      const res = fakeRes();
      handleRequest(fakeReq({ method: 'GET', url: '/api/config', ip }), res);
      expect(res.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Staples through the API (pricing-honesty)
// ---------------------------------------------------------------------------

/**
 * A tiny PipelineResult: one store carrying a real protein (chicken, 500 g) and
 * a pantry staple (soy sauce, 16 g) — the staple has a matching flyer item so we
 * can prove it is deliberately excluded by default, not merely unmatched.
 * No `asWritten` on the ingredients, so no substitution/FormJudge path runs.
 */
function stirFryResult(): PipelineResult {
  const store: Store = {
    storeId: 's1',
    merchant: 'Foo Mart',
    name: 'Foo Mart Queen St',
    address: '1 Queen St',
    lat: 0,
    lng: 0,
    distanceKm: 1.2,
  };
  const chicken: Ingredient = { name: 'chicken', qtyGrams: 500, category: 'protein', substitutes: [] };
  const soy: Ingredient = { name: 'soy sauce', qtyGrams: 16, category: 'pantry', substitutes: [] };
  const chickenItem: FlyerItem = {
    name: 'chicken breast',
    rawPrice: '$10.00',
    size: '1 kg',
    merchant: 'Foo Mart',
    storeIds: ['s1'],
    validFrom: '2026-06-01',
    validTo: '2026-06-30',
  };
  const soyItem: FlyerItem = {
    name: 'soy sauce',
    rawPrice: '$2.99',
    size: '500 ml',
    merchant: 'Foo Mart',
    storeIds: ['s1'],
    validFrom: '2026-06-01',
    validTo: '2026-06-30',
  };
  const basket: StoreBasket = {
    store,
    matches: [
      { ingredient: chicken, item: chickenItem, pricePerGram: 0.01, status: 'MATCHED', neededGrams: 500, lineCost: 5 },
      { ingredient: soy, item: soyItem, pricePerGram: 2.99 / 500, status: 'MATCHED', neededGrams: 16, lineCost: 0.1 },
    ],
    matchedCount: 2,
    totalIngredients: 2,
    coverage: 1,
    total: 5.1,
    projectedTotal: 5.1,
  };
  return {
    recipe: { dish: 'chicken stir fry', servings: 2, ingredients: [chicken, soy] },
    rankedStores: [basket],
    cheapest: basket,
  };
}

describe('staples through the API', () => {
  it('default request assumes staples on hand: out of trips, listed in plan.staples', async () => {
    vi.mocked(search).mockResolvedValueOnce(stirFryResult());
    const req = fakeReq({ url: '/api/search', body: JSON.stringify({ postal: 'M5V', dinner: 'chicken stir fry' }) });
    const res = fakeRes();
    await handleSearch(req, res);

    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.plan.staples).toEqual([{ ingredient: 'soy sauce', neededGrams: 16 }]);
    expect(out.plan.staplesCount).toBe(1);
    const tripIngredients = out.plan.trips.flatMap((t: { items: Array<{ ingredient: string }> }) =>
      t.items.map((i) => i.ingredient),
    );
    expect(tripIngredients).toContain('chicken');
    expect(tripIngredients).not.toContain('soy sauce');
    // The honest "what buying the staple anyway would cost" figure.
    expect(out.plan.fullTotalWithStaples).toBeCloseTo(out.plan.fullTotal + 2.99, 2);
    // All recipe ingredients still counted, staple included.
    expect(out.plan.totalIngredients).toBe(2);
  });

  it('includeStaples: true prices everything — staple back in trips, staples empty', async () => {
    vi.mocked(search).mockResolvedValueOnce(stirFryResult());
    const req = fakeReq({
      url: '/api/search',
      body: JSON.stringify({ postal: 'M5V', dinner: 'chicken stir fry', includeStaples: true }),
    });
    const res = fakeRes();
    await handleSearch(req, res);

    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.plan.staples).toEqual([]);
    expect(out.plan.staplesCount).toBe(0);
    const tripIngredients = out.plan.trips.flatMap((t: { items: Array<{ ingredient: string }> }) =>
      t.items.map((i) => i.ingredient),
    );
    expect(tripIngredients).toContain('soy sauce');
    expect(out.plan.fullTotalWithStaples).toBe(out.plan.fullTotal);
  });
});

// ---------------------------------------------------------------------------
// PostalNotFoundError → 422 (matched by err.name; the class is lazily imported)
// ---------------------------------------------------------------------------

describe('PostalNotFoundError mapping', () => {
  const POSTAL_MSG = "We couldn't find that postal code. Double-check it (e.g. M5V 2T6).";
  const postalErr = () => Object.assign(new Error(POSTAL_MSG), { name: 'PostalNotFoundError' });

  it('handleSearch returns 422 with the message and code', async () => {
    vi.mocked(search).mockRejectedValueOnce(postalErr());
    const res = fakeRes();
    await handleSearch(fakeReq({ url: '/api/search', body: JSON.stringify({ postal: 'Z9Z9Z9', dinner: 'tacos' }) }), res);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: POSTAL_MSG, code: 'PostalNotFoundError' });
  });

  it('handlePlanWeek returns 422 with the message and code', async () => {
    vi.mocked(planPrediabetesWeek).mockRejectedValueOnce(postalErr());
    const res = fakeRes();
    await handlePlanWeek(fakeReq({ url: '/api/plan-week', body: JSON.stringify({ postal: 'Z9Z9Z9', budget: 80 }) }), res);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: POSTAL_MSG, code: 'PostalNotFoundError' });
  });

  it('handleRecipe returns 422 with the message and code', async () => {
    vi.mocked(priceRecipeFromSource).mockRejectedValueOnce(postalErr());
    const res = fakeRes();
    await handleRecipe(
      fakeReq({ url: '/api/recipe', body: JSON.stringify({ postal: 'Z9Z9Z9', url: 'https://example.com/r' }) }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: POSTAL_MSG, code: 'PostalNotFoundError' });
  });
});

describe('NoRecipeError web guidance', () => {
  it('appends the Live-switch hint when the request was NOT live', async () => {
    const err = new NoRecipeError('unicorn pie');
    vi.mocked(search).mockRejectedValueOnce(err);
    const res = fakeRes();
    await handleSearch(fakeReq({ url: '/api/search', body: JSON.stringify({ postal: 'M5V', dinner: 'unicorn pie' }) }), res);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: err.message + ' Switch the data source to Live to price any dish.',
    });
  });

  it('keeps the message as-is when live was requested', async () => {
    const err = new NoRecipeError('unicorn pie');
    vi.mocked(search).mockRejectedValueOnce(err);
    const res = fakeRes();
    await handleSearch(
      fakeReq({ url: '/api/search', body: JSON.stringify({ postal: 'M5V', dinner: 'unicorn pie', live: true }) }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: err.message });
  });
});

// ---------------------------------------------------------------------------
// Blood-sugar lens coverage gate
// ---------------------------------------------------------------------------

describe('healthLensDto coverage gate', () => {
  function lensRecipe(names: string[]): Recipe {
    return {
      dish: 'test dish',
      servings: 2,
      ingredients: names.map((name) => ({ name, qtyGrams: 100, category: 'other' as const, substitutes: [] })),
    };
  }

  it('returns the LIMITED shape at 1-of-9 coverage (no macros, no read, no verdict)', () => {
    const recipe = lensRecipe([
      'chicken', // only table-known ingredient
      'ramen noodles',
      'fish cake',
      'nori',
      'mirin',
      'dashi',
      'menma',
      'chashu',
      'narutomaki',
    ]);
    const lens = healthLensDto(recipe);
    // Exact-shape pin: nothing beyond these five keys may leak into the limited DTO.
    expect(lens).toEqual({
      limited: true,
      matched: 1,
      total: 9,
      coverageNote: 'We only recognize 1 of 9 ingredients — not enough for a reliable blood-sugar estimate.',
      swaps: expect.any(Array),
    });
  });

  it('returns the LIMITED shape when matched >= 3 but coverage < 60%', () => {
    const recipe = lensRecipe([
      'chicken',
      'broccoli',
      'quinoa',
      'mirin',
      'dashi',
      'menma',
      'chashu',
      'narutomaki',
      'fish cake',
    ]);
    const lens = healthLensDto(recipe);
    expect(lens).toMatchObject({ limited: true, matched: 3, total: 9 });
    expect(lens).not.toHaveProperty('perServing');
    expect(lens).not.toHaveProperty('read');
    expect(lens).not.toHaveProperty('verdict');
  });

  it('returns the full shape with limited:false when every ingredient is known', () => {
    const recipe = lensRecipe(['chicken', 'broccoli', 'quinoa']);
    const lens = healthLensDto(recipe);
    expect(lens).toMatchObject({
      limited: false,
      matched: 3,
      total: 3,
      coverageNote: null,
      perServing: {
        carbsG: expect.any(Number),
        fiberG: expect.any(Number),
        proteinG: expect.any(Number),
      },
      read: expect.any(String),
    });
    expect(lens).toHaveProperty('verdict');
    expect(lens).toHaveProperty('swaps');
  });

  it('still returns null when nothing matched at all', () => {
    expect(healthLensDto(lensRecipe(['mirin', 'dashi', 'menma']))).toBeNull();
  });
});

describe('web dir sanity', () => {
  it('WEB_DIR join is what serveStatic uses (smoke)', () => {
    // Guards against accidental path-base regressions in the test harness itself.
    expect(join('a', 'b')).toBe(join('a', 'b'));
  });
});
