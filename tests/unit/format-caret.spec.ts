/**
 * Where the caret lands after Format.
 *
 * Not on the offset it held: formatting rewrites indentation and
 * spacing throughout, so the same offset points somewhere else
 * afterwards -- the reader is dropped mid-token, often several lines
 * from what they were working on. Which is enough to stop anyone using
 * Format on a file they are in the middle of.
 *
 * The line survives, because the formatter is line-based: it only ever
 * splits a line, never merges or reorders two.
 */

import { describe, expect, it } from 'vitest';
import { caretAfterFormat } from '@tc/components/tc-app';
import { formatSource } from '@tc/format/format';

/** Offset of the start of a 1-based line. */
const startOfLine = (text: string, line: number): number => {
  const lines = text.split('\n');
  let at = 0;
  for (let i = 0; i < line - 1; i++) at += lines[i].length + 1;
  return at;
};

/** The line the caret sits on, 1-based. */
const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split('\n').length;

const MESSY = `relay R_FDR {
        voltage    = "MV";
        ct_ratio   = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; }
}`;

describe('the caret after a reflow', () => {
  const tidy = formatSource(MESSY);

  it('changes the text, so there is something to survive', () => {
    expect(tidy).not.toBe(MESSY);
  });

  it('follows the line it was on, by its text', () => {
    const at = startOfLine(MESSY, 2) + 10;          /* inside `voltage` */
    const after = caretAfterFormat(MESSY, tidy, at);
    expect(tidy.split('\n')[lineOf(tidy, after) - 1]).toContain('voltage');
  });

  it('lands at the start of that line', () => {
    const at = startOfLine(MESSY, 3) + 12;
    const after = caretAfterFormat(MESSY, tidy, at);
    expect(after).toBe(startOfLine(tidy, lineOf(tidy, after)));
  });

  it('survives a line being exploded into several', () => {
    /* Line 4 is a whole element on one line; formatting breaks it up,
     * so every line after it moves. */
    const at = startOfLine(MESSY, 4) + 5;
    const after = caretAfterFormat(MESSY, tidy, at);
    expect(lineOf(tidy, after)).toBeGreaterThan(1);
    expect(after).toBeLessThanOrEqual(tidy.length);
  });

  it('never points outside the formatted text', () => {
    for (let at = 0; at <= MESSY.length; at += 7) {
      const after = caretAfterFormat(MESSY, tidy, at);
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBeLessThanOrEqual(tidy.length);
    }
  });

  it('falls back to the same line index when the text repeats', () => {
    /* Two identical lines give no unique match, so the index decides
     * rather than an arbitrary one of the two. */
    const repeated = 'relay A {\n  voltage = "MV";\n}\nrelay B {\n  voltage = "MV";\n}';
    const out = formatSource(repeated);
    const at = startOfLine(repeated, 5);
    expect(caretAfterFormat(repeated, out, at)).toBe(startOfLine(out, 5));
  });

  it('copes with an offset past the end', () => {
    expect(caretAfterFormat(MESSY, tidy, MESSY.length + 500))
      .toBeLessThanOrEqual(tidy.length);
  });
});
