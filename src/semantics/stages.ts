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

/**
 * The largest current at which an element still has a characteristic.
 *
 * `undefined` where it has no end: the element declared no `I_cutoff`
 * and at least one stage runs on unbounded.
 *
 * Not simply the element's own figure, because a stage may stop
 * earlier than the element that owns it -- and the element as a whole
 * survives as long as *any* stage does, so the ceiling is the largest
 * of theirs. (`buildStudy` has already given a stage its element's
 * cutoff where it declared none, so a stage with none here really has
 * none.)
 */
export function cutoffOf(element: Element): number | undefined {
  if (element.stages.length === 0) return element.I_cutoff_A;
  if (element.stages.some((s) => s.I_cutoff_A == null)) return undefined;
  return Math.max(...element.stages.map((s) => s.I_cutoff_A ?? 0));
}

/** Operate time of a whole element -- the envelope over its stages. */
export function tTripElement(element: Element, I_total: number, sharePct?: number): number {
  let best = Infinity;
  for (const stage of element.stages) {
    const t = tTripStage(stage, I_total, sharePct);
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
export function slowestStage(
  element: Element,
  I_total: number,
  sharePct?: number,
): Stage | undefined {
  let best: Stage | undefined;
  let bestT = -Infinity;
  for (const stage of element.stages) {
    const t = tTripStage(stage, I_total, sharePct);
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
