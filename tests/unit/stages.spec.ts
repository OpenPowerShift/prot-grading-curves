/**
 * Multi-stage elements and combines.
 *
 * Sources: spec/sections/semantics.adoc -- _Stages and composite
 * curves_ and _Combine -- synthetic curves_.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { buildStudy } from '@tc/semantics/model';
import { controllingStage, slowestStage, tTripElement, sampleElement } from '@tc/semantics/stages';
import { combineTimes, tTripCombine } from '@tc/semantics/combine';
import { tTripStage } from '@tc/semantics/curves';

const MULTISTAGE = `
system { voltages { "MV" { kV = 11.0; } } }

faults { "F_bus" { I_A = 6000 A; } }

relay R_TGT {
    voltage  = "MV";
    ct_ratio = 600/5;

    element 51 {
        function = "phase_oc";
        stages {
            stage main {
                curve = iec.si;
                I_pu  = 400 A;
                tms   = 0.35;
            }
            stage inst {
                curve   = definite;
                I_pu    = 4500 A;
                t_delay = 0.08 s;
            }
        }
    }
}
`;

const study = buildStudy(parse(MULTISTAGE).document!);
const element = study.relays.get('R_TGT')!.elements[0];

describe('stage resolution', () => {
  it('expands a stages block into one Stage per declaration', () => {
    expect(element.staged).toBe(true);
    expect(element.stages.map((s) => s.id)).toEqual(['main', 'inst']);
  });

  it('folds the time suffix on t_delay', () => {
    expect(element.stages[1].t_delay_s).toBeCloseTo(0.08, 9);
  });

  it('names the implicit stage of a shorthand element "main"', () => {
    const short = buildStudy(parse(`
      relay R { element 51 { curve = iec.si; I_pu = 100 A; tms = 0.1; } }
    `).document!);
    expect(short.relays.get('R')!.elements[0].staged).toBe(false);
    expect(short.relays.get('R')!.elements[0].stages[0].id).toBe('main');
  });
});

describe('composite curve is the pointwise minimum', () => {
  it('takes the fastest stage at every current', () => {
    for (const I of [500, 1000, 3000, 4499, 4500, 6000, 20000]) {
      const perStage = element.stages.map((s) => tTripStage(s, I));
      expect(tTripElement(element, I)).toBeCloseTo(Math.min(...perStage), 9);
    }
  });

  it('follows the IDMT stage below the high-set pickup', () => {
    // At 3000 A the instantaneous (4500 A pickup) has not picked up.
    expect(controllingStage(element, 3000)!.id).toBe('main');
  });

  it('switches to the instantaneous stage above its pickup', () => {
    // At 6000 A the definite stage's 0.08 s beats the IDMT.
    expect(controllingStage(element, 6000)!.id).toBe('inst');
    expect(tTripElement(element, 6000)).toBeCloseTo(0.08, 9);
  });

  it('does not operate below the lowest pickup', () => {
    expect(tTripElement(element, 100)).toBe(Infinity);
  });

  it('samples only where the element operates', () => {
    const pts = sampleElement(element, 10, 50_000, 100);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((p) => p.I_A >= 400 && Number.isFinite(p.t_s))).toBe(true);
  });
});

describe('solver stage selection', () => {
  it('picks the slowest stage -- the one holding the margin open', () => {
    // spec _Multi-stage solve_: "the stage with the largest t_trip(I_f)"
    expect(slowestStage(element, 6000)!.id).toBe('main');
  });
});

describe('combine operators', () => {
  it('applies each operator per the spec table', () => {
    expect(combineTimes([0.4, 1.2, 0.9], 'envelope_min')).toBeCloseTo(0.4, 9);
    expect(combineTimes([0.4, 1.2, 0.9], 'envelope_max')).toBeCloseTo(1.2, 9);
    expect(combineTimes([0.4, 1.2, 0.9], 'sum')).toBeCloseTo(2.5, 9);
    expect(combineTimes([0.4, 1.2, 0.9], 'select_first')).toBeCloseTo(0.4, 9);
  });

  it('treats a non-operating leg as breaking a sum cascade', () => {
    expect(combineTimes([0.4, Infinity], 'sum')).toBe(Infinity);
    // but an OR still trips on the leg that did operate
    expect(combineTimes([0.4, Infinity], 'envelope_min')).toBeCloseTo(0.4, 9);
  });

  it('evaluates a declared combine against its sources', () => {
    const src = `
      system { voltages { "MV" { kV = 11.0; } } }
      relay R_A { voltage = "MV"; element 51 { curve = iec.si; I_pu = 400 A; tms = 0.20; } }
      relay R_B { voltage = "MV"; element 51 { curve = iec.si; I_pu = 400 A; tms = 0.50; } }
      combine {
          name    = "A_OR_B";
          sources = [R_A:51, R_B:51];
          as      = "envelope_min";
      }
    `;
    const s = buildStudy(parse(src).document!);
    expect(s.combines).toHaveLength(1);

    const a = s.relays.get('R_A')!.elements[0];
    const b = s.relays.get('R_B')!.elements[0];
    const I = 4000;
    // envelope_min: the faster (lower tms) relay wins
    expect(tTripCombine(s, s.combines[0], I))
      .toBeCloseTo(Math.min(tTripElement(a, I), tTripElement(b, I)), 9);
  });
});

describe('current_pct current share', () => {
  it('scales the measured current before computing the multiple', () => {
    // spec _Current-share factor_: I_eff = I_total * current_pct / 100
    const src = `
      relay R {
        element 51 { curve = iec.si; I_pu = 400 A; tms = 0.30; current_pct = 50; }
      }
      relay R2 {
        element 51 { curve = iec.si; I_pu = 400 A; tms = 0.30; }
      }
    `;
    const s = buildStudy(parse(src).document!);
    const half = s.relays.get('R')!.elements[0];
    const full = s.relays.get('R2')!.elements[0];

    expect(half.stages[0].current_pct).toBe(50);
    expect(full.stages[0].current_pct).toBe(100);
    // seeing half the current at 8000 A is the same as seeing all of 4000 A
    expect(tTripElement(half, 8000)).toBeCloseTo(tTripElement(full, 4000), 9);
  });
});

describe('secondary-amp pickups', () => {
  it('converts to primary amps using the relay ct_ratio', () => {
    // spec _Input units_: I_pu_primary = I_pu_declared * n_CT
    const src = `
      relay R {
        ct_ratio = 600/5;
        element 51 { curve = iec.si; I_pu = 4 A; I_units = "secondary"; tms = 0.30; }
      }
    `;
    const s = buildStudy(parse(src).document!);
    const stage = s.relays.get('R')!.elements[0].stages[0];
    expect(stage.I_pu_declared).toBe(4);
    expect(stage.I_pu_A).toBeCloseTo(4 * 120, 9);
  });

  it('leaves a primary-amp pickup untouched', () => {
    const src = `
      relay R {
        ct_ratio = 600/5;
        element 51 { curve = iec.si; I_pu = 480 A; I_units = "primary"; tms = 0.30; }
      }
    `;
    const s = buildStudy(parse(src).document!);
    expect(s.relays.get('R')!.elements[0].stages[0].I_pu_A).toBe(480);
  });
});
