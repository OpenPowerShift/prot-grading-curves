/**
 * Grading against multi-stage elements.
 *
 * A staged element is graded on its *composite* -- the pointwise
 * minimum over its stages -- so whichever stage would actually operate
 * at the fault is the one the margin is computed from. That is what
 * makes a high-set undercutting a downstream device visible.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { controllingStage, tTripElement } from '@tc/semantics/stages';

const STAGED = `
system { voltages { "MV" { kV = 11.0; } } }
faults { "F_low" { I_A = 2000 A; } "F_high" { I_A = 9000 A; } }

relay R_DN { voltage = "MV"; ct_ratio = 300/5;
  element 51 { curve = iec.si; I_pu = 200 A; tms = 0.10; } }

relay R_UP { voltage = "MV"; ct_ratio = 600/5;
  element 51 {
    stages {
      stage main { curve = iec.si;   I_pu = 500 A;  tms = 0.30; }
      stage inst { curve = definite; I_pu = 8000 A; t_delay = 0.10 s; }
    }
  } }

grade { primary = R_DN:51; backup = R_UP:51; fault = "F_low";  CTI_min_s = 0.30; }
grade { primary = R_DN:51; backup = R_UP:51; fault = "F_high"; CTI_min_s = 0.30; }
`;

describe('grading a multi-stage element', () => {
  const result = process(STAGED);

  it('accepts the study', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('grades on the composite, not on one stage', () => {
    const backup = result.study!.relays.get('R_UP')!.elements[0];
    const [low, high] = result.reports;

    expect(low.rows[0].t_backup_s).toBeCloseTo(tTripElement(backup, 2000), 9);
    expect(high.rows[0].t_backup_s).toBeCloseTo(tTripElement(backup, 9000), 9);
  });

  it('lets the IDMT stage govern below the high-set pickup', () => {
    const backup = result.study!.relays.get('R_UP')!.elements[0];
    expect(controllingStage(backup, 2000)!.id).toBe('main');
    expect(result.reports[0].rows[0].t_backup_s).toBeCloseTo(1.494, 2);
    expect(result.reports[0].pass).toBe(true);
  });

  it('lets the definite stage govern above it, and catches the undercut', () => {
    const backup = result.study!.relays.get('R_UP')!.elements[0];
    expect(controllingStage(backup, 9000)!.id).toBe('inst');

    const high = result.reports[1];
    expect(high.rows[0].t_backup_s).toBeCloseTo(0.10, 9);
    /* The backup now operates *before* the primary: a real fault. */
    expect(high.rows[0].margin_s).toBeLessThan(0);
    expect(high.pass).toBe(false);
  });

  it('reports the multiple of the stage that actually operates', () => {
    // 9000 / 8000 = 1.125 on the high-set, not 9000 / 500 on the IDMT.
    expect(result.reports[1].rows[0].M_backup).toBeCloseTo(1.125, 3);
  });

  it('works with a staged element as the primary too', () => {
    const swapped = STAGED
      .replace('primary = R_DN:51; backup = R_UP:51; fault = "F_low"',
               'primary = R_UP:51; backup = R_DN:51; fault = "F_low"')
      .replace('grade { primary = R_DN:51; backup = R_UP:51; fault = "F_high"; CTI_min_s = 0.30; }', '');
    const r = process(swapped);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(Number.isFinite(r.reports[0].rows[0].t_primary_s)).toBe(true);
  });
});

describe('duplicate grade detection', () => {
  it('allows one pair to be graded at several faults', () => {
    const codes = process(STAGED).diagnostics.map((d) => d.code);
    expect(codes).not.toContain('DUPLICATE_GRADE');
  });

  it('still rejects the same pair at the same fault twice', () => {
    const repeated = `
      system { voltages { "MV" { kV = 11.0; } } }
      faults { "F" { I_A = 2000 A; } }
      relay A { voltage = "MV"; element 51 { curve = iec.si; I_pu = 200 A; tms = 0.1; } }
      relay B { voltage = "MV"; element 51 { curve = iec.si; I_pu = 500 A; tms = 0.3; } }
      grade { primary = A:51; backup = B:51; fault = "F"; CTI_min_s = 0.3; }
      grade { primary = A:51; backup = B:51; fault = "F"; CTI_min_s = 0.4; }
    `;
    expect(process(repeated).diagnostics.map((d) => d.code)).toContain('DUPLICATE_GRADE');
  });
});
