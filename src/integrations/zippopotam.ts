/**
 * ZippopotamGeocoder — LIVE, keyless geocoder over the free api.zippopotam.us
 * service (OpenStreetMap-derived). Resolves a Canadian/US postal code to
 * coordinates with NO API key required, so --live works on Gemini credits alone
 * (docs/DECISIONS.md D9). Never exercised by the test suite.
 */
import type { Geocoder, LatLng } from '../core/types.js';

const BASE_URL = 'https://api.zippopotam.us';

interface ZippopotamPlace {
  latitude: string;
  longitude: string;
}
interface ZippopotamResponse {
  places?: ZippopotamPlace[];
}

export interface ZippopotamOptions {
  country?: string;
  fetchImpl?: typeof fetch;
}

export class ZippopotamGeocoder implements Geocoder {
  private readonly country: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZippopotamOptions = {}) {
    this.country = options.country ?? 'CA';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async geocodePostal(postal: string): Promise<LatLng> {
    // Canada is indexed at the Forward Sortation Area (first 3 chars).
    const key =
      this.country === 'CA'
        ? postal.replace(/\s+/g, '').slice(0, 3).toUpperCase()
        : postal.replace(/\s+/g, '');
    const url = `${BASE_URL}/${this.country}/${encodeURIComponent(key)}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Zippopotam geocoding failed (${res.status}) for "${postal}"`);
    }
    const body = (await res.json()) as ZippopotamResponse;
    const place = body.places?.[0];
    if (!place) {
      throw new Error(`Zippopotam returned no location for "${postal}"`);
    }
    return { lat: Number(place.latitude), lng: Number(place.longitude) };
  }
}
