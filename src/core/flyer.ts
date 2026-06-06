/**
 * FlyerClient: the boundary around the (unofficial, fragile) flyer source.
 * FixtureFlyerClient loads flyer data from local JSON and touches no network,
 * so every test runs against it. The live BackflippClient lives in
 * src/integrations and is never exercised by tests (docs/DECISIONS.md D1).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FlyerClient, FlyerData, FlyerItem, Store } from './types.js';

function parseFlyerData(raw: string, source: string): FlyerData {
  const data = JSON.parse(raw) as Partial<FlyerData>;
  if (!Array.isArray(data.stores) || !Array.isArray(data.items)) {
    throw new Error(`Invalid flyer fixture (need {stores, items}): ${source}`);
  }
  return { stores: data.stores as Store[], items: data.items as FlyerItem[] };
}

/**
 * Loads flyer data from a single JSON file or, when given a directory, merges
 * every `*.json` file inside it. Pure file I/O — no network.
 */
export class FixtureFlyerClient implements FlyerClient {
  private readonly data: FlyerData;

  constructor(pathOrData: string | FlyerData) {
    if (typeof pathOrData !== 'string') {
      this.data = pathOrData;
      return;
    }
    this.data = FixtureFlyerClient.load(pathOrData);
  }

  private static load(path: string): FlyerData {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const merged: FlyerData = { stores: [], items: [] };
      const seenStores = new Set<string>();
      for (const file of readdirSync(path).filter((f) => f.endsWith('.json')).sort()) {
        const full = join(path, file);
        const part = parseFlyerData(readFileSync(full, 'utf8'), full);
        for (const store of part.stores) {
          if (!seenStores.has(store.storeId)) {
            seenStores.add(store.storeId);
            merged.stores.push(store);
          }
        }
        merged.items.push(...part.items);
      }
      return merged;
    }
    return parseFlyerData(readFileSync(path, 'utf8'), path);
  }

  getDeals(_postal: string): Promise<FlyerData> {
    return Promise.resolve(this.data);
  }
}
