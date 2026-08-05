/**
 * How far the upstream sweep is entitled to look.
 *
 * The sweep exists because a pair that grades at the declared fault can
 * still fail above it. But its ceiling was the largest of the declared
 * fault, twenty times the primary's pick-up, and twice the starting
 * current -- so a study declaring a 9.4 kA board maximum was swept to
 * 18.8 kA and failed at 12 kA, a current its own data says cannot flow.
 *
 * A failure reported at an impossible fault is unfalsifiable from
 * inside the study: no setting the engineer can change will make an
 * impossible current coordinate. That is worse than the gap it closed,
 * and it is why the check had to be left opt-in.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

const study = (faults: string, grade: string): string => `
system { voltages { "MV" { V = 11 kV; } } }
faults { ${faults} }
relay R_FDR { voltage = "MV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.vi; I_pickup = 720 A; tms = 0.14; } }
relay R_INC { voltage = "MV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc";
    stages {
      stage toc  { curve = iec.vi; I_pickup = 900 A; tms = 0.40; }
      stage inst { curve = definite; I_pickup = 12 kA; t_delay = 0.05 s; }
    } } }
grade { ${grade} }
view { voltage = "MV"; }
`;

const MAX_9K4 = '"Board max" { I = 9.4 kA; type = three_phase; voltage = "MV"; }';
const BOTH = '"Board min" { I = 2.0 kA; type = two_phase; voltage = "MV"; } '
  + '"Board max" { I = 14 kA; type = three_phase; voltage = "MV"; }';

const reportFor = (src: string) => {
  const result = parse(src);
  expect(result.parseErrors).toEqual([]);
  return result.reports![0];
};

describe('the sweep ceiling', () => {
  it('does not exceed the largest fault the study declares', () => {
    const report = reportFor(study(MAX_9K4,
      'primary = R_FDR:51; backup = R_INC:51; fault = "Board max"; '
      + 'margin = 0.3 s; upstream = true;'));
    /*
     * The graded fault *is* the maximum, so there is nothing above it
     * to sweep. Previously this ran to 18.8 kA and failed at 12 kA.
     */
    expect(report.upstream_to_A ?? 0).toBeLessThanOrEqual(9400);
    expect(report.pass).toBe(true);
  });

  it('says so when that leaves nothing to sweep', () => {
    /*
     * Reporting a pass earned over no points at all would be its own
     * silence. The range being empty is a fact about the study.
     */
    const result = parse(study(MAX_9K4,
      'primary = R_FDR:51; backup = R_INC:51; fault = "Board max"; '
      + 'margin = 0.3 s; upstream = true;'));
    const codes = (result.reports![0].diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain('UPSTREAM_RANGE_EMPTY');
  });

  it('still catches a real failure inside the declared range', () => {
    /*
     * The point of the check, and it must survive the fix. Grading at
     * the 2 kA minimum, the backup's 12 kA instantaneous undercuts the
     * primary well below the declared 14 kA maximum.
     */
    const report = reportFor(study(BOTH,
      'primary = R_FDR:51; backup = R_INC:51; fault = "Board min"; '
      + 'margin = 0.3 s; upstream = true;'));
    expect(report.pass).toBe(false);
    expect(report.min_margin_at_A).toBeGreaterThan(9000);
    expect(report.min_margin_at_A).toBeLessThanOrEqual(14000);
  });

  it('honours an explicit upstream_to over the declared faults', () => {
    const report = reportFor(study(MAX_9K4,
      'primary = R_FDR:51; backup = R_INC:51; fault = "Board max"; '
      + 'margin = 0.3 s; upstream_to = 20 kA;'));
    expect(report.upstream_to_A).toBeCloseTo(20000, 0);
  });

  /*
   * The "no fault declared at all" fallback in `upstreamCeiling` is
   * left untested on purpose: a grade with no fault computes no margin
   * and never reaches the sweep, and a grade driven by a `scenario` is
   * not swept either. It stands as a guard for a study whose faults do
   * not project into the primary's frame, which is reachable in
   * principle and which I could not construct.
   */
});
