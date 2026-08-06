/**
 * The advanced guide's own examples, and its size.
 *
 * `docs/advanced.adoc` is what someone reads on their third study, when
 * one sheet has become several and the question is what belongs where.
 * Its code blocks are what they will copy, so a block that does not
 * parse teaches a mistake.
 *
 * It exists at all because the guide is at its budget. That budget is
 * not a nuisance to route around -- it keeps the guide a digest small
 * enough to hand to a reader whole -- so this document gets one of its
 * own rather than becoming the place everything goes.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';

const ADVANCED = readFileSync('docs/advanced.adoc', 'utf8');
const GUIDE = readFileSync('docs/guide.adoc', 'utf8');

const BLOCKS = [...ADVANCED.matchAll(/\[source,tc\]\n----\n([\s\S]*?)\n----/g)]
  .map((m) => m[1]);

describe('the advanced guide as a document', () => {
  it('is a single self-contained file', () => {
    expect(ADVANCED).not.toMatch(/^include::/m);
  });

  it('carries a useful number of worked examples', () => {
    expect(BLOCKS.length).toBeGreaterThan(5);
  });

  it('stays smaller than the guide it supplements', () => {
    /*
     * The guide is the document you hand someone. If the advanced guide
     * outgrows it, the split has stopped being "first study" against
     * "third study" and become a second copy of the spec by another
     * route -- which is exactly what the guide's own budget exists to
     * prevent.
     */
    expect(ADVANCED.length).toBeLessThan(32_000);
    expect(ADVANCED.length).toBeLessThan(GUIDE.length);
  });
});

describe('every example in the advanced guide', () => {
  for (const [i, block] of BLOCKS.entries()) {
    it(`block ${i + 1} parses`, () => {
      const errors = parse(block).errors.filter((e) => e.severity === 'error');
      expect(errors.map((e) => `${e.code}: ${e.message}`), block.slice(0, 80)).toEqual([]);
    });
  }
});

describe('the advanced guide covers', () => {
  /*
   * Named rather than counted. Each of these is something the guide
   * deliberately does not carry, and if one silently vanishes the
   * split has lost its point.
   */
  it.each([
    ['the three naming tiers', /description/],
    ['groups', /group\s+BESS_CHAIN/],
    ['the precedence order', /Derived/],
    ['nesting inside a view', /may not also carry/],
    ['what may not nest, and why', /exist in the world are declared where they live/],
    ['ranges across sequence components', /I_min/],
    ['the SVG layer contract', /data-layer/],
    ['exit codes', /grading fails/],
  ])('%s', (_what, pattern) => {
    expect(ADVANCED).toMatch(pattern);
  });
});
