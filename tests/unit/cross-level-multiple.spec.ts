/**
 * A multiple read off a cross-level sheet.
 *
 * A TCC is read by eye: how far a fault stands to the right of a
 * pickup *is* the multiple. Ampere-turns referral is a uniform map --
 * it scales everything by V_from/V_to -- so a sheet drawn in a
 * referred frame preserves every multiple on it, which is what makes
 * it readable at all.
 *
 * The vector-group work broke that by scaling one mark and not the
 * others: the fault rule carried the 2/sqrt(3) shape factor while the
 * curves stayed on the plain ratio, so a multiple came out 6.30 where
 * the truth was 5.45. This pins the invariant rather than the numbers:
 * whatever frame the sheet is drawn in, the ratio between a fault and
 * a pickup must be the ratio those two have in the element's own
 * winding.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const study = (condition: string): string => `
system {
  voltages { HV { V = 33 kV; } LV { V = 11 kV; } }
  transformer HV to LV { vector_group = "Dyn11"; }
}
faults { F { type = two_phase; I = 6 kA; voltage = LV; } }
relay R_LV { voltage = LV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = definite; I_pickup = 1100 A; t_delay = 0.1 s; } }
view { voltage = HV; quantity = phase; ${condition}
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;

/** Where a mark stands, in the axis's own amps. */
const read = (src: string): { curve: number; rule: number } => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  const svg = renderStudy(r, { theme: 'light' });
  const [lo, hi] = svg.match(/data-domain-i="([^"]+)"/)![1].split(',').map(Number);
  const [x0, , w] = svg.match(/data-plot="([^"]+)"/)![1].split(',').map(Number);
  const amps = (px: number): number =>
    10 ** (Math.log10(lo) + ((px - x0) / w) * (Math.log10(hi) - Math.log10(lo)));

  const path = svg.match(/<path[^>]*data-ref="R_LV:51"[^>]*>/)![0];
  const xs = [...path.match(/\sd="([^"]+)"/)![1].matchAll(/[ML]\s*(-?[\d.]+)/g)]
    .map((m) => Number(m[1]));
  const rule = [...svg.matchAll(/<line[^>]*>/g)].map((m) => m[0])
    .find((t) => t.includes('tc-fault'))!;
  return { curve: amps(Math.min(...xs)), rule: amps(Number(rule.match(/x1="([\d.]+)"/)![1])) };
};

/* The element's own winding: a 6 kA fault against an 1100 A pickup. */
const TRUE_MULTIPLE = 6000 / 1100;

describe('a sheet drawn in the other winding', () => {
  it('reads the true multiple with no condition named', () => {
    const { curve, rule } = read(study(''));
    expect(rule / curve).toBeCloseTo(TRUE_MULTIPLE, 2);
  });

  it('reads the true multiple with the fault as its condition', () => {
    /*
     * Here both marks carry the 2/sqrt(3) the windings give, so the
     * rule stands where the *report* grades -- 2309 A, not 2000 -- and
     * the curve moves with it.
     */
    const { curve, rule } = read(study('condition = F;'));
    expect(rule / curve).toBeCloseTo(TRUE_MULTIPLE, 2);
    expect(rule).toBeCloseTo(2309, 0);
  });

  it('leaves the rule on the turns ratio when the sheet depicts something else', () => {
    /*
     * A shape factor belongs to a condition, not to a transformer.
     * Applied to a rule on a sheet drawn for something else it would
     * put that one mark in a frame none of the curves are in.
     */
    expect(read(study('')).rule).toBeCloseTo(2000, 0);
  });
});
