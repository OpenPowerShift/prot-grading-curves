/**
 * `t_delay = 0`: has no position on a logarithmic time axis.
 *
 * Used to mean the stage vanished from the plot and the legend with
 * only a warning to say why -- the same failure mode a missing `tms`
 * had before it was defaulted to 1.0 under a warning of its own. 20 ms
 * is a plausible instantaneous operate time, so the stage is drawn at
 * it instead, and the warning still fires to say the figure was
 * assumed rather than declared.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const SRC = `
system { voltages { HV { V = 33 kV; } } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 50 { function = phase_oc; curve = definite; I_pickup = 5 kA; t_delay = 0 ms; } }
view { voltage = HV; }
`;

describe('a definite-time stage declared at t_delay = 0', () => {
  it('still warns ZERO_DELAY_NOT_PLOTTABLE', () => {
    const r = parse(SRC);
    const warning = r.diagnostics.find((d) => d.code === 'ZERO_DELAY_NOT_PLOTTABLE');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('is drawn, not dropped from the plot', () => {
    const svg = renderStudy(parse(SRC), { theme: 'light' });
    expect(svg).toContain('class="tc-curve"');
  });

  it('is drawn at 20 ms, not at the declared 0', () => {
    const r = parse(SRC);
    const element = r.study!.relays.get('R')!.elements[0];
    expect(element.stages[0].t_delay_s).toBe(0.02);
  });

  it('leaves a declared non-zero delay alone', () => {
    const src = SRC.replace('t_delay = 0 ms', 't_delay = 50 ms');
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('ZERO_DELAY_NOT_PLOTTABLE');
    const element = r.study!.relays.get('R')!.elements[0];
    expect(element.stages[0].t_delay_s).toBe(0.05);
  });

  it('does not warn when t_delay is left out entirely (a different case)', () => {
    /* DEFINITE_NO_DELAY covers this one; it is implicitly 0 s, not a
     * declared zero, and warns with a different code. */
    const src = SRC.replace('t_delay = 0 ms; ', '');
    const r = parse(src);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('DEFINITE_NO_DELAY');
    expect(codes).not.toContain('ZERO_DELAY_NOT_PLOTTABLE');
  });
});
