/**
 * Two things a reader looks at without noticing: the grid, and the
 * fact that a study is one document rather than a pile of files.
 *
 * A log axis draws nine lines per decade and only one is a labelled
 * power of ten. They used to differ by weight alone -- 0.9px against
 * 0.6, full against 70% -- which at a glance is one grey field, so
 * finding a decade meant counting.
 *
 * And a study with four sheets was four separate exports, which is
 * four chances for one of them to be the old revision.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { exportPdfSheets } from '@tc/export/export-pdf.js';

const STUDY = (page = ''): string => `
system { voltages { HV { V = 33 kV; } } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
${page}
view A { quantity = phase; voltage = HV; title = "Sheet A";
         current_min = 100 A; current_max = 10 kA; time_min = 20 ms; time_max = 20 s; }
view B { quantity = phase; voltage = HV; title = "Sheet B";
         current_min = 100 A; current_max = 10 kA; time_min = 20 ms; time_max = 20 s; }
`;

const sheet = (src: string, view = 0, extra = {}): string => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  return renderStudy(r, { theme: 'light', view: r.study!.views[view], ...extra });
};

/** The `<line>` elements of one grid class. */
const gridLines = (svg: string, which: 'major' | 'minor'): string[] =>
  [...svg.matchAll(/<line[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`tc-grid-${which}`));

describe('major and minor gridlines', () => {
  const svg = sheet(STUDY());

  it('are both drawn', () => {
    expect(gridLines(svg, 'major').length).toBeGreaterThan(2);
    expect(gridLines(svg, 'minor').length).toBeGreaterThan(gridLines(svg, 'major').length);
  });

  it('differ in more than weight by default', () => {
    /*
     * The point of the change. Minor lines are dotted, so a decade is
     * found by looking rather than by counting -- and it works in one
     * ink, which a colour difference alone would not survive being
     * photocopied.
     */
    expect(gridLines(svg, 'minor').every((l) => l.includes('stroke-dasharray'))).toBe(true);
    expect(gridLines(svg, 'major').some((l) => l.includes('stroke-dasharray'))).toBe(false);
  });

  it('take a colour of their own when the study says so', () => {
    const styled = sheet(STUDY(`page { axes = {
      grid_color = "#111111"; grid_minor_color = "#eeeeee"; }; }`));
    expect(gridLines(styled, 'major').every((l) => l.includes('#111111'))).toBe(true);
    expect(gridLines(styled, 'minor').every((l) => l.includes('#eeeeee'))).toBe(true);
  });

  it('take a style of their own when the study says so', () => {
    const styled = sheet(STUDY(`page { axes = {
      grid_style = "dashed"; grid_minor_style = "solid"; }; }`));
    expect(gridLines(styled, 'major').every((l) => l.includes('stroke-dasharray'))).toBe(true);
    expect(gridLines(styled, 'minor').some((l) => l.includes('stroke-dasharray'))).toBe(false);
  });

  it('fall back to the major colour when only one is given', () => {
    /*
     * What every study written before this did, and what a study that
     * only wants to recolour the grid still means.
     */
    const styled = sheet(STUDY('page { axes = { grid_color = "#123456"; }; }'));
    expect(gridLines(styled, 'minor').every((l) => l.includes('#123456'))).toBe(true);
  });
});

describe('the footer pagination macros', () => {
  const FOOTER = `page { footer = { right = "[page] of [of]"; }; }`;

  it('say "?" on a single sheet, which has no pagination to report', () => {
    /*
     * Claiming "1 of 1" would be an assertion the renderer cannot
     * make: it is handed one sheet and told nothing about a document.
     */
    expect(sheet(STUDY(FOOTER))).toContain('? of ?');
  });

  it('resolve when the caller is paginating', () => {
    const svg = sheet(STUDY(FOOTER), 1, { pagination: { page: 2, of: 4 } });
    expect(svg).toContain('2 of 4');
  });
});

describe('every sheet in one PDF', () => {
  /*
   * The page count itself is checked end to end rather than here:
   * `svg2pdf` calls `getBBox`, which jsdom does not implement, so a
   * unit test of the binding would be a test of the stub. What is
   * checkable in this environment is the guard, which runs before any
   * of that.
   *
   * The real check is `tests/unit/pdf-pages.spec.ts`, which runs the
   * CLI and counts pages in the file it wrote.
   */
  it('refuses an empty set rather than writing a blank document', async () => {
    await expect(exportPdfSheets([])).rejects.toThrow(/at least one sheet/);
  });
});
