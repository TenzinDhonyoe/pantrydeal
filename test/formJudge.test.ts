/**
 * FormJudge tests: one batched call for all uncached pairs, permanent caching by
 * (requested, product), and graceful nulls on failure. Fake fetchImpl, no network.
 */
import { describe, it, expect } from 'vitest';
import { FormJudge } from '../src/integrations/formJudge.js';
import { LruCache } from '../src/core/cache.js';

function fakeFetch(handler: (body: string) => { ok: boolean; status: number; payload?: unknown }) {
  const calls: string[] = [];
  const fn = (_input: string | URL, init?: { body?: unknown }) => {
    const body = String(init?.body ?? '');
    calls.push(body);
    const res = handler(body);
    return Promise.resolve({
      ok: res.ok,
      status: res.status,
      json: () => Promise.resolve(res.payload ?? {}),
      text: () => Promise.resolve(''),
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

/** A canned Gemini response whose text part is the given JSON object. */
const gemini = (obj: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

const PAIRS = [
  { requestedAs: 'chicken thighs', matched: 'Chicken Quarters' },
  { requestedAs: 'extra-virgin olive oil', matched: 'OLIVE OIL, 1 L' },
];

describe('FormJudge', () => {
  it('judges all pairs in ONE batched call and returns per-pair verdicts', async () => {
    const { fn, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      payload: gemini({ judgments: [{ index: 0, sameForm: false }, { index: 1, sameForm: true }] }),
    }));
    const judge = new FormJudge({ apiKey: 'k', fetchImpl: fn, cache: new LruCache(100) });
    const verdicts = await judge.judge(PAIRS);
    expect(verdicts).toEqual([false, true]);
    expect(calls).toHaveLength(1); // batched: one HTTP call for both pairs
    expect(calls[0]).toContain('chicken thighs');
    expect(calls[0]).toContain('OLIVE OIL');
  });

  it('serves repeat pairs from the cache with no network call', async () => {
    const { fn, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      payload: gemini({ judgments: [{ index: 0, sameForm: false }] }),
    }));
    const cache = new LruCache<boolean>(100);
    const judge = new FormJudge({ apiKey: 'k', fetchImpl: fn, cache });

    await judge.judge([PAIRS[0]!]);
    const second = await judge.judge([PAIRS[0]!]);
    expect(second).toEqual([false]);
    expect(calls).toHaveLength(1); // second judge() hit the cache, not the network
  });

  it('mixes cached and fresh pairs: only the uncached pair reaches the LLM', async () => {
    const { fn, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      payload: gemini({ judgments: [{ index: 0, sameForm: true }] }),
    }));
    const cache = new LruCache<boolean>(100);
    const judge = new FormJudge({ apiKey: 'k', fetchImpl: fn, cache });

    await judge.judge([PAIRS[0]!]); // seeds the cache for pair 0
    const verdicts = await judge.judge(PAIRS); // pair 0 cached, pair 1 fresh
    expect(verdicts).toEqual([true, true]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('chicken thighs'); // cached pair not re-sent
    expect(calls[1]).toContain('OLIVE OIL');
  });

  it('returns null per pair when the call fails (caller applies its own fallback)', async () => {
    const { fn } = fakeFetch(() => ({ ok: false, status: 503 }));
    const judge = new FormJudge({ apiKey: 'k', fetchImpl: fn, cache: new LruCache(100) });
    expect(await judge.judge(PAIRS)).toEqual([null, null]);
  });

  it('returns null when the response is malformed JSON', async () => {
    const fn = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
        text: () => Promise.resolve(''),
      })) as unknown as typeof fetch;
    const judge = new FormJudge({ apiKey: 'k', fetchImpl: fn, cache: new LruCache(100) });
    expect(await judge.judge([PAIRS[0]!])).toEqual([null]);
  });

  it('throws at construction without an API key', () => {
    const prevG = process.env.GEMINI_API_KEY;
    const prevGo = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      expect(() => new FormJudge()).toThrow(/GEMINI_API_KEY/);
    } finally {
      if (prevG !== undefined) process.env.GEMINI_API_KEY = prevG;
      if (prevGo !== undefined) process.env.GOOGLE_API_KEY = prevGo;
    }
  });
});
