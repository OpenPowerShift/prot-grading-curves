/**
 * Composite (multi-stage) element resolution.
 *
 * Spec _Stages and composite curves_:
 *
 *   t_composite(I) = min over stages s of t_s(I)
 *
 * `min` because whichever stage picks up first is the one that opens
 * the breaker -- the element as a whole operates as fast as its
 * fastest stage. The renderer draws one curve per element by default
 * and only splits stages apart under `view { stages = "individual"; }`.
 */

import { tTripStage } from './curves.js';
import type { Element, Stage } from './model.js';

/** Operate time of a whole element -- the envelope over its stages. */
export function tTripElement(element: Element, I_total: number): number {
  let best = Infinity;
  for (const stage of element.stages) {
    const t = tTripStage(stage, I_total);
    if (t < best) best = t;
  }
  return best;
}

/**
 * The stage that actually operates at a current -- the one setting the
 * composite time. `undefined` when no stage picks up.
 */
export function controllingStage(element: Element, I_total: number): Stage | undefined {
  let best: Stage | undefined;
  let bestT = Infinity;
  for (const stage of element.stages) {
    const t = tTripStage(stage, I_total);
    if (t < bestT) { bestT = t; best = stage; }
  }
  return bestT === Infinity ? undefined : best;
}

/**
 * The stage the solver should adjust: the *slowest* stage at the
 * declared fault, which is the one holding the grading margin open.
 *
 * Spec _Multi-stage solve_: "the solver picks the stage with the
 * largest `t_trip(I_f)`". Stages that do not respond to `tms` at all
 * (definite time) are only returned when nothing else is available,
 * so the caller can report SOLVER_NO_IDMT_STAGE.
 */
export function slowestStage(element: Element, I_total: number): Stage | undefined {
  let best: Stage | undefined;
  let bestT = -Infinity;
  for (const stage of element.stages) {
    const t = tTripStage(stage, I_total);
    if (!Number.isFinite(t)) continue;
    if (t > bestT) { bestT = t; best = stage; }
  }
  return best ?? element.stages[0];
}

/**
 * Sample an element's composite curve over a log-spaced current range.
 * Points where the element does not operate are dropped, so a caller
 * plotting the result gets a path that simply starts at pickup.
 */
export function sampleElement(
  element: Element,
  I_min: number,
  I_max: number,
  samples = 160,
): Array<{ I_A: number; t_s: number }> {
  const out: Array<{ I_A: number; t_s: number }> = [];
  if (!(I_min > 0) || !(I_max > I_min)) return out;
  const lo = Math.log(I_min);
  const hi = Math.log(I_max);
  for (let i = 0; i <= samples; i++) {
    const I = Math.exp(lo + (i / samples) * (hi - lo));
    const t = tTripElement(element, I);
    if (Number.isFinite(t) && t > 0) out.push({ I_A: I, t_s: t });
  }
  return out;
}
