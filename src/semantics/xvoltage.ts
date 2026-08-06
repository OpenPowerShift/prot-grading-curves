/**
 * Cross-voltage current projection.
 *
 * A study spanning a transformer names its voltage levels and lets the
 * processor work out the turns ratio, rather than making the engineer
 * declare a transformer block (spec: _Voltage levels and cross-voltage
 * grading_).
 *
 * The projection rule:
 *
 *   I_at(level L) = I_fault * V_fault / V_L
 *
 * applied *per relay*, to the level that relay sits on:
 *
 *   M_primary = I_at(V_primary) / I_pu_primary
 *   M_backup  = I_at(V_backup)  / I_pu_backup
 *
 * One fault, but not one current. Ampere-turns balance across a
 * transformer, so the two windings carry currents in inverse
 * proportion to their voltages: a 6.4 kA fault on an 11 kV bus puts
 * 2.13 kA through the 33 kV winding. Each relay must be evaluated at
 * the current *it* measures, against its own pickup.
 *
 * Evaluating the backup at the primary's current instead -- dividing
 * an LV current by an HV pickup -- inflates the backup's multiple and
 * so *understates* its operate time, reporting a grading margin that
 * does not physically exist. See `IMPLEMENTATION.adoc`
 * _Spec discrepancies_: an earlier draft of the spec asserted exactly
 * that, and its worked examples were computed from it.
 *
 * Margins need no conversion once each side is evaluated correctly: an
 * operate *time* does not depend on which winding you measure from.
 */

import { levelPairKey, type Fault, type Study } from './model.js';
import { referralFactor, type Referral } from '../constants/vector-groups.js';

export interface Projection {
  /** Current in primary amps, in the target voltage frame. */
  I_A: number;
  /** Ratio applied to get there (1 when no conversion was needed). */
  ratio: number;
  /** Set when a ratio was wanted but could not be computed. */
  warning?: string;
  /**
   * Set when the windings between the two levels do not settle how
   * this fault carries across. The current is the plain ratio, which
   * is *not* the answer; the caller reports rather than uses it.
   */
  referralIssue?: Extract<Referral, { kind: 'declare' }>;
}

/**
 * Project a current declared at `fromKV` into the `toKV` frame.
 * A missing level on either side is not an error: the study may be
 * single-voltage, in which case the identity is the right answer.
 */
export function projectCurrent(
  I_A: number,
  fromKV: number | undefined,
  toKV: number | undefined,
): Projection {
  if (fromKV == null || toKV == null) return { I_A, ratio: 1 };
  if (!(fromKV > 0) || !(toKV > 0)) {
    return {
      I_A,
      ratio: 1,
      warning: `cannot convert between ${fromKV} kV and ${toKV} kV (a level is zero or negative)`,
    };
  }
  const ratio = fromKV / toKV;
  return { I_A: I_A * ratio, ratio };
}

/** Look up a named voltage level's magnitude in kV. */
export function levelKv(study: Study, name: string | undefined): number | undefined {
  if (!name) return undefined;
  return study.voltages.get(name)?.kV;
}

/**
 * The fault current as the relay on `relayVoltage` measures it.
 *
 * `which` selects the endpoint of the fault's range: a fault with
 * `min_A` / `max_A` declared sweeps across them for the `CTI_min_s`
 * constraint check, while `I_A` is the single point that `margin_s`
 * and the solver are pinned to.
 */
export function faultCurrentAt(
  study: Study,
  fault: Fault,
  relayVoltage: string | undefined,
  which: 'I' | 'min' | 'max' = 'I',
): Projection {
  const I = which === 'min' ? fault.min_A : which === 'max' ? fault.max_A : fault.I_A;
  const faultKv = fault.voltage_kV ?? levelKv(study, fault.voltage);
  const relayKv = levelKv(study, relayVoltage);
  const base = projectCurrent(I, faultKv, relayKv);

  /*
   * The turns ratio is the whole answer only for a balanced fault.
   *
   * A delta-star transition rotates the positive- and
   * negative-sequence components in opposite directions, so they
   * recombine differently on the far side: a phase-phase fault on the
   * star side comes out 2:1:1 on the delta lines, the largest being
   * `2/sqrt(3)` times what the ratio alone gives. Referring by ratio
   * understated the backup's current by 15.5%, made it look slower
   * than it is, and reported a margin that does not exist.
   *
   * `transformerReferral` returns the factor where the windings
   * settle it and a refusal where they do not. A refusal is not
   * applied here -- the caller reports it, having somewhere to put a
   * diagnostic -- because silently returning the unadjusted number is
   * exactly the behaviour being removed.
   */
  const adjust = transformerReferral(study, fault.type, fault.voltage, relayVoltage);
  if (adjust.kind === 'factor') {
    return adjust.factor === 1
      ? base
      : { ...base, I_A: base.I_A * adjust.factor, ratio: base.ratio * adjust.factor };
  }
  return { ...base, referralIssue: adjust };
}

/**
 * What the windings between two levels say about carrying a fault.
 *
 * `{ kind: 'factor', factor: 1 }` where nothing needs adjusting --
 * one level, a balanced fault, or a like-for-like connection -- so a
 * caller can apply the result without asking whether it applies.
 */
export function transformerReferral(
  study: Study,
  type: Fault['type'],
  faultLevel: string | undefined,
  relayLevel: string | undefined,
): Referral {
  const same = { kind: 'factor', factor: 1, derived: false } as const;
  if (!faultLevel || !relayLevel || faultLevel === relayLevel) return same;

  /* Without a declared type there is no shape to refer, and the
   * balanced case is the one the ratio already gets right. */
  if (!type || type === 'three_phase') return same;

  const link = study.transformers.get(levelPairKey(faultLevel, relayLevel));
  if (!link) {
    return {
      kind: 'declare',
      reason: `no transformer is declared between ${faultLevel} and ${relayLevel}, so a `
        + `${type.replace(/_/g, '-')} fault cannot be carried across it -- the turns ratio `
        + 'alone is only right for a balanced fault',
    };
  }
  return referralFactor(link.group, type, faultLevel === link.hvLevel ? 'hv' : 'lv');
}
