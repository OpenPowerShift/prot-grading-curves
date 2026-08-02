/**
 * The pass/fail verdict itself.
 *
 * Every other grading test asks whether the *numbers* are right --
 * operate times, margins, referral across a transformer. None of them
 * asked whether the one comparison those numbers exist to feed is
 * right. Replacing `margin_s >= margin` with `margin_s > margin`
 * changed no test's outcome, so a study sitting exactly on its declared
 * minimum could have flipped from PASS to FAIL without a word.
 *
 * A study *does* sit exactly on its minimum, routinely: the whole point
 * of `solve` is to land there. So the boundary is the case that matters
 * most, not an edge case.
 *
 * Times here are definite, and the figures are exact in binary
 * (0.5 - 0.25 = 0.25 with no rounding at all), so the boundary really
 * is the boundary rather than a float a hair to one side of it.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { formatGradeReport } from '@tc/semantics/grades';

/** Two definite-time elements a fixed distance apart. */
function study(t_primary: number, t_backup: number, required: string): ReturnType<typeof process> {
  return process(`
    system { voltages { "HV" { V = 11 kV; } } }
    faults { "F" { I = 5 kA; voltage = "HV"; } }
    relay R_P {
      voltage = "HV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = definite; I_pickup = 400 A;
                   t_delay = ${t_primary} s; }
    }
    relay R_B {
      voltage = "HV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = definite; I_pickup = 400 A;
                   t_delay = ${t_backup} s; }
    }
    grade { primary = R_P:51; backup = R_B:51; fault = "F"; margin = ${required}; }
  `);
}

const verdict = (r: ReturnType<typeof process>) => r.reports[0];

describe('the margin comparison', () => {
  it('passes a pair with room to spare', () => {
    const g = verdict(study(0.25, 0.75, '0.25 s'));
    expect(g.min_margin_s).toBeCloseTo(0.5, 9);
    expect(g.pass).toBe(true);
    expect(g.rows[0].pass).toBe(true);
  });

  it('fails a pair that is short', () => {
    const g = verdict(study(0.25, 0.375, '0.25 s'));
    expect(g.min_margin_s).toBeCloseTo(0.125, 9);
    expect(g.pass).toBe(false);
    expect(g.rows[0].pass).toBe(false);
  });

  it('passes a pair sitting exactly on the declared minimum', () => {
    /*
     * The mutation this exists to kill. 0.5 - 0.25 is exactly 0.25, and
     * the requirement is exactly 0.25: `>=` passes, `>` fails, and
     * before this test nothing told them apart. Grading a study to its
     * stated minimum is what `solve` is *for*, so failing here would
     * reject correct designs.
     */
    const g = verdict(study(0.25, 0.5, '0.25 s'));
    expect(g.min_margin_s).toBe(0.25);
    expect(g.rows[0].margin_s).toBe(0.25);
    expect(g.pass).toBe(true);
    expect(g.rows[0].pass).toBe(true);
  });

  it('fails one hair under the minimum', () => {
    const g = verdict(study(0.25, 0.5, '0.2500001 s'));
    expect(g.pass).toBe(false);
  });

  it('reaches no verdict when no minimum is declared', () => {
    /*
     * Absent a requirement there is nothing to be right or wrong
     * against, and `false` would read as a failed study.
     */
    const r = process(`
      system { voltages { "HV" { V = 11 kV; } } }
      faults { "F" { I = 5 kA; voltage = "HV"; } }
      relay R_P { voltage = "HV"; ct_ratio = 400/5;
        element 51 { curve = definite; I_pickup = 400 A; t_delay = 0.25 s; } }
      relay R_B { voltage = "HV"; ct_ratio = 400/5;
        element 51 { curve = definite; I_pickup = 400 A; t_delay = 0.5 s; } }
      grade { primary = R_P:51; backup = R_B:51; fault = "F"; }
    `);
    expect(verdict(r).pass).toBeUndefined();
  });

  it('fails when the backup is faster than the primary', () => {
    /* A negative margin is a miscoordination, not a small one. */
    const g = verdict(study(0.5, 0.25, '0.25 s'));
    expect(g.min_margin_s).toBeLessThan(0);
    expect(g.pass).toBe(false);
  });
});

describe('the verdict the report prints', () => {
  const printed = (r: ReturnType<typeof process>) =>
    /overall\s*:\s*(PASS|FAIL)/.exec(formatGradeReport(r.reports[0]))?.[1];

  it('prints PASS exactly when the verdict is true', () => {
    const ok = study(0.25, 0.5, '0.25 s');
    expect(verdict(ok).pass).toBe(true);
    expect(printed(ok)).toBe('PASS');
  });

  it('prints FAIL exactly when the verdict is false', () => {
    const bad = study(0.25, 0.375, '0.25 s');
    expect(verdict(bad).pass).toBe(false);
    expect(printed(bad)).toBe('FAIL');
  });
});

describe('a row where nothing operated', () => {
  /*
   * A margin only exists where both sides operate. Scoring the absence
   * of one as a pass produced a report reading `achieved margin =
   * no-op s -- pass` directly above `overall : FAIL` -- two lines of
   * one table contradicting each other, which teaches the reader that
   * the column cannot be trusted.
   */
  const noOperation = () => process(`
    system { voltages { "MV" { V = 11 kV; } } }
    faults { "F" { I = 600 A; type = three_phase; voltage = "MV"; } }
    relay R_A { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
    relay R_B { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 40 kA; tms = 0.3; } }
    grade { primary = R_A:51; backup = R_B:51; fault = "F"; margin = 0.30 s; }
  `);

  it('is scored neither pass nor fail', () => {
    expect(noOperation().reports[0].rows[0].pass).toBeUndefined();
  });

  it('does not print a verdict beside a margin it does not have', () => {
    const text = formatGradeReport(noOperation().reports[0]);
    expect(text).toMatch(/achieved margin\s*=\s*no-op/);
    expect(text).not.toMatch(/no-op s\s+--\s+pass/);
  });

  it('says why, rather than leaving the row unexplained', () => {
    const codes = noOperation().reports[0].diagnostics.map((d) => d.code);
    expect(codes).toContain('NO_OPERATION');
  });

  it('still scores rows where both sides do operate', () => {
    const r = verdict(study(0.25, 0.75, '0.25 s'));
    expect(r.rows[0].pass).toBe(true);
  });
});
