/**
 * Honest cut/form labelling for the Recipe view. The recipe parser canonicalizes
 * specific cuts to a general grocery term ("chicken thighs" -> "chicken") so more
 * flyer deals match, and the matcher treats any cut of the same animal as
 * equivalent. That maximizes savings but can silently substitute a different cut
 * (drumsticks for thighs). This module decides, deterministically, whether a
 * matched product actually honors the SPECIFIC thing the shopper wrote — so the UI
 * can say "we matched a different cut" instead of pretending it's the same.
 *
 * It never changes what gets matched or priced; it only describes the result.
 */
import { stem, tokenize } from './matcher.js';

export interface Substitution {
  /** The ingredient as the shopper wrote it (e.g. "chicken thighs"). */
  requestedAs: string;
  /** The flyer product that was matched (e.g. "Fresh Chicken Leg"). */
  matched: string;
  /** True when the matched product carries none of the specific cut/form words. */
  differentForm: boolean;
}

/** Content stems of a phrase, dropping stopwords (via tokenize) and bare numbers. */
function contentStems(text: string): Set<string> {
  return new Set(
    tokenize(text)
      .map(stem)
      .filter((t) => !/^\d+$/.test(t)),
  );
}

/**
 * Describe whether `productName` honors the specific cut/form the shopper wrote.
 *
 * Returns null when `asWritten` adds nothing beyond the canonical `name` (they
 * just wrote "chicken"), so there is nothing to flag. When they wrote something
 * more specific ("chicken thighs" -> canonical "chicken"), the extra words are the
 * "specifier" (thigh); `differentForm` is true when the matched product name
 * contains none of them — i.e. a different cut/form was substituted.
 */
export function describeSubstitution(
  asWritten: string | undefined,
  canonicalName: string,
  productName: string,
): Substitution | null {
  const written = (asWritten ?? '').trim();
  if (!written) return null;

  const canon = contentStems(canonicalName);
  const specifier = [...contentStems(written)].filter((s) => !canon.has(s));
  if (specifier.length === 0) return null; // no more specific than the canonical term

  const product = contentStems(productName);
  const honored = specifier.some((s) => product.has(s));
  return { requestedAs: written, matched: productName, differentForm: !honored };
}
