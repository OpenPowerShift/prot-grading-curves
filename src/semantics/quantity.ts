/**
 * What current a relay element actually measures.
 *
 * A relay does not measure "the fault current". A phase overcurrent
 * element measures phase current; an earth-fault element measures the
 * residual `3*I0` its CT connection presents; a negative-sequence
 * element measures `I2` (or `3*I2`, depending on how the IED is
 * scaled). Those quantities differ from one another at a single fault,
 * so the multiple `M = I / I_pu` is only meaningful once the right one
 * has been chosen.
 *
 * `spec/sections/semantics.adoc` -- _Function-specific multiple
 * derivation_ -- has carried the normative table for this since
 * v0.1.0. This module is its implementation: before it, `function` was
 * parsed, stored, and never read, so every element was evaluated
 * against the declared phase current whatever its function said.
 *
 * Deliberately separate from `curves.ts`. That module is "time as a
 * function of one current", which is what lets a fuse band, an IDMT
 * element and a definite-time high-set be treated identically;
 * choosing *which* current belongs to the callers that know about
 * faults and scenarios.
 */

import type { Stage } from './model.js';

/**
 * A current a pickup can be expressed in.
 *
 * `phase` is the phase current. `I1` / `I2` / `I0` are the symmetrical
 * components. `3I2` / `3I0` are those components scaled by three, as
 * a residual CT connection presents them and as many IEDs are set.
 */
export type MeasuredQuantity = 'phase' | 'I1' | 'I2' | '3I2' | 'I0' | '3I0';

export const MEASURED_QUANTITIES: readonly MeasuredQuantity[] =
  ['phase', 'I1', 'I2', '3I2', 'I0', '3I0'];

/** True for a spelling this module understands. */
export function isMeasuredQuantity(value: unknown): value is MeasuredQuantity {
  return typeof value === 'string'
    && (MEASURED_QUANTITIES as readonly string[]).includes(value);
}

/**
 * Default measured quantity for a function, per the spec table.
 *
 * `neg_seq` is deliberately absent. IEDs differ over whether a
 * negative-sequence pickup is scaled in `I2` or `3*I2` -- the GE 850
 * measures `I2` directly -- and the factor of three is the difference
 * between an element that operates and one that does not. Guessing it
 * would be a silent three-to-one error in a pickup, so the language
 * requires it to be stated.
 */
const DEFAULT_BY_FUNCTION: Record<string, MeasuredQuantity> = {
  phase_oc: 'phase',
  thermal: 'phase',
  breaker_fail: 'phase',
  earth_fault: '3I0',
};

/** Functions that must state their measured quantity explicitly. */
export const FUNCTIONS_REQUIRING_MEASURES: readonly string[] = ['neg_seq'];

/**
 * The quantity a stage's pickup is expressed in.
 *
 * `null` means it cannot be determined: a `neg_seq` element that does
 * not declare `measures`. The caller raises the diagnostic -- this
 * module does not know the source location.
 */
export function measuredQuantityOf(stage: Stage): MeasuredQuantity | null {
  if (isMeasuredQuantity(stage.measures)) return stage.measures;

  const fn = stage.function;
  if (!fn) return 'phase';
  if (FUNCTIONS_REQUIRING_MEASURES.includes(fn)) return null;

  return DEFAULT_BY_FUNCTION[fn] ?? 'phase';
}

/** Symmetrical components of one condition at one voltage level. */
export interface SequenceCurrents {
  /** Phase current, primary amps at this level. */
  phase?: number;
  I1?: number;
  I2?: number;
  I0?: number;
  /**
   * Residual current declared directly, as `3*I0`. An alternative to
   * `I0` for engineers whose study reports the residual.
   */
  residual?: number;
}

/**
 * The current a quantity resolves to, or `null` when it was not
 * declared.
 *
 * Never falls back to another quantity. Substituting phase current for
 * a missing `I2` is how the present wrong numbers arise: it produces a
 * well-formed margin for a comparison that was never made.
 */
export function currentFor(
  quantity: MeasuredQuantity,
  currents: SequenceCurrents,
): number | null {
  const at = (value: number | undefined): number | null =>
    value != null && Number.isFinite(value) ? value : null;

  switch (quantity) {
    case 'phase': return at(currents.phase);
    case 'I1': return at(currents.I1);
    case 'I2': return at(currents.I2);
    case 'I0': return at(currents.I0) ?? scaled(at(currents.residual), 1 / 3);
    case '3I2': return scaled(at(currents.I2), 3);
    /* A declared residual is the residual; otherwise derive it. */
    case '3I0': return at(currents.residual) ?? scaled(at(currents.I0), 3);
  }
}

function scaled(value: number | null, factor: number): number | null {
  return value == null ? null : value * factor;
}

/** How a quantity reads on a legend or in a diagnostic. */
export function quantityLabel(quantity: MeasuredQuantity): string {
  switch (quantity) {
    case 'phase': return 'phase';
    case 'I1': return 'I1';
    case 'I2': return 'I2';
    case '3I2': return '3I2';
    case 'I0': return 'I0';
    case '3I0': return 'residual 3I0';
  }
}

/**
 * The field an author would declare to supply this quantity.
 *
 * Used in diagnostics, so the message names the thing to type rather
 * than the internal concept.
 */
export function quantityField(quantity: MeasuredQuantity): string {
  switch (quantity) {
    case 'phase': return 'I_A';
    case 'I1': return 'I1_A';
    case 'I2':
    case '3I2': return 'I2_A';
    case 'I0':
    case '3I0': return 'I0_A (or earth_A)';
  }
}

/**
 * True when a quantity survives being referred across a transformer.
 *
 * Positive and negative sequence pass through a two-winding
 * transformer, their magnitudes scaling with the turns ratio. Zero
 * sequence does not cross a delta winding at all, so referring a
 * residual figure from one level to another by the voltage ratio
 * states something physically false -- and it is the reason an HV
 * negative-sequence element, not an HV residual element, backs up an
 * LV earth fault.
 */
export function survivesVoltageReferral(quantity: MeasuredQuantity): boolean {
  return quantity === 'phase' || quantity === 'I1' || quantity === 'I2' || quantity === '3I2';
}

/**
 * The quantity an element as a whole measures.
 *
 * Every stage of one element normally measures the same thing -- they
 * are stages of one protection function. `'mixed'` reports the case
 * where they do not, which the validator turns into a diagnostic
 * rather than silently grading against one of them.
 */
export function elementQuantity(
  stages: readonly Stage[],
): MeasuredQuantity | null | 'mixed' {
  if (stages.length === 0) return 'phase';

  const first = measuredQuantityOf(stages[0]);
  for (const stage of stages.slice(1)) {
    if (measuredQuantityOf(stage) !== first) return 'mixed';
  }
  return first;
}
