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

const docsPath = (name: string): string =>
  join((globalThis as { process?: { cwd(): string } }).process!.cwd(), 'docs', name);

const GUIDE = readFileSync(docsPath('guide.adoc'), 'utf8');
const TUTORIAL = readFileSync(docsPath('tutorial.adoc'), 'utf8');

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

describe('the tutorial', () => {
  /*
   * The tutorial is the document a newcomer meets first, and every
   * step of it is presented as a file they can paste in. A block that
   * does not parse teaches the mistake before anything else has had a
   * chance to teach the language.
   */
  const blocks = [...TUTORIAL.matchAll(/\[source,tc\]\n----\n([\s\S]*?)\n----/g)]
    .map((m) => m[1]);

  it('has code blocks to check', () => {
    expect(blocks.length).toBeGreaterThan(15);
  });

  for (const [i, block] of blocks.entries()) {
    it(`block ${i + 1} parses`, () => {
      const errors = parse(block).errors.filter((e) => e.severity === 'error');
      expect(errors.map((e) => `${e.code}: ${e.message}`), block.split('\n')[0]).toEqual([]);
    });
  }

  it('builds to a study that grades, and quotes the figures it gets', () => {
    /*
     * Section 3 prints a report. Quoting numbers the tool does not
     * actually produce is the one error a reader cannot catch, because
     * they have nothing to check it against yet.
     */
    const result = process(`
      system { voltages { "MV" { V = 11 kV; } } }
      faults { "Board max" { I = 6.2 kA; type = three_phase; voltage = "MV"; } }
      relay R_FDR { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
      relay R_INC { voltage = "MV"; ct_ratio = 1200/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 960 A; tms = 0.25; } }
      grade { primary = R_FDR:51; backup = R_INC:51; fault = "Board max"; margin = 0.30 s; }
    `);
    const report = result.reports[0];
    expect(report.rows[0].t_primary_s).toBeCloseTo(0.267, 3);
    expect(report.rows[0].t_backup_s).toBeCloseTo(0.921, 3);
    expect(report.min_margin_s).toBeCloseTo(0.654, 3);
    expect(report.pass).toBe(true);
  });
});
