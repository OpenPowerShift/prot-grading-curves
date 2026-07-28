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

import type { Fault, Study } from './model.js';

export interface Projection {
  /** Current in primary amps, in the target voltage frame. */
  I_A: number;
  /** Ratio applied to get there (1 when no conversion was needed). */
  ratio: number;
  /** Set when a ratio was wanted but could not be computed. */
  warning?: string;
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
  return projectCurrent(I, faultKv, relayKv);
}
