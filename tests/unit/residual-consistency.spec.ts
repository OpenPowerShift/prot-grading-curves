/**
 * The residual is three times the zero-sequence component.
 *
 * `3I0` is not a convention: it is what a residual connection sums. So
 * a condition declaring both `I0` and `residual` has written one number
 * twice, and if the two disagree one of them is wrong with nothing to
 * say which.
 *
 * The tool does not pick. `currentFor` reads `I0` from `I0` and `3I0`
 * from `residual`, each preferring the figure written for it -- so
 * `I0 = 300 A; residual = 450 A` grades a `3I0` relay at 450 A and an
 * `I0` relay at 300 A *at the same earth fault*, a ratio of 1.5 where
 * the definition says 3:
 *
 * [cols="1,1,1"]
 * |===
 * | | Contradictory | Consistent
 *
 * | primary at | 450 A  | 900 A
 * | backup at  | 300 A  | 300 A
 * | margin     | 0.563 s | 0.710 s
 * |===
 *
 * The check existed, for `scenario` levels and only for those. The
 * identical contradiction inside a `fault` -- which is where a study
 * actually puts it -- inside a `point`, or inside an `annotate` was
 * taken in silence.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

const SYS = 'system { voltages { MV { V = 11 kV; } } }';
const RELAY = `relay R { voltage = MV; ct_ratio = 400/5;
  element 51G { function = earth_fault; measures = 3I0;
                curve = iec.si; I_pickup = 100 A; tms = 0.1; } }`;
const VIEW = 'view { voltage = MV; quantity = 3I0; }';

const conflicts = (src: string) => {
  const r = parse(`${SYS}\n${src}\n${RELAY}\n${VIEW}`);
  expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
  return r.diagnostics.filter((d) => d.code === 'SEQUENCE_RESIDUAL_CONFLICT');
};

describe('every place the pair can be written', () => {
  /* 3 x 300 is 900, not 450. */
  const CASES: Array<[string, string]> = [
    ['a fault',
      'faults { F { I = 3 kA; I0 = 300 A; residual = 450 A; '
      + 'type = single_phase_earth; voltage = MV; } }'],
    ['a scenario level',
      'scenario S { type = single_phase_earth; '
      + 'level MV { I = 3 kA; I0 = 300 A; residual = 450 A; } }'],
    ['a point',
      'point P { I0 = 300 A; residual = 450 A; t = 1 s; label = "m"; }'],
    ['an annotation',
      'annotate { on_curve = R:51G; at_I0 = 300 A; at_residual = 450 A; label = "a"; }'],
  ];

  for (const [what, src] of CASES) {
    it(`refuses a contradiction in ${what}`, () => {
      expect(conflicts(src)).toHaveLength(1);
    });

    it(`reports it where it was written, not at 1:1, in ${what}`, () => {
      /*
       * `Fault`, `StudyPoint` and `Annotation` carried no source
       * location at all, so every diagnostic about one landed at the
       * top of the file -- and the location is a clickable go-to-line.
       */
      const d = conflicts(src)[0]!;
      expect(d.line).toBeGreaterThan(1);
    });
  }

  it('says the same thing everywhere, one checker serving all four', () => {
    const messages = CASES.map(([, src]) => conflicts(src)[0]!.message);
    for (const m of messages) {
      expect(m).toMatch(/the residual is 3 x I0 \(900 A\)/);
      expect(m).toMatch(/declare one or make them agree/);
    }
  });

  it('names the fields as the study spells them', () => {
    /*
     * The scenario check reported `earth_A` and `I0_A` -- the model's
     * field names, which appear nowhere in a `.ptc` file. A reader
     * searching for `earth_A` finds nothing.
     */
    expect(conflicts(CASES[0]![1])[0]!.message).toMatch(/residual = 450 A and I0 = 300 A/);
    expect(conflicts(CASES[3]![1])[0]!.message)
      .toMatch(/at_residual = 450 A and at_I0 = 300 A/);
  });
});

describe('a consistent pair', () => {
  it('passes, so a study may state both as its fault report does', () => {
    expect(conflicts('faults { F { I = 3 kA; I0 = 300 A; residual = 900 A; '
      + 'type = single_phase_earth; voltage = MV; } }')).toEqual([]);
  });

  it('tolerates a rounded figure, which is one measurement and not two', () => {
    /* 3 x 105 is 315; a fault study quoting 316 has rounded, not
     * contradicted itself. */
    expect(conflicts('faults { F { I = 1 kA; I0 = 105 A; residual = 316 A; '
      + 'type = single_phase_earth; voltage = MV; } }')).toEqual([]);
  });

  it('says nothing where only one of the two is given', () => {
    for (const only of ['I0 = 300 A;', 'residual = 900 A;']) {
      expect(conflicts(`faults { F { I = 3 kA; ${only} `
        + 'type = single_phase_earth; voltage = MV; } }')).toEqual([]);
    }
  });
});

describe('a declared range', () => {
  it('is checked at each end, being the same claim made twice more', () => {
    /*
     * A sweep run between contradictory endpoints walks a condition
     * that does not exist.
     */
    const d = conflicts('faults { F { I = 3 kA; I0 = 300 A; residual = 900 A; '
      + 'I0_min = 200 A; I0_max = 400 A; '
      + 'residual_min = 300 A; residual_max = 1.2 kA; '
      + 'type = single_phase_earth; voltage = MV; } }');
    /* min is wrong (3 x 200 = 600, not 300); max is right. */
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toMatch(/residual_min/);
  });
});

describe('the currents a fault declares', () => {
  it('are all checked, where only the phase figure was', () => {
    /*
     * A scenario level has always had every one of its five figures
     * checked for being finite and not negative. A fault carries the
     * same five and had one.
     */
    const r = parse(`${SYS}
faults { F { I = 3 kA; I2 = -100 A; type = two_phase; voltage = MV; } }
${RELAY}
${VIEW}`);
    const codes = r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
    expect(codes).toContain('FAULT_CURRENT_INVALID');
  });
});

describe('what the contradiction actually did', () => {
  it('graded one earth fault at two currents that cannot both be true', () => {
    const study = (residual: string) => `${SYS}
faults { F { I = 3 kA; I0 = 300 A; residual = ${residual}; type = single_phase_earth;
             voltage = MV; } }
relay R_A { voltage = MV; ct_ratio = 400/5;
  element 51G { function = earth_fault; measures = 3I0;
                curve = iec.si; I_pickup = 100 A; tms = 0.1; } }
relay R_B { voltage = MV; ct_ratio = 400/5;
  element 51G { function = earth_fault; measures = I0;
                curve = iec.si; I_pickup = 40 A; tms = 0.3; } }
grade { primary = R_A:51G; backup = R_B:51G; fault = F; margin = 0.3 s; upstream = false; }
${VIEW}`;

    const bad = parse(study('450 A'));
    const good = parse(study('900 A'));

    /* The pair is still graded -- the refusal is a diagnostic, not a
     * silent drop -- but it is now refused rather than reported as an
     * answer. */
    expect(bad.reports[0]!.rows[0]!.I_f_A).toBeCloseTo(450, 0);
    expect(bad.reports[0]!.rows[0]!.I_backup_A).toBeCloseTo(300, 0);
    expect(bad.diagnostics.map((d) => d.code)).toContain('SEQUENCE_RESIDUAL_CONFLICT');

    expect(good.reports[0]!.rows[0]!.I_f_A).toBeCloseTo(900, 0);
    expect(good.reports[0]!.rows[0]!.margin_s).toBeCloseTo(0.710, 2);
    expect(bad.reports[0]!.rows[0]!.margin_s).toBeCloseTo(0.563, 2);
  });
});
