/**
 * The report and the plot resolve a condition the same way.
 *
 * A fault's `type` fixes the ratios between phase current and the
 * sequence components. The renderer used those ratios to place rules
 * and convert curves; grading did not, so one condition gave two
 * answers -- the sheet drew a coordinated pair while the margin table
 * refused to grade it.
 */

import { describe, expect, it } from 'vitest';
import { process, parseAndRender } from '@tc/index';

/* Declares only its phase current, plus the type that fixes I2. */
const STUDY = `
system { voltages { "HV" { kV = 33; } } }
faults { "2ph min" { I_A = 390 A; type = two_phase; voltage = "HV"; } }
relay A { voltage = "HV"; ct_ratio = 250/1;
  element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 75 A; t_delay = 0.10 s; } }
relay B { voltage = "HV"; ct_ratio = 250/1;
  element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 75 A; t_delay = 0.45 s; } }
grade { primary = A:46; backup = B:46; fault = "2ph min"; CTI_min_s = 0.30; }
view { voltage = "HV"; quantity = I2; condition = "2ph min";
       current_min = 10 A; current_max = 40 kA; }
`;

const result = process(STUDY);
const report = result.reports[0];

describe('a component derived from the fault type', () => {
  it('grades the pair rather than refusing it', () => {
    /* `currentFor` never derives, so this used to report
     * SEQUENCE_DATA_MISSING and fail the pair outright. */
    expect(report.diagnostics.map((d) => d.code)).not.toContain('SEQUENCE_DATA_MISSING');
    expect(report.pass).toBe(true);
  });

  it('grades at the same current the sheet draws the rule at', () => {
    /* 390 A of phase current at a phase-phase fault is 390/root3 of
     * I2. One condition, one answer. */
    const onSheet = Number(parseAndRender(STUDY, { theme: 'light' }).svg
      .match(/data-fault="[^"]+" data-current="([\d.]+)"/)![1]);
    const inReport = report.rows.find((r) => r.at === 'I')!.I_f_A;

    expect(onSheet).toBeCloseTo(390 / Math.sqrt(3), 1);
    expect(inReport).toBeCloseTo(onSheet, 1);
  });

  it('says the margin rests on an assumed fault shape', () => {
    /*
     * A margin from a ratio table is still a margin, but it rests on
     * the fault's assumed shape rather than on measured figures, and a
     * reader is entitled to know which they have. `resolveCurrent` has
     * carried the flag since the ratios were added; nothing read it.
     */
    expect(report.diagnostics.map((d) => d.code)).toContain('MARGIN_FROM_DERIVED_COMPONENT');
  });

  it('says nothing of the sort when the component is declared', () => {
    const declared = process(STUDY.replace('type = two_phase;', 'I2_A = 225 A;'));
    expect(declared.reports[0].diagnostics.map((d) => d.code))
      .not.toContain('MARGIN_FROM_DERIVED_COMPONENT');
    expect(declared.reports[0].pass).toBe(true);
  });

  it('still refuses where neither a figure nor a type can supply it', () => {
    const bare = process(STUDY.replace('type = two_phase;', ''));
    const codes = bare.reports[0].diagnostics.map((d) => d.code);
    expect(codes).toContain('SEQUENCE_DATA_MISSING');
    expect(bare.reports[0].diagnostics.find((d) => d.code === 'SEQUENCE_DATA_MISSING')!.message)
      .toContain('no type to derive it from');
  });
});
