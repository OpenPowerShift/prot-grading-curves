/**
 * Grading solver.
 *
 * Given a primary that must clear first and a backup that must hold
 * off by a declared margin, compute the backup's free variables
 * (spec: _Solver -- automatic grading_).
 *
 *   t_p_at(I_f)   = t_trip(R_p, I_f)
 *   target_margin = margin_s * (1 + tolerance_pct / 100)
 *   t_b_target    = t_p_at(I_f) + target_margin
 *   bracket       = k / (M_b^alpha - 1) + c
 *   TMS_b         = t_b_target / bracket             # closed-form
 *
 * The additive `c` term stays *inside* the bracket. The naive
 * rearrangement `TMS_b = t_b_target * (M^alpha - 1) / k` drops it and
 * underestimates `TMS_b` whenever `c` is material -- which it is for
 * every ANSI/IEEE curve. `tests/unit/solver.spec.ts` pins this.
 *
 * The computed value is never written back to the source file; it is
 * reported and flagged `source: "auto"` so the engineer stays in
 * charge of the settings sheet.
 */

import { TMS_RANGE_ANSI, TMS_RANGE_IEC, tmsRangeFor } from '../constants/curves.js';
import { isTmsAdjustable, tTripStage, tmsBracket } from './curves.js';
import { slowestStage } from './stages.js';
import type { Element, Stage } from './model.js';

export type SolveStrategy = 'tight' | 'loose' | 'safety_factor';
export type FreeVariable = 'tms' | 't_delay' | 'I_pu';

export interface SolveRequest {
  /** Backup element whose settings are being computed. */
  backup: Element;
  /** Primary operate time at the declared fault, in seconds. */
  t_primary_s: number;
  /** Design target margin, in seconds. */
  margin_s: number;
  /** Fault current in the backup's own voltage frame, primary amps. */
  I_f_A: number;
  strategy: SolveStrategy;
  tolerance_pct?: number;
  free: FreeVariable[];
  /** Primary pickup, used to bound a free `I_pu` (IEEE 242 §15.3.2). */
  I_pu_primary_A?: number;
}

export interface SolveResult {
  ok: boolean;
  /** The stage the solver adjusted. */
  stage?: Stage;
  /** Computed time multiplier, rounded per `strategy`. */
  tms?: number;
  /** Computed pickup, when `I_pu` was free. */
  I_pu_A?: number;
  /** Backup operate time achieved with the computed settings. */
  t_backup_s?: number;
  /** Achieved margin at the declared fault. */
  achieved_margin_s?: number;
  /** `t_b_target` before rounding. */
  target_t_backup_s?: number;
  /** Unrounded closed-form solution, for the report. */
  tms_exact?: number;
  /** Extra margin, in seconds, contributed by snapping `tms` upward. */
  quantisation_s?: number;
  /** True when the achieved margin sits inside the tolerance band. */
  within_tolerance?: boolean;
  /** Diagnostic code when `ok` is false. */
  code?: 'SOLVER_NO_IDMT_STAGE' | 'SOLVER_UNSATISFIABLE' | 'SOLVER_NO_TARGET';
  message?: string;
  /** Populated for an unsatisfiable target, per the spec's report. */
  unsatisfiable?: {
    required_tms: number;
    tms_min: number;
    tms_max: number;
    t_backup_at_max_s: number;
    margin_at_max_s: number;
    suggestions: string[];
  };
}

/** Smallest multiple of `step` that is >= `value`. */
function ceilTo(value: number, step: number): number {
  return Math.ceil((value - 1e-9) / step) * step;
}

/**
 * Snap a raw time multiplier onto the settable grid.
 *
 * `tight` takes the smallest step that still *meets* the margin, so it
 * rounds up rather than down -- rounding down would land under the
 * declared target and defeat the purpose. The spec's worked solver
 * case relies on this: 0.28859 -> 0.290, not 0.285. (The prose in
 * _Algorithm_ says "floor"; see the note in `IMPLEMENTATION.adoc`.)
 *
 * `loose` snaps up to the vendor's coarse dial step -- 0.025 for IEC,
 * 0.05 for ANSI.
 */
export function snapTms(raw: number, strategy: SolveStrategy, curveId?: string): number {
  const range = curveId ? tmsRangeFor(curveId) : TMS_RANGE_IEC;
  switch (strategy) {
    case 'loose':
      return ceilTo(raw, range.step);
    case 'safety_factor':
      /* v0.2 multiplies by (1 + safety_value); with no value declared
       * yet this behaves as `tight`. */
      return ceilTo(raw, 0.005);
    case 'tight':
    default:
      return ceilTo(raw, 0.005);
  }
}

function rangeForStage(stage: Stage): typeof TMS_RANGE_IEC | typeof TMS_RANGE_ANSI {
  const producer = stage.producer;
  if (producer?.kind === 'standard') return tmsRangeFor(producer.id);
  return TMS_RANGE_IEC;
}

/**
 * Solve for the backup's settings.
 *
 * With a single free variable the answer is closed-form. With `I_pu`
 * also free, `tms` is solved first and the pickup is then walked down
 * (which raises `M`, lowering the operate time) by a bounded Newton
 * iteration -- `M` sits inside `M^alpha`, so there is no closed form
 * once both move together.
 */
export function solveGrade(req: SolveRequest): SolveResult {
  const { backup, t_primary_s, margin_s, I_f_A, strategy } = req;

  if (!Number.isFinite(margin_s)) {
    return { ok: false, code: 'SOLVER_NO_TARGET', message: 'no margin target declared' };
  }

  const tolerance_pct = req.tolerance_pct ?? 0;
  const target_margin = margin_s * (1 + tolerance_pct / 100);
  const t_b_target = t_primary_s + target_margin;

  const stage = slowestStage(backup, I_f_A);
  if (!stage) {
    return { ok: false, code: 'SOLVER_NO_IDMT_STAGE', message: 'backup has no evaluable stage' };
  }
  if (!isTmsAdjustable(stage)) {
    return {
      ok: false,
      stage,
      code: 'SOLVER_NO_IDMT_STAGE',
      message:
        `controlling stage "${stage.id}" of ${backup.ref} is definite-time and has no tms; ` +
        'reporting the existing margin instead',
    };
  }

  const bracket = tmsBracket(stage, I_f_A);
  if (bracket == null || !(bracket > 0)) {
    return {
      ok: false,
      stage,
      code: 'SOLVER_UNSATISFIABLE',
      message: `${backup.ref} does not pick up at ${I_f_A.toFixed(0)} A`,
    };
  }

  const tms_exact = t_b_target / bracket;
  const range = rangeForStage(stage);
  const curveId = stage.producer?.kind === 'standard' ? stage.producer.id : undefined;
  const tms = snapTms(tms_exact, strategy, curveId);

  /* Outside the device's settable range the target cannot be met. */
  if (tms < range.min || tms > range.max) {
    const clamped = Math.min(Math.max(tms, range.min), range.max);
    const atMax = withTms(stage, range.max);
    const t_at_max = tTripStage(atMax, I_f_A);
    return {
      ok: false,
      stage,
      code: 'SOLVER_UNSATISFIABLE',
      tms: clamped,
      tms_exact,
      target_t_backup_s: t_b_target,
      message:
        `target margin ${margin_s.toFixed(3)} s at I_f = ${I_f_A.toFixed(0)} A needs ` +
        `tms = ${tms_exact.toFixed(3)}, outside the settable range ` +
        `[${range.min}, ${range.max}]`,
      unsatisfiable: {
        required_tms: tms_exact,
        tms_min: range.min,
        tms_max: range.max,
        t_backup_at_max_s: t_at_max,
        margin_at_max_s: t_at_max - t_primary_s,
        suggestions: [
          'change the primary curve family (e.g. iec.si -> iec.vi)',
          'increase I_pu of the primary',
          'lower CTI to allow a tighter margin',
        ],
      },
    };
  }

  let I_pu_A = stage.I_pu_A;

  /*
   * `I_pu` free: walk the pickup down towards the discrimination floor
   * to recover any margin that rounding `tms` up overshot. Lower
   * pickup means a higher multiple, hence a faster backup.
   */
  if (req.free.includes('I_pu') && stage.I_pu_A != null && !backup.staged) {
    const floor = Math.max(
      1e-6,
      req.I_pu_primary_A != null ? 1.2 * req.I_pu_primary_A : stage.I_pu_A * 0.5,
    );
    I_pu_A = solvePickup(stage, tms, t_b_target, I_f_A, floor, stage.I_pu_A);
  } else if (req.free.includes('I_pu') && backup.staged) {
    /* Spec _Multi-stage solve_: two free variables on a staged
     * element is deferred to v0.2; `tms` alone still applies. */
    I_pu_A = stage.I_pu_A;
  }

  const solved = withTms({ ...stage, I_pu_A }, tms);
  const t_backup_s = tTripStage(solved, I_f_A);
  const achieved = t_backup_s - t_primary_s;

  /*
   * Tolerance verdict.
   *
   * The closed-form solution lands on `target_margin` exactly; what
   * moves it is snapping `tms` onto the settable grid, which is always
   * *upward* so the margin is never eroded. That quantisation is
   * deliberate, so it is not a tolerance violation -- the band is
   * widened by exactly the time the snap added.
   *
   * This is what reconciles the spec's two statements: its algorithm
   * aims at `margin_s * (1 + tolerance_pct/100)`, while its sample
   * report calls the worked case "within tolerance (0.0 %)" despite
   * `tms` having been rounded 0.28859 -> 0.290.
   */
  const quantisation_s = Math.max(0, (tms - tms_exact) * bracket);
  const within_tolerance =
    achieved >= margin_s - 1e-9 &&
    achieved <= target_margin + quantisation_s + 1e-9;

  return {
    ok: true,
    stage,
    tms,
    tms_exact,
    I_pu_A,
    t_backup_s,
    achieved_margin_s: achieved,
    target_t_backup_s: t_b_target,
    quantisation_s,
    within_tolerance,
  };
}

/** A copy of a stage with `tms` overridden and flagged as solver-set. */
export function withTms(stage: Stage, tms: number): Stage {
  return { ...stage, tms, tms_auto: true };
}

/**
 * Bounded Newton search for the pickup that lands the backup on its
 * target time, falling back to bisection when the derivative is flat.
 * Bracketed by `[floor, start]` -- the solver only ever *lowers* the
 * pickup, since raising it would erode discrimination.
 */
function solvePickup(
  stage: Stage,
  tms: number,
  t_target: number,
  I_f_A: number,
  floor: number,
  start: number,
): number {
  const f = (I_pu: number): number =>
    tTripStage(withTms({ ...stage, I_pu_A: I_pu }, tms), I_f_A) - t_target;

  const fStart = f(start);
  if (!Number.isFinite(fStart)) return start;
  /* Already at or below target: nothing to recover by moving pickup. */
  if (fStart <= 0) return start;

  const fFloor = f(floor);
  if (!Number.isFinite(fFloor) || fFloor > 0) return floor;

  let lo = floor;
  let hi = start;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (!Number.isFinite(fm)) { hi = mid; continue; }
    if (Math.abs(fm) < 1e-9) return mid;
    if (fm > 0) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}
