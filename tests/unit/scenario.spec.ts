/**
 * `scenario` blocks: one condition, its currents at every level.
 *
 * The alternative to referring a figure across a transformer, which
 * cannot be done for zero sequence at all. The engineer's fault study
 * already produces currents at each bus, so the language takes them and
 * the processor selects rather than transforms.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';

/**
 * A delta-star transformer with an LV earth fault.
 *
 * The HV level declares `I0_A = 0`: zero sequence does not cross the
 * delta. That is the whole point of the example -- an HV residual
 * element is blind to this fault, and the negative-sequence element is
 * what backs it up.
 */
const STUDY = `
system { voltages { "HV" { kV = 33; } "LV" { kV = 0.48; } } }

scenario "LV earth fault" {
    description = "Single phase to earth at 0.48 kV";
    level "LV" { I_A = 460 A; I1_A = 153 A; I2_A = 153 A; I0_A = 153 A; }
    level "HV" { I_A = 3.9 A; I1_A = 2.2 A; I2_A = 2.2 A;  I0_A = 0 A;  }
}

relay R_ACB { voltage = "LV"; element 51 { function = "phase_oc"; curve = iec.si; I_pu = 300 A; tms = 0.1; } }
relay R_850 {
  voltage = "HV"; ct_ratio = 250/1;
  element 51G { function = "earth_fault"; curve = iec.si; I_pu = 20 A; tms = 0.15; }
  element 46  { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 1.5 A; t_delay = 0.35 s; }
}
`;

function run(extra: string) {
  const result = process(STUDY + extra);
  return {
    errors: result.diagnostics.filter((d) => d.severity === 'error'),
    codes: [
      ...result.diagnostics.map((d) => d.code),
      ...result.reports.flatMap((r) => r.diagnostics.map((d) => d.code)),
    ],
    reports: result.reports,
    study: result.study,
  };
}

describe('declaring a scenario', () => {
  it('resolves each level against system.voltages', () => {
    const { study, errors } = run('');
    expect(errors).toHaveLength(0);

    const scenario = study!.scenarios.get('LV earth fault')!;
    expect([...scenario.levels.keys()]).toEqual(['LV', 'HV']);
    expect(scenario.levels.get('HV')!.voltage_kV).toBe(33);
    expect(scenario.levels.get('LV')!.I0_A).toBe(153);
  });

  it('carries its description', () => {
    const { study } = run('');
    expect(study!.scenarios.get('LV earth fault')!.description)
      .toBe('Single phase to earth at 0.48 kV');
  });
});

describe('grading against a scenario', () => {
  it('reads each side at its own level, referring nothing', () => {
    const { reports } = run(`
      grade { primary = R_ACB:51; backup = R_850:46; scenario = "LV earth fault"; CTI_min_s = 0.30; }
    `);
    const row = reports[0].rows[0];
    /* The LV phase figure and the HV I2 figure, both as declared. */
    expect(row.I_f_A).toBe(460);
    expect(row.I_backup_A).toBe(2.2);
  });

  it('leaves an HV residual element blind to an LV earth fault', () => {
    /*
     * `3 x I0` at HV is `3 x 0`, because zero sequence cannot cross
     * the delta. The element does not operate, which is the physical
     * answer and the reason the negative-sequence element exists.
     */
    const { reports, codes } = run(`
      grade { primary = R_ACB:51; backup = R_850:51G; scenario = "LV earth fault"; CTI_min_s = 0.30; }
    `);
    expect(reports[0].rows[0].I_backup_A).toBe(0);
    expect(reports[0].rows[0].t_backup_s).toBe(Infinity);
    expect(codes).toContain('NO_OPERATION');
  });

  it('applies a declared current share', () => {
    const { reports } = run(`
      scenario "shared" {
          level "LV" { I_A = 1000 A; }
          sees R_ACB { current_pct = 50; }
      }
      relay R_UP { voltage = "LV"; element 51 { curve = iec.si; I_pu = 400 A; tms = 0.3; } }
      grade { primary = R_ACB:51; backup = R_UP:51; scenario = "shared"; CTI_min_s = 0.10; }
    `);
    /* Half of the level's 1000 A reaches the shared relay. */
    expect(reports[0].rows[0].I_f_A).toBe(500);
    expect(reports[0].rows[0].I_backup_A).toBe(1000);
  });

  it('reports the scenario name on the report', () => {
    const { reports } = run(`
      grade { primary = R_ACB:51; backup = R_850:46; scenario = "LV earth fault"; CTI_min_s = 0.30; }
    `);
    expect(reports[0].fault).toBe('LV earth fault');
  });
});

describe('what a scenario refuses', () => {
  it('rejects a grade naming both a fault and a scenario', () => {
    const { codes } = run(`
      faults { "F" { I_A = 1 kA; voltage = "LV"; } }
      grade { primary = R_ACB:51; backup = R_850:46; fault = "F"; scenario = "LV earth fault"; }
    `);
    expect(codes).toContain('GRADE_FAULT_AND_SCENARIO');
  });

  it('reports a scenario that is not declared', () => {
    const { codes } = run(`
      grade { primary = R_ACB:51; backup = R_850:46; scenario = "nope"; }
    `);
    expect(codes).toContain('UNRESOLVED_REFERENCE');
  });

  it('reports a relay sitting at a level the scenario does not cover', () => {
    const { codes } = run(`
      scenario "lv only" { level "LV" { I_A = 1 kA; } }
      grade { primary = R_ACB:51; backup = R_850:46; scenario = "lv only"; }
    `);
    expect(codes).toContain('SCENARIO_LEVEL_MISSING');
  });

  it('reports a component the scenario does not declare at that level', () => {
    const { codes } = run(`
      scenario "phase only" {
          level "LV" { I_A = 1 kA; }
          level "HV" { I_A = 20 A; }
      }
      grade { primary = R_ACB:51; backup = R_850:46; scenario = "phase only"; }
    `);
    expect(codes).toContain('SEQUENCE_DATA_MISSING');
  });

  it('rejects a level naming an unknown voltage', () => {
    const { codes } = run(`
      scenario "bad level" { level "MV" { I_A = 1 kA; } }
    `);
    expect(codes).toContain('VOLTAGE_UNKNOWN');
  });

  it('rejects a scenario with no levels', () => {
    const { codes } = run('scenario "empty" { description = "nothing"; }');
    expect(codes).toContain('SCENARIO_NO_LEVELS');
  });

  it('rejects a residual that contradicts its component', () => {
    /* `earth_A` is the residual, `I0_A` the component; one implies the
     * other, so disagreeing means one figure is wrong. */
    const { codes } = run(`
      scenario "conflict" { level "LV" { I_A = 1 kA; I0_A = 100 A; earth_A = 900 A; } }
    `);
    expect(codes).toContain('SEQUENCE_RESIDUAL_CONFLICT');
  });

  it('accepts a residual that agrees with its component', () => {
    const { codes } = run(`
      scenario "agrees" { level "LV" { I_A = 1 kA; I0_A = 100 A; earth_A = 300 A; } }
    `);
    expect(codes).not.toContain('SEQUENCE_RESIDUAL_CONFLICT');
  });

  it('rejects an impossible current share', () => {
    const { codes } = run(`
      scenario "over" { level "LV" { I_A = 1 kA; } sees R_ACB { current_pct = 150; } }
    `);
    expect(codes).toContain('CURRENT_PCT_OUT_OF_RANGE');
  });

  it('rejects a share for a relay that does not exist', () => {
    const { codes } = run(`
      scenario "ghost" { level "LV" { I_A = 1 kA; } sees R_NOPE { current_pct = 50; } }
    `);
    expect(codes).toContain('UNRESOLVED_REFERENCE');
  });
});
