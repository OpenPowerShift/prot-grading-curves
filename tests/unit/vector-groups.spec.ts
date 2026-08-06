/**
 * What a nameplate says, and what follows from it.
 *
 * Cross-voltage referral was `I x V_from / V_to` for every fault, which
 * is exact for a balanced one and wrong for the rest. A delta-star
 * transition rotates the positive- and negative-sequence components in
 * opposite directions, so they recombine differently on the far side:
 * a star-side phase-phase fault comes out 2:1:1 on the delta lines.
 * The plain ratio understated the backup's current by 15.5%, made it
 * look slower than it is, and reported a margin that does not exist.
 *
 * The factor cannot be got from the voltages. It comes from the
 * windings, so the study declares the vector group and this table
 * turns it into an answer -- or into a refusal, where the answer needs
 * data the language does not carry.
 */

import { describe, expect, it } from 'vitest';
import {
  EARTH_ACROSS_DELTA,
  TWO_PHASE_ACROSS_DELTA,
  parseVectorGroup,
  referralFactor,
  zeroSequenceCrosses,
} from '@tc/constants/vector-groups.js';

const group = (text: string) => {
  const g = parseVectorGroup(text);
  expect(g, `${text} should parse`).not.toBeNull();
  return g!;
};

describe('reading a vector group', () => {
  it('reads the forms a nameplate actually carries', () => {
    expect(parseVectorGroup('Dyn11')).toMatchObject({ hv: 'D', lv: 'YN', clock: 11 });
    expect(parseVectorGroup('Dy11')).toMatchObject({ hv: 'D', lv: 'Y', clock: 11 });
    expect(parseVectorGroup('YNd1')).toMatchObject({ hv: 'YN', lv: 'D', clock: 1 });
    expect(parseVectorGroup('YNyn0')).toMatchObject({ hv: 'YN', lv: 'YN', clock: 0 });
    expect(parseVectorGroup('Dd0')).toMatchObject({ hv: 'D', lv: 'D', clock: 0 });
    expect(parseVectorGroup('Dzn0')).toMatchObject({ hv: 'D', lv: 'ZN', clock: 0 });
  });

  it('takes a group with no clock number', () => {
    /* `Dy` says everything the referral needs; the clock is a phase
     * shift, and a magnitude does not care about it. */
    expect(parseVectorGroup('Dy')).toMatchObject({ hv: 'D', lv: 'Y', clock: undefined });
    expect(parseVectorGroup('Yd')).toMatchObject({ hv: 'Y', lv: 'D' });
  });

  it('is not case-sensitive about the shape', () => {
    expect(parseVectorGroup('DYN11')).toMatchObject({ hv: 'D', lv: 'YN' });
    expect(parseVectorGroup('dyn11')).toMatchObject({ hv: 'D', lv: 'YN' });
  });

  it('refuses what it cannot read in full', () => {
    /*
     * A partial read is the failure this whole change exists to stop.
     * `Dyn11 (assumed)` is not a vector group; taking the first five
     * characters and carrying on would be exactly the silent guess
     * the plain ratio was.
     */
    for (const bad of ['Dyn11x', 'Xy11', 'D', '', 'Dyn13', 'star-delta']) {
      expect(parseVectorGroup(bad), `${bad} should be refused`).toBeNull();
    }
  });
});

describe('whether zero sequence crosses', () => {
  it('is blocked by a delta on either side', () => {
    /* It circulates in the delta and never reaches the line. */
    expect(zeroSequenceCrosses(group('Dyn11'))).toBe(false);
    expect(zeroSequenceCrosses(group('YNd1'))).toBe(false);
    expect(zeroSequenceCrosses(group('Dd0'))).toBe(false);
  });

  it('passes only when both neutrals are earthed', () => {
    expect(zeroSequenceCrosses(group('YNyn0'))).toBe(true);
    expect(zeroSequenceCrosses(group('Yy0'))).toBe(false);
    expect(zeroSequenceCrosses(group('YNy0'))).toBe(false);
  });
});

describe('referring a fault across a delta-star', () => {
  const dyn = group('Dyn11');

  it('leaves a balanced fault at the turns ratio', () => {
    expect(referralFactor(dyn, 'three_phase', 'lv')).toMatchObject({ factor: 1 });
  });

  it('carries a star-side phase-phase fault at 2/sqrt(3)', () => {
    /*
     * The one that mattered. In per-unit the star side carries
     * sqrt(3)/2 of the three-phase current while the largest delta
     * line carries all of it, so the delta sees 15.5% more than the
     * ratio alone would give -- it operates faster, and the margin is
     * smaller than the old answer claimed.
     */
    const r = referralFactor(dyn, 'two_phase', 'lv');
    expect(r).toMatchObject({ kind: 'factor', derived: true });
    expect((r as { factor: number }).factor).toBeCloseTo(1.1547, 4);
    expect(TWO_PHASE_ACROSS_DELTA).toBeCloseTo(1.1547, 4);
  });

  it('carries a star-side earth fault at 1/sqrt(3)', () => {
    /*
     * Zero sequence circulates in the delta, so the far side sees the
     * fault as a phase-phase current: two lines at I/sqrt(3), the
     * third at nothing.
     */
    const r = referralFactor(dyn, 'single_phase_earth', 'lv');
    expect((r as { factor: number }).factor).toBeCloseTo(0.5774, 4);
    expect(EARTH_ACROSS_DELTA).toBeCloseTo(0.5774, 4);
  });

  it('refuses the reciprocal direction rather than inverting the factor', () => {
    /*
     * A fault on the delta side referred to the star side is a
     * different problem and does not simply invert. It is refused
     * because it has not been derived, which is the honest state to
     * ship it in.
     */
    expect(referralFactor(dyn, 'two_phase', 'hv').kind).toBe('declare');
  });

  it('refuses a two-phase-earth fault, which needs Z0', () => {
    const r = referralFactor(dyn, 'two_phase_earth', 'lv');
    expect(r.kind).toBe('declare');
    expect((r as { reason: string }).reason).toMatch(/zero-sequence impedance/);
  });
});

describe('referring a fault across a like-for-like connection', () => {
  it('needs no factor: nothing is transposed', () => {
    for (const text of ['Yy0', 'Dd0', 'YNyn0']) {
      expect(referralFactor(group(text), 'two_phase', 'lv')).toMatchObject({ factor: 1 });
    }
  });

  it('still refuses an earth fault where the study gives it no path', () => {
    const r = referralFactor(group('Yy0'), 'single_phase_earth', 'lv');
    expect(r.kind).toBe('declare');
    expect((r as { reason: string }).reason).toMatch(/no path/);
  });

  it('refuses an earth fault on two earthed stars, which the ratio does not settle', () => {
    /*
     * `YNyn0` does pass zero sequence, but how much each winding
     * carries is set by the zero-sequence impedance network --
     * earthing resistors, a delta tertiary, the source behind each --
     * and not by the turns ratio. The study has to state it.
     */
    const r = referralFactor(group('YNyn0'), 'single_phase_earth', 'lv');
    expect(r.kind).toBe('declare');
    expect((r as { reason: string }).reason).toMatch(/impedance network/);
  });
});
