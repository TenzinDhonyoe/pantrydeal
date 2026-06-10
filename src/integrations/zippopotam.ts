/**
 * ZippopotamGeocoder — LIVE, keyless geocoder over the free api.zippopotam.us
 * service (OpenStreetMap-derived). Resolves a Canadian/US postal code to
 * coordinates with NO API key required, so --live works on Gemini credits alone
 * (docs/DECISIONS.md D9). Never exercised by the test suite.
 */
import type { Geocoder, LatLng } from '../core/types.js';

const BASE_URL = 'https://api.zippopotam.us';
/** Geocoding round-trip cap (P2): a hung upstream can't stall the pipeline. */
const FETCH_TIMEOUT_MS = 8000;

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

/**
 * Thrown when the postal code itself is wrong (404 / no places) — a user-fixable
 * error, unlike upstream 5xxs. The server matches on `err.name` and forwards
 * `err.message` verbatim, so both are part of the API contract.
 */
export class PostalNotFoundError extends Error {
  override name = 'PostalNotFoundError';
}

const POSTAL_NOT_FOUND_MESSAGE =
  "We couldn't find that postal code. Double-check it (e.g. M5V 2T6).";

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
    // AbortController-based timeout (P2); the signal is threaded through fetchImpl so
    // the injection seam is preserved. clearTimeout in finally disarms the timer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Zippopotam geocoding timed out after ${FETCH_TIMEOUT_MS}ms for "${postal}"`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      // Zippopotam 404s on unknown postal codes — the user's input is wrong,
      // not the upstream service.
      throw new PostalNotFoundError(POSTAL_NOT_FOUND_MESSAGE);
    }
    if (!res.ok) {
      throw new Error(`Zippopotam geocoding failed (${res.status}) for "${postal}"`);
    }
    const body = (await res.json()) as ZippopotamResponse;
    const place = body.places?.[0];
    if (!place) {
      throw new PostalNotFoundError(POSTAL_NOT_FOUND_MESSAGE);
    }
    return { lat: Number(place.latitude), lng: Number(place.longitude) };
  }
}
