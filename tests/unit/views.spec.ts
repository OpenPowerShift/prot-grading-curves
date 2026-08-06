/**
 * Several sheets from one study.
 *
 * A coordination study routinely wants more than one drawing of the
 * same network: a phase sheet and a negative-sequence sheet, or the
 * same grading under two conditions. Each `view` is one sheet.
 *
 * Presentation stays in the presentation layer. A `scenario` remains
 * purely what the fault study measured; the view names the condition it
 * depicts and carries its own title. Nesting the view inside the
 * scenario would have put the two in one block and needed a precedence
 * rule between them.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { process, renderStudy } from '@tc/index';
import { viewLabel } from '@tc/semantics/condition';

const STUDY = `
meta { project = "Two sheets"; }
system { voltages { "HV" { V  = 33 kV; } } }
faults { "3ph min" { I   = 450 A; type = three_phase; voltage = "HV"; } }
scenario "1ph min" {
  type = single_phase_earth;
  level "HV" { I   = 260 A; I1   = 150 A; I2   = 150 A; I0   = 0 A; }
}
relay R {
  voltage = "HV"; ct_ratio = 250/1;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 105 A; tms = 0.1; }
  element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pickup = 75 A; t_delay = 0.1 s; }
}

view "Phase grading" {
    voltage = "HV"; quantity = phase; condition = "3ph min";
    title = "Phase sheet";
    current_min = 10 A; current_max = 40 kA;
}
view "I2 grading" {
    voltage = "HV"; quantity = I2; condition = "1ph min";
    title = "Negative-sequence sheet"; subtitle = "480 V earth fault at 33 kV";
    current_min = 10 A; current_max = 40 kA;
}
page { title = { text = "Fallback title"; }; }
`;

const result = process(STUDY);

/** One sheet, by index. */
function sheet(i: number): string {
  return renderStudy(result, { theme: 'light', view: result.study!.views[i] });
}

const curves = (svg: string): string[] =>
  [...svg.matchAll(/data-curve="([^"]+)"/g)].map((m) => m[1]);

describe('declaring several views', () => {
  it('parses without error', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('keeps them all, in source order', () => {
    expect(result.study!.views.map((v) => v.name)).toEqual(['Phase grading', 'I2 grading']);
  });

  it('draws the first unless another is chosen', () => {
    expect(result.study!.view).toBe(result.study!.views[0]);
  });

  it('leaves a study with one unnamed view exactly as it was', () => {
    const one = process('system { voltages { hv { V  = 11 kV; } } }\n'
      + 'relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 100 A; tms = 0.1; } }\n'
      + 'view { voltage = hv; }');
    expect(one.study!.views).toHaveLength(1);
    expect(one.study!.view).toBe(one.study!.views[0]);
    expect(one.study!.view!.name).toBeUndefined();
  });
});

describe('naming a sheet for a picker', () => {
  it('uses the declared name', () => {
    expect(viewLabel({ name: 'Phase grading' }, 0)).toBe('Phase grading');
  });

  it('falls back to the condition it depicts', () => {
    expect(viewLabel({ condition: '1ph min' }, 1)).toBe('1ph min');
  });

  it('then to the quantity, then to the position', () => {
    expect(viewLabel({ quantity: 'I2' }, 1)).toBe('I2 sheet');
    expect(viewLabel({ quantity: 'any' }, 2)).toBe('Sheet 3');
    expect(viewLabel(undefined, 0)).toBe('Sheet 1');
  });
});

describe('each sheet draws itself', () => {
  it('takes its own quantity and condition', () => {
    expect(sheet(0)).toContain('Current (A primary · 33 kV)');
    expect(sheet(1)).toContain('Current (A primary · I2 · 33 kV)');
  });

  it('draws the elements that condition allows', () => {
    /*
     * The 46 measures I2, and a balanced three-phase fault carries
     * none, so it cannot operate on the phase sheet's condition. On the
     * I2 sheet the scenario supplies both quantities, so the phase
     * element converts on beside it.
     */
    expect(curves(sheet(0))).toEqual(['R:51']);
    expect(curves(sheet(1)).sort()).toEqual(['R:46', 'R:51']);
  });

  it('converts the phase element using the scenario\'s own figures', () => {
    /* 260 A phase against 150 A of I2 is a ratio of 1.733, so the
     * phase curve sits at 0.577 of its own current on the I2 axis. */
    expect(sheet(1)).toContain('R:51: phase drawn on the I2 axis, x0.577');
  });
});

describe('a sheet titles itself', () => {
  it('overrides the page title, which every sheet shares', () => {
    /*
     * A negative-sequence sheet headed "Phase grading" because the page
     * said so is worse than no title. `page` keeps the paper; the sheet
     * keeps what it is of.
     */
    expect(sheet(0)).toContain('Phase sheet');
    expect(sheet(1)).toContain('Negative-sequence sheet');
    expect(sheet(1)).not.toContain('Fallback title');
  });

  it('carries its own subtitle', () => {
    expect(sheet(1)).toContain('480 V earth fault at 33 kV');
  });

  it('falls back to the page title when the sheet declares none', () => {
    const plain = process('system { voltages { hv { V  = 11 kV; } } }\n'
      + 'relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 100 A; tms = 0.1; } }\n'
      + 'view { voltage = hv; }\npage { title = { text = "From the page"; }; }');
    expect(renderStudy(plain, { theme: 'light' })).toContain('From the page');
  });
});

describe('the syntax', () => {
  it('accepts a name before the brace, and as a field', () => {
    const doc = parse('view "By position" { voltage = "HV"; }\n'
      + 'view { name = "By field"; voltage = "HV"; }').document!;
    const names = doc.items
      .filter((i): i is Extract<typeof i, { type: 'view' }> => i.type === 'view')
      .map((v) => v.name);
    expect(names).toEqual(['By position', 'By field']);
  });
});
