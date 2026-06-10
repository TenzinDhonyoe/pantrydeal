/**
 * BackflippClient — LIVE flyer source over Flipp's unofficial "backflipp"
 * endpoint (backflipp.wishabi.com). This endpoint is UNDOCUMENTED, UNOFFICIAL,
 * and may change shape or disappear without notice. It is isolated behind the
 * FlyerClient interface and is NEVER exercised by the test suite
 * (docs/DECISIONS.md D1). No API key is required.
 *
 * Notes on the real response (verified live):
 *  - The items/search endpoint requires a FULL 6-char postal code (the 3-char
 *    FSA is rejected), so we pad a bare FSA to "<FSA> 1A1" (docs/DECISIONS.md D10).
 *  - Items carry merchant_name/merchant_id but NO per-store coordinates. Flipp
 *    already returns flyers local to the postal's FSA, so we treat each merchant
 *    as one nearby store stamped at the geocoded postal location (D10).
 *  - Price is current_price (a number) plus a unit in post_price_text
 *    (e.g. "/lb 13.21/kg"); we reconstruct a string the normalizer understands.
 */
import type {
  FlyerClient,
  FlyerData,
  FlyerItem,
  Geocoder,
  LatLng,
  Store,
} from '../core/types.js';

const SEARCH_URL = 'https://backflipp.wishabi.com/flipp/items/search';

/** How many term searches run at once (P1). The week-planner passes 40+ terms;
 * sequential round-trips were pathologically slow. Kept deliberately low (not max
 * parallel): each response is ~440 KB and Flipp's unofficial endpoint rate-limits
 * per IP, so a wide burst was tripping the throttle and failing whole requests. */
const TERM_CONCURRENCY = 3;
/** Per-term request timeout (P2): a hung upstream can't stall the whole batch. */
const FETCH_TIMEOUT_MS = 8000;
/** Extra attempts after the first on a TRANSIENT per-term failure (429/5xx/network). */
const MAX_RETRIES = 2;
/** Base backoff between term retries; grows linearly per attempt. Injectable for tests. */
const DEFAULT_RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run async tasks with bounded concurrency over a shared index (worker pool). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Broad fallback search terms when none are supplied. */
const DEFAULT_TERMS = [
  'chicken',
  'beef',
  'milk',
  'cheese',
  'butter',
  'tomato',
  'onion',
  'rice',
  'pasta',
  'bread',
  'egg',
];

interface BackflippItem {
  name?: string;
  current_price?: number | string | null;
  pre_price_text?: string | null;
  post_price_text?: string | null;
  sale_story?: string | null;
  merchant_name?: string;
  merchant_id?: number | string;
  valid_from?: string;
  valid_to?: string;
  flyer_item_id?: number | string;
}

interface BackflippResponse {
  items?: BackflippItem[];
}

export interface BackflippOptions {
  /** Geocoder used to stamp store coordinates at the postal location. */
  geocoder: Geocoder;
  /** Search terms (typically the recipe's ingredient names). */
  terms?: string[];
  /** Country code for the locale (default CA). */
  locale?: string;
  fetchImpl?: typeof fetch;
  /** Base backoff (ms) between transient term retries. Defaults to 400; set 0 in tests. */
  retryDelayMs?: number;
}

/** Pad a bare 3-char FSA to a format-valid full postal code. */
export function toFullPostal(postal: string): string {
  const clean = postal.replace(/\s+/g, '').toUpperCase();
  if (clean.length <= 3) return `${clean} 1A1`;
  return `${clean.slice(0, 3)} ${clean.slice(3)}`;
}

/**
 * Extract a size (weight/volume) embedded in a flyer item's name or price text,
 * e.g. "LACTANTIA BUTTER, 454 G" -> "454 g", "...RICE, 4 KG" -> "4 kg",
 * "...(500g) or..." -> "500 g". Returns undefined when none is found. This lets
 * the normalizer price per-each items that would otherwise be unpriceable.
 */
export function extractSize(...texts: Array<string | null | undefined>): string | undefined {
  const sizeRe = /(\d+(?:\.\d+)?)\s*(kg|g|gram|grams|lb|lbs|oz|ml|l|litre|liter)\b/i;
  for (const text of texts) {
    const m = (text ?? '').match(sizeRe);
    if (m) return `${m[1]} ${m[2]!.toLowerCase()}`;
  }
  return undefined;
}

/** Reconstruct a normalizer-friendly price string from Flipp price fields. */
export function buildRawPrice(item: BackflippItem): string {
  const cur = item.current_price;
  const post = (item.post_price_text ?? '').toString().trim();
  const story = (item.sale_story ?? '').toString().trim();

  // Per-weight pricing carried in post_price_text, e.g. "/lb 13.21/kg".
  if (cur != null && cur !== '' && /\/\s*\d*\s*(lb|kg|oz|g)\b/i.test(post)) {
    return `$${cur}${post.startsWith('/') ? '' : ' '}${post}`;
  }
  // Multi-buy carried in the sale story, e.g. "2/$5.00".
  const multi = story.match(/\d+\s*\/\s*\$\s*\d+(?:\.\d+)?/);
  if (multi) return multi[0];
  // Plain price (no unit) — usually un-priceable per gram, surfaced as UNMATCHED.
  if (cur != null && cur !== '') return `$${cur}`;
  return '';
}

export class BackflippClient implements FlyerClient {
  private readonly geocoder: Geocoder;
  private readonly terms: string[];
  private readonly locale: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: BackflippOptions) {
    this.geocoder = options.geocoder;
    this.terms = options.terms && options.terms.length > 0 ? options.terms : DEFAULT_TERMS;
    this.locale = `en-${(options.locale ?? 'CA').toLowerCase()}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** One HTTP attempt for a term. 'ok' on success; 'retry' on a transient failure
   * (429 / 5xx / network / timeout) worth retrying; 'fail' on a permanent one (4xx). */
  private async attemptTerm(
    url: string,
    term: string,
  ): Promise<{ kind: 'ok'; items: BackflippItem[] } | { kind: 'retry' | 'fail' }> {
    // AbortController-based timeout (P2); the signal is threaded through fetchImpl so
    // the injection seam is preserved. clearTimeout in finally disarms the timer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as BackflippResponse;
        return { kind: 'ok', items: body.items ?? [] };
      }
      // A rate-limit (429) or server error (5xx) may clear on retry; a 4xx won't.
      const transient = res.status === 429 || res.status >= 500;
      if (process.env.PANTRYDEAL_DEBUG) {
        process.stderr.write(`[backflipp] term "${term}" failed (${res.status})${transient ? ' — will retry' : ''}\n`);
      }
      return { kind: transient ? 'retry' : 'fail' };
    } catch {
      // Network error / timeout — transient by nature.
      if (process.env.PANTRYDEAL_DEBUG) {
        const reason = controller.signal.aborted ? 'timed out' : 'errored';
        process.stderr.write(`[backflipp] term "${term}" ${reason} — will retry\n`);
      }
      return { kind: 'retry' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch one term's items with bounded retry+backoff. Returns the items array on
   * success, or null once a permanent failure or the retry budget is hit (P1, P2). */
  private async fetchTerm(term: string, fullPostal: string): Promise<BackflippItem[] | null> {
    const url =
      `${SEARCH_URL}?locale=${encodeURIComponent(this.locale)}` +
      `&postal_code=${encodeURIComponent(fullPostal)}&q=${encodeURIComponent(term)}`;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.attemptTerm(url, term);
      if (result.kind === 'ok') return result.items;
      if (result.kind === 'fail') return null; // permanent (4xx) — retrying won't help
      if (attempt === MAX_RETRIES) return null; // out of retries
      await sleep(this.retryDelayMs * (attempt + 1)); // linear backoff between tries
    }
    return null;
  }

  async getDeals(postal: string): Promise<FlyerData> {
    const origin: LatLng = await this.geocoder.geocodePostal(postal);
    const fullPostal = toFullPostal(postal);

    // Fetch terms with bounded concurrency (P1). Per-term failures are non-fatal:
    // fetchTerm returns null and we skip it. Ordering is now nondeterministic, but
    // dedup keys off Maps/Sets so it stays correct.
    const perTerm = await mapPool(this.terms, TERM_CONCURRENCY, (term) =>
      this.fetchTerm(term, fullPostal),
    );

    // If EVERY term failed (even after retries), the source is unreachable or
    // rate-limiting — surface it rather than silently returning an empty flyer
    // (which would read as "no deals", a wrong answer). The user-facing layer
    // already turns this into a generic "try again" message.
    if (perTerm.every((r) => r === null)) {
      throw new Error('Backflipp unavailable after retries (the flyer source may be rate-limiting). Try again shortly.');
    }

    const storesById = new Map<string, Store>();
    const items: FlyerItem[] = [];
    const seenItemIds = new Set<string>();

    for (const termItems of perTerm) {
      if (!termItems) continue; // skipped (failed) term
      for (const raw of termItems) {
        if (!raw.name || !raw.merchant_name) continue;
        const itemId = String(raw.flyer_item_id ?? `${raw.merchant_id}:${raw.name}`);
        if (seenItemIds.has(itemId)) continue;
        seenItemIds.add(itemId);

        const storeId = String(raw.merchant_id ?? raw.merchant_name);
        if (!storesById.has(storeId)) {
          storesById.set(storeId, {
            storeId,
            merchant: raw.merchant_name,
            name: raw.merchant_name,
            address: `Near ${fullPostal}`,
            lat: origin.lat,
            lng: origin.lng,
          });
        }

        items.push({
          name: raw.name,
          rawPrice: buildRawPrice(raw),
          size: extractSize(raw.name, raw.post_price_text),
          merchant: raw.merchant_name,
          storeIds: [storeId],
          validFrom: raw.valid_from ?? '',
          validTo: raw.valid_to ?? '',
          sku: raw.flyer_item_id != null ? String(raw.flyer_item_id) : undefined,
        });
      }
    }

    return { stores: [...storesById.values()], items };
  }
}
