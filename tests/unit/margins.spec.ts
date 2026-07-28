/**
 * The spec's worked grading case, end to end.
 *
 * Source: spec/sections/worked-examples.adoc -- _Worked grading case_,
 * over the study in _Example file_. The spec requires the numerical
 * report to match its sample within +/- 0.001 s.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { tTripElement } from '@tc/semantics/stages';

/**
 * The canonical example, trimmed to the two relays and the faults the
 * worked grading case exercises. `R_FDR_1:51` is IEC very inverse at
 * tms = 0.25 on the LV side; `R_TRF_INC:51` is IEC standard inverse
 * at tms = 0.30 on the HV side.
 */
const RIVERSIDE = `
meta {
    project   = "Riverside 33/11";
    study     = "OC grading";
    CTI_min_s = 0.30;
}

system {
    voltages {
        "HV" { kV = 33.0; description = "33 kV side"; }
        "LV" { kV = 11.0; description = "11 kV side"; }
    }
    frequency_Hz = 50;
}

faults {
    "F_FDR1_max" { I_A = 6.40 kA; voltage = "LV"; }
    "F_FDR1_min" { I_A = 2.50 kA; voltage = "LV"; }
}

relay R_TRF_INC {
    voltage  = "HV";
    ct_ratio = 600/5;
    element 51 {
        function = "phase_oc";
        curve    = iec.si;
        I_pu     = 720 A;
        tms      = 0.30;
        reset    = "instant";
    }
}

relay R_FDR_1 {
    voltage  = "LV";
    ct_ratio = 400/5;
    element 51 {
        function = "phase_oc";
        curve    = iec.vi;
        I_pu     = 480 A;
        tms      = 0.25;
        reset    = "instant";
    }
}

grade {
    primary   = R_FDR_1:51;
    backup    = R_TRF_INC:51;
    fault     = "F_FDR1_max";
    CTI_min_s = 0.30;
}
`;

/**
 * The spec quotes its worked figures to 3 dp and asks for agreement
 * "within +/- 0.001 s". Its margin column is the difference of the
 * *rounded* operate times, so a full-precision result can sit up to
 * ~0.001 s away from the printed value -- exactly the tolerance the
 * spec allows. `toBeCloseTo(x, 3)` would be twice as strict.
 */
const SPEC_TOL = 0.001;
const withinSpec = (got: number, want: number): void => {
  expect(Math.abs(got - want), `${got} is not within ${SPEC_TOL} of ${want}`)
    .toBeLessThanOrEqual(SPEC_TOL);
};

describe('worked grading case', () => {
  const result = process(RIVERSIDE);

  it('parses without errors', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
  });

  it('resolves both relays onto their declared voltage levels', () => {
    expect(result.study!.relays.get('R_TRF_INC')!.voltage_kV).toBe(33);
    expect(result.study!.relays.get('R_FDR_1')!.voltage_kV).toBe(11);
  });

  it('folds the kA suffix on the fault current', () => {
    expect(result.study!.faults.get('F_FDR1_max')!.I_A).toBe(6400);
  });

  it('reports the spec numbers at I_f = 6400 A', () => {
    const report = result.reports[0];
    const row = report.rows.find((r) => r.at === 'I')!;

    expect(row.I_f_A).toBeCloseTo(6400, 6);
    // The HV incomer measures the fault through the 33/11 transformer.
    expect(row.I_backup_A).toBeCloseTo(6400 * 11 / 33, 6);

    // spec: R_FDR_1:51 operates in 0.274 s at M = 13.333
    expect(row.M_primary).toBeCloseTo(13.333, 3);
    withinSpec(row.t_primary_s, 0.274);
    // spec: R_TRF_INC:51 operates in 1.912 s at M = 2.963
    expect(row.M_backup).toBeCloseTo(2.963, 3);
    withinSpec(row.t_backup_s, 1.912);
    // spec: margin 1.639 s, pass against the 0.30 s constraint
    withinSpec(row.margin_s, 1.639);
    expect(row.pass).toBe(true);
    expect(report.pass).toBe(true);
  });

  it('reports the spec numbers at the minimum fault, I_f = 2500 A', () => {
    // The spec's second bullet uses the same pair at sc_3ph_min.
    const alt = process(RIVERSIDE.replace('"F_FDR1_max";', '"F_FDR1_min";'));
    const row = alt.reports[0].rows.find((r) => r.at === 'I')!;

    expect(row.I_f_A).toBeCloseTo(2500, 6);
    expect(row.I_backup_A).toBeCloseTo(2500 * 11 / 33, 6);
    expect(row.M_primary).toBeCloseTo(5.208, 3);
    withinSpec(row.t_primary_s, 0.802);
    expect(row.M_backup).toBeCloseTo(1.157, 3);
    withinSpec(row.t_backup_s, 14.345);
    withinSpec(row.margin_s, 13.543);
    expect(row.pass).toBe(true);
  });

  it('evaluates each side at the current that side measures', () => {
    /*
     * spec _Cross-voltage grading_: ampere-turns balance, so the HV
     * incomer measures 6400 * 11/33 = 2133 A, not 6400 A. Dividing the
     * LV current by the HV pickup gives M = 8.889 and a margin that
     * does not physically exist.
     */
    const row = result.reports[0].rows.find((r) => r.at === 'I')!;
    expect(row.M_backup).toBeCloseTo((6400 * 11 / 33) / 720, 6);
    expect(row.M_backup).not.toBeCloseTo(6400 / 720, 3);
  });

  it('agrees with what the renderer draws at the fault current', () => {
    /*
     * The report and the plot must not disagree: a study that reads
     * 1.9 s off the chart and 0.9 s off the report is worse than
     * either number alone. The renderer asks each curve about its own
     * voltage frame; this reproduces that projection.
     */
    const study = result.study!;
    const row = result.reports[0].rows.find((r) => r.at === 'I')!;

    for (const V_view of [33, 11]) {
      const I_view = 6400 * (11 / V_view);
      for (const [relayId, expected] of [
        ['R_FDR_1', row.t_primary_s],
        ['R_TRF_INC', row.t_backup_s],
      ] as const) {
        const relay = study.relays.get(relayId)!;
        const I_source = I_view * (V_view / relay.voltage_kV!);
        expect(
          tTripElement(relay.elements[0], I_source),
          `${relayId} disagrees when the plot is drawn in the ${V_view} kV frame`,
        ).toBeCloseTo(expected, 9);
      }
    }
  });
});

describe('CTI_min_s constraint sweeps the declared fault range', () => {
  const WITH_RANGE = RIVERSIDE.replace(
    '"F_FDR1_max" { I_A = 6.40 kA; voltage = "LV"; }',
    '"F_FDR1_max" { I_A = 6.40 kA; min_A = 2.50 kA; max_A = 8.00 kA; voltage = "LV"; }',
  );

  it('evaluates a row at I_A, min_A and max_A', () => {
    const report = process(WITH_RANGE).reports[0];
    expect(report.rows.map((r) => r.at).sort()).toEqual(['I', 'max', 'min']);
    expect(report.rows.find((r) => r.at === 'min')!.I_f_A).toBeCloseTo(2500, 6);
    expect(report.rows.find((r) => r.at === 'max')!.I_f_A).toBeCloseTo(8000, 6);
  });

  it('reports the worst margin across the range', () => {
    const report = process(WITH_RANGE).reports[0];
    const worst = Math.min(...report.rows.map((r) => r.margin_s));
    expect(report.min_margin_s).toBeCloseTo(worst, 9);
  });

  it('fails the grade when any point in the range falls short', () => {
    /*
     * Derive the threshold from the achieved margins rather than
     * hard-coding one: a constraint just above the worst point must
     * fail, and one just below it must pass. That keeps the test
     * meaningful if the numbers move.
     */
    const baseline = process(WITH_RANGE).reports[0];
    const worst = baseline.min_margin_s!;
    expect(worst).toBeGreaterThan(0);

    const withCti = (value: number): boolean | undefined => {
      // anchor on the grade block -- meta carries an identical line
      const src = WITH_RANGE.replace(
        '    fault     = "F_FDR1_max";\n    CTI_min_s = 0.30;',
        `    fault     = "F_FDR1_max";\n    CTI_min_s = ${value.toFixed(3)};`,
      );
      expect(src, 'the CTI substitution did not apply').not.toEqual(WITH_RANGE);
      return process(src).reports[0].pass;
    };

    expect(withCti(worst + 0.5), 'a constraint above the worst margin must fail').toBe(false);
    expect(withCti(worst - 0.1), 'a constraint below the worst margin must pass').toBe(true);
  });
});

describe('grade blocks without a fault', () => {
  it('warns and computes no margin', () => {
    const noFault = RIVERSIDE.replace('    fault     = "F_FDR1_max";\n', '');
    const result = process(noFault);
    expect(result.reports[0].rows).toHaveLength(0);
    expect(result.reports[0].diagnostics.map((d) => d.code))
      .toContain('FAULT_OPTIONAL_NO_GRADE_CHECK');
  });
});
