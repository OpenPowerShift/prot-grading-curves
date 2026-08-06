/**
 * A condition's range, per component.
 *
 * `I_min` / `I_max` were phase-only, so a study that knew its
 * negative-sequence range had to work backwards through the ratio to a
 * phase figure it never measured -- and the tool then converted it
 * forwards again by an assumed fault shape. Two conversions to express
 * something the fault report already stated.
 *
 * Every component now takes its own range, and an undeclared one is
 * carried across from phase by the same factor the component's *value*
 * was. That last part is the whole of it: a range has to stay coherent
 * with the centre it surrounds.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

const study = (fault: string): string => `
system { voltages { HV { V = 33 kV; } } }
faults { F { voltage = HV; ${fault} } }
relay R_DN { voltage = HV; ct_ratio = 400/5;
  element 46 { function = neg_seq; measures = I2;
               curve = definite; I_pickup = 100 A; t_delay = 0.3 s; } }
relay R_UP { voltage = HV; ct_ratio = 400/5;
  element 46 { function = neg_seq; measures = I2;
               curve = definite; I_pickup = 200 A; t_delay = 0.9 s; } }
grade { primary = R_DN:46; backup = R_UP:46; fault = F; margin = 0.3 s; }
view { quantity = I2; voltage = HV; }
`;

/** The currents the range check actually evaluated at. */
const sweptAt = (fault: string): number[] => {
  const result = parse(study(fault));
  expect(result.parseErrors).toEqual([]);
  return (result.reports[0]?.rows ?? [])
    .filter((r) => r.at === 'min' || r.at === 'max')
    .map((r) => Math.round(r.I_f_A))
    .sort((a, b) => a - b);
};

/** Every finding, from either half of the front end. */
const codes = (fault: string): string[] => {
  const r = parse(study(fault));
  return [...r.parseErrors.map((e) => e.code), ...r.diagnostics.map((d) => d.code)];
};

describe('a range declared in phase', () => {
  it('is carried onto the component by the fault type', () => {
    /* two_phase fixes I2 = I / sqrt(3): 1.2 kA -> 693 A, 3 kA -> 1732 A. */
    expect(sweptAt('type = two_phase; I = 2 kA; I_min = 1.2 kA; I_max = 3 kA;'))
      .toEqual([693, 1732]);
  });
});

describe('a range declared in the component', () => {
  it('is used as written, with no conversion at all', () => {
    expect(sweptAt('type = two_phase; I = 2 kA; I2 = 500 A; I2_min = 300 A; I2_max = 900 A;'))
      .toEqual([300, 900]);
  });

  it('sweeps even when no phase range is given', () => {
    /*
     * A fault report that states negative-sequence minimum and maximum
     * declares those. The sweep used to trigger on the phase range
     * alone, so a range the study had written was ignored.
     */
    expect(sweptAt('type = two_phase; I = 2 kA; I2 = 500 A; I2_min = 300 A; I2_max = 900 A;'))
      .toHaveLength(2);
  });

  it('does not report the condition as a single point', () => {
    expect(codes('type = two_phase; I = 2 kA; I2 = 500 A; I2_min = 300 A; I2_max = 900 A;'))
      .not.toContain('FAULT_SINGLE_POINT');
  });

  it('still reports a genuine single point', () => {
    expect(codes('type = two_phase; I = 2 kA; I2 = 500 A;'))
      .toContain('FAULT_SINGLE_POINT');
  });
});

describe('an undeclared component range', () => {
  it('travels by the factor the value did, not by the ideal ratio', () => {
    /*
     * The heart of it. `I2 = 500 A` against `I = 2 kA` is a ratio of
     * 0.25 where the two-phase table says 0.577 -- a real network with
     * Z2 != Z1. Deriving the range from the table would put the
     * minimum at 693 A, above the declared centre of 500 A: a range
     * that does not contain its own value.
     */
    expect(sweptAt('type = two_phase; I = 2 kA; I_min = 1.2 kA; I_max = 3 kA; I2 = 500 A;'))
      .toEqual([300, 750]);
  });

  it('produces a range that contains its centre', () => {
    const swept = sweptAt('type = two_phase; I = 2 kA; I_min = 1.2 kA; I_max = 3 kA; I2 = 500 A;');
    expect(swept[0]).toBeLessThan(500);
    expect(swept[1]).toBeGreaterThan(500);
  });
});

describe('a range without a centre', () => {
  it('is refused, because the point and the sweep would disagree', () => {
    /*
     * The graded point would come from the fault type and the sweep
     * from the study, so the two would not describe one condition.
     * Which to believe is not the tool's to decide.
     */
    expect(codes('type = two_phase; I = 2 kA; I2_min = 300 A; I2_max = 900 A;'))
      .toContain('RANGE_WITHOUT_CENTRE');
  });

  it('is refused when only one end is given', () => {
    expect(codes('type = two_phase; I = 2 kA; I2 = 500 A; I2_min = 300 A;'))
      .toContain('RANGE_INCOMPLETE');
  });
});

describe('a declared component with a phase range', () => {
  it('no longer collapses both ends onto the centre', () => {
    /*
     * The bug this work uncovered. A range endpoint substituted the
     * phase minimum and left every declared component at its centre,
     * so `resolveCurrent` returned the declared figure whichever end
     * was asked for. The report printed a range check that had checked
     * nothing, twice, and called it a pass.
     */
    const swept = sweptAt('type = two_phase; I = 2 kA; I_min = 1.2 kA; I_max = 3 kA; I2 = 500 A;');
    expect(new Set(swept).size, 'the two ends must differ').toBe(2);
  });
});

describe('a scenario level', () => {
  it('takes a range, which it had no way to state at all', () => {
    /*
     * The bigger half. An unbalanced fault behind a delta cannot be
     * written as a `fault`, so a study forced into scenarios got a
     * single operating point per condition and no sweep -- a hole in
     * the middle of the feature scenarios exist to serve.
     */
    const result = parse(`
system { voltages { HV { V = 33 kV; } } }
scenario S {
  type = two_phase;
  level HV { I = 2 kA; I_min = 1.2 kA; I_max = 3 kA;
             I2 = 500 A; I2_min = 300 A; I2_max = 900 A; }
}
`);
    expect(result.parseErrors).toEqual([]);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const level = result.study!.scenarios.get('S')!.levels.get('HV')!;
    expect(level.range.I2_min).toBe(300);
    expect(level.range.I2_max).toBe(900);
    expect(level.range.min).toBe(1200);
  });
});

describe('an unknown key in a fault', () => {
  it('is reported rather than skipped', () => {
    /*
     * The fault block read keys with `eat('KW')` alone, so anything
     * that was not already a keyword was stepped over in silence --
     * which is how the first cut of these range keys did nothing at
     * all and said nothing about it.
     */
    expect(codes('type = two_phase; I = 2 kA; I2_mn = 300 A;'))
      .toContain('UNKNOWN_KEY');
  });
});
