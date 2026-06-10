#!/usr/bin/env node
/**
 * PantryDeal CLI.
 *
 *   pantrydeal --postal M8Y --dinner "butter chicken"
 *
 * Defaults to offline fixtures (FixtureFlyerClient + StaticGeocoder +
 * StaticRecipeParser). Pass --live (or PANTRYDEAL_LIVE=1) to go fully online:
 * the unofficial Backflipp flyer endpoint (keyless), keyless Zippopotam
 * geocoding, and Gemini recipe parsing (reads GEMINI_API_KEY from the env).
 */
import { pathToFileURL } from 'node:url';
import { NoRecipeError, type Match, type PipelineResult } from './core/index.js';
import { search } from './runner.js';

interface CliArgs {
  postal?: string;
  dinner?: string;
  people?: number;
  live: boolean;
  radiusKm?: number;
  fixture?: string;
  help: boolean;
}

// Exported so it can be unit-tested directly; it is a pure function.
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { live: Boolean(process.env.PANTRYDEAL_LIVE), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--postal':
        args.postal = argv[++i];
        break;
      case '--dinner':
        args.dinner = argv[++i];
        break;
      case '--people':
      case '--servings': {
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('--people must be a positive number.');
        }
        args.people = n;
        break;
      }
      case '--radius': {
        // Validate like --people so "--radius abc" fails loudly instead of
        // producing NaN, which would silently filter out every store (B6).
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('--radius must be a positive number.');
        }
        args.radiusKm = n;
        break;
      }
      case '--fixture':
        args.fixture = argv[++i];
        break;
      case '--live':
        args.live = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg && arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return args;
}

const HELP = `PantryDeal — cheapest single nearby store for a dinner's ingredients.

Usage:
  pantrydeal --postal <code> --dinner "<request>" [--people <n>] [--live] [--radius <km>] [--fixture <path>]

Options:
  --postal <code>    Postal/ZIP code to search near (e.g. M8Y).
  --dinner "<text>"  Free-text dinner request (e.g. "butter chicken").
  --people <n>       Number of people to cook for; scales quantities (alias --servings).
  --live             Go fully online (Backflipp flyers + Zippopotam geocoding
                     + Gemini recipe parsing). Requires GEMINI_API_KEY.
  --radius <km>      Search radius in kilometres (default 25).
  --fixture <path>   Flyer fixture file/dir for offline mode.
  -h, --help         Show this help.
`;

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPer100g(pricePerGram: number): string {
  return `${fmtMoney(pricePerGram * 100)}/100g`;
}

function renderMatchRow(m: Match): string {
  const ing = `${m.ingredient.name} (${m.neededGrams}g)`.padEnd(26);
  if (m.status === 'UNMATCHED' || m.item === null || m.pricePerGram === null) {
    return `  ${ing} ${'UNMATCHED'.padEnd(34)} ${'—'.padStart(10)}`;
  }
  const item = m.item.name.length > 32 ? m.item.name.slice(0, 31) + '…' : m.item.name;
  const per = fmtPer100g(m.pricePerGram).padEnd(34 - 0);
  return `  ${ing} ${item.padEnd(34)} ${fmtMoney(m.lineCost ?? 0).padStart(10)}   (${per.trim()}, ${m.item.rawPrice})`;
}

function render(result: PipelineResult, postal: string): string {
  const { recipe, cheapest, rankedStores } = result;
  const lines: string[] = [];
  lines.push('');
  lines.push(`Recipe: ${recipe.dish} (serves ${recipe.servings})`);
  lines.push(`Ingredients: ${recipe.ingredients.map((i) => i.name).join(', ')}`);
  lines.push('');

  if (!cheapest) {
    lines.push(`No nearby stores found for postal ${postal}.`);
    return lines.join('\n');
  }

  const dist = cheapest.store.distanceKm;
  lines.push(
    `Cheapest store: ${cheapest.store.name} (${cheapest.store.merchant})` +
      (dist != null && dist > 0.05 ? `  ${dist.toFixed(1)} km` : ''),
  );
  lines.push(`Address: ${cheapest.store.address}`);
  lines.push('');
  lines.push('Ingredient                 Matched item                       Line cost');
  lines.push('-'.repeat(78));
  for (const m of cheapest.matches) {
    lines.push(renderMatchRow(m));
  }
  lines.push('-'.repeat(78));
  lines.push(
    `Sale items total: ${fmtMoney(cheapest.total)}   ` +
      `coverage ${cheapest.matchedCount}/${cheapest.totalIngredients}`,
  );
  if (cheapest.projectedTotal > cheapest.total) {
    lines.push(
      `Est. whole-recipe cost (incl. off-sale items at ~regular price): ${fmtMoney(
        cheapest.projectedTotal,
      )}`,
    );
  }

  const unmatched = cheapest.matches.filter((m) => m.status === 'UNMATCHED');
  if (unmatched.length > 0) {
    lines.push('');
    lines.push(
      `Not on sale here (buy at regular price): ${unmatched
        .map((m) => m.ingredient.name)
        .join(', ')}`,
    );
  }

  // Only show alternative stores that actually matched something, capped.
  const MAX_OTHERS = 8;
  const others = rankedStores.slice(1).filter((b) => b.matchedCount > 0);
  if (others.length > 0) {
    lines.push('');
    lines.push('Other nearby stores:');
    for (const b of others.slice(0, MAX_OTHERS)) {
      lines.push(
        `  ${b.store.name.padEnd(28)} ${fmtMoney(b.projectedTotal).padStart(9)}  ` +
          `(coverage ${b.matchedCount}/${b.totalIngredients})`,
      );
    }
    const hidden = others.length - Math.min(others.length, MAX_OTHERS);
    const noMatch = rankedStores.slice(1).length - others.length;
    if (hidden > 0 || noMatch > 0) {
      const parts: string[] = [];
      if (hidden > 0) parts.push(`${hidden} more with matches`);
      if (noMatch > 0) parts.push(`${noMatch} with no matching deals`);
      lines.push(`  … and ${parts.join(', ')}.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.postal || !args.dinner) {
    process.stderr.write('Error: --postal and --dinner are required.\n\n' + HELP);
    return 2;
  }

  try {
    const result = await search({
      postal: args.postal,
      dinner: args.dinner,
      people: args.people,
      live: args.live,
      radiusKm: args.radiusKm,
      fixturePath: args.fixture,
    });
    process.stdout.write(render(result, args.postal));
    return 0;
  } catch (err) {
    if (err instanceof NoRecipeError) {
      process.stderr.write(`\n${err.message}\n`);
      // CLI-only hint: the error message itself stays channel-neutral so the
      // web UI (which has a "Live" toggle, not a flag) can reuse it verbatim.
      if (!args.live) {
        process.stderr.write('Tip: pass --live to parse any dish with AI.\n');
      }
      return 1;
    }
    process.stderr.write(`\nError: ${(err as Error).message}\n`);
    return 1;
  }
}

// Only run when executed directly (`npm run cli` / `node dist/cli.js`), not when
// imported by tests. Under tsx and node ESM, the entry module's URL equals
// `file://<argv[1]>`; importing this file from a test makes the two differ.
const entry = process.argv[1];
const isEntrypoint = entry != null && import.meta.url === pathToFileURL(entry).href;

if (isEntrypoint) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
