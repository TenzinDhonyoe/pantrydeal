import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Measure the tested application code: the pure core PLUS the runner
      // (offline planner), server handlers, and CLI arg parsing. The
      // src/integrations/** layer is the deliberately-untested network boundary
      // (docs/DECISIONS.md D1/D11) — exercising it needs live Gemini/Backflipp,
      // so it stays out of the coverage denominator rather than faking a number.
      include: ['src/**/*.ts'],
      exclude: ['src/core/**/index.ts', 'src/integrations/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        // Honest global floor across all measured app code. It is lower than the
        // core's because the CLI render path and the runner/server live-mode
        // branches need real Gemini/Backflipp to exercise; this guards against
        // regression rather than pretending the entry points are fully covered.
        statements: 74,
        branches: 67,
        functions: 74,
        lines: 73,
        // The pure, deterministic core has no excuse for gaps — hold it high.
        'src/core/**/*.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
