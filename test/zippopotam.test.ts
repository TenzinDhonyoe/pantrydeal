/**
 * ZippopotamGeocoder tests: user-fixable postal errors (404 / no places) throw
 * PostalNotFoundError with a stable, user-safe message that the server forwards
 * verbatim; upstream faults (5xx) stay generic. Fake fetchImpl, no network.
 */
import { describe, it, expect } from 'vitest';
import { ZippopotamGeocoder, PostalNotFoundError } from '../src/integrations/zippopotam.js';

const POSTAL_NOT_FOUND_MESSAGE =
  "We couldn't find that postal code. Double-check it (e.g. M5V 2T6).";

function fakeFetch(res: { ok: boolean; status: number; payload?: unknown }) {
  const calls: string[] = [];
  const fn = (input: string | URL) => {
    calls.push(String(input));
    return Promise.resolve({
      ok: res.ok,
      status: res.status,
      json: () => Promise.resolve(res.payload ?? {}),
      text: () => Promise.resolve(''),
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('ZippopotamGeocoder', () => {
  it('throws PostalNotFoundError with the exact user-safe message on 404', async () => {
    const { fn } = fakeFetch({ ok: false, status: 404 });
    const geocoder = new ZippopotamGeocoder({ fetchImpl: fn });
    const err = await geocoder.geocodePostal('99999').then(
      () => expect.unreachable('should have thrown'),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PostalNotFoundError);
    // The server matches on err.name and forwards err.message verbatim.
    expect((err as Error).name).toBe('PostalNotFoundError');
    expect((err as Error).message).toBe(POSTAL_NOT_FOUND_MESSAGE);
  });

  it('throws PostalNotFoundError when the response parses but has no places', async () => {
    const { fn } = fakeFetch({ ok: true, status: 200, payload: { places: [] } });
    const geocoder = new ZippopotamGeocoder({ fetchImpl: fn });
    const err = await geocoder.geocodePostal('M5V').then(
      () => expect.unreachable('should have thrown'),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PostalNotFoundError);
    expect((err as Error).message).toBe(POSTAL_NOT_FOUND_MESSAGE);
  });

  it('keeps a plain Error (NOT PostalNotFoundError) for upstream 5xx faults', async () => {
    const { fn } = fakeFetch({ ok: false, status: 500 });
    const geocoder = new ZippopotamGeocoder({ fetchImpl: fn });
    const err = await geocoder.geocodePostal('M5V').then(
      () => expect.unreachable('should have thrown'),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PostalNotFoundError);
    expect((err as Error).message).toMatch(/Zippopotam geocoding failed \(500\)/);
  });

  it('returns numeric {lat,lng} on success', async () => {
    const { fn, calls } = fakeFetch({
      ok: true,
      status: 200,
      payload: { places: [{ latitude: '43.6205', longitude: '-79.5132' }] },
    });
    const geocoder = new ZippopotamGeocoder({ fetchImpl: fn });
    const loc = await geocoder.geocodePostal('M8Y 1A1');
    expect(loc).toEqual({ lat: 43.6205, lng: -79.5132 });
    // Canada is indexed at the FSA (first 3 chars, uppercased, no spaces).
    expect(calls[0]).toContain('/CA/M8Y');
  });
});
