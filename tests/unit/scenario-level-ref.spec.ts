/**
 * `scenario = S.LEVEL`: naming one of a scenario's own levels directly
 * in a condition reference.
 *
 * Without this, the level a scenario condition resolved to came only
 * from context -- a marker's own `voltage`, or the element an
 * annotation pointed at -- so showing a scenario at a level nothing
 * else on the sheet was drawn at needed a `voltage` field spelling out
 * what the name already said, and listing several of a scenario's
 * levels in one place (`fault = [S.HV, S.LV]`, one mark per level, as
 * a list of plain names already does) was not possible at all.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const BASE = `
system { voltages { HV { V = 33 kV; } LV { V = 11 kV; } } }
scenario S {
  type = single_phase_earth;
  level HV { I = 500 A; residual = 100 A; }
  level LV { I = 3 kA; residual = 900 A; }
}
relay R_HV { voltage = HV; ct_ratio = 200/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 300 A; tms = 0.2; } }
view { voltage = HV; }
`;

describe('a point naming one level of a scenario', () => {
  it('resolves without a voltage field', () => {
    const r = parse(`${BASE}\npoint "at_hv" { scenario = S.HV; t = 500 ms; label = "HV level"; }`);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('UNRESOLVED_REFERENCE');
    expect(r.diagnostics.map((d) => d.code)).not.toContain('SCENARIO_LEVEL_MISSING');
  });

  it('takes the current from the level named, not the view frame', () => {
    const src = `${BASE}\npoint "at_lv" { scenario = S.LV; t = 500 ms; label = "LV level"; }`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect(svg).toContain('LV level');
  });

  it('still refuses a level the scenario does not declare', () => {
    const r = parse(`${BASE}\npoint "bad" { scenario = S.MV; t = 500 ms; label = "x"; }`);
    expect(r.diagnostics.map((d) => d.code)).toContain('SCENARIO_LEVEL_MISSING');
  });

  it('an explicit level wins over the marker\'s own voltage', () => {
    /* `voltage` would otherwise pick HV; `.LV` in the name is more
     * specific and takes precedence. */
    const src = `${BASE}\npoint "p" { scenario = S.LV; voltage = HV; t = 500 ms; label = "picked"; }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('SCENARIO_LEVEL_MISSING');
  });
});

describe('an annotate naming several levels of one scenario', () => {
  it('draws one mark per level, the same as a list of separate conditions', () => {
    const src = `${BASE}\nannotate { on_curve = R_HV:51; scenario = [S.HV, S.LV]; label = "both"; }`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect([...svg.matchAll(/both/g)]).toHaveLength(2);
  });
});

describe('a name that only looks dotted', () => {
  it('leaves a fault reference with a literal dot alone', () => {
    /* Faults are never declared with a scenario base before the dot,
     * so this falls through to an ordinary unresolved-name error
     * rather than being mistaken for a scenario level. */
    const r = parse(`${BASE}\npoint "p" { scenario = F1.HV; t = 500 ms; label = "x"; }`);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('UNRESOLVED_REFERENCE');
    expect(codes).not.toContain('SCENARIO_LEVEL_MISSING');
  });

  it('does not disturb an ordinary bare condition name', () => {
    const r = parse(`${BASE}\npoint "p" { scenario = S; voltage = HV; t = 500 ms; label = "x"; }`);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('UNRESOLVED_REFERENCE');
  });
});
