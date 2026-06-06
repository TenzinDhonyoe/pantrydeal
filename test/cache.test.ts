import { describe, it, expect } from 'vitest';
import { LruCache, cacheKey, isFresh } from '../src/core/cache.js';

describe('cacheKey', () => {
  it('normalizes whitespace and case so equivalent inputs collide', () => {
    expect(cacheKey('recipe', 'Butter Chicken', 4)).toBe(cacheKey('recipe', '  butter   chicken ', 4));
  });

  it('keeps distinct part lists distinct', () => {
    expect(cacheKey('recipe', 'butter chicken', 4)).not.toBe(cacheKey('recipe', 'butter chicken', 6));
    expect(cacheKey('cls', 'onion', 'sku1')).not.toBe(cacheKey('cls', 'onion', 'sku2'));
  });

  it('does not alias when a part value contains the separator-like text', () => {
    // "a","b" must not collide with "a b" — different part counts/contents.
    expect(cacheKey('a', 'b c')).not.toBe(cacheKey('a b', 'c'));
  });
});

describe('isFresh', () => {
  const now = new Date('2026-06-06T12:00:00Z');

  it('is fresh while now is on or before the valid day', () => {
    expect(isFresh('2026-06-10', now)).toBe(true);
    expect(isFresh('2026-06-06', now)).toBe(true); // inclusive of the valid day
  });

  it('is stale once past the valid day', () => {
    expect(isFresh('2026-06-04', now)).toBe(false);
  });

  it('treats missing or unparseable validTo as stale', () => {
    expect(isFresh(undefined, now)).toBe(false);
    expect(isFresh('', now)).toBe(false);
    expect(isFresh('not-a-date', now)).toBe(false);
  });
});

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache<number>(3);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.has('a')).toBe(true);
    expect(c.get('missing')).toBeUndefined();
    expect(c.size).toBe(1);
  });

  it('evicts the least-recently-used entry past the bound', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // evicts 'a' (oldest)
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.size).toBe(2);
  });

  it('a read refreshes recency, protecting the entry from eviction', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // 'a' is now most-recently-used
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  it('updating an existing key refreshes recency and value', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 10); // update + refresh
    c.set('c', 3); // evicts 'b'
    expect(c.get('a')).toBe(10);
    expect(c.has('b')).toBe(false);
  });

  it('clear empties the cache', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('rejects a nonsensical bound', () => {
    expect(() => new LruCache<number>(0)).toThrow();
  });
});
