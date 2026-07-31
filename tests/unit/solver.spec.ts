/**
 * Solver conformance.
 *
 * Source: spec/sections/worked-examples.adoc -- _Worked solver case_.
 * "A passing test of the solver on this exact case must return
 *  tms = 0.125 +/- 0.001."
 *
 * The backup sits on HV while the fault is declared on LV, so the
 * solver works in the backup's own frame: it measures 4850 * 11/33 =
 * 1616.7 A, not 4850 A.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { snapTms, solveGrade } from '@tc/semantics/solver';
import { buildStudy } from '@tc/semantics/model';
import { parse } from '@tc/parser';
import { tTripIDMT, curveParamsFromId } from '@tc/semantics/curves';

/**
 * The spec's solver study: an LV feeder at tms = 0.25 graded against
 * the HV incomer, targeting exactly 0.30 s of margin at 4850 A with
 * zero tolerance.
 */
const SOLVER_CASE = `
system {
    voltages {
        "HV" { V  = 33.0 kV; }
        "LV" { V  = 11.0 kV; }
    }
}

faults {
    "F_FDR2_max" { I   = 4850 A; voltage = "LV"; }
    "F_FDR2_min" { I   = 1900 A; voltage = "LV"; }
}

relay R_TRF_INC {
    voltage  = "HV";
    ct_ratio = 600/5;
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 720 A; tms = 0.45; }
}

relay R_FDR_2 {
    voltage  = "LV";
    ct_ratio = 400/5;
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.25; }
}

grade {
    primary    = R_FDR_2:51;
    backup     = R_TRF_INC:51;
    fault      = "F_FDR2_max";
    margin_target = 0.30 s;

    solve {
        strategy       = "tight";
        tolerance_pct  = 0;
    }
}
`;

describe('worked solver case', () => {
  const result = process(SOLVER_CASE);
  const report = result.reports[0];

  it('parses without errors', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
  });

  it('computes the primary operate time the spec quotes', () => {
    const row = report.rows.find((r) => r.at === 'I')!;
    // spec: M = 10.104, t_p = 0.739 s
    expect(row.M_primary).toBeCloseTo(10.104, 3);
    expect(Math.abs(row.t_primary_s - 0.739)).toBeLessThanOrEqual(0.001);
  });

  it('evaluates the backup in its own voltage frame', () => {
    // The HV incomer measures 4850 * 11/33 = 1616.7 A, not 4850 A.
    const row = report.rows.find((r) => r.at === 'I')!;
    expect(row.I_backup_A).toBeCloseTo(4850 * 11 / 33, 6);
    expect(row.M_backup).toBeCloseTo((4850 * 11 / 33) / 720, 3);
  });

  it('solves the backup tms to 0.125 +/- 0.001', () => {
    expect(report.solve).toBeDefined();
    expect(report.solve!.ok).toBe(true);
    expect(Math.abs(report.solve!.tms! - 0.125)).toBeLessThanOrEqual(0.001);
  });

  it('derives the unrounded solution the spec works through', () => {
    // spec: bracket = 0.14 / (2.2454^0.02 - 1) = 8.584, TMS = 1.039 / 8.584
    expect(Math.abs(report.solve!.tms_exact! - 0.1211)).toBeLessThanOrEqual(0.001);
  });

  it('targets t_b = t_p + margin at the declared fault', () => {
    // spec: t_b_target = 0.739 + 0.30 = 1.039 s
    expect(Math.abs(report.solve!.target_t_backup_s! - 1.039)).toBeLessThanOrEqual(0.001);
  });

  it('records the solved value on the model, flagged as automatic', () => {
    const stage = result.study!.relays.get('R_TRF_INC')!.elements[0].stages[0];
    expect(stage.tms_auto).toBe(true);
    expect(Math.abs(stage.tms! - 0.125)).toBeLessThanOrEqual(0.001);
  });

  it('achieves at least the declared margin', () => {
    // Rounding tms *up* must never land under the target.
    expect(report.achieved_margin_s).toBeGreaterThanOrEqual(0.30 - 1e-9);
  });
});

describe('closed-form solution keeps the additive c term', () => {
  /*
   * spec _Algorithm_: the naive rearrangement
   * `TMS = t_target * (M^alpha - 1) / k` drops `c` and underestimates
   * the answer whenever `c` is material -- which it is for every
   * ANSI/IEEE curve.
   */
  const ANSI_CASE = SOLVER_CASE
    .replace('curve = iec.si; I_pickup = 720 A; tms = 0.45;', 'curve = ansi.vi; I_pickup = 720 A; tms = 2.0;')
    .replace('strategy       = "tight";', 'strategy       = "loose";');

  it('is not the naive k-only rearrangement', () => {
    const study = buildStudy(parse(ANSI_CASE).document!);
    const backup = study.relays.get('R_TRF_INC')!.elements[0];
    const stage = backup.stages[0];
    const I_f = 4850;
    const M = I_f / stage.I_pu_A!;

    const t_p = 0.739;
    const t_target = t_p + 0.30;
    const p = curveParamsFromId('ansi.vi')!;

    const correct = t_target / (p.k / (Math.pow(M, p.alpha) - 1) + p.c);
    const naive = (t_target * (Math.pow(M, p.alpha) - 1)) / p.k;

    // The two differ materially; the solver must use the former.
    expect(Math.abs(correct - naive)).toBeGreaterThan(1e-6);

    const solved = solveGrade({
      backup,
      t_primary_s: t_p,
      margin_s: 0.30,
      I_f_A: I_f,
      strategy: 'tight',
      tolerance_pct: 0,
      free: ['tms'],
    });
    expect(solved.ok).toBe(true);
    expect(solved.tms_exact!).toBeCloseTo(correct, 6);
    expect(solved.tms_exact!).not.toBeCloseTo(naive, 6);
  });

  it('reproduces the target time when the solved tms is applied', () => {
    const study = buildStudy(parse(ANSI_CASE).document!);
    const backup = study.relays.get('R_TRF_INC')!.elements[0];
    const stage = backup.stages[0];
    const M = 4850 / stage.I_pu_A!;
    const p = curveParamsFromId('ansi.vi')!;

    const solved = solveGrade({
      backup,
      t_primary_s: 0.739,
      margin_s: 0.30,
      I_f_A: 4850,
      strategy: 'tight',
      tolerance_pct: 0,
      free: ['tms'],
    });
    expect(tTripIDMT(M, p, solved.tms_exact!)).toBeCloseTo(1.039, 6);
  });
});

describe('rounding strategies', () => {
  it('tight snaps up to the nearest 0.005', () => {
    // The spec's worked case: 0.28859 -> 0.290, not 0.285.
    expect(snapTms(0.28859, 'tight')).toBeCloseTo(0.290, 6);
    expect(snapTms(0.2851, 'tight')).toBeCloseTo(0.290, 6);
    expect(snapTms(0.285, 'tight')).toBeCloseTo(0.285, 6);
  });

  it('loose snaps up to the vendor dial step', () => {
    // IEC: 0.025 steps
    expect(snapTms(0.28859, 'loose', 'iec.si')).toBeCloseTo(0.300, 6);
    // ANSI: 0.05 steps
    expect(snapTms(2.31, 'loose', 'ansi.vi')).toBeCloseTo(2.35, 6);
  });

  it('never rounds below the value that meets the margin', () => {
    for (const raw of [0.001, 0.2886, 0.5001, 1.4999]) {
      expect(snapTms(raw, 'tight')).toBeGreaterThanOrEqual(raw - 1e-9);
    }
  });
});

describe('solver edge cases', () => {
  it('reports an unsatisfiable target instead of erroring out', () => {
    // A margin no setting in [0.025, 1.5] can deliver.
    const impossible = SOLVER_CASE.replace('margin_target = 0.30 s;', 'margin_target = 600 s;');
    const report = process(impossible).reports[0];

    expect(report.solve!.ok).toBe(false);
    expect(report.solve!.code).toBe('SOLVER_UNSATISFIABLE');
    expect(report.solve!.unsatisfiable).toBeDefined();
    expect(report.solve!.unsatisfiable!.suggestions.length).toBeGreaterThan(0);
  });

  it('declines to adjust a definite-time controlling stage', () => {
    const definiteBackup = SOLVER_CASE.replace(
      'element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 720 A; tms = 0.45; }',
      'element 50 { function = "phase_oc"; curve = definite; I_pickup = 720 A; t_delay = 0.8 s; }',
    ).replace('backup     = R_TRF_INC:51;', 'backup     = R_TRF_INC:50;');

    const report = process(definiteBackup).reports[0];
    expect(report.solve!.ok).toBe(false);
    expect(report.solve!.code).toBe('SOLVER_NO_IDMT_STAGE');
    // The existing margin is still reported.
    expect(report.rows.find((r) => r.at === 'I')!.margin_s).toBeGreaterThan(0);
  });

  it('applies the tolerance band as an overshoot allowance', () => {
    const tolerant = SOLVER_CASE.replace('tolerance_pct  = 0;', 'tolerance_pct  = 5;');
    const report = process(tolerant).reports[0];
    // target_margin = 0.30 * 1.05 = 0.315
    expect(Math.abs(report.solve!.target_t_backup_s! - (0.739 + 0.315))).toBeLessThanOrEqual(0.002);
    expect(report.achieved_margin_s).toBeGreaterThanOrEqual(0.30 - 1e-9);
  });
});
