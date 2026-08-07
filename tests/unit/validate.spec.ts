/**
 * Semantic validation rules.
 *
 * Source: spec/sections/validation.adoc. Each case asserts the code
 * and severity the spec prescribes, not just "something was reported",
 * so a rule that silently changes meaning fails here.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { parse } from '@tc/parser';

/** Codes reported for a source, with their severities. */
function codes(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of process(src).diagnostics) out.set(d.code, d.severity);
  return out;
}

const BASE = `
system { voltages { "LV" { V  = 11.0 kV; } } }
faults { "F1" { I   = 4000 A; voltage = "LV"; } }
`;

describe('curve identifiers', () => {
  it('rejects a curve not in the constants table, with a suggestion', () => {
    const result = process(`${BASE}
      relay R { voltage = "LV"; element 51 { curve = iec.s1; I_pickup = 400 A; tms = 0.3; } }
    `);
    const d = result.diagnostics.find((x) => x.code === 'CURVE_UNKNOWN');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('did you mean "iec.si"');
  });

  it('accepts every namespace the spec declares', () => {
    for (const id of ['iec.si', 'ansi.mi', 'sel.c1', 'ge.ur.vi', 'abb.ri', 'siemens.inv']) {
      const tms = id.startsWith('ansi.') ? '2.0' : '0.3';
      const found = codes(`${BASE}
        relay R { voltage = "LV"; element 51 { curve = ${id}; I_pickup = 400 A; tms = ${tms}; } }
      `);
      expect(found.has('CURVE_UNKNOWN'), `${id} was rejected`).toBe(false);
    }
  });
});

describe('element shape', () => {
  it('rejects mixing the shorthand form with a stages block', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV";
        element 51 {
          curve = iec.si; I_pickup = 400 A; tms = 0.3;
          stages { stage a { curve = iec.vi; I_pickup = 400 A; tms = 0.3; } }
        }
      }
    `);
    expect(found.get('ELEMENT_MIXED_FORMS')).toBe('error');
  });

  it('rejects an element with no curve producer at all', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV"; element 51 { I_pickup = 400 A; } }
    `);
    expect(found.get('ELEMENT_NO_CURVE')).toBe('error');
  });

  it('rejects a definite stage that also declares tms', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV";
        element 50 { curve = definite; I_pickup = 4000 A; t_delay = 0.1 s; tms = 0.3; }
      }
    `);
    expect(found.get('DEFINITE_WITH_TMS')).toBe('error');
  });

  it('treats a bare t_delay as a definite-time stage', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV"; element 50 { I_pickup = 4000 A; t_delay = 0.1 s; } }
    `);
    expect(found.has('ELEMENT_NO_CURVE')).toBe(false);
  });
});

describe('numeric ranges', () => {
  it('rejects a non-positive pickup', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 0 A; tms = 0.3; } }
    `);
    expect(found.get('PICKUP_NOT_POSITIVE')).toBe('error');
  });

  it('rejects tms outside the IEC range', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 400 A; tms = 3.0; } }
    `);
    expect(found.get('TMS_OUT_OF_RANGE')).toBe('error');
  });

  it('applies the wider ANSI range to ANSI curves', () => {
    // 3.0 is out of range for IEC but valid as an ANSI time dial
    const found = codes(`${BASE}
      relay R { voltage = "LV"; element 51 { curve = ansi.mi; I_pickup = 400 A; tms = 3.0; } }
    `);
    expect(found.has('TMS_OUT_OF_RANGE')).toBe(false);
  });

  it('rejects current_pct outside (0, 100]', () => {
    for (const bad of ['0', '120', '-10']) {
      const found = codes(`${BASE}
        relay R { voltage = "LV";
          element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; share       = ${bad}; }
        }
      `);
      expect(found.get('CURRENT_PCT_OUT_OF_RANGE'), `current_pct = ${bad}`).toBe('error');
    }
  });

  it('rejects an invalid formula', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV";
        element 51 { formula = { k = -1 s; c = 0 s; alpha = 9 }; I_pickup = 400 A; tms = 0.3; }
      }
    `);
    expect(found.get('FORMULA_K_INVALID')).toBe('error');
    expect(found.get('FORMULA_ALPHA_INVALID')).toBe('error');
  });
});

describe('flex points', () => {
  it('rejects a table with fewer than two entries', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV";
        element 51 { flex_points = [(100 A, 5 s)]; I_pickup = 100 A; tms = 1.0; }
      }
    `);
    expect(found.get('FLEX_TOO_FEW_POINTS')).toBe('error');
  });

  it('rejects a repeated current', () => {
    const found = codes(`${BASE}
      relay R { voltage = "LV";
        element 51 { flex_points = [(100 A, 5 s), (100 A, 2 s)]; I_pickup = 100 A; tms = 1.0; }
      }
    `);
    expect(found.get('FLEX_NOT_MONOTONE')).toBe('error');
  });
});

describe('the keys removed on 2026-08-08', () => {
  /*
   * `reset` and `t_reset` had a validator of their own and a formula
   * in `curves.ts`, and nothing ever drew or graded a reset
   * characteristic. `direction`, `directional` and `char_angle`
   * described directionality, which is not a time-current property at
   * all. All five parsed, were stored on the model, and were read by
   * nothing.
   *
   * Refused now -- and refused with a *reason*, because a key that
   * behaved for months is one a study is entitled to have been
   * written with. A bare "unknown setting" would leave its author with
   * no idea the tool had been ignoring it all along.
   */
  for (const [key, source] of [
    ['reset', 'element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; reset = "instant"; }'],
    ['t_reset', 'element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; t_reset = 6 s; }'],
    ['directional', 'element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; directional = true; }'],
    ['char_angle', 'element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; char_angle = 45 deg; }'],
    ['direction', 'element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; }'],
  ] as const) {
    it(`refuses ${key}, and says why`, () => {
      const body = key === 'direction'
        ? `relay R { voltage = "LV"; direction = forward; ${source} }`
        : `relay R { voltage = "LV"; ${source} }`;
      const errors = parse(`${BASE}\n${body}`).errors
        .filter((e) => e.severity === 'error');
      const removed = errors.find((e) => e.code === 'REMOVED_KEY');
      expect(removed, `${key} should be refused`).toBeDefined();
      expect(removed!.message).toContain(key);
      /* Not just "unknown": the sentence has to say what it was. */
      expect(removed!.message.length).toBeGreaterThan(40);
    });
  }
});

describe('references', () => {
  const RELAYS = `${BASE}
    relay R_A { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
    relay R_B { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 800 A; tms = 0.5; } }
  `;

  it('rejects a grade naming an element that does not exist', () => {
    const result = process(`${RELAYS}
      grade { primary = R_A:99; backup = R_B:51; fault = "F1"; margin    = 0.3 s; }
    `);
    const d = result.diagnostics.find((x) => x.code === 'UNRESOLVED_REFERENCE');
    expect(d?.severity).toBe('error');
  });

  it('rejects a grade naming a fault that does not exist', () => {
    const result = process(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; fault = "NOPE"; margin    = 0.3 s; }
    `);
    expect(result.diagnostics.some((d) =>
      d.code === 'UNRESOLVED_REFERENCE' && d.message.includes('NOPE'))).toBe(true);
  });

  it('rejects two grade blocks for the same pair', () => {
    const found = codes(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; fault = "F1"; margin    = 0.3 s; }
      grade { primary = R_A:51; backup = R_B:51; fault = "F1"; margin    = 0.4 s; }
    `);
    expect(found.get('DUPLICATE_GRADE')).toBe('error');
  });

  it('rejects a combine whose source is another combine', () => {
    const found = codes(`${RELAYS}
      combine { name = "X"; sources = [R_A:51, R_B:51]; as = "envelope_min"; }
      combine { name = "Y"; sources = [X]; as = "envelope_min"; }
    `);
    expect(found.get('COMBINE_CHAINED')).toBe('error');
  });

  it('rejects an unknown voltage level, with a suggestion', () => {
    const result = process(`
      system { voltages { "LV" { V  = 11.0 kV; } } }
      faults { "F1" { I   = 4000 A; voltage = "LV"; } }
      relay R { voltage = "LW"; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; } }
    `);
    const d = result.diagnostics.find((x) => x.code === 'VOLTAGE_UNKNOWN');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('did you mean "LV"');
  });
});

describe('grade intent combinations', () => {
  const RELAYS = `${BASE}
    relay R_A { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
    relay R_B { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 800 A; tms = 0.5; } }
  `;

  it('warns when margin_s is declared without a solve block', () => {
    const found = codes(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; fault = "F1"; margin_target = 0.3 s; }
    `);
    expect(found.get('MARGIN_NO_SOLVE')).toBe('warning');
  });

  it('rejects margin_s below CTI_min_s', () => {
    const found = codes(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; fault = "F1";
              margin_target = 0.2 s; margin    = 0.3 s; }
    `);
    expect(found.get('MARGIN_BELOW_CTI')).toBe('error');
  });

  it('rejects a solve block with no target to aim at', () => {
    const found = codes(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; fault = "F1";
              solve { strategy = "tight"; } }
    `);
    expect(found.get('SOLVE_WITHOUT_TARGET')).toBe('error');
  });

  it('rejects tolerance_pct outside [0, 50]', () => {
    const found = codes(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; fault = "F1"; margin_target = 0.3 s;
              solve { strategy = "loose"; tolerance_pct = 90; } }
    `);
    expect(found.get('TOLERANCE_OUT_OF_RANGE')).toBe('error');
  });

  it('warns when a grade has no fault', () => {
    const found = codes(`${RELAYS}
      grade { primary = R_A:51; backup = R_B:51; margin    = 0.3 s; }
    `);
    expect(found.get('FAULT_OPTIONAL_NO_GRADE_CHECK')).toBe('warning');
  });
});

describe('view and page', () => {
  it('sends two_axes to the key that replaced it', () => {
    /*
     * `two_axes = true` parsed and drew nothing at all. It is refused
     * now, naming `second_axis` -- which does the thing the boolean
     * only promised, and says which level the second scale is in.
     */
    const removed = parse(`${BASE}\nview { two_axes = true; }`).errors
      .find((e) => e.code === 'REMOVED_KEY');
    expect(removed).toBeDefined();
    expect(removed!.message).toContain('second_axis');
  });

  it('rejects a second_axis on a level the system does not declare', () => {
    const found = codes(`${BASE}
      view { voltage = "LV"; second_axis = "HV"; }
    `);
    expect(found.get('VOLTAGE_UNKNOWN')).toBe('error');
  });

  it('warns where the second axis repeats the sheet\'s own level', () => {
    const found = codes(`${BASE}
      view { voltage = "LV"; second_axis = "LV"; }
    `);
    expect(found.get('SECOND_AXIS_SAME_LEVEL')).toBe('warning');
  });

  it('rejects an unknown paper size', () => {
    const found = codes(`${BASE}
      page { size = "A9"; }
    `);
    expect(found.get('PAGE_SIZE_UNKNOWN')).toBe('error');
  });

  it('accepts every documented paper size', () => {
    for (const size of ['A0', 'A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid']) {
      const found = codes(`${BASE}\npage { size = "${size}"; }`);
      expect(found.has('PAGE_SIZE_UNKNOWN'), size).toBe(false);
    }
  });
});

describe('devices', () => {
  it('rejects a fuse with neither a band nor a table', () => {
    const found = codes(`${BASE}
      device "f1" { kind = "fuse"; rating_I = 100 A; }
    `);
    expect(found.get('DEVICE_NO_CURVE')).toBe('error');
  });

  it('accepts a breaker carrying only a clearing time', () => {
    const found = codes(`${BASE}
      device "cb1" { kind = "breaker"; t_delay = 0.06 s; }
    `);
    expect(found.has('DEVICE_NO_CURVE')).toBe(false);
  });
});

describe('a clean study reports no errors', () => {
  it('validates the canonical example without error-severity findings', () => {
    const result = process(`
      meta { project = "Clean"; }
      system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 11.0 kV; } } }
      faults { "F1" { I   = 6.40 kA; voltage = "LV"; } }
      relay R_INC { voltage = "HV"; ct_ratio = 600/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 720 A; tms = 0.30; } }
      relay R_FDR { voltage = "LV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.vi; I_pickup = 480 A; tms = 0.25; } }
      grade { primary = R_FDR:51; backup = R_INC:51; fault = "F1"; margin    = 0.30 s; }
      page { size = "A4"; orientation = "landscape"; theme = "light"; }
    `);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });
});
