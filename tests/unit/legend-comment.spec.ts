/**
 * The office's own words on the sheet.
 *
 * `Notes` is the tool accounting for what it could not draw, and
 * changes as the study does. A drawing office also wants standing text
 * it put there deliberately -- the issue the settings were checked
 * against, the assumption the study rests on, who to ask -- and there
 * was nowhere for it. `meta` is metadata rather than something drawn,
 * and the title block takes a line, not a paragraph.
 *
 * The two must not be confused for each other, so each keeps its own
 * heading and its own ink.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender, process } from '@tc/index';

const STUDY = (legend: string): string => `
system { voltages { "HV" { V = 33 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "HV"; } }
relay R { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
page { legend = { ${legend} }; }
view { voltage = "HV"; }
`;

const drawn = (legend: string): string =>
  parseAndRender(STUDY(legend), { theme: 'light' }).svg;

const errors = (legend: string): string[] => {
  const r = process(STUDY(legend));
  return [...r.parseErrors, ...r.diagnostics]
    .filter((d) => d.severity === 'error').map((d) => d.code);
};

/** Every piece of text drawn on the sheet, in document order. */
const texts = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);

describe('a comment written as one string', () => {
  it('is drawn under its own heading', () => {
    const t = texts(drawn('comment = "Checked against issue C.";'));
    expect(t).toContain('Comment');
    expect(t).toContain('Checked against issue C.');
  });

  it('is absent when nothing was written', () => {
    expect(texts(drawn('title = "Curves";'))).not.toContain('Comment');
  });

  it('breaks at a newline', () => {
    const t = texts(drawn('comment = "Line one.\\nLine two.";'));
    expect(t).toContain('Line one.');
    expect(t).toContain('Line two.');
  });

  it('drops blank lines rather than drawing gaps', () => {
    const t = texts(drawn('comment = "One.\\n\\n\\nTwo.";'));
    expect(t.filter((s) => s.trim() === '' && s.length > 0)).toEqual([]);
  });
});

describe('a comment written as a list', () => {
  const LIST = 'comment = ["Assumes 250 MVA source.", "Query: A. Cooper."];';

  it('draws one entry per line', () => {
    const t = texts(drawn(LIST));
    expect(t).toContain('Assumes 250 MVA source.');
    expect(t).toContain('Query: A. Cooper.');
  });

  it('parses without complaint', () => {
    expect(errors(LIST)).toEqual([]);
  });

  it('keeps its declared order', () => {
    const t = texts(drawn(LIST));
    expect(t.indexOf('Assumes 250 MVA source.'))
      .toBeLessThan(t.indexOf('Query: A. Cooper.'));
  });
});

describe('the comment and the tool\'s notes', () => {
  /*
   * Both live at the foot of the panel and say different kinds of
   * thing. A reader has to be able to tell which is which.
   */
  const WITH_NOTE = `
system { voltages { "HV" { V = 33 kV; } } }
relay R { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
annotate { on_curve = R:51; at_t = 1 ms; label = "unreachable"; }
page { legend = { comment = "Standing text."; }; }
view { voltage = "HV"; }
`;

  it('keep separate headings', () => {
    const t = texts(parseAndRender(WITH_NOTE, { theme: 'light' }).svg);
    expect(t).toContain('Comment');
    expect(t.some((s) => s === 'Notes')).toBe(true);
  });

  it('put the office\'s words before the tool\'s', () => {
    const t = texts(parseAndRender(WITH_NOTE, { theme: 'light' }).svg);
    expect(t.indexOf('Comment')).toBeLessThan(t.indexOf('Notes'));
  });

  it('draw the comment in the legend ink, not the muted note ink', () => {
    const svg = parseAndRender(WITH_NOTE, { theme: 'light' }).svg;
    const line = new RegExp('<text[^>]*>Standing text\\.<').exec(svg)?.[0] ?? '';
    expect(line).toContain('class="tc-legend"');
    expect(line).not.toContain('tc-legend-muted');
  });
});

describe('a mistyped legend key', () => {
  /*
   * A warning rather than an error, as every cosmetic key is: it
   * cannot change a number. What matters is that adding `comment` to
   * the block did not turn the check off, and that the message now
   * lists it among what is accepted.
   */
  const diagnostics = (legend: string) => {
    const r = process(STUDY(legend));
    return [...r.parseErrors, ...r.diagnostics];
  };

  it('is still reported', () => {
    expect(diagnostics('commnet = "typo";').map((d) => d.code)).toContain('UNKNOWN_KEY');
  });

  it('offers comment among the keys it does accept', () => {
    const found = diagnostics('commnet = "typo";').find((d) => d.code === 'UNKNOWN_KEY');
    expect(found?.message).toContain('comment');
  });
});
