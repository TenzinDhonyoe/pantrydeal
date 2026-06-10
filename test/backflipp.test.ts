/**
 * BackflippClient resilience tests: bounded retry + backoff on transient failures,
 * no retry on permanent ones, and the all-fail guard. Uses a scripted fake
 * fetchImpl (no network) and retryDelayMs:0 so backoff doesn't slow the suite.
 * The integration is otherwise live-only (docs/DECISIONS.md D1); these cover just
 * the pure retry/failure control flow added for the rate-limit hardening.
 */
import { describe, it, expect } from 'vitest';
import { BackflippClient } from '../src/integrations/backflipp.js';
import type { Geocoder, LatLng } from '../src/core/types.js';

const geocoder: Geocoder = { geocodePostal: (): Promise<LatLng> => Promise.resolve({ lat: 43.65, lng: -79.38 }) };

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

const ok = (items: unknown[]): FakeResponse => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ items }),
  text: () => Promise.resolve(''),
});
const err = (status: number): FakeResponse => ({
  ok: false,
  status,
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(''),
});
const THROW = 'throw' as const;

type Step = FakeResponse | typeof THROW;

/** A fetchImpl that returns a scripted sequence per search term (`q`), repeating the last step. */
function scriptedFetch(script: Record<string, Step[]>) {
  const calls: Record<string, number> = {};
  const fn = (input: string | URL): Promise<FakeResponse> => {
    const url = new URL(String(input));
    const term = url.searchParams.get('q') ?? '';
    const n = (calls[term] = (calls[term] ?? 0) + 1);
    const seq = script[term] ?? [ok([])];
    const step = seq[Math.min(n - 1, seq.length - 1)]!;
    if (step === THROW) return Promise.reject(new Error('network down'));
    return Promise.resolve(step);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const item = (merchant: string, name: string) => ({
  flyer_item_id: `${merchant}:${name}`,
  merchant_id: merchant,
  merchant_name: merchant,
  name,
  current_price: 1.99,
});

describe('BackflippClient resilience', () => {
  it('retries a transient 429 and succeeds on the next attempt', async () => {
    const { fn, calls } = scriptedFetch({
      chicken: [err(429), ok([item('Foody World', 'Fresh Chicken Leg')])],
    });
    const client = new BackflippClient({ geocoder, terms: ['chicken'], fetchImpl: fn, retryDelayMs: 0 });
    const data = await client.getDeals('M5V');
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.name).toBe('Fresh Chicken Leg');
    expect(calls.chicken).toBe(2); // first 429, then the retry
  });

  it('retries a thrown network error then recovers', async () => {
    const { fn, calls } = scriptedFetch({
      beef: [THROW, THROW, ok([item('Metro', 'Ground Beef')])],
    });
    const client = new BackflippClient({ geocoder, terms: ['beef'], fetchImpl: fn, retryDelayMs: 0 });
    const data = await client.getDeals('M5V');
    expect(data.items).toHaveLength(1);
    expect(calls.beef).toBe(3); // 2 throws + 1 success (MAX_RETRIES = 2)
  });

  it('does NOT retry a permanent 4xx (gives up after one attempt)', async () => {
    const { fn, calls } = scriptedFetch({
      rice: [err(400)],
      onion: [ok([item('No Frills', 'Cooking Onions')])],
    });
    const client = new BackflippClient({ geocoder, terms: ['rice', 'onion'], fetchImpl: fn, retryDelayMs: 0 });
    const data = await client.getDeals('M5V');
    expect(calls.rice).toBe(1); // 400 is permanent — not retried
    expect(data.items).toHaveLength(1); // onion still came through
    expect(data.items[0]!.name).toBe('Cooking Onions');
  });

  it('tolerates a partial failure: one term fails, another succeeds', async () => {
    const { fn } = scriptedFetch({
      tomato: [THROW, THROW, THROW], // exhausts retries -> skipped
      cheese: [ok([item('Costco', 'Cheddar Block')])],
    });
    const client = new BackflippClient({ geocoder, terms: ['tomato', 'cheese'], fetchImpl: fn, retryDelayMs: 0 });
    const data = await client.getDeals('M5V');
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.merchant).toBe('Costco');
  });

  it('throws when EVERY term fails after retries', async () => {
    const { fn } = scriptedFetch({
      chicken: [err(503)],
      beef: [THROW],
    });
    const client = new BackflippClient({ geocoder, terms: ['chicken', 'beef'], fetchImpl: fn, retryDelayMs: 0 });
    await expect(client.getDeals('M5V')).rejects.toThrow(/rate-limiting|unavailable/i);
  });
});
