/**
 * A stage reference means that stage, everywhere.
 *
 * `R_850:46/energ` was honoured by the renderer and dropped by
 * `resolveRef`, so the sheet drew the stage that was named and the
 * report graded the composite. A study could state a margin its own
 * drawing contradicted, and neither the sheet nor the report nor a
 * diagnostic said so.
 *
 * The narrowing now lives in `resolveRef`, which is the one place a
 * reference becomes a thing, so grading, combining, validation and
 * drawing cannot disagree about what a reference means.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

/**
 * An element whose two stages give very different answers at the fault.
 *
 * The inverse stage takes 157 ms at 9.4 kA; the high-set is a 40 ms
 * shelf. The composite is the pointwise minimum, so it is the high-set
 * -- which is what grading a stage reference used to return.
 */
const STUDY = (primary: string): string => `
system { voltages { "MV" { V = 11 kV; } } }
faults { "F" { I = 9.4 kA; type = three_phase; voltage = "MV"; } }
relay R_A { voltage = "MV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc";
    stages {
      stage toc  { curve = iec.vi; I_pickup = 720 A; tms = 0.14; }
      stage inst { curve = definite; I_pickup = 6000 A; t_delay = 0.04 s; }
    } } }
relay R_B { voltage = "MV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.vi; I_pickup = 900 A; tms = 0.40; } }
grade { primary = ${primary}; backup = R_B:51; fault = "F"; margin = 0.3 s; }
view { voltage = "MV"; }
`;

const reportFor = (primary: string) => {
  const result = parse(STUDY(primary));
  expect(result.parseErrors).toEqual([]);
  const report = result.reports?.[0];
  expect(report, 'the study should produce one grade report').toBeDefined();
  return report!;
};

describe('grading a named stage', () => {
  it('uses that stage, not the composite', () => {
    const staged = reportFor('R_A:51/toc');
    /*
     * IEC VI at M = 9400/720 = 13.06: 0.14 x 13.5 / 12.06 = 0.157 s.
     * The composite would answer 0.040 s, the high-set's shelf.
     */
    expect(staged.rows[0].t_primary_s).toBeCloseTo(0.157, 3);
  });

  it('differs from grading the element, which is the whole point', () => {
    const staged = reportFor('R_A:51/toc');
    const whole = reportFor('R_A:51');
    expect(whole.rows[0].t_primary_s).toBeCloseTo(0.040, 3);
    expect(staged.rows[0].t_primary_s).not.toBeCloseTo(whole.rows[0].t_primary_s, 3);
  });

  it('names the stage in the report, so the figure cannot be misread', () => {
    /*
     * Without this the row reads `R_A:51` while the numbers beside it
     * are one stage's -- indistinguishable from the composite's answer
     * except by arithmetic.
     */
    expect(reportFor('R_A:51/toc').primaryRef).toBe('R_A:51/toc');
    expect(reportFor('R_A:51').primaryRef).toBe('R_A:51');
  });

  it('changes the verdict here, which is why silence was the bug', () => {
    /*
     * The high-set clears in 40 ms and grades comfortably; the inverse
     * stage is the one that has to be checked against the backup. The
     * study asked about the second and was answered about the first.
     */
    const staged = reportFor('R_A:51/toc');
    const whole = reportFor('R_A:51');
    expect(staged.rows[0].margin_s).not.toBeCloseTo(whole.rows[0].margin_s, 3);
  });
});

describe('a stage name that matches nothing', () => {
  it('falls back to the element rather than grading an empty one', () => {
    /*
     * Reporting the typo is the validator's job. Silently grading
     * nothing would stack a second failure on the first.
     */
    const report = reportFor('R_A:51/nosuch');
    expect(Number.isFinite(report.rows[0].t_primary_s)).toBe(true);
    expect(report.rows[0].t_primary_s).toBeCloseTo(0.040, 3);
  });

  it('is reported, so the fallback is never silent', () => {
    const result = parse(STUDY('R_A:51/nosuch'));
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('UNRESOLVED_STAGE');
  });
});
