/**
 * Symmetrical-component ratios by fault type.
 *
 * At one fault the phase current and the sequence components are not
 * independent -- they are fixed multiples of one another, decided by
 * what kind of fault it is. Knowing the type is therefore what lets a
 * curve measured in one quantity be placed on an axis drawn in
 * another, and what says which components are zero and so which
 * elements cannot operate at all.
 *
 * Every ratio here is expressed against **the condition's own declared
 * phase current**. A two-phase fault's phase current is its own value,
 * not a fraction of some other condition's -- nothing in this table is
 * referenced to a three-phase figure.
 *
 * Assumptions, stated because they are the limits of the table:
 *
 *   - `Z1 = Z2`, which holds for the network away from rotating
 *     machines and is the usual basis for hand grading;
 *   - fault impedance neglected;
 *   - `two_phase_earth` derives nothing, because its split between
 *     the sequence networks depends on `Z0`, which this language does
 *     not carry.
 *
 * A declared component always wins over a derived one, so an engineer
 * whose study says otherwise writes the figure and this table steps
 * aside. Kept as a visible table beside `curves.ts` for the same
 * reason that one exists: a number a study depends on should be
 * auditable, not buried in a branch.
 */

import type { MeasuredQuantity } from '../semantics/quantity.js';

/** What kind of fault a condition is. */
export type FaultType =
  | 'three_phase'
  | 'two_phase'
  | 'two_phase_earth'
  | 'single_phase_earth';

export const FAULT_TYPES: readonly FaultType[] =
  ['three_phase', 'two_phase', 'two_phase_earth', 'single_phase_earth'];

export function isFaultType(value: unknown): value is FaultType {
  return typeof value === 'string' && (FAULT_TYPES as readonly string[]).includes(value);
}

/**
 * Component per unit of declared phase current.
 *
 * `undefined` for a component this type cannot supply -- distinct from
 * `0`, which is a real answer meaning the component is absent.
 */
export interface SequenceRatios {
  I1?: number;
  I2?: number;
  I0?: number;
}

const ROOT3 = Math.sqrt(3);

const RATIOS: Record<FaultType, SequenceRatios> = {
  /* Balanced: positive sequence only. */
  three_phase: { I1: 1, I2: 0, I0: 0 },

  /*
   * Phase to phase. |I1| = |I2| and the line current is their
   * difference, larger by root three -- so each component is the phase
   * current divided by root three. No earth path, so no zero sequence.
   */
  two_phase: { I1: 1 / ROOT3, I2: 1 / ROOT3, I0: 0 },

  /*
   * Phase to earth, solidly earthed. The three sequence currents are
   * equal and sum to the faulted phase current, so each is a third of
   * it; the residual `3*I0` is the phase current itself.
   */
  single_phase_earth: { I1: 1 / 3, I2: 1 / 3, I0: 1 / 3 },

  /*
   * Two phases to earth. The division between the negative and zero
   * sequence networks depends on `Z0`, so nothing is derived and the
   * components must be declared.
   */
  two_phase_earth: {},
};

/** Ratios for a type, or an empty set for one that derives nothing. */
export function ratiosFor(type: FaultType | undefined): SequenceRatios {
  return type ? RATIOS[type] : {};
}

/**
 * Component per unit of phase current for one quantity.
 *
 * `undefined` means this type cannot say. `0` means the component is
 * genuinely absent -- a balanced fault has no negative sequence -- and
 * callers use that to suppress elements that cannot operate rather
 * than to draw them at zero.
 */
export function ratioFor(
  type: FaultType | undefined,
  quantity: MeasuredQuantity,
): number | undefined {
  if (quantity === 'phase') return 1;

  const r = ratiosFor(type);
  switch (quantity) {
    case 'I1': return r.I1;
    case 'I2': return r.I2;
    case 'I0': return r.I0;
    case '3I2': return r.I2 == null ? undefined : r.I2 * 3;
    case '3I0': return r.I0 == null ? undefined : r.I0 * 3;
  }
}

/**
 * True when this type is known to carry none of that quantity.
 *
 * An earth-fault element on a balanced three-phase condition is the
 * case worth catching: it has nothing to measure, so drawing its curve
 * on that sheet would imply an operation that cannot happen.
 */
export function quantityIsAbsent(
  type: FaultType | undefined,
  quantity: MeasuredQuantity,
): boolean {
  return ratioFor(type, quantity) === 0;
}

/** How a type reads in a legend or a diagnostic. */
export function faultTypeLabel(type: FaultType): string {
  switch (type) {
    case 'three_phase': return 'three-phase';
    case 'two_phase': return 'phase-phase';
    case 'two_phase_earth': return 'two-phase to earth';
    case 'single_phase_earth': return 'phase-earth';
  }
}
