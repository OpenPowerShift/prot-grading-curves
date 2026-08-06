/**
 * Where a curve stops, and what that means beyond the drawing.
 *
 * `I_cutoff` (spelled `current_max` until this change) was read in one
 * place: the renderer, deciding how far right to draw. Everything that
 * computes a *number* ignored it. So a high-set blocked above the
 * maximum through-fault was drawn stopping at its ceiling, and then
 * evaluated well past it -- the composite kept returning the blocked
 * stage's 50 ms at twice the current, and that was the figure printed
 * in the grade report beside the sheet that said otherwise.
 *
 * The two halves of the fix, both tested here: a stage does not
 * operate past its cutoff, so a composite steps back onto whatever is
 * still there; and a grade *asked for* beyond a curve's end is refused
 * rather than answered, because the study has said two things that
 * cannot both hold.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { cutoffOf, tTripElement } from '@tc/semantics/stages.js';
import { tTripStage } from '@tc/semantics/curves.js';

const study = (element: string, fault = '10 kA'): string => `
system { voltages { HV { V = 33 kV; } } }
faults { F { I = ${fault}; type = three_phase; voltage = HV; } }
relay R { voltage = HV; ct_ratio = 400/5; element 51 { ${element} } }
relay R_UP { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 800 A; tms = 0.5; } }
grade { primary = R:51; backup = R_UP:51; fault = F; margin = 0.3 s; upstream = false; }
view { quantity = phase; voltage = HV;
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;

const TWO_STAGE = `function = phase_oc; measures = phase;
  stages {
    stage A { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
    stage B { curve = definite; I_pickup = 3 kA; t_delay = 50 ms; I_cutoff = 5 kA; }
  }`;

const elementOf = (src: string) => {
  const r = parse(src);
  expect(r.parseErrors, 'the study should parse').toEqual([]);
  return { result: r, element: r.study!.relays.get('R')!.elements[0] };
};

const codes = (src: string): string[] => {
  const r = parse(src);
  return [...r.parseErrors.map((e) => e.code), ...r.diagnostics.map((d) => d.code)];
};

describe('a stage past its cutoff', () => {
  it('does not operate', () => {
    const { element } = elementOf(study(TWO_STAGE));
    const B = element.stages[1];
    expect(tTripStage(B, 5000)).toBeCloseTo(0.05, 4);
    expect(tTripStage(B, 5001)).toBe(Infinity);
  });

  it('leaves the composite standing on whatever is still there', () => {
    /*
     * The measurement that found this. Stage B is declared to stop at
     * 5 kA; at 10 kA the composite used to keep returning its 50 ms --
     * eight times fast, and the number the report printed. The right
     * answer above the cutoff is stage A's own.
     */
    const { element } = elementOf(study(TWO_STAGE));
    const [A] = element.stages;
    expect(tTripElement(element, 4000)).toBeCloseTo(0.05, 4);
    expect(tTripElement(element, 10_000)).toBeCloseTo(tTripStage(A, 10_000), 6);
    expect(tTripElement(element, 10_000)).toBeGreaterThan(0.4);
  });
});

describe('the element as a whole', () => {
  it('survives as long as any stage does', () => {
    /*
     * The ceiling is the largest of the stages', not the element's own
     * figure and not the smallest: a blocked high-set does not take
     * the inverse stage down with it.
     */
    const { element } = elementOf(study(TWO_STAGE));
    expect(cutoffOf(element)).toBeUndefined();
  });

  it('ends where its last stage does', () => {
    const { element } = elementOf(study(`function = phase_oc; measures = phase;
      stages {
        stage A { curve = iec.si; I_pickup = 400 A; tms = 0.2; I_cutoff = 8 kA; }
        stage B { curve = definite; I_pickup = 3 kA; t_delay = 50 ms; I_cutoff = 5 kA; }
      }`));
    expect(cutoffOf(element)).toBe(8000);
  });

  it('passes its own cutoff down to a stage that declares none', () => {
    const { element } = elementOf(study(`function = phase_oc; measures = phase;
      I_cutoff = 6 kA;
      stages {
        stage A { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
      }`));
    expect(element.stages[0].I_cutoff_A).toBe(6000);
    expect(cutoffOf(element)).toBe(6000);
  });
});

describe('a grade taken past where a curve stops', () => {
  const BOUNDED = `function = phase_oc; measures = phase;
    curve = iec.si; I_pickup = 400 A; tms = 0.2; I_cutoff = 5 kA;`;

  it('is refused rather than answered', () => {
    /*
     * It used to be answered, silently: the drawn sheet stopped the
     * curve at 5 kA while the report beside it quoted a margin taken
     * at 10 kA. Refused rather than falling back, because "grade at
     * this current" and "this curve ends before it" cannot both hold
     * and which one is wrong is the author's to say.
     */
    expect(codes(study(BOUNDED, '10 kA'))).toContain('GRADE_BEYOND_CUTOFF');
  });

  it('produces no margin row to be read by mistake', () => {
    const r = parse(study(BOUNDED, '10 kA'));
    expect(r.reports[0]?.rows ?? []).toEqual([]);
  });

  it('names the curve, its end and the current asked for', () => {
    const d = parse(study(BOUNDED, '10 kA')).diagnostics
      .find((x) => x.code === 'GRADE_BEYOND_CUTOFF');
    expect(d?.message).toContain('R:51');
    expect(d?.message).toContain('5000');
    expect(d?.message).toContain('10000');
  });

  it('grades normally at a current the curve reaches', () => {
    expect(codes(study(BOUNDED, '4 kA'))).not.toContain('GRADE_BEYOND_CUTOFF');
    expect(parse(study(BOUNDED, '4 kA')).reports[0]?.rows.length).toBe(1);
  });

  it('is an error, not a warning', () => {
    const d = parse(study(BOUNDED, '10 kA')).diagnostics
      .find((x) => x.code === 'GRADE_BEYOND_CUTOFF');
    expect(d?.severity).toBe('error');
  });
});

describe('the upstream sweep', () => {
  it('stops where the curves do', () => {
    /*
     * Clamped rather than refused, unlike a declared fault: the sweep
     * is the tool's own choice of currents, so running past a cutoff
     * is the tool overreaching rather than the study contradicting
     * itself.
     */
    const src = `
system { voltages { HV { V = 33 kV; } } }
faults { F { I = 2 kA; type = three_phase; voltage = HV; }
         BIG { I = 20 kA; type = three_phase; voltage = HV; } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.2; I_cutoff = 6 kA; } }
relay R_UP { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 800 A; tms = 0.5; } }
grade { primary = R:51; backup = R_UP:51; fault = F; margin = 0.3 s; }
view { quantity = phase; voltage = HV;
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const swept = (r.reports[0]?.rows ?? []).map((x) => x.I_f_A);
    expect(swept.length).toBeGreaterThan(1);
    expect(Math.max(...swept)).toBeLessThanOrEqual(6000);
  });
});

describe('a combined curve', () => {
  it('stops where its sources stop', () => {
    /*
     * `combine` builds a curve from curves. An envelope drawn past the
     * end of every one of its members is describing nothing at all --
     * sample 14's four combined curves ran to the sheet edge while
     * both their sources stopped at 21 kA.
     */
    const src = `
system { voltages { HV { V = 33 kV; } } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.2; I_cutoff = 6 kA; } }
relay R2 { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 500 A; tms = 0.3; I_cutoff = 6 kA; } }
combine { name = ENV; sources = [R:51, R2:51]; as = envelope_min; label = "envelope"; }
view { quantity = phase; voltage = HV;
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const svg = renderStudy(r, { theme: 'light' });
    const right = (name: string): number => {
      const forward = [...svg.matchAll(/<path[^>]*d="([^"]+)"[^>]*data-curve="([^"]*)"/g)]
        .find((x) => x[2] === name)?.[1];
      const backward = [...svg.matchAll(/<path[^>]*data-curve="([^"]*)"[^>]*d="([^"]+)"/g)]
        .find((x) => x[1] === name)?.[2];
      const d = String(forward ?? backward ?? '');
      const xs = [...d.matchAll(/[ML]\s*(-?[\d.]+)/g)].map((a) => Number(a[1]));
      return Math.max(...xs);
    };
    /* Within one sampling step of where its sources end. */
    expect(Math.abs(right('envelope') - right('R:51'))).toBeLessThan(5);
  });
});

describe('the old spelling', () => {
  it('is refused with the new one named', () => {
    /*
     * A bare UNKNOWN_KEY would leave the author guessing. `view` still
     * takes `current_max`, so the message has to say which block it is
     * talking about or it reads as a contradiction of the sheet they
     * just wrote.
     */
    const r = parse(study(`function = phase_oc; measures = phase;
      curve = iec.si; I_pickup = 400 A; tms = 0.2; current_max = 5 kA;`));
    const e = r.parseErrors.find((x) => x.code === 'RENAMED_KEY');
    expect(e, 'the old spelling should be caught by name').toBeDefined();
    expect(e!.message).toContain('I_cutoff');
    expect(e!.message).toContain('view still takes');
  });

  it('still means the axis on a view', () => {
    expect(codes(study(`function = phase_oc; measures = phase;
      curve = iec.si; I_pickup = 400 A; tms = 0.2;`))).not.toContain('RENAMED_KEY');
  });
});
