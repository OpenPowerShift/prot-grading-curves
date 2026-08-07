/**
 * What units the sweeps run in.
 *
 * The three declared rows -- `I`, `min`, `max` -- come from
 * `sideCurrentAt`, which resolves the quantity each side measures. The
 * interior of the range and the upstream sweep did not: they walked
 * `fault.min_A` to `fault.max_A` in *phase* amps and scaled the backup
 * by a phase-and-voltage ratio.
 *
 * So an earth-fault pair had three rows in residual amps and
 * thirty-two in phase amps, and its verdict line named a worst point
 * at a current no row had been taken at and neither element sees.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

/* A residual-measuring pair: the fault's phase figure is 2 kA and its
 * residual 1.2 kA, so the two axes are a long way apart. */
const RESIDUAL = `
system { voltages { HV { V = 33 kV; } } }
faults { F { type = single_phase_earth; I = 2 kA; I_min = 1 kA; I_max = 4 kA;
             I0 = 400 A; residual = 1.2 kA; voltage = HV; } }
relay R_A { voltage = HV; ct_ratio = 400/5;
  element 51G { function = earth_fault; measures = 3I0;
                curve = iec.si; I_pickup = 200 A; tms = 0.10; } }
relay R_B { voltage = HV; ct_ratio = 400/5;
  element 51G { function = earth_fault; measures = 3I0;
                curve = iec.si; I_pickup = 300 A; tms = 0.30; } }
grade { primary = R_A:51G; backup = R_B:51G; fault = F; margin = 0.3 s; }
view { voltage = HV; quantity = 3I0; }
`;

const report = (src: string) => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  return r;
};

describe('a pair measuring residual current', () => {
  const rep = report(RESIDUAL).reports[0]!;

  it('states its declared points in residual amps', () => {
    /* 1.2 kA declared, and endpoints carried by the same ratio. */
    expect(rep.rows.find((r) => r.at === 'I')!.I_f_A).toBeCloseTo(1200, 0);
    expect(rep.rows.find((r) => r.at === 'min')!.I_f_A).toBeCloseTo(600, 0);
    expect(rep.rows.find((r) => r.at === 'max')!.I_f_A).toBeCloseTo(2400, 0);
  });

  it('sweeps its interior in the same units', () => {
    /*
     * The interior used to run 1 kA to 4 kA -- the phase range -- so
     * rows in one table were in two different currents.
     */
    const interior = rep.rows.filter((r) => r.at === 'range');
    expect(interior.length).toBeGreaterThan(8);
    for (const row of interior) {
      expect(row.I_f_A).toBeGreaterThanOrEqual(599);
      expect(row.I_f_A).toBeLessThanOrEqual(2401);
    }
  });

  it('never sweeps above the range in phase amps', () => {
    /* The ceiling comes back in phase and is carried across; without
     * that the sweep ran from 2.4 kA of residual to 4 kA of phase. */
    for (const row of rep.rows.filter((r) => r.at === 'upstream')) {
      expect(row.I_f_A).toBeGreaterThan(2399);
      expect(row.I_f_A).toBeLessThanOrEqual(2401);
    }
  });

  it('reports a worst point that is one of its own rows', () => {
    /*
     * The symptom: "worst 0.563 s at 4000 A" under a table whose
     * largest row was 2400 A.
     */
    if (rep.min_margin_at_A == null) return;
    const currents = rep.rows.map((r) => r.I_f_A);
    expect(Math.min(...currents.map((c) => Math.abs(c - rep.min_margin_at_A!)))).toBeLessThan(1);
  });
});

describe('a pair the study gives no data for', () => {
  const NO_DATA = RESIDUAL
    .replace('type = single_phase_earth; ', '')
    .replace('I0 = 400 A; residual = 1.2 kA; ', '')
    .replace(/51G/g, '46')
    .replace(/function = earth_fault/g, 'function = neg_seq')
    .replace(/measures = 3I0/g, 'measures = I2');

  it('is not swept, so no verdict is printed beside the refusal', () => {
    /*
     * It used to report `verdict: pass` under
     * `SEQUENCE_DATA_MISSING: this pair cannot be graded` -- phase
     * current silently substituted for a quantity the study never
     * gave.
     */
    const r = report(NO_DATA);
    const rep = r.reports[0]!;
    expect(rep.rows.filter((x) => x.at === 'range')).toEqual([]);
    expect(rep.pass).not.toBe(true);
    expect(rep.diagnostics.map((d) => d.code)).toContain('SEQUENCE_DATA_MISSING');
  });
});
