/**
 * Four things the engineer controls about the drawing.
 *
 * Where a required-time caption sits, how far a curve is drawn, how
 * strongly a fault rule is inked, and what happens to anything anchored
 * outside the window. None of them changes a number; all of them change
 * whether the number can be read off the sheet.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const svgOf = (src: string) => renderStudy(process(src), { theme: 'light' });

const BASE = (extra: string, view = 'current_min = 100 A; current_max = 40 kA;') => `
  system { voltages { "HV" { V = 11 kV; } } }
  faults { "Max fault" { I = 6 kA; voltage = "HV"; } }
  relay R {
    voltage = "HV"; ct_ratio = 400/5;
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2;
                 ${extra} }
  }
  view { voltage = "HV"; ${view} time_min = 20 ms; time_max = 100 s; }
`;

/** Rightmost x the named curve reaches. */
function curveRight(svg: string, name: string): number {
  const d = new RegExp(`d="([^"]+)"[^>]*data-curve="${name}"`).exec(svg)![1];
  return Math.max(...[...d.matchAll(/[ML](-?[\d.]+)/g)].map((m) => Number(m[1])));
}

const notes = (svg: string): string =>
  [...svg.matchAll(/<text[^>]*font-style="italic"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1]).join(' ');

describe('a curve can be told where to stop', () => {
  it('ends exactly at the declared current', () => {
    /*
     * Checked against a fault rule drawn at the same figure rather than
     * against a calibration of my own: the two must land on the same
     * pixel, whatever the scale is doing.
     */
    const svg = svgOf(BASE('I_cutoff = 6 kA;'));
    const rule = Number(/x1="([\d.]+)"[^>]*data-fault="Max fault"/.exec(svg)![1]);
    expect(curveRight(svg, 'R:51')).toBeCloseTo(rule, 1);
  });

  it('runs to the frame without one', () => {
    const svg = svgOf(BASE(''));
    const rule = Number(/x1="([\d.]+)"[^>]*data-fault="Max fault"/.exec(svg)![1]);
    expect(curveRight(svg, 'R:51')).toBeGreaterThan(rule);
  });

  it('says so in the legend', () => {
    /* A curve that stops short reads as one the renderer failed to
     * finish unless the sheet says the stop was asked for. */
    expect(svgOf(BASE('I_cutoff = 6 kA;'))).toContain('to 6 kA');
  });
});

describe('a required time can be told where to put its caption', () => {
  const timed = (at: string) => svgOf(`
    system { voltages { "HV" { V = 11 kV; } } }
    times { "Arc flash limit" { t = 0.5 s; ${at} } }
    relay R { voltage = "HV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
    view { voltage = "HV"; current_min = 100 A; current_max = 10 kA;
           time_min = 20 ms; time_max = 100 s; }
  `);
  const captionX = (svg: string): number =>
    Number(/<text x="([\d.]+)"[^>]*>(?:<[^>]*>)*[^<]*Arc flash limit/.exec(svg)![1]);

  it('defaults to the left-hand end', () => {
    /* The rule spans the plot, so its name has no natural anchor. */
    expect(captionX(timed(''))).toBeLessThan(150);
  });

  it('moves the caption to the declared current', () => {
    expect(captionX(timed('at_I = 3 kA;'))).toBeGreaterThan(400);
  });

  it('falls back rather than writing into the margin', () => {
    /* A figure outside the plotted currents would put the text off the
     * sheet, which is worse than the default it overrode. */
    expect(captionX(timed('at_I = 30 kA;'))).toBe(captionX(timed('')));
  });
});

describe('fault rules are inked like the legend entry that names them', () => {
  it('draws the rule at full strength', () => {
    /*
     * At 0.7 opacity the rule read as a paler colour than its own
     * legend swatch, so the two did not obviously belong together.
     */
    const svg = svgOf(BASE(''));
    const rule = /<line[^>]*class="tc-fault"[^>]*>/.exec(svg)![0];
    expect(rule).not.toContain('stroke-opacity');
  });
});

describe('nothing is drawn where the reader cannot see it', () => {
  /*
   * `toPx` is affine in `log10` and extrapolates past the frame quite
   * happily, so a zoomed-in sheet drew markers at coordinates outside
   * the plot -- over the legend -- with leaders running back to them.
   */
  const WITH_MARKS = (hi: string) => `
    system { voltages { "HV" { V = 11 kV; } } }
    relay R { voltage = "HV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
    point "far trip" { I = 18 kA; t = 0.12 s; label = "way off right"; }
    annotate { on_curve = R:51; at_I = 15 kA; label = "off-screen"; style = leader; }
    view { voltage = "HV"; current_min = 100 A; current_max = ${hi};
           time_min = 20 ms; time_max = 100 s; }
  `;

  const markers = (svg: string) => [...svg.matchAll(/<circle[^>]*r="3\.5"/g)].length;
  const glyphs = (svg: string) => [...svg.matchAll(/data-point=/g)].length;

  it('draws them when they are in the window', () => {
    const svg = svgOf(WITH_MARKS('40 kA'));
    expect(markers(svg)).toBe(1);
    expect(glyphs(svg)).toBe(1);
  });

  it('drops the annotation and its leader when the anchor is outside', () => {
    const svg = svgOf(WITH_MARKS('1 kA'));
    expect(markers(svg)).toBe(0);
    expect(notes(svg)).toContain('1 annotation outside the plotted range');
  });

  it('drops the marker but keeps it in the legend', () => {
    /*
     * A point off the window is not a point that stopped mattering, so
     * it moves to the legend rather than vanishing -- the list of
     * points the legend prints is exactly the ones not drawn.
     */
    const svg = svgOf(WITH_MARKS('1 kA'));
    expect(glyphs(svg)).toBe(0);
    expect(svg).toContain('way off right');
  });

  it('counts rather than names them', () => {
    /* Zooming is interactive; naming each one would turn the notes into
     * a running commentary on the viewport. */
    expect(notes(svgOf(WITH_MARKS('1 kA')))).not.toContain('off-screen');
  });
});
