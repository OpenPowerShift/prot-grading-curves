/**
 * The agent skill, held to what it claims.
 *
 * `docs/skill.adoc` is written to be handed to an AI along with a
 * protection setting report. That reader will not notice a subtly
 * wrong example: it has no relay in front of it and no reason to doubt
 * the document. So every block in it is parsed here, and the smallest
 * study -- the one an agent is told to start from and stop at -- is
 * processed and graded, because "valid" and "produces an answer" are
 * different claims and the document makes the second one.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { process as processStudy } from '@tc/index';

const SKILL = readFileSync('docs/skill.adoc', 'utf8');

const BLOCKS = [...SKILL.matchAll(/\[source,tc\]\n----\n([\s\S]*?)\n----/g)]
  .map((m) => m[1]);

/** Blocks that are whole studies, rather than a fragment of one. */
const isWholeStudy = (block: string): boolean => block.includes('relay ') && block.includes('view');

describe('the skill as a document', () => {
  it('is a single self-contained file', () => {
    expect(SKILL).not.toMatch(/^include::/m);
  });

  it('stays short enough to be read before the work starts', () => {
    /*
     * Its whole value is being read in full by an agent that then gets
     * on with the study. A skill the length of the reference guide is
     * one that gets skimmed, and a skimmed instruction is worse than a
     * short one: it carries the authority without the content.
     */
    expect(SKILL.length).toBeLessThan(18_000);
  });

  it('leads with the two rules that matter', () => {
    /*
     * An agent's characteristic failure here is filling a gap in the
     * report with a plausible number. The document has to say so
     * before it says anything else, and it has to say to run the
     * validator rather than to re-read its own output.
     */
    const opening = SKILL.slice(0, 2_200);
    expect(opening).toMatch(/Only write what the report says/);
    expect(opening).toMatch(/tc-curves check/);
  });

  it('gives a ladder that says when to stop', () => {
    expect(SKILL).toMatch(/decision ladder/i);
    expect(SKILL).toMatch(/Stop at the first row/);
  });

  it('names the findings an agent will actually hit', () => {
    for (const code of [
      'TMS_MISSING', 'UNKNOWN_SETTING', 'MEASURES_REQUIRED',
      'NO_OPERATION', 'GRADE_BEYOND_CUTOFF', 'SEQUENCE_ACROSS_LEVELS',
    ]) {
      expect(SKILL, `${code} should be explained`).toContain(code);
    }
  });

  it('says that a failing grade is an answer, not a defect', () => {
    /*
     * Otherwise an agent adjusts settings until the study goes green,
     * which is the one outcome that must never happen unasked.
     */
    expect(SKILL).toMatch(/do not adjust settings to make it pass/i);
  });
});

describe('every example in the skill', () => {
  it('carries enough of them to work from', () => {
    expect(BLOCKS.length).toBeGreaterThan(10);
  });

  for (const [i, block] of BLOCKS.entries()) {
    it(`block ${i + 1} parses`, () => {
      const errors = parse(block).errors.filter((e) => e.severity === 'error');
      expect(errors.map((e) => `${e.code}: ${e.message}`), block.slice(0, 90)).toEqual([]);
    });
  }
});

describe('the smallest study the skill starts from', () => {
  const first = BLOCKS.find(isWholeStudy)!;

  it('is a whole study, not a fragment', () => {
    expect(first, 'the first complete block should be the starter study').toBeDefined();
    expect(first).toContain('grade {');
  });

  it('validates clean', () => {
    const r = processStudy(first);
    expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('actually produces a margin', () => {
    /*
     * The document's claim is "a complete, valid, useful study". Valid
     * is checked above; useful means it answers the question it was
     * written to ask.
     */
    const r = processStudy(first);
    const row = r.reports[0]?.rows.find((x) => x.at === 'I');
    expect(row, 'the starter study should grade its one pair').toBeDefined();
    expect(Number.isFinite(row!.margin_s)).toBe(true);
  });
});
