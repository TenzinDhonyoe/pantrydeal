/**
 * GooglePlacesGeocoder — LIVE geocoder over the Google Geocoding API.
 * Reads GOOGLE_PLACES_KEY from the environment (docs/DECISIONS.md D8). Never
 * exercised by tests. No key is committed to the repo.
 */
import type { Geocoder, LatLng } from '../core/types.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

interface GeocodeResponse {
  status: string;
  results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
}

export interface GooglePlacesOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class GooglePlacesGeocoder implements Geocoder {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GooglePlacesOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GOOGLE_PLACES_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_KEY is not set (required for --live geocoding).');
    }
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async geocodePostal(postal: string): Promise<LatLng> {
    const url =
      `${GEOCODE_URL}?address=${encodeURIComponent(postal)}` +
      `&components=country:CA&key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Google geocoding failed (${res.status}) for "${postal}"`);
    }
    const body = (await res.json()) as GeocodeResponse;
    const loc = body.results[0]?.geometry.location;
    if (body.status !== 'OK' || !loc) {
      throw new Error(`Google geocoding returned no result for "${postal}" (${body.status})`);
    }
    return { lat: loc.lat, lng: loc.lng };
  }
}
