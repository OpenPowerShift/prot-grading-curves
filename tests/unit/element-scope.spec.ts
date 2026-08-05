/**
 * Keeping a whole curve to the sheets it belongs on.
 *
 * The *marks* -- faults, times, points, annotations -- were scoped
 * first. The curves themselves were not, so a study drawing a phase
 * sheet and a sequence sheet had to put every element on both, and the
 * only way to separate them was two files that then drift apart. That
 * is the case the scoping was wanted for.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const STUDY = `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2;
               view = "Phase"; }
  element 46 { function = "neg_seq"; measures = I2; curve = definite;
               I_pickup = 200 A; t_delay = 600 ms; views = ["Sequence"]; }
  element 50 { function = "phase_oc"; curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
}
view "Phase"    { voltage = "MV"; quantity = any; current_min = 100 A; current_max = 40 kA; }
view "Sequence" { voltage = "MV"; quantity = any; current_min = 100 A; current_max = 40 kA; }
`;

const refsOn = (name: string): string[] => {
  const r = process(STUDY);
  expect(
    [...r.parseErrors, ...r.diagnostics].filter((d) => d.severity === 'error').map((d) => d.code),
  ).toEqual([]);
  const view = r.study!.views.find((v) => v.name === name);
  const svg = renderStudy(r, { theme: 'light', view });
  return [...svg.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]).sort();
};

describe('an element scoped to one sheet', () => {
  it('is drawn there', () => {
    expect(refsOn('Phase')).toContain('R:51');
  });

  it('is absent from the others', () => {
    expect(refsOn('Sequence')).not.toContain('R:51');
  });

  it('takes a list as well as a single name', () => {
    expect(refsOn('Sequence')).toContain('R:46');
    expect(refsOn('Phase')).not.toContain('R:46');
  });
});

describe('an element that names no sheet', () => {
  it('is drawn on every one, so nothing written before this changes', () => {
    expect(refsOn('Phase')).toContain('R:50');
    expect(refsOn('Sequence')).toContain('R:50');
  });
});

describe('a curve kept off a sheet', () => {
  it('does not stretch that sheet\'s axes', () => {
    /*
     * The domain is fitted to every pickup. An element excluded from
     * the sheet must be excluded from the fit too, or it widens the
     * axis for a curve that is not there -- leaving an empty margin
     * whose cause is invisible.
     */
    const withHighSet = `
      system { voltages { "MV" { V = 11 kV; } } }
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; }
        element 50 { function = "phase_oc"; curve = definite; I_pickup = 30 kA;
                     t_delay = 50 ms; view = "Other"; } }
      view "Main"  { voltage = "MV"; }
      view "Other" { voltage = "MV"; }`;
    const r = process(withHighSet);
    const domainOf = (name: string): number => {
      const view = r.study!.views.find((v) => v.name === name);
      const svg = renderStudy(r, { theme: 'light', view });
      return Number(/data-domain-i="[\d.]+,([\d.]+)"/.exec(svg)![1]);
    };
    expect(domainOf('Main')).toBeLessThan(domainOf('Other'));
  });

  it('is not counted among the curves the sheet could not place', () => {
    /* Being on another sheet is a choice the study made, not a
     * failure worth reporting. */
    const r = process(STUDY);
    const view = r.study!.views.find((v) => v.name === 'Sequence');
    const svg = renderStudy(r, { theme: 'light', view });
    expect(svg).not.toContain('could not place');
    expect(svg).not.toMatch(/R:51[^<]*not drawn/);
  });
});
