/**
 * The user guide's own examples.
 *
 * `docs/guide.adoc` is the document handed to someone -- or something --
 * writing a study, and its code blocks are what they will copy. A
 * example that does not parse teaches a mistake, so every block is
 * checked here against the real parser.
 *
 * Fragments are expected to be semantically incomplete (a lone
 * `element` block declares no relay), so only *syntax* is required of
 * them. The one block the guide presents as a complete file is held to
 * the higher standard.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { process } from '@tc/index';

const GUIDE = readFileSync(
  join((globalThis as { process?: { cwd(): string } }).process!.cwd(), 'docs/guide.adoc'),
  'utf8',
);

/** Every `[source,tc]` block, in document order. */
const BLOCKS = [...GUIDE.matchAll(/\[source,tc\]\n----\n([\s\S]*?)\n----/g)].map((m) => m[1]);

describe('the guide as a document', () => {
  it('is a single self-contained file, so it can be given whole to a reader', () => {
    /* No `include::` -- the spec is the assembled document, not this. */
    expect(GUIDE).not.toMatch(/^include::/m);
  });

  it('carries a useful number of worked examples', () => {
    expect(BLOCKS.length).toBeGreaterThan(10);
  });

  it('is small enough to paste into a prompt', () => {
    /* The assembled spec is a quarter of a megabyte; this must not be. */
    expect(GUIDE.length).toBeLessThan(60_000);
  });
});

describe('every example parses', () => {
  for (const [i, block] of BLOCKS.entries()) {
    const firstLine = block.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? '';
    it(`block ${i + 1} (${firstLine.trim().slice(0, 40)})`, () => {
      const errors = parse(block).errors.filter((e) => e.severity === 'error');
      expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
    });
  }
});

describe('the complete-file example', () => {
  /* The guide says of the first block: "This is a working study". */
  const result = process(BLOCKS[0]);

  it('has no parse errors', () => {
    const errors = result.parseErrors.filter((e) => e.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  it('has no semantic errors', () => {
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  it('actually grades, and passes', () => {
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].pass).toBe(true);
  });
});

describe('the guide covers what the language has', () => {
  /*
   * A guide that silently omits a block is worse than one that is
   * shorter than the language: someone writing a study will not know
   * the construct exists. These are the top-level blocks.
   */
  const TOP_LEVEL = [
    'meta', 'system', 'faults', 'scenario', 'relay', 'element',
    'device', 'grade', 'combine', 'annotate', 'point', 'view', 'page',
  ];

  for (const block of TOP_LEVEL) {
    it(`documents ${block}`, () => {
      expect(GUIDE).toMatch(new RegExp(`(^|\\s)${block}\\b`, 'm'));
    });
  }

  it('states the measured-current rule for every function', () => {
    for (const fn of ['phase_oc', 'earth_fault', 'neg_seq', 'thermal', 'breaker_fail']) {
      expect(GUIDE, fn).toContain(fn);
    }
    /* And the one that has no default. */
    expect(GUIDE).toContain('MEASURES_REQUIRED');
  });

  it('warns about the traps that produce silently wrong output', () => {
    expect(GUIDE).toContain('ZERO_DELAY_NOT_PLOTTABLE');
    expect(GUIDE).toContain('SEQUENCE_DATA_MISSING');
    /* Units are mandatory, and the commonest authoring error. */
    expect(GUIDE).toMatch(/[Uu]nits are required|Omitting units/);
  });
});
