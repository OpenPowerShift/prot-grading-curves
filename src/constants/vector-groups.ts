/**
 * Transformer vector groups, and what they say about referring a
 * current from one winding to the other.
 *
 * A study spanning a transformer used to refer every current by the
 * turns ratio alone -- `I x V_from / V_to`, whatever the fault was and
 * whatever the windings were. That is exact for a balanced fault and
 * wrong for every other kind, because a delta-star transition
 * redistributes the phase currents: the positive- and
 * negative-sequence components rotate in *opposite* directions across
 * it, so they recombine differently on the far side.
 *
 * For a phase-phase fault on the star side the delta-side line
 * currents come out in the ratio 2:1:1, the largest being `2/sqrt(3)`
 * times the ratio referral -- so the plain ratio understated the
 * backup's current by 15.5%, made it look slower than it is, and
 * reported a margin that does not exist. The dangerous direction.
 *
 * The factor is not derivable from the voltages; it depends on the
 * windings. A vector group is what the nameplate says, so that is what
 * the study declares.
 *
 * Nothing here is asserted from memory: the three derivable rows are
 * the standard symmetrical-component results, restated as a table so
 * they can be checked by a reader rather than trusted, in the same
 * spirit as `constants/sequence.ts`. Where the answer depends on data
 * the language does not carry -- a zero-sequence impedance network, a
 * fault type whose distribution needs `Z0` -- this module says so
 * rather than producing a number.
 */

/** One winding's connection. `YN` is a star with the neutral earthed. */
export type Winding = 'D' | 'Y' | 'YN' | 'Z' | 'ZN';

export interface VectorGroup {
  /** As written, for diagnostics. */
  text: string;
  hv: Winding;
  lv: Winding;
  /** Clock number: the LV lags the HV by `clock x 30` degrees. */
  clock?: number;
}

/**
 * Read a vector group off a nameplate string.
 *
 * Accepts the forms an engineer actually writes: `Dyn11`, `Dy11`,
 * `YNd1`, `YNyn0`, `Dd0`, `Yy0`, `Dzn0`, and the bare `Dy` / `Yd`
 * without a clock number. Case is not significant to the *shape* --
 * `DYN11` and `dyn11` are the same transformer -- but the
 * conventional casing (HV upper, LV lower) is what the letters mean,
 * so the split is positional rather than by case.
 *
 * Returns `null` for anything it cannot read, which the caller reports
 * rather than guessing at.
 */
export function parseVectorGroup(text: string): VectorGroup | null {
  const trimmed = text.trim();
  /*
   * One regex over the whole string, anchored, so a trailing scrap --
   * `Dyn11x`, `Dyn 11 (est)` -- is a refusal rather than a silent
   * partial read. A group that cannot be read in full has not been
   * read.
   */
  const m = /^([DYZ]N?)([DYZ]N?)(\d{1,2})?$/i.exec(trimmed.replace(/\s+/g, ''));
  if (!m) return null;

  const hv = normaliseWinding(m[1]);
  const lv = normaliseWinding(m[2]);
  if (!hv || !lv) return null;

  const clock = m[3] == null ? undefined : Number(m[3]);
  if (clock != null && (clock < 0 || clock > 11)) return null;

  return { text: trimmed, hv, lv, clock };
}

function normaliseWinding(raw: string): Winding | null {
  const up = raw.toUpperCase();
  return up === 'D' || up === 'Y' || up === 'YN' || up === 'Z' || up === 'ZN' ? up : null;
}

/** True where the winding is a star with its neutral earthed. */
export function isEarthedStar(w: Winding): boolean {
  return w === 'YN' || w === 'ZN';
}

/** True where the winding is a delta. */
export function isDelta(w: Winding): boolean {
  return w === 'D';
}

/**
 * Whether zero-sequence current crosses this transformer at all.
 *
 * A delta on either side blocks it: the zero-sequence current
 * circulates in the delta and never reaches the line. Two stars pass
 * it only if *both* neutrals are earthed -- an unearthed star has no
 * path for it either.
 *
 * This is the robust half of the answer, and it is the same question
 * `system { zero_sequence }` was added to answer by hand.
 */
export function zeroSequenceCrosses(group: VectorGroup): boolean {
  if (isDelta(group.hv) || isDelta(group.lv)) return false;
  return isEarthedStar(group.hv) && isEarthedStar(group.lv);
}

/** Fault shapes a referral factor can be asked for. */
export type ReferralFault =
  | 'three_phase'
  | 'two_phase'
  | 'single_phase_earth'
  | 'two_phase_earth';

/**
 * The answer to "what does the other winding carry?".
 *
 * `factor` multiplies the plain turns-ratio referral. `reason` is
 * present only when there is no factor, and is the sentence the
 * diagnostic will carry.
 */
export type Referral =
  | { kind: 'factor'; factor: number; derived: boolean }
  | { kind: 'declare'; reason: string };

/** `2/sqrt(3)`: a star-side phase-phase fault, seen on the delta side. */
export const TWO_PHASE_ACROSS_DELTA = 2 / Math.sqrt(3);

/** `1/sqrt(3)`: a star-side phase-earth fault, seen on the delta side. */
export const EARTH_ACROSS_DELTA = 1 / Math.sqrt(3);

/**
 * How a fault current on one winding appears on the other.
 *
 * `faultSide` is which winding the fault is declared on, so the same
 * transformer answers differently depending on which way the current
 * is being carried.
 *
 * The derivable cases, all for a delta-star transition with the fault
 * on the *star* side:
 *
 * [cols="1,1,3"]
 * |===
 * | Fault | Factor | Why
 *
 * | `three_phase`        | 1        | Balanced; nothing redistributes.
 * | `two_phase`          | 2/sqrt3  | Delta lines carry 2:1:1; the
 *                                     largest equals the three-phase
 *                                     current in per-unit while the
 *                                     star side carries sqrt3/2 of it.
 * | `single_phase_earth` | 1/sqrt3  | Zero sequence circulates in the
 *                                     delta, so the far side sees the
 *                                     fault as a phase-phase current
 *                                     in two lines and nothing in the
 *                                     third.
 * |===
 *
 * Everything else is refused rather than guessed:
 *
 * - `two_phase_earth` needs `Z0`, which the language does not carry.
 * - A fault on the *delta* side referred to the star side is the
 *   reciprocal problem and does not simply invert; it is not stated
 *   here because it has not been derived here.
 * - Two earthed stars pass zero sequence, but how much of an earth
 *   fault each winding carries is set by the zero-sequence impedance
 *   network -- earthing resistors, a delta tertiary, the source behind
 *   each -- and not by the turns ratio.
 */
export function referralFactor(
  group: VectorGroup,
  fault: ReferralFault,
  faultSide: 'hv' | 'lv',
): Referral {
  const faultWinding = faultSide === 'hv' ? group.hv : group.lv;
  const otherWinding = faultSide === 'hv' ? group.lv : group.hv;

  /* Balanced current does not care what the windings are. */
  if (fault === 'three_phase') return { kind: 'factor', factor: 1, derived: false };

  if (fault === 'two_phase_earth') {
    return {
      kind: 'declare',
      reason: 'a two-phase-earth fault splits by zero-sequence impedance, '
        + 'which this study does not carry',
    };
  }

  const transposes = isDelta(faultWinding) !== isDelta(otherWinding);

  /* Like for like -- Yy, Dd, YNyn -- transposes nothing, so the phase
   * currents map straight across at the turns ratio. */
  if (!transposes) {
    if (fault === 'single_phase_earth' && !zeroSequenceCrosses(group)) {
      return {
        kind: 'declare',
        reason: `${group.text} gives an earth fault no path across the transformer`,
      };
    }
    if (fault === 'single_phase_earth') {
      return {
        kind: 'declare',
        reason: `${group.text} passes zero sequence, but how much each winding carries `
          + 'is set by the zero-sequence impedance network rather than the turns ratio',
      };
    }
    return { kind: 'factor', factor: 1, derived: false };
  }

  /* A delta-star transition. Derived only for a fault on the star
   * side, which is the direction a study grades: the fault is
   * downstream and the backup is the winding above it. */
  if (isDelta(faultWinding)) {
    return {
      kind: 'declare',
      reason: `a ${fault.replace(/_/g, '-')} fault on the ${group.text} delta winding `
        + 'redistributes onto the star side by a factor this tool does not derive',
    };
  }

  return {
    kind: 'factor',
    factor: fault === 'two_phase' ? TWO_PHASE_ACROSS_DELTA : EARTH_ACROSS_DELTA,
    derived: true,
  };
}
