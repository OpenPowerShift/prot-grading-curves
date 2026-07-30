/**
 * What each element measures, and what follows from it.
 *
 * A relay does not measure "the fault current": a `51` measures phase,
 * a `51G` measures residual `3*I0`, a `46` measures `I2`. Before this,
 * `function` was parsed and never read, so every element was graded
 * against the declared phase current -- producing well-formed margins
 * for comparisons that were never made.
 *
 * `spec/sections/semantics.adoc` -- _Function-specific multiple
 * derivation_ -- is the normative table these tests pin.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import {
  currentFor,
  measuredQuantityOf,
  quantityLabel,
  survivesVoltageReferral,
} from '@tc/semantics/quantity';
import type { Stage } from '@tc/semantics/model';

/** A bare stage carrying only what the resolver reads. */
const stage = (fields: Partial<Stage>): Stage =>
  ({ id: 'main', current_pct: 100, node: { type: 'element', id: 'x', members: [], loc: { line: 1, column: 1, offset: 0 } }, ...fields }) as Stage;

describe('defaults by function', () => {
  it('reads phase current for the phase functions', () => {
    for (const fn of ['phase_oc', 'thermal', 'breaker_fail']) {
      expect(measuredQuantityOf(stage({ function: fn })), fn).toBe('phase');
    }
  });

  it('reads residual 3I0 for an earth-fault element', () => {
    expect(measuredQuantityOf(stage({ function: 'earth_fault' }))).toBe('3I0');
  });

  it('refuses to guess for negative sequence', () => {
    /*
     * IEDs differ over whether the pickup is scaled in I2 or 3*I2 --
     * a factor of three, which is the difference between an element
     * that operates and one that does not.
     */
    expect(measuredQuantityOf(stage({ function: 'neg_seq' }))).toBeNull();
  });

  it('takes an explicit declaration over the default', () => {
    expect(measuredQuantityOf(stage({ function: 'earth_fault', measures: 'I0' }))).toBe('I0');
    expect(measuredQuantityOf(stage({ function: 'neg_seq', measures: '3I2' }))).toBe('3I2');
  });

  it('treats an element with no function as a phase element', () => {
    expect(measuredQuantityOf(stage({}))).toBe('phase');
  });
});

describe('resolving a quantity against declared currents', () => {
  const currents = { phase: 6000, I1: 2000, I2: 1500, I0: 800 };

  it('picks the component asked for', () => {
    expect(currentFor('phase', currents)).toBe(6000);
    expect(currentFor('I1', currents)).toBe(2000);
    expect(currentFor('I2', currents)).toBe(1500);
    expect(currentFor('I0', currents)).toBe(800);
  });

  it('scales the residual forms by three', () => {
    expect(currentFor('3I0', currents)).toBe(2400);
    expect(currentFor('3I2', currents)).toBe(4500);
  });

  it('takes a directly declared residual as the residual', () => {
    /* `earth_A` is the residual itself, not a component to triple. */
    expect(currentFor('3I0', { residual: 2400 })).toBe(2400);
    expect(currentFor('I0', { residual: 2400 })).toBe(800);
  });

  it('reports absence rather than substituting another quantity', () => {
    expect(currentFor('I2', { phase: 6000 })).toBeNull();
    expect(currentFor('3I0', { phase: 6000, I2: 1500 })).toBeNull();
  });
});

describe('which quantities survive a voltage referral', () => {
  it('passes positive and negative sequence', () => {
    for (const q of ['phase', 'I1', 'I2', '3I2'] as const) {
      expect(survivesVoltageReferral(q), q).toBe(true);
    }
  });

  it('blocks zero sequence, which does not cross a delta', () => {
    expect(survivesVoltageReferral('I0')).toBe(false);
    expect(survivesVoltageReferral('3I0')).toBe(false);
  });

  it('labels the residual so a legend reads plainly', () => {
    expect(quantityLabel('3I0')).toBe('residual 3I0');
    expect(quantityLabel('I2')).toBe('I2');
  });
});

/* ---------------------------------------------------------------- */

const SYSTEM = `
system { voltages { "HV" { kV = 33; } "LV" { kV = 0.48; } } }
relay R_FDR { voltage = "LV"; element 51 { function = "phase_oc"; curve = iec.si; I_pu = 300 A; tms = 0.1; } }
`;

function report(extra: string) {
  const result = process(SYSTEM + extra);
  return {
    diagnostics: [
      ...result.diagnostics,
      ...(result.reports[0]?.diagnostics ?? []),
    ],
    rows: result.reports[0]?.rows ?? [],
    codes: [
      ...result.diagnostics.map((d) => d.code),
      ...(result.reports[0]?.diagnostics ?? []).map((d) => d.code),
    ],
  };
}

describe('grading against the measured current', () => {
  it('grades an earth-fault element off the residual, not the phase current', () => {
    const r = report(`
      faults { "F" { I_A = 6 kA; I0_A = 800 A; voltage = "LV"; } }
      relay R_INC { voltage = "LV"; element 51G { function = "earth_fault"; curve = iec.si; I_pu = 20 A; tms = 0.15; } }
      grade { primary = R_FDR:51; backup = R_INC:51G; fault = "F"; CTI_min_s = 0.3; }
    `);
    /* 3 x 800 A, where the phase figure would have been 6000 A. */
    expect(r.rows[0].I_backup_A).toBe(2400);
  });

  it('grades a negative-sequence element off I2', () => {
    const r = report(`
      faults { "F" { I_A = 6 kA; I2_A = 2 kA; voltage = "LV"; } }
      relay R_INC { voltage = "LV"; element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 75 A; t_delay = 0.4 s; } }
      grade { primary = R_FDR:51; backup = R_INC:46; fault = "F"; CTI_min_s = 0.3; }
    `);
    expect(r.rows[0].I_backup_A).toBe(2000);
  });

  it('errors rather than falling back when the component is not declared', () => {
    const r = report(`
      faults { "F" { I_A = 6 kA; voltage = "LV"; } }
      relay R_INC { voltage = "LV"; element 51G { function = "earth_fault"; curve = iec.si; I_pu = 20 A; tms = 0.15; } }
      grade { primary = R_FDR:51; backup = R_INC:51G; fault = "F"; CTI_min_s = 0.3; }
    `);
    expect(r.codes).toContain('SEQUENCE_DATA_MISSING');
    expect(r.rows).toHaveLength(0);
  });

  it('refuses to refer a residual across a transformer', () => {
    /*
     * Zero sequence does not cross a delta winding, which is why an
     * HV negative-sequence element -- not an HV residual element --
     * backs up an LV earth fault.
     */
    const r = report(`
      faults { "F" { I_A = 6 kA; I0_A = 800 A; voltage = "LV"; } }
      relay R_HV { voltage = "HV"; element 51G { function = "earth_fault"; curve = iec.si; I_pu = 20 A; tms = 0.15; } }
      grade { primary = R_FDR:51; backup = R_HV:51G; fault = "F"; CTI_min_s = 0.3; }
    `);
    expect(r.codes).toContain('SEQUENCE_ACROSS_LEVELS');
    expect(r.rows).toHaveLength(0);
  });

  it('does refer negative sequence across a transformer, by the turns ratio', () => {
    const r = report(`
      faults { "F" { I_A = 6 kA; I2_A = 2 kA; voltage = "LV"; } }
      relay R_HV { voltage = "HV"; element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 20 A; t_delay = 0.4 s; } }
      grade { primary = R_FDR:51; backup = R_HV:46; fault = "F"; CTI_min_s = 0.3; }
    `);
    expect(r.rows[0].I_backup_A).toBeCloseTo(2000 * (0.48 / 33), 6);
  });

  it('says so when the two sides measure different currents', () => {
    const r = report(`
      faults { "F" { I_A = 6 kA; I2_A = 2 kA; voltage = "LV"; } }
      relay R_INC { voltage = "LV"; element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 75 A; t_delay = 0.4 s; } }
      grade { primary = R_FDR:51; backup = R_INC:46; fault = "F"; CTI_min_s = 0.3; }
    `);
    const mixed = r.diagnostics.find((d) => d.code === 'GRADE_MIXED_QUANTITY');
    expect(mixed?.severity).toBe('warning');
  });
});

describe('validation', () => {
  it('requires the quantity on a negative-sequence element', () => {
    const r = report(`
      relay R_INC { voltage = "LV"; element 46 { function = "neg_seq"; curve = definite; I_pu = 75 A; t_delay = 0.4 s; } }
    `);
    expect(r.codes).toContain('MEASURES_REQUIRED');
  });

  it('rejects a spelling it does not know', () => {
    const r = report(`
      relay R_INC { voltage = "LV"; element 51 { measures = "I7"; curve = iec.si; I_pu = 75 A; tms = 0.2; } }
    `);
    expect(r.codes).toContain('MEASURES_UNKNOWN');
  });

  it('rejects stages of one element measuring different currents', () => {
    const r = report(`
      relay R_INC {
        voltage = "LV";
        element 50 {
          stages {
            stage a { measures = "phase"; curve = definite; I_pu = 1 kA; t_delay = 0.1 s; }
            stage b { measures = "I2";    curve = definite; I_pu = 1 kA; t_delay = 0.2 s; }
          }
        }
      }
    `);
    expect(r.codes).toContain('MEASURES_MIXED');
  });

  it('no longer calls a 51 and a 51G a double trip', () => {
    /*
     * DUPLICATE_ELEMENT keyed on (curve, I_pu, tms) alone, so two
     * elements responding to entirely different currents -- which
     * routinely share settings -- were reported as identical.
     */
    const r = report(`
      faults { "F" { I_A = 6 kA; voltage = "LV"; } }
      relay R_INC {
        voltage = "LV";
        element 51  { function = "phase_oc";    curve = iec.si; I_pu = 100 A; tms = 0.2; }
        element 51G { function = "earth_fault"; curve = iec.si; I_pu = 100 A; tms = 0.2; }
      }
    `);
    expect(r.codes).not.toContain('DUPLICATE_ELEMENT');
  });

  it('still catches a genuine duplicate', () => {
    const r = report(`
      relay R_INC {
        voltage = "LV";
        element 51  { function = "phase_oc"; curve = iec.si; I_pu = 100 A; tms = 0.2; }
        element 51X { function = "phase_oc"; curve = iec.si; I_pu = 100 A; tms = 0.2; }
      }
    `);
    expect(r.codes).toContain('DUPLICATE_ELEMENT');
  });
});

describe('letter-suffixed element references', () => {
  it('resolves a reference to 51G rather than dropping the suffix', () => {
    /*
     * The reference parser ate one token after the colon, so
     * `R_INC:51G` referred to `51` -- resolving to a different element
     * where one existed and to nothing where it did not. Every
     * suffixed device number was affected: 51G, 67N, 51X, 50BF.
     */
    const result = process(SYSTEM + `
      faults { "F" { I_A = 6 kA; I0_A = 800 A; voltage = "LV"; } }
      relay R_INC { voltage = "LV"; element 51G { function = "earth_fault"; curve = iec.si; I_pu = 20 A; tms = 0.15; } }
      grade { primary = R_FDR:51; backup = R_INC:51G; fault = "F"; CTI_min_s = 0.3; }
    `);
    const grade = result.document!.items.find((i) => i.type === 'grade') as { backup?: { elementId?: string } };
    expect(grade.backup?.elementId).toBe('51G');
    expect(result.reports[0].diagnostics.map((d) => d.code)).not.toContain('UNRESOLVED_REFERENCE');
  });
});
