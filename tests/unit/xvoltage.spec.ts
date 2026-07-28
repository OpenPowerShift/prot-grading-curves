/**
 * Cross-voltage current projection.
 *
 * Source: spec/sections/semantics.adoc -- _Voltage levels and
 * cross-voltage grading_.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { buildStudy } from '@tc/semantics/model';
import { faultCurrentAt, levelKv, projectCurrent } from '@tc/semantics/xvoltage';

const TWO_LEVEL = `
system {
    voltages {
        "HV" { kV = 33.0; }
        "LV" { kV = 11.0; }
    }
}
faults {
    "F_lv" { I_A = 6400 A; voltage = "LV"; }
    "F_hv" { I_A = 18400 A; voltage = "HV"; }
}
relay R_HV { voltage = "HV"; element 51 { curve = iec.si; I_pu = 720 A; tms = 0.3; } }
relay R_LV { voltage = "LV"; element 51 { curve = iec.vi; I_pu = 480 A; tms = 0.25; } }
`;

const study = buildStudy(parse(TWO_LEVEL).document!);

describe('projectCurrent', () => {
  it('scales by the turns ratio', () => {
    // 6400 A at 11 kV is 6400 * 11/33 = 2133 A referred to 33 kV
    expect(projectCurrent(6400, 11, 33).I_A).toBeCloseTo(6400 / 3, 6);
    expect(projectCurrent(6400, 11, 33).ratio).toBeCloseTo(1 / 3, 9);
  });

  it('is the identity within one voltage level', () => {
    expect(projectCurrent(6400, 11, 11).I_A).toBeCloseTo(6400, 9);
    expect(projectCurrent(6400, 11, 11).ratio).toBe(1);
  });

  it('is the identity when a level is unknown', () => {
    expect(projectCurrent(6400, undefined, 33).I_A).toBe(6400);
    expect(projectCurrent(6400, 11, undefined).I_A).toBe(6400);
  });

  it('warns rather than dividing by zero', () => {
    const p = projectCurrent(6400, 0, 33);
    expect(p.I_A).toBe(6400);
    expect(p.warning).toBeDefined();
  });

  it('round-trips through both directions', () => {
    const up = projectCurrent(480, 11, 33);
    const back = projectCurrent(up.I_A, 33, 11);
    expect(back.I_A).toBeCloseTo(480, 9);
  });
});

describe('levelKv', () => {
  it('resolves declared level names', () => {
    expect(levelKv(study, 'HV')).toBe(33);
    expect(levelKv(study, 'LV')).toBe(11);
  });

  it('returns undefined for an unknown or absent name', () => {
    expect(levelKv(study, 'MV')).toBeUndefined();
    expect(levelKv(study, undefined)).toBeUndefined();
  });
});

describe('faultCurrentAt', () => {
  const fault = study.faults.get('F_lv')!;

  it('leaves the fault untouched on its own level', () => {
    expect(faultCurrentAt(study, fault, 'LV').I_A).toBeCloseTo(6400, 9);
  });

  it('refers the fault onto another level', () => {
    expect(faultCurrentAt(study, fault, 'HV').I_A).toBeCloseTo(6400 / 3, 6);
  });

  it('defaults min_A and max_A to I_A for a single-point fault', () => {
    expect(faultCurrentAt(study, fault, 'LV', 'min').I_A).toBeCloseTo(6400, 9);
    expect(faultCurrentAt(study, fault, 'LV', 'max').I_A).toBeCloseTo(6400, 9);
  });

  it('projects each endpoint of a declared range', () => {
    const ranged = buildStudy(parse(`
      system { voltages { "HV" { kV = 33.0; } "LV" { kV = 11.0; } } }
      faults { "F" { I_A = 6000 A; min_A = 3000 A; max_A = 9000 A; voltage = "LV"; } }
    `).document!);
    const f = ranged.faults.get('F')!;
    expect(faultCurrentAt(ranged, f, 'HV', 'min').I_A).toBeCloseTo(1000, 6);
    expect(faultCurrentAt(ranged, f, 'HV', 'max').I_A).toBeCloseTo(3000, 6);
  });
});

describe('voltage defaults', () => {
  it('places a relay on the only level when it declares none', () => {
    const single = buildStudy(parse(`
      system { voltages { "MV" { kV = 11.0; } } }
      relay R { element 51 { curve = iec.si; I_pu = 400 A; tms = 0.3; } }
    `).document!);
    const relay = single.relays.get('R')!;
    expect(relay.voltage).toBe('MV');
    expect(relay.voltage_kV).toBe(11);
  });

  it('leaves the level unset when the study declares several', () => {
    const many = buildStudy(parse(`
      system { voltages { "HV" { kV = 33.0; } "LV" { kV = 11.0; } } }
      relay R { element 51 { curve = iec.si; I_pu = 400 A; tms = 0.3; } }
    `).document!);
    expect(many.relays.get('R')!.voltage).toBeUndefined();
  });
});
