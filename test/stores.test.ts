import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  attachDistances,
  filterByRadius,
  resolveNearbyStores,
  StaticGeocoder,
} from '../src/core/stores.js';
import type { Geocoder, LatLng, Store } from '../src/core/types.js';

function store(storeId: string, lat: number, lng: number): Store {
  return { storeId, merchant: 'M', name: storeId, address: '', lat, lng };
}

const M8Y: LatLng = { lat: 43.6205, lng: -79.496 };

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm(M8Y, M8Y)).toBeCloseTo(0, 6);
  });
  it('approximates a known Toronto distance', () => {
    // M8Y to downtown (~43.6532,-79.3832) is roughly 9-10 km
    const d = haversineKm(M8Y, { lat: 43.6532, lng: -79.3832 });
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(12);
  });
});

describe('attachDistances', () => {
  it('attaches distanceKm and sorts nearest-first', () => {
    const stores = [
      store('far', 43.77, -79.41),
      store('near', 43.625, -79.49),
      store('mid', 43.645, -79.4),
    ];
    const result = attachDistances(stores, M8Y);
    expect(result.map((s) => s.storeId)).toEqual(['near', 'mid', 'far']);
    expect(result[0]!.distanceKm).toBeLessThan(result[1]!.distanceKm!);
    expect(result.every((s) => typeof s.distanceKm === 'number')).toBe(true);
  });
});

describe('filterByRadius', () => {
  it('keeps only stores within the radius', () => {
    const stores = attachDistances(
      [store('near', 43.625, -79.49), store('hamilton', 43.2557, -79.8711)],
      M8Y,
    );
    const kept = filterByRadius(stores, 25);
    expect(kept.map((s) => s.storeId)).toEqual(['near']);
  });
  it('treats missing distance as out of range', () => {
    expect(filterByRadius([store('x', 0, 0)], 25)).toEqual([]);
  });
});

describe('resolveNearbyStores', () => {
  const mockGeocoder: Geocoder = {
    geocodePostal: (postal: string) => {
      expect(postal).toBe('M8Y');
      return Promise.resolve(M8Y);
    },
  };

  it('geocodes then filters/sorts (mocked geocoder, no network)', async () => {
    const stores = [
      store('hamilton', 43.2557, -79.8711),
      store('near', 43.625, -79.49),
      store('mid', 43.645, -79.4),
    ];
    const result = await resolveNearbyStores('M8Y', stores, mockGeocoder, 25);
    expect(result.map((s) => s.storeId)).toEqual(['near', 'mid']);
  });
});

describe('StaticGeocoder', () => {
  it('resolves known FSAs and falls back for unknown', async () => {
    const g = new StaticGeocoder();
    const m8y = await g.geocodePostal('M8Y 1A1');
    expect(m8y).toEqual({ lat: 43.6205, lng: -79.496 });
    const unknown = await g.geocodePostal('X9X');
    expect(unknown).toEqual({ lat: 43.6532, lng: -79.3832 });
  });
});
