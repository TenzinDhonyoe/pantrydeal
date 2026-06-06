import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { FixtureFlyerClient } from '../src/core/flyer.js';
import type { FlyerData } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const flyersDir = join(fixtures, 'flyers');

describe('FixtureFlyerClient', () => {
  it('accepts in-memory FlyerData', async () => {
    const data: FlyerData = { stores: [], items: [] };
    const client = new FixtureFlyerClient(data);
    expect(await client.getDeals('M8Y')).toBe(data);
  });

  it('loads a single fixture file', async () => {
    const client = new FixtureFlyerClient(join(flyersDir, 'toronto.json'));
    const deals = await client.getDeals('M8Y');
    expect(deals.stores.length).toBeGreaterThan(0);
    expect(deals.items.length).toBeGreaterThan(0);
    expect(deals.stores.some((s) => s.storeId === 'metro-etobicoke')).toBe(true);
  });

  it('merges every *.json in a directory and dedupes stores by id', async () => {
    const client = new FixtureFlyerClient(flyersDir);
    const deals = await client.getDeals('M8Y');
    const ids = deals.stores.map((s) => s.storeId);
    expect(ids).toContain('metro-etobicoke'); // from toronto.json
    expect(ids).toContain('fortinos-hamilton'); // from hamilton.json
    expect(new Set(ids).size).toBe(ids.length); // no duplicate store ids
  });

  it('throws on a malformed fixture', () => {
    expect(() => new FixtureFlyerClient(join(fixtures, 'invalid-flyer.json'))).toThrow(
      /Invalid flyer fixture/,
    );
  });

  it('ignores postal code (offline; never hits the network)', async () => {
    const client = new FixtureFlyerClient(join(flyersDir, 'toronto.json'));
    const a = await client.getDeals('M8Y');
    const b = await client.getDeals('ZZZZ');
    expect(a).toBe(b);
  });
});
