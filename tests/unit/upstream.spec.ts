/**
 * Upstream margin sweep.
 *
 * Source: spec/sections/semantics.adoc -- _Upstream sweep_. The case
 * that motivates it: an extremely-inverse backup grades correctly at
 * the declared fault but overtakes a standard-inverse primary further
 * up the curve, which a declared-points-only check cannot see.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { formatGradeReport } from '@tc/semantics/grades';

/** SI primary, EI backup: fine at 3 kA, inverted well above it. */
const CONVERGING = `
system { voltages { "MV" { V  = 11.0 kV; } } }
faults { "F_bus" { I   = 3000 A; } "F_max" { I   = 20000 A; } }
relay R_DN { voltage = "MV"; ct_ratio = 400/5;
  element 51 { curve = iec.si; I_pickup = 300 A; tms = 0.20; } }
relay R_UP { voltage = "MV"; ct_ratio = 600/5;
  element 51 { curve = iec.ei; I_pickup = 500 A; tms = 0.40; } }
grade {
  primary   = R_DN:51;
  backup    = R_UP:51;
  fault     = "F_bus";
  margin    = 0.30 s;
  upstream  = true;
}
`;

const withoutSweep = CONVERGING.replace('  upstream  = true;\n', '');

describe('upstream sweep', () => {
  it('passes at the declared fault', () => {
    const row = process(CONVERGING).reports[0].rows.find((r) => r.at === 'I')!;
    expect(row.margin_s).toBeGreaterThan(0.30);
    expect(row.pass).toBe(true);
  });

  it('is what turns the grade from pass to fail', () => {
    // Without the sweep the declared point is all that is judged.
    expect(process(withoutSweep).reports[0].pass).toBe(true);
    expect(process(CONVERGING).reports[0].pass).toBe(false);
  });

  it('finds the inversion above the declared fault', () => {
    const report = process(CONVERGING).reports[0];
    const swept = report.rows.filter((r) => r.at === 'upstream');
    expect(swept.length).toBeGreaterThan(10);

    const worst = swept.reduce((a, b) => (b.margin_s < a.margin_s ? b : a));
    // The backup ends up faster than the primary: a negative margin.
    expect(worst.margin_s).toBeLessThan(0);
    expect(worst.I_f_A).toBeGreaterThan(3000);
  });

  it('sweeps only above the declared fault', () => {
    const report = process(CONVERGING).reports[0];
    for (const row of report.rows.filter((r) => r.at === 'upstream')) {
      expect(row.I_f_A).toBeGreaterThan(3000);
    }
  });

  it('defaults its ceiling to the largest declared fault', () => {
    const report = process(CONVERGING).reports[0];
    expect(report.upstream_to_A).toBeCloseTo(20000, 6);
  });

  it('honours an explicit upstream_to', () => {
    const capped = CONVERGING.replace('  upstream  = true;', '  upstream_to = 8 kA;');
    const report = process(capped).reports[0];
    expect(report.upstream_to_A).toBeCloseTo(8000, 6);
    for (const row of report.rows.filter((r) => r.at === 'upstream')) {
      expect(row.I_f_A).toBeLessThanOrEqual(8000 + 1e-6);
    }
  });

  it('reports the tightest point in the text output', () => {
    const text = formatGradeReport(process(CONVERGING).reports[0]);
    expect(text).toContain('upstream sweep');
    expect(text).toContain('tightest at');
    expect(text).toMatch(/overall\s+: FAIL/);
  });

  it('warns when swept without a constraint to judge against', () => {
    const noCti = CONVERGING.replace('  margin    = 0.30 s;\n', '');
    const codes = process(noCti).diagnostics.map((d) => d.code);
    expect(codes).toContain('UPSTREAM_WITHOUT_CTI');
  });

  it('carries cross-voltage pairs through the sweep in each own frame', () => {
    const crossVoltage = `
      system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 11.0 kV; } } }
      faults { "F" { I   = 6400 A; voltage = "LV"; } }
      relay R_FDR { voltage = "LV"; ct_ratio = 400/5;
        element 51 { curve = iec.vi; I_pickup = 480 A; tms = 0.25; } }
      relay R_INC { voltage = "HV"; ct_ratio = 600/5;
        element 51 { curve = iec.si; I_pickup = 720 A; tms = 0.30; } }
      grade { primary = R_FDR:51; backup = R_INC:51; fault = "F";
              margin    = 0.30 s; upstream = true; }
    `;
    for (const row of process(crossVoltage).reports[0].rows) {
      expect(row.I_backup_A).toBeCloseTo(row.I_f_A * 11 / 33, 6);
    }
  });
});
