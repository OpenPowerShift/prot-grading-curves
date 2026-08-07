/**
 * Two ways to say what a relay carries, and which one wins.
 *
 * `scenario { sees R { share } }` states what this relay takes of
 * *that* condition. `element { share }` states it generally. Both used
 * to apply, multiplying: a 50/50 pair was graded at a quarter of the
 * level current, and the report printed the half as `I_f` on the line
 * directly above a multiple computed from the quarter.
 *
 * Shipped example 15 did exactly that -- `seen by primary = 3600 A`
 * over `(M = 3.75)` against a 480 A pickup, where 3600/480 is 7.5 --
 * and its `ONE_CIRCUIT_OUT` scenario declared 100% ("A carries the
 * lot") and was silently halved anyway.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

const study = (elementShare: string, seesShare: string): string => `
system { voltages { HV { V = 33 kV; } } }
scenario S {
  name = "Both in"; type = three_phase;
  level HV { I = 4000 A; I1 = 4000 A; I2 = 0 A; I0 = 0 A; }
  ${seesShare}
}
relay R_A { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase; curve = definite;
               I_pickup = 500 A; t_delay = 100 ms; ${elementShare} } }
relay R_B { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase; curve = definite;
               I_pickup = 100 A; t_delay = 1 s; } }
grade { primary = R_A:51; backup = R_B:51; scenario = S; margin = 0.3 s; }
view { voltage = HV; }
`;

const row = (src: string) => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  return { report: r.reports[0]!, codes: r.diagnostics.map((d) => d.code) };
};

describe('a relay whose share the scenario states', () => {
  it('is graded at the scenario\'s figure, not that times its own', () => {
    /* 4000 x 50% = 2000 A, against a 500 A pickup: a multiple of 4. */
    const { report } = row(study('share = 50;', 'sees R_A { share = 50; }'));
    expect(report.rows[0].I_f_A).toBeCloseTo(2000, 0);
    expect(report.rows[0].M_primary).toBeCloseTo(4, 2);
  });

  it('prints a multiple that agrees with the current beside it', () => {
    /*
     * The symptom a reader met: two adjacent lines contradicting each
     * other by a factor of two.
     */
    const { report } = row(study('share = 50;', 'sees R_A { share = 50; }'));
    const r = report.rows[0];
    expect(r.M_primary).toBeCloseTo(r.I_f_A / 500, 2);
  });

  it('honours a scenario share of 100 rather than halving it', () => {
    const { report } = row(study('share = 50;', 'sees R_A { share = 100; }'));
    expect(report.rows[0].I_f_A).toBeCloseTo(4000, 0);
    expect(report.rows[0].M_primary).toBeCloseTo(8, 2);
  });

  it('says so, because it is choosing between two readings of the study', () => {
    expect(row(study('share = 50;', 'sees R_A { share = 50; }')).codes)
      .toContain('SHARE_DECLARED_TWICE');
  });

  it('stays quiet when only one of them is declared', () => {
    expect(row(study('', 'sees R_A { share = 50; }')).codes)
      .not.toContain('SHARE_DECLARED_TWICE');
    expect(row(study('share = 50;', '')).codes)
      .not.toContain('SHARE_DECLARED_TWICE');
  });
});

describe('a relay whose share only the element states', () => {
  it('still takes it, the scenario having said nothing', () => {
    /* The installation-level split: two identical feeders off a board,
     * with no condition claiming to know better. */
    const { report } = row(study('share = 50;', ''));
    expect(report.rows[0].M_primary).toBeCloseTo(4, 2);
  });
});

describe('the shipped parallel-feeder study', () => {
  const src = readFileSync('examples/15-parallel-feeders.ptc', 'utf8');

  it('no longer declares a share in both places', () => {
    expect(parse(src).diagnostics.map((d) => d.code))
      .not.toContain('SHARE_DECLARED_TWICE');
  });

  it('grades its feeder at the current it prints', () => {
    const rep = parse(src).reports[0]!;
    expect(rep.rows[0].M_primary).toBeCloseTo(rep.rows[0].I_f_A / 480, 2);
  });
});
