import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli.js';

// B6: --radius must be validated like --people. Importing cli.ts must NOT run
// main() (the auto-run is guarded to the entrypoint), so these imports are safe.

describe('parseArgs --radius validation (B6)', () => {
  it('throws on a non-numeric radius', () => {
    expect(() => parseArgs(['--radius', 'abc'])).toThrow('--radius must be a positive number.');
  });

  it('throws on a negative radius', () => {
    expect(() => parseArgs(['--radius', '-5'])).toThrow('--radius must be a positive number.');
  });

  it('throws on a zero radius', () => {
    expect(() => parseArgs(['--radius', '0'])).toThrow('--radius must be a positive number.');
  });

  it('accepts a valid positive radius', () => {
    expect(parseArgs(['--radius', '10']).radiusKm).toBe(10);
  });
});

describe('parseArgs other flags (existing behavior)', () => {
  it('throws on --people 0', () => {
    expect(() => parseArgs(['--people', '0'])).toThrow('--people must be a positive number.');
  });

  it('parses valid flags together', () => {
    const args = parseArgs(['--postal', 'M8Y', '--dinner', 'butter chicken', '--people', '4', '--radius', '8']);
    expect(args.postal).toBe('M8Y');
    expect(args.dinner).toBe('butter chicken');
    expect(args.people).toBe(4);
    expect(args.radiusKm).toBe(8);
    expect(args.live).toBe(false);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown flag: --nope');
  });
});
