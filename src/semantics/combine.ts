/**
 * Synthetic curves from the `combine { ... }` block.
 *
 * Spec _Combine -- synthetic curves_:
 *
 *   envelope_min   min(t1, t2, ...)   OR  -- whichever trips first
 *   envelope_max   max(t1, t2, ...)   AND -- slowest path must trip
 *   sum            t1 + t2 + ...      cascaded cable / breaker
 *   select_first   t1                 documentation only
 *
 * A combine is not a relay: it can neither be graded nor feed another
 * combine, which is what keeps the dependency graph acyclic and lets
 * this module stay a pure fold over already-resolved sources.
 */

import type { CombineAsKeyword } from '../parser/ast.js';
import { tTripElement } from './stages.js';
import { tTripFlex } from './curves.js';
import { resolveRef, type Combine, type Study } from './model.js';

/** Apply a combine operator to a list of per-source operate times. */
export function combineTimes(times: number[], as: CombineAsKeyword): number {
  if (times.length === 0) return Infinity;
  switch (as) {
    case 'envelope_min':
      return Math.min(...times);
    case 'envelope_max':
      return Math.max(...times);
    case 'sum':
      /* Any non-operating leg makes the cascade non-operating. */
      return times.some((t) => !Number.isFinite(t))
        ? Infinity
        : times.reduce((a, b) => a + b, 0);
    case 'select_first':
      return times[0];
    default:
      return Infinity;
  }
}

/** Operate times of a combine's sources at a current, in source order. */
export function sourceTimes(study: Study, combine: Combine, I_total: number): number[] {
  return combine.sources.map((ref) => {
    const { element, device } = resolveRef(study, ref);
    if (element) return tTripElement(element, I_total);
    if (device) {
      /* A device's own curve: total-clear for a fuse band, else the
       * single table, else a breaker's flat clearing time. */
      const points = device.total_clear ?? device.flex_points ?? device.min_melt;
      if (points) return tTripFlex(I_total, points);
      if (device.t_delay_s != null) return device.t_delay_s;
    }
    return Infinity;
  });
}

/** Operate time of a synthetic combine curve at a current. */
export function tTripCombine(study: Study, combine: Combine, I_total: number): number {
  return combineTimes(sourceTimes(study, combine, I_total), combine.as);
}

/** Sample a combine's curve over a log-spaced current range. */
export function sampleCombine(
  study: Study,
  combine: Combine,
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
    const t = tTripCombine(study, combine, I);
    if (Number.isFinite(t) && t > 0) out.push({ I_A: I, t_s: t });
  }
  return out;
}
