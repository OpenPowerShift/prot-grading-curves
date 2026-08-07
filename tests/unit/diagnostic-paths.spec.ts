/**
 * The diagnostics themselves -- the refusal paths, exercised.
 *
 * Named `diagnostic-paths` rather than `diagnostics` so it is not
 * confused with `diagnostic-registry.spec.ts`, which is about the
 * *list* of codes rather than about any code firing.
 *
 * `validate.ts` and `grades.ts` are the two largest files in the
 * semantics layer, and most of what was untested in them was the
 * refusal paths -- the branches that fire when a study is wrong. Those
 * are the ones a user meets, and the ones nobody exercises by running
 * a study that works.
 *
 * Each case here is a study with exactly one thing wrong with it, and
 * asserts on the code rather than the wording, so a clearer message
 * does not break the test.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';

const codesFor = (source: string): string[] => {
  const r = process(source);
  return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
};

const has = (source: string, code: string): boolean => codesFor(source).includes(code);

const SYS = 'system { voltages { "MV" { V = 11 kV; } "LV" { V = 400 V; } } }\n';

describe('settings that cannot be evaluated', () => {
  it('refuses a curve name it does not know', () => {
    expect(codesFor(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { curve = iec.nonsense; I_pickup = 400 A; tms = 0.1; } }`))
      .toContain('CURVE_UNKNOWN');
  });

  it('notices a pickup that needs a CT ratio it has not got', () => {
    const codes = codesFor(`${SYS}relay R { voltage = "MV";
      element 51 { curve = iec.si; I_units = "secondary"; I_pickup = 5 A; tms = 0.1; } }`);
    expect(codes.some((c) => /CT_RATIO/.test(c))).toBe(true);
  });

  it('notices an element with no pickup at all', () => {
    expect(codesFor(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { curve = iec.si; tms = 0.1; } }`)).toContain('PICKUP_MISSING');
  });

  it('notices a tms outside the dial range', () => {
    const codes = codesFor(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { curve = ansi.mi; I_pickup = 400 A; tms = 99; } }`);
    expect(codes).toContain('TMS_OUT_OF_RANGE');
  });

  it('refuses a definite-time stage with no delay', () => {
    const codes = codesFor(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 50 { curve = definite; I_pickup = 4 kA; } }`);
    expect(codes.some((c) => /DELAY|DEFINITE/.test(c))).toBe(true);
  });
});

describe('references that do not resolve', () => {
  it('names an unknown relay in a grade', () => {
    expect(has(`${SYS}faults { "F" { I = 6 kA; voltage = "MV"; } }
      grade { primary = R_NOPE:51; backup = R_ALSO_NOPE:51; fault = "F"; }`,
    'UNRESOLVED_REFERENCE')).toBe(true);
  });

  it('names an unknown fault in a grade', () => {
    const codes = codesFor(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
      grade { primary = R:51; backup = R:51; fault = "not declared"; }`);
    expect(codes.some((c) => /FAULT|UNRESOLVED/.test(c))).toBe(true);
  });

  it('names a voltage level a relay claims but the system does not declare', () => {
    const codes = codesFor(`${SYS}relay R { voltage = "HV"; ct_ratio = 400/5;
      element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.1; } }`);
    expect(codes.some((c) => /VOLTAGE|LEVEL/.test(c))).toBe(true);
  });

  it('names an annotation pointing at nothing', () => {
    const codes = codesFor(`${SYS}annotate { on_curve = R_GHOST:51; at_I = 1 kA; label = "x"; }`);
    expect(codes.some((c) => /UNRESOLVED/.test(c))).toBe(true);
  });
});

describe('conditions', () => {
  it('refuses a fault with no current', () => {
    const codes = codesFor(`${SYS}faults { "F" { voltage = "MV"; } }`);
    expect(codes.length).toBeGreaterThan(0);
  });

  it('notes a fault whose level is not declared', () => {
    const codes = codesFor(`${SYS}faults { "F" { I = 6 kA; voltage = "NOWHERE"; } }`);
    expect(codes.some((c) => /VOLTAGE|LEVEL|UNRESOLVED/.test(c))).toBe(true);
  });

  it('refuses a scenario level naming an undeclared voltage', () => {
    const codes = codesFor(`${SYS}scenario "S" { type = three_phase;
      level "NOWHERE" { I = 100 A; } }`);
    expect(codes.some((c) => /VOLTAGE|LEVEL|UNRESOLVED/.test(c))).toBe(true);
  });

  it('refuses a negative or zero current', () => {
    const codes = codesFor(`${SYS}faults { "F" { I = 0 A; voltage = "MV"; } }`);
    expect(codes.length).toBeGreaterThan(0);
  });
});

describe('grading pairs', () => {
  const PAIR = `${SYS}
    faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
    relay R_A { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
    relay R_B { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.40; } }
  `;

  it('warns when a pair grades against itself', () => {
    const codes = codesFor(`${PAIR}
      grade { primary = R_A:51; backup = R_A:51; fault = "F"; margin = 0.3 s; }`);
    expect(codes).toContain('GRADE_SELF_PAIR');
  });

  it('warns when the two sides measure different currents', () => {
    /* Reported against the pair, so it travels with the row it
     * qualifies rather than sitting in a study-wide list. */
    const r = process(`${SYS}
      faults { "F" { I = 6 kA; type = single_phase_earth; voltage = "MV"; } }
      relay R_A { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.1; }
        element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 100 A; tms = 0.1; } }
      grade { primary = R_A:51; backup = R_A:51G; fault = "F"; margin = 0.3 s; }`);
    const codes = r.reports.flatMap((rep) => rep.diagnostics.map((d) => d.code));
    expect(codes).toContain('GRADE_MIXED_QUANTITY');
  });

  it('reports a pair that does not grade, without refusing the study', () => {
    const r = process(`${PAIR}
      grade { primary = R_B:51; backup = R_A:51; fault = "F"; margin = 0.3 s; }`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.reports[0].pass).toBe(false);
  });

  it('sweeps a declared range when asked', () => {
    const r = process(`${SYS}
      faults { "F" { I = 6 kA; I_min = 2 kA; I_max = 8 kA; type = three_phase; voltage = "MV"; } }
      relay R_A { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
      relay R_B { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.40; } }
      grade { primary = R_A:51; backup = R_B:51; fault = "F"; margin = 0.3 s; upstream = true; }`);
    expect(r.reports[0].rows.length).toBeGreaterThan(1);
  });
});

describe('the page block', () => {
  it('refuses a paper size it does not know', () => {
    const codes = codesFor(`${SYS}page { size = "A99"; }`);
    expect(codes.some((c) => /SIZE|PAGE/.test(c))).toBe(true);
  });

  it('accepts every size it does know', () => {
    for (const size of ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid']) {
      const errs = process(`${SYS}page { size = "${size}"; }`).diagnostics
        .filter((d) => d.severity === 'error');
      expect(errs, size).toEqual([]);
    }
  });
});

describe('a number written without its unit', () => {
  /*
   * No key names its own unit -- that was done so the author states it,
   * and for a while nothing made them. `t_delay = 50;` on an
   * instantaneous element meant fifty *seconds* where the author meant
   * fifty milliseconds, and the sheet drew it without a word. A
   * thousandfold error on a trip time is not a thing to infer.
   */
  const RELAY = (body: string) =>
    `${SYS}relay R { voltage = "MV"; ct_ratio = 400/5; ${body} }`;

  it('is refused on an element field', () => {
    expect(codesFor(RELAY('element 50 { curve = definite; I_pickup = 4 kA; t_delay = 50; }')))
      .toContain('UNIT_MISSING');
  });

  it('is refused on a stage field', () => {
    expect(codesFor(RELAY(`element 51 { stages {
      stage m { curve = definite; I_pickup = 400 A; t_delay = 2; } } }`)))
      .toContain('UNIT_MISSING');
  });

  it('is refused on a pickup', () => {
    expect(codesFor(RELAY('element 51 { curve = iec.si; I_pickup = 400; tms = 0.1; }')))
      .toContain('UNIT_MISSING');
  });

  it('is refused on a fault current', () => {
    expect(codesFor(`${SYS}faults { "F" { I = 6000; voltage = "MV"; } }`))
      .toContain('UNIT_MISSING');
  });

  it('is refused on a view bound', () => {
    expect(codesFor(`${SYS}view { voltage = "MV"; current_min = 100; }`))
      .toContain('UNIT_MISSING');
  });

  it('names the units the field will take', () => {
    const d = process(RELAY('element 50 { curve = definite; I_pickup = 4 kA; t_delay = 50; }'))
      .diagnostics.find((x) => x.code === 'UNIT_MISSING');
    expect(d?.message).toMatch(/"s"/);
    expect(d?.message).toMatch(/"ms"/);
  });

  it('says nothing when the unit is there', () => {
    expect(codesFor(RELAY('element 50 { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }')))
      .not.toContain('UNIT_MISSING');
  });

  it('says nothing about a field that has no quantity', () => {
    /* `tms` is a multiplier and `share` a percentage of a figure
     * already stated; neither has a unit to write. */
    expect(codesFor(RELAY('element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.1; share = 50; }')))
      .not.toContain('UNIT_MISSING');
  });

  it('leaves every shipped example clean', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    for (const f of readdirSync('examples').filter((x) => x.endsWith('.ptc'))) {
      const r = process(readFileSync(`examples/${f}`, 'utf8'));
      const errs = [...r.parseErrors, ...r.diagnostics].filter((d) => d.severity === 'error');
      expect(errs.map((e) => e.code), f).toEqual([]);
    }
  });
});
