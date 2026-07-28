/**
 * Marked points.
 *
 * Source: spec/sections/semantics.adoc -- _Marked points_. The
 * motivating case is transformer inrush: the relay curve must clear
 * the point or the transformer trips on energisation.
 */

import { describe, expect, it } from 'vitest';
import { process, parseAndRender } from '@tc/index';
import { tTripElement } from '@tc/semantics/stages';

const INRUSH = `
system { voltages { "HV" { kV = 33.0; } "LV" { kV = 11.0; } } base_MVA = 25.0; }
faults { "F_hv" { I_A = 8000 A; voltage = "HV"; } }

point "TX1_inrush" {
    I_A     = 5250 A;
    t_s     = 0.10 s;
    voltage = "HV";
    label   = "TX1 inrush (12 x FLC)";
    shape   = "cross";
}

relay R_INC { voltage = "HV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pu = 720 A; tms = 0.30; } }
`;

describe('point blocks', () => {
  const result = process(INRUSH);

  it('parses and validates', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('resolves onto the study, with its voltage level', () => {
    const [point] = result.study!.points;
    expect(point.id).toBe('TX1_inrush');
    expect(point.I_A).toBe(5250);
    expect(point.t_s).toBeCloseTo(0.10, 9);
    expect(point.voltage_kV).toBe(33);
    expect(point.label).toContain('inrush');
    expect(point.shape).toBe('cross');
  });

  it('folds unit suffixes on both axes', () => {
    const study = process(`
      point "p" { I_A = 5.25 kA; t_s = 100 ms; }
    `).study!;
    expect(study.points[0].I_A).toBeCloseTo(5250, 6);
    expect(study.points[0].t_s).toBeCloseTo(0.1, 9);
  });

  it('is drawn on the plot', () => {
    const { svg } = parseAndRender(INRUSH);
    expect(svg).toContain('TX1 inrush');
  });

  it('lets the study show the relay clears inrush', () => {
    /*
     * The engineering check the point exists for: at the inrush
     * current the relay must take *longer* than the inrush duration,
     * or energising the transformer trips it.
     */
    const element = result.study!.relays.get('R_INC')!.elements[0];
    const tAtInrush = tTripElement(element, 5250);
    expect(tAtInrush).toBeGreaterThan(0.10);
  });

  it('rejects a non-positive coordinate', () => {
    const codes = process('point "p" { I_A = 0 A; t_s = 0.1 s; }').diagnostics.map((d) => d.code);
    expect(codes).toContain('POINT_CURRENT_INVALID');

    const codes2 = process('point "p" { I_A = 100 A; t_s = 0 s; }').diagnostics.map((d) => d.code);
    expect(codes2).toContain('POINT_TIME_INVALID');
  });

  it('rejects an unknown voltage level, with a suggestion', () => {
    const result2 = process(`
      system { voltages { "HV" { kV = 33.0; } } }
      point "p" { I_A = 100 A; t_s = 0.1 s; voltage = "HW"; }
    `);
    const d = result2.diagnostics.find((x) => x.code === 'VOLTAGE_UNKNOWN');
    expect(d?.message).toContain('did you mean "HV"');
  });

  it('rejects a duplicate id', () => {
    const codes = process(`
      point "p" { I_A = 100 A; t_s = 0.1 s; }
      point "p" { I_A = 200 A; t_s = 0.2 s; }
    `).diagnostics.map((d) => d.code);
    expect(codes).toContain('DUPLICATE_POINT');
  });
});
