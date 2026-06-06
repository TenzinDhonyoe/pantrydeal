import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/core/pipeline.js';
import { FixtureFlyerClient } from '../src/core/flyer.js';
import { itemMatchesIngredient } from '../src/core/matcher.js';
import { StaticGeocoder } from '../src/core/stores.js';
import { StaticRecipeParser } from '../src/core/recipe.js';
import type { PipelineDeps } from '../src/core/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const casesDir = join(fixtures, 'cases');

interface CaseFixture {
  name: string;
  postal: string;
  dinner: string;
  flyer: string;
  expectCheapestMerchant?: string;
  expectFullCoverage?: boolean;
  expectUnmatchedIncludes?: string[];
}

const caseFiles = readdirSync(casesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const cases = caseFiles.map(
  (f) => JSON.parse(readFileSync(join(casesDir, f), 'utf8')) as CaseFixture,
);

function depsFor(c: CaseFixture): PipelineDeps {
  return {
    recipeParser: new StaticRecipeParser(),
    flyerClient: new FixtureFlyerClient(join(fixtures, c.flyer)),
    geocoder: new StaticGeocoder(),
  };
}

describe('end-to-end pipeline over case fixtures', () => {
  it('has at least 10 named case fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.every((c) => typeof c.name === 'string' && c.name.length > 0)).toBe(true);
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('returns a non-empty ranked store list with cheapest = top', async () => {
        const result = await runPipeline(depsFor(c), { postal: c.postal, dinner: c.dinner });
        expect(result.rankedStores.length).toBeGreaterThan(0);
        expect(result.cheapest).toBe(result.rankedStores[0]);
        // Ranked by projected whole-recipe cost, ascending (D12).
        for (let i = 1; i < result.rankedStores.length; i += 1) {
          expect(result.rankedStores[i]!.projectedTotal).toBeGreaterThanOrEqual(
            result.rankedStores[i - 1]!.projectedTotal,
          );
        }
      });

      it('matches or flags every ingredient — never silently dropped (D3)', async () => {
        const result = await runPipeline(depsFor(c), { postal: c.postal, dinner: c.dinner });
        const recipeNames = result.recipe.ingredients.map((i) => i.name);

        for (const basket of result.rankedStores) {
          // exactly one match entry per recipe ingredient, same set, no drops
          expect(basket.matches).toHaveLength(recipeNames.length);
          expect(basket.matches.map((m) => m.ingredient.name).sort()).toEqual(
            [...recipeNames].sort(),
          );

          for (const m of basket.matches) {
            expect(['MATCHED', 'UNMATCHED']).toContain(m.status);
            expect(m.neededGrams).toBe(m.ingredient.qtyGrams);
            if (m.status === 'MATCHED') {
              expect(m.item).not.toBeNull();
              expect(typeof m.pricePerGram).toBe('number');
              expect(Number.isFinite(m.pricePerGram!)).toBe(true);
              expect(m.pricePerGram!).toBeGreaterThan(0);
              expect(typeof m.lineCost).toBe('number');
              expect(Number.isFinite(m.lineCost!)).toBe(true);
            } else {
              expect(m.item).toBeNull();
              expect(m.pricePerGram).toBeNull();
              expect(m.lineCost).toBeNull();
            }
          }

          // coverage + total are internally consistent
          const matched = basket.matches.filter((m) => m.status === 'MATCHED');
          expect(basket.matchedCount).toBe(matched.length);
          expect(basket.coverage).toBeCloseTo(matched.length / recipeNames.length, 8);
          const sum = matched.reduce((acc, m) => acc + (m.lineCost ?? 0), 0);
          expect(basket.total).toBeCloseTo(sum, 8);
        }
      });

      it('satisfies its declared expectations', async () => {
        const result = await runPipeline(depsFor(c), { postal: c.postal, dinner: c.dinner });
        const cheapest = result.cheapest!;

        if (c.expectCheapestMerchant) {
          expect(cheapest.store.merchant).toBe(c.expectCheapestMerchant);
        }
        if (c.expectFullCoverage) {
          expect(cheapest.coverage).toBe(1);
        }
        for (const name of c.expectUnmatchedIncludes ?? []) {
          const m = cheapest.matches.find((x) => x.ingredient.name === name);
          expect(m, `expected ingredient "${name}" in recipe`).toBeDefined();
          expect(m!.status).toBe('UNMATCHED');
        }
      });
    });
  }

  it('exercises the UNMATCHED path in at least one case (never-drop is real)', async () => {
    let sawUnmatched = false;
    for (const c of cases) {
      const result = await runPipeline(depsFor(c), { postal: c.postal, dinner: c.dinner });
      if (result.cheapest!.matches.some((m) => m.status === 'UNMATCHED')) {
        sawUnmatched = true;
        break;
      }
    }
    expect(sawUnmatched).toBe(true);
  });

  it('honors a custom matcher end-to-end (live reranker hook)', async () => {
    const c = cases.find((x) => x.flyer.includes('toronto'))!;
    const base = { postal: c.postal, dinner: 'butter chicken' };
    const without = await runPipeline(depsFor(c), base);
    const withFilter = await runPipeline(depsFor(c), {
      ...base,
      // lexical match, but never accept the "chicken" ingredient
      matcher: {
        matches: (ing, item) =>
          ing.name !== 'chicken' && itemMatchesIngredient(item, ing),
      },
    });
    const cheapest = withFilter.cheapest!;
    const chicken = cheapest.matches.find((m) => m.ingredient.name === 'chicken')!;
    expect(chicken.status).toBe('UNMATCHED');
    // coverage drops by exactly the filtered ingredient
    expect(without.cheapest!.matchedCount - cheapest.matchedCount).toBe(1);
  });

  it('scales the basket to the requested number of people', async () => {
    const c = cases.find((x) => x.flyer.includes('toronto'))!;
    const four = await runPipeline(depsFor(c), { postal: c.postal, dinner: 'butter chicken' });
    const eight = await runPipeline(depsFor(c), {
      postal: c.postal,
      dinner: 'butter chicken',
      servings: 8,
    });
    expect(eight.recipe.servings).toBe(8);
    // quantities double, and the cheapest store's matched total doubles with them
    expect(eight.recipe.ingredients[0]!.qtyGrams).toBe(
      four.recipe.ingredients[0]!.qtyGrams * 2,
    );
    expect(eight.cheapest!.total).toBeCloseTo(four.cheapest!.total * 2, 6);
  });

  it('honors the search radius (tight radius drops far stores)', async () => {
    const deps = depsFor(cases.find((c) => c.flyer.includes('toronto'))!);
    const wide = await runPipeline(deps, { postal: 'M8Y', dinner: 'butter chicken', radiusKm: 25 });
    const tight = await runPipeline(
      { ...deps, flyerClient: new FixtureFlyerClient(join(fixtures, 'flyers', 'toronto.json')) },
      { postal: 'M8Y', dinner: 'butter chicken', radiusKm: 3 },
    );
    expect(tight.rankedStores.length).toBeLessThan(wide.rankedStores.length);
  });
});
