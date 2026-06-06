/**
 * Store geocoding + nearest-branch resolution. The Geocoder interface is
 * pluggable; StaticGeocoder is the deterministic default used offline and in
 * tests. The live Google Places impl lives in src/integrations (docs/DECISIONS.md D1).
 */
import type { Geocoder, LatLng, Store } from './types.js';

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two coordinates, in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Attach distanceKm to each store relative to origin, then sort nearest-first. */
export function attachDistances(stores: Store[], origin: LatLng): Store[] {
  return stores
    .map((s) => ({ ...s, distanceKm: haversineKm(origin, { lat: s.lat, lng: s.lng }) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Keep only stores within radiusKm of origin (already sorted nearest-first). */
export function filterByRadius(stores: Store[], radiusKm: number): Store[] {
  return stores.filter((s) => (s.distanceKm ?? Infinity) <= radiusKm);
}

/**
 * Resolve the nearby store branches for a postal code: geocode the postal,
 * attach distances to the candidate stores, and filter to those within radiusKm.
 */
export async function resolveNearbyStores(
  postal: string,
  stores: Store[],
  geocoder: Geocoder,
  radiusKm: number,
): Promise<Store[]> {
  const origin = await geocoder.geocodePostal(postal);
  return filterByRadius(attachDistances(stores, origin), radiusKm);
}

/**
 * A deterministic, offline geocoder seeded with a small table of Toronto-area
 * Forward Sortation Areas (the first 3 chars of a Canadian postal code).
 * Unknown postals fall back to downtown Toronto.
 */
export class StaticGeocoder implements Geocoder {
  private static readonly TABLE: Record<string, LatLng> = {
    M8Y: { lat: 43.6205, lng: -79.496 },
    M8Z: { lat: 43.6175, lng: -79.512 },
    M6K: { lat: 43.6383, lng: -79.4297 },
    M5V: { lat: 43.6426, lng: -79.3957 },
    M4C: { lat: 43.6896, lng: -79.3074 },
    M2N: { lat: 43.7689, lng: -79.4138 },
    L5B: { lat: 43.589, lng: -79.6441 }, // Mississauga
  };

  private static readonly DEFAULT: LatLng = { lat: 43.6532, lng: -79.3832 };

  geocodePostal(postal: string): Promise<LatLng> {
    const fsa = postal.replace(/\s+/g, '').slice(0, 3).toUpperCase();
    return Promise.resolve(StaticGeocoder.TABLE[fsa] ?? StaticGeocoder.DEFAULT);
  }
}
