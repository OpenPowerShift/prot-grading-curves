/**
 * Where a curve from another voltage level goes.
 *
 * A cross-level curve used to be placed in two independent steps: the
 * kV turns ratio for the level, then the condition's ratios for the
 * quantity. Those two disagree whenever a scenario's per-level figures
 * do not follow the turns ratio -- and behind a delta they must not,
 * because phase current is `I1 + I2 + I0` and the zero-sequence part
 * does not cross.
 *
 * The result was one drawing telling two stories: on example 12 the LV
 * breaker's curve sat a factor of sqrt(3) right of where its own
 * grading report put it, so its pickup landed past the fault rule and
 * the sheet showed a breaker that never operates, while the report had
 * it clearing in 1.631 s and passing.
 *
 * The fix removes the referral rather than correcting it. Where the
 * condition declares figures at both levels, nothing needs referring:
 * the element measures a stated current at its own bus, the axis reads
 * a stated current at the sheet's, and their ratio is the whole
 * mapping. Plot and report then agree by construction.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

/**
 * Turns ratio 10, condition ratio 20 -- chosen so the two answers land
 * on opposite sides of the fault rule, which is the difference that
 * matters rather than a difference that merely exists.
 *
 * The LV element picks up at 1500 A of its own phase current:
 *   by the condition   1500 / 20 = 75 A   -- left of the 100 A rule
 *   by the turns ratio 1500 / 10 = 150 A  -- right of it, so the sheet
 *                                            would show it never picking up
 */
const CROSS = (extra = '') => `
  system {
    voltages { "HV" { V = 10 kV; } "LV" { V = 1 kV; } }
    ${extra}
  }
  scenario "unbalanced" {
    type = single_phase_earth;
    level "LV" { I = 2000 A; I1 = 667 A; I2 = 667 A; I0 = 667 A; }
    level "HV" { I = 100 A;  I1 = 58 A;  I2 = 58 A;  I0 = 0 A;   }
  }
  relay R_LV {
    voltage = "LV"; ct_ratio = 2000/1;
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 1500 A; tms = 0.1; }
  }
  relay R_HV {
    voltage = "HV"; ct_ratio = 200/1;
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 50 A; tms = 0.2; }
  }
  view {
    voltage = "HV"; quantity = phase; condition = "unbalanced";
    current_min = 1 A; current_max = 1 kA;
  }
`;

const svgOf = (src: string) => renderStudy(process(src), { theme: 'light' });

/** Leftmost x of a curve's path, in SVG user units. */
function curveLeftPx(svg: string, name: string): number {
  const m = new RegExp(`d="([^"]+)"[^>]*data-curve="${name}[^"]*"`).exec(svg);
  if (!m) throw new Error(`no curve matching ${name}`);
  const xs = [...m[1].matchAll(/[ML](-?[\d.]+)/g)].map((v) => Number(v[1]));
  return Math.min(...xs);
}

/** x of a condition's vertical rule. */
function rulePx(svg: string, name: string): number {
  return Number(new RegExp(`x1="([\\d.]+)"[^>]*data-fault="${name}"`).exec(svg)![1]);
}

const notes = (svg: string): string =>
  [...svg.matchAll(/<text[^>]*font-style="italic"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1]).join(' ');

describe('a condition that declares both levels', () => {
  it('places the curve by the condition, not the turns ratio', () => {
    const svg = svgOf(CROSS());
    /*
     * The whole point: the pickup falls on the operating side of the
     * fault rule. By the turns ratio it would fall on the other side,
     * and the sheet would contradict its own grading report.
     */
    expect(curveLeftPx(svg, 'R_LV')).toBeLessThan(rulePx(svg, 'unbalanced'));
  });

  it('says so in the legend, with both levels and the ratio', () => {
    /*
     * A cross-level factor carries the change of level as well as the
     * change of quantity, so a bare number reads as the quantity ratio
     * alone. Naming both levels and the condition is what makes the
     * placement checkable by hand.
     */
    const n = notes(svgOf(CROSS()));
    expect(n).toContain('LV phase drawn on the HV phase axis');
    expect(n).toContain('from unbalanced, not the turns ratio');
    /* 1 / (2000/100) = 0.05 */
    expect(n).toContain('x0.05');
  });

  it('agrees with the element the sheet is already in the frame of', () => {
    /* The HV element is in the sheet's own frame and must not move. */
    const svg = svgOf(CROSS());
    expect(notes(svg)).not.toContain('R_HV:51: HV phase');
  });
});

describe('a condition that does not declare both levels', () => {
  const WITH_FAULT = `
    system {
      voltages { "HV" { V = 10 kV; } "LV" { V = 1 kV; } }
      zero_sequence { "HV" to "LV" = blocked; }
    }
    faults { "F" { I = 100 A; type = single_phase_earth; voltage = "HV"; } }
    relay R_LV {
      voltage = "LV"; ct_ratio = 2000/1;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 1500 A; tms = 0.1; }
    }
    view { voltage = "HV"; quantity = phase; condition = "F";
           current_min = 1 A; current_max = 1 kA; }
  `;

  it('falls back to the turns ratio', () => {
    /*
     * A `fault` is one current at one level and is properly referred by
     * the ratio. Nothing here changes, which is why the four examples
     * that grade across a transformer without a scenario render byte
     * for byte as they did.
     */
    const svg = svgOf(WITH_FAULT);
    expect(curveLeftPx(svg, 'R_LV')).toBeGreaterThan(rulePx(svg, 'F'));
  });

  it('warns that the ratio is unreliable where zero sequence is blocked', () => {
    /*
     * The study has said the delta blocks zero sequence, so it has said
     * enough for the tool to know phase current does not follow the
     * turns ratio under this fault. Advisory rather than suppressing:
     * the sheet is still worth reading and the fix is one line.
     */
    const n = notes(svgOf(WITH_FAULT));
    expect(n).toContain('placed by the LV-HV turns ratio');
    expect(n).toContain('Zero sequence is blocked');
    expect(n).toContain('name a condition declaring both levels');
  });

  it('stays quiet on a balanced condition, where the ratio is right', () => {
    const balanced = WITH_FAULT.replace('type = single_phase_earth', 'type = three_phase');
    expect(notes(svgOf(balanced))).not.toContain('turns ratio');
  });

  it('stays quiet where zero sequence is not declared blocked', () => {
    const open = WITH_FAULT.replace('zero_sequence { "HV" to "LV" = blocked; }', '');
    expect(notes(svgOf(open))).not.toContain('turns ratio');
  });
});

describe('example 12, the case that surfaced this', () => {
  it('puts the LV breaker where its report says it operates', async () => {
    const { readFileSync } = await import('node:fs');
    const svg = renderStudy(
      process(readFileSync('examples/12-sequence-scenario.tc', 'utf8')),
      { theme: 'light' },
    );
    const rule = Number(/x1="([\d.]+)"[^>]*data-fault="LV earth fault"/.exec(svg)![1]);
    /* Its pickup must fall left of the fault rule: the report has it
     * clearing this fault in 1.631 s, so the drawing has to show a
     * breaker that has picked up. */
    expect(curveLeftPx(svg, 'LV ACB')).toBeLessThan(rule);
  });
});
