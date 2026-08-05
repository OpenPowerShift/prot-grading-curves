/**
 * Where a required time writes its name.
 *
 * A `times` rule spans the whole plot, so its caption has no natural
 * anchor and `at_I` says where along it to put the text -- beside the
 * curve the requirement actually bites on.
 *
 * `at_I` alone means *phase* current. On a sheet drawn in `I2` or
 * `3I0` that is a figure from a different axis, so the caption sat
 * beside a current meaning nothing there. The component vocabulary is
 * the same one a `fault`, a `point` and an `annotate` use.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const STUDY = (times: string, quantity: string): string => `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 200 A; tms = 0.2; } }
times { ${times} }
view "Sheet" { voltage = "MV"; quantity = ${quantity};
               current_min = 50 A; current_max = 20 kA; }
`;

const sheet = (times: string, quantity: string): string => {
  const r = process(STUDY(times, quantity));
  expect(
    [...r.parseErrors, ...r.diagnostics].filter((d) => d.severity === 'error').map((d) => d.code),
  ).toEqual([]);
  return renderStudy(r, { theme: 'light', view: r.study!.views[0] });
};

/** Where a named caption was drawn, in sheet pixels. */
const captionX = (svg: string, name: string): number | null => {
  const found = new RegExp(`<text x="([\\d.]+)"[^>]*>${name}[^<]*<`).exec(svg);
  return found ? Number(found[1]) : null;
};

/** The plot's left edge, which is where an unanchored caption goes. */
const leftEdge = (svg: string): number =>
  Number(/data-plot="([\d.]+),/.exec(svg)![1]);

describe('a caption anchored by component', () => {
  it('is placed on a residual sheet by at_residual', () => {
    const svg = sheet('"R" { t = 500 ms; at_residual = 2 kA; }', '3I0');
    const x = captionX(svg, 'R');
    expect(x).not.toBeNull();
    expect(x!).toBeGreaterThan(leftEdge(svg) + 20);
  });

  it('is placed on a phase sheet by at_I', () => {
    const svg = sheet('"P" { t = 500 ms; at_I = 2 kA; }', 'phase');
    const x = captionX(svg, 'P');
    expect(x!).toBeGreaterThan(leftEdge(svg) + 20);
  });

  it('derives the residual from at_I0, three times smaller', () => {
    const byResidual = sheet('"X" { t = 500 ms; at_residual = 2.1 kA; }', '3I0');
    const byComponent = sheet('"X" { t = 500 ms; at_I0 = 700 A; }', '3I0');
    expect(captionX(byComponent, 'X')).toBeCloseTo(captionX(byResidual, 'X')!, 0);
  });

  it('places I2 on an I2 sheet', () => {
    const svg = sheet('"Q" { t = 500 ms; at_I2 = 700 A; }', 'I2');
    expect(captionX(svg, 'Q')!).toBeGreaterThan(leftEdge(svg) + 20);
  });
});

describe('a caption whose anchor is not in the sheet\'s quantity', () => {
  /*
   * Falling back to the left-hand end is right -- the rule still spans
   * the plot and still carries its name -- but it is indistinguishable
   * from having asked for no anchor at all, so the author would never
   * learn the figure they wrote was ignored.
   */
  it('falls back to the left-hand end', () => {
    const svg = sheet('"Z" { t = 500 ms; at_I = 2 kA; }', '3I0');
    expect(captionX(svg, 'Z')!).toBeLessThan(leftEdge(svg) + 20);
  });

  it('says so, naming the rule', () => {
    const svg = sheet('"Z" { t = 500 ms; at_I = 2 kA; }', '3I0');
    expect(svg).toContain('caption anchor not in');
    expect(svg).toContain('Z');
  });

  it('says nothing when no anchor was asked for', () => {
    /* The left-hand end is the documented default here. */
    const svg = sheet('"Z" { t = 500 ms; }', '3I0');
    expect(svg).not.toContain('caption anchor not in');
  });

  it('says nothing when the anchor resolves', () => {
    const svg = sheet('"Z" { t = 500 ms; at_residual = 2 kA; }', '3I0');
    expect(svg).not.toContain('caption anchor not in');
  });
});

describe('a fault type on a time', () => {
  it('lets one figure supply the others', () => {
    /*
     * For a solid phase-earth fault the residual is the whole fault
     * current, so a phase figure does place on a residual sheet once
     * the type says which fault is meant.
     */
    const svg = sheet('"T" { t = 500 ms; at_I = 2 kA; type = single_phase_earth; }', '3I0');
    expect(svg).not.toContain('caption anchor not in');
    expect(captionX(svg, 'T')!).toBeGreaterThan(leftEdge(svg) + 20);
  });
});
