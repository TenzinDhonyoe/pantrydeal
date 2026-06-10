/**
 * Honest cut/form labelling for the Recipe view. The recipe parser canonicalizes
 * specific cuts to a general grocery term ("chicken thighs" -> "chicken") so more
 * flyer deals match, and the matcher treats any cut of the same animal as
 * equivalent. That maximizes savings but can silently substitute a different cut
 * (drumsticks for thighs). This module decides whether a matched product honors
 * the SPECIFIC thing the shopper wrote — so the UI can say "we matched a
 * different cut" instead of pretending it's the same.
 *
 * Resolution is LAYERED, cheapest first (docs: generalized form detection):
 *   1. nothing more specific written            -> null      (free)
 *   2. specifier honored, synonym-aware         -> 'same'    (free)
 *   3. conflicting member of a known form group -> 'different' (free)
 *   4. otherwise                                -> 'ambiguous'
 * 'ambiguous' is NOT shown to the shopper directly; the integration layer asks a
 * tiny cached LLM judgment (src/integrations/formJudge.ts) to resolve it, falling
 * back to 'different' (the honest default) when no judge is available.
 *
 * It never changes what gets matched or priced; it only describes the result.
 */
import { stem } from './matcher.js';

/**
 * 'same'      — the product is the form the shopper asked for (no flag).
 * 'different' — confirmed mismatch (flag it).
 * 'ambiguous' — lexically unresolvable; a smarter judge should decide.
 */
export type FormVerdict = 'same' | 'different' | 'ambiguous';

export interface Substitution {
  /** The ingredient as the shopper wrote it (e.g. "chicken thighs"). */
  requestedAs: string;
  /** The flyer product that was matched (e.g. "Fresh Chicken Leg"). */
  matched: string;
  verdict: FormVerdict;
}

/**
 * TRUE-equivalent grocery phrasings: the first entry is the canonical token the
 * aliases are folded to before comparison, so "heavy cream" written against a
 * "Whipping Cream 35%" product resolves to 'same' instead of a false flag.
 * Only genuine equivalents belong here — "related" is not "equal".
 */
const FORM_EQUIVALENTS: string[][] = [
  ['heavy cream', 'whipping cream', '35% cream', 'heavy whipping cream'],
  ['green onion', 'scallion', 'spring onion', 'green onions'],
  ['cilantro', 'coriander', 'fresh coriander'],
  ['ground', 'minced', 'mince', 'lean ground', 'extra lean ground'],
  ['chickpea', 'garbanzo', 'garbanzo bean'],
  ['shrimp', 'prawn'],
  ['zucchini', 'courgette'],
  ['eggplant', 'aubergine'],
  ['bell pepper', 'sweet pepper', 'capsicum'],
  ['rolled oats', 'old fashioned oats', 'oat flakes'],
];

/**
 * Groups of mutually-exclusive forms: writing one member and matching a DIFFERENT
 * member of the same group is a confirmed substitution — deterministically, with
 * no LLM. Keep groups conservative: members must be true alternatives a flyer
 * would name explicitly (poultry cuts, preservation states).
 */
const DISTINCT_FORMS: string[][] = [
  // Cuts: a flyer naming a different cut is a different cut.
  ['breast', 'thigh', 'drumstick', 'wing', 'leg', 'tenderloin', 'whole'],
  // Preservation state — only conflicts when the shopper specified one.
  ['fresh', 'frozen', 'canned', 'dried', 'smoked'],
  // Common rice varieties (jasmine/basmati are both white, so only the broad split).
  ['white', 'brown', 'wild'],
];

/** Fold every known alias phrase in `text` to its canonical token, longest first.
 * Plural-tolerant: "Scallions" folds via the "scallion" alias. */
function foldEquivalents(text: string): string {
  let out = ` ${text.toLowerCase()} `;
  for (const group of FORM_EQUIVALENTS) {
    const canonical = group[0]!;
    // Longest aliases first so "heavy whipping cream" wins over "whipping cream".
    for (const alias of [...group.slice(1)].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(`(^|[^a-z])${alias}(?:e?s)?([^a-z]|$)`, 'g'), `$1${canonical}$2`);
    }
  }
  return out.trim();
}

/**
 * Minimal stopwords for FORM comparison. Deliberately NOT the matcher's list:
 * that one drops form words (fresh, frozen, boneless, skinless) to widen deal
 * matching, but here those words ARE the signal the shopper wrote.
 */
const FORM_STOPWORDS = new Set([
  'the', 'of', 'and', 'with', 'a', 'an', 'or', 'in', 'for', 'to', 'per',
  'each', 'ea', 'pack', 'value', 'family', 'size', 'bag', 'box', 'jar',
]);

/** Content stems of a phrase, after alias folding, dropping stopwords and numbers. */
function contentStems(text: string): Set<string> {
  return new Set(
    foldEquivalents(text)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !FORM_STOPWORDS.has(t) && !/^\d+$/.test(t))
      .map(stem),
  );
}

/** The DISTINCT_FORMS group (as stems) containing `s`, if any. */
function distinctGroupOf(s: string): Set<string> | null {
  for (const group of DISTINCT_FORMS) {
    const stems = new Set(group.map(stem));
    if (stems.has(s)) return stems;
  }
  return null;
}

/**
 * Describe whether `productName` honors the specific cut/form the shopper wrote.
 *
 * Returns null when `asWritten` adds nothing beyond the canonical `name` (they
 * just wrote "chicken"), so there is nothing to check. Otherwise the extra words
 * are the "specifier" (thigh, fresh, brown …) and the verdict is resolved through
 * the deterministic layers above; see FormVerdict for what each value means.
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
  const base: Omit<Substitution, 'verdict'> = { requestedAs: written, matched: productName };

  // Layer 2: any specifier word present (after synonym folding) -> honored.
  if (specifier.some((s) => product.has(s))) return { ...base, verdict: 'same' };

  // Layer 3: the product names a DIFFERENT member of a requested form group
  // (asked "thigh", product says "leg") -> confirmed substitution, no LLM needed.
  for (const s of specifier) {
    const group = distinctGroupOf(s);
    if (!group) continue;
    for (const p of product) {
      if (p !== s && group.has(p)) return { ...base, verdict: 'different' };
    }
  }

  // Layer 4: lexically unresolvable (e.g. "extra-virgin" vs plain "olive oil").
  return { ...base, verdict: 'ambiguous' };
}
