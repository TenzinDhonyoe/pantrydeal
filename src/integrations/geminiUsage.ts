/**
 * Token-usage measurement for the LIVE Gemini path. Every generateContent
 * response carries a `usageMetadata` block; this logs it to stderr when
 * PANTRYDEAL_DEBUG is set so each token-cost optimization can be measured against
 * a real baseline instead of guessed at (docs/ARCHITECTURE.md §5 Step 0).
 *
 * Output is one line per call, plus a process-lifetime running total:
 *   [usage] recipe         prompt=512 out=88 cached=0 total=600
 *   [usage] analyzer:onion prompt=731 out=24 cached=448 total=755
 *   [usage] TOTAL calls=11 prompt=8123 out=402 cached=4480 total=8525
 *
 * `cached` is cachedContentTokenCount — the portion served from Gemini context
 * caching (option A). Watching it go up as a fraction of `prompt` is how we verify
 * caching is actually applied.
 */

/** The token-accounting block Gemini returns on every generateContent response. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

/** Anything with an optional usageMetadata (all our Gemini response shapes). */
export interface WithUsage {
  usageMetadata?: GeminiUsageMetadata;
}

const totals = {
  calls: 0,
  prompt: 0,
  output: 0,
  cached: 0,
  total: 0,
};

/**
 * Record one Gemini call's usage. `label` identifies the call site
 * (e.g. "recipe", "analyzer:onion"). No-op unless PANTRYDEAL_DEBUG is set.
 * Always safe to call: missing usageMetadata logs zeros, never throws.
 */
export function recordUsage(label: string, body: WithUsage | undefined): void {
  if (!process.env.PANTRYDEAL_DEBUG) return;

  const u = body?.usageMetadata ?? {};
  const prompt = u.promptTokenCount ?? 0;
  const output = u.candidatesTokenCount ?? 0;
  const cached = u.cachedContentTokenCount ?? 0;
  const total = u.totalTokenCount ?? prompt + output;

  totals.calls += 1;
  totals.prompt += prompt;
  totals.output += output;
  totals.cached += cached;
  totals.total += total;

  process.stderr.write(
    `[usage] ${label} prompt=${prompt} out=${output} cached=${cached} total=${total}\n`,
  );
  process.stderr.write(
    `[usage] TOTAL calls=${totals.calls} prompt=${totals.prompt} out=${totals.output} ` +
      `cached=${totals.cached} total=${totals.total}\n`,
  );
}
