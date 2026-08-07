/**
 * Operate-time evaluators.
 *
 * Every characteristic in the language reduces to one function of the
 * current: `t(I) -> seconds`, with `+Infinity` meaning "does not
 * operate at this current". Keeping the shape uniform is what lets
 * stages, combines, grading, and the renderer treat a fuse band, an
 * IDMT element, and a definite-time high-set identically.
 *
 * Forms implemented (spec: _Curve model_ through _Piecewise /
 * FlexCurve_):
 *
 *   IDMT      t(M) = TMS * [ k / (M^alpha - 1) + c ]     for M < G_D
 *                  = TMS * [ k / (G_D^alpha - 1) + c ]   for M >= G_D
 *   definite  t(I) = t_delay for I >= I_pu, else +inf
 *   flex      log-log interpolation of a (I, t) table, scaled by TMS
 *   ABB RI    t(M) = a - b * M          (linear, not IDMT)
 *   ABB RD    t(M) = a - b * ln(M)      (logarithmic, not IDMT)
 *   reset     t_reset(M) = TMS * [ t_r / (1 - M^2) ]     for M < 1
 */

import { lookupCurve, type CurveConstants } from '../constants/curves.js';
import type { Stage } from './model.js';
import type { FlexPoint } from '../parser/ast.js';

export interface IecParams {
  k: number;
  c: number;
  alpha: number;
  G_D?: number;
}

/* ------------------------------------------------------------------ */
/* Primitive forms                                                     */
/* ------------------------------------------------------------------ */

/**
 * IDMT operate time at multiple `M`.
 *
 * Above the ceiling multiple `G_D` the characteristic stops being
 * dependent and holds flat, which is what keeps the curve from
 * collapsing towards zero at very high multiples.
 *
 * The ceiling is *off* unless a curve (or caller) supplies `G_D`.
 * The spec's own acceptance vectors require this: its worked table
 * lists `iec.si` at `M = 50` as 1.720 s, which is the unclamped
 * value -- clamping at the nominal `G_D = 20` would give 2.267 s.
 * Per-element `G_D` override is deferred to v0.2 by the spec, so
 * there is nothing yet that turns the ceiling on for a standard
 * curve. `DEFAULT_G_D` stays exported for callers that want it.
 */
export function tTripIDMT(M: number, p: IecParams, tms: number): number {
  if (!Number.isFinite(M) || M <= 1) return Infinity;
  const at = p.G_D != null && M > p.G_D ? p.G_D : M;
  const denom = Math.pow(at, p.alpha) - 1;
  if (denom <= 0) return Infinity;
  return tms * (p.k / denom + p.c);
}

/** Definite time: operates after a fixed delay once above pickup. */
export function tTripDefinite(I: number, I_pu: number, t_delay_s: number): number {
  return I >= I_pu ? t_delay_s : Infinity;
}

/**
 * ABB RI-type: `t = tms / (a - b / M)`, hyperbolic in the multiple.
 *
 * Unlike the IDMT and RD forms this has no zero crossing -- it decays
 * from `tms / (a - b)` at pickup towards an asymptote of `tms / a`, so
 * it stays positive however large the fault.
 */
export function tTripRI(M: number, a: number, b: number, tms: number): number {
  if (!Number.isFinite(M) || M <= 1) return Infinity;
  const denom = a - b / M;
  return denom > 0 ? tms / denom : Infinity;
}

/**
 * ABB RD-type, logarithmic in the multiple: `t = a - b * ln(M)`.
 *
 * The published form runs out of definition at `M = exp(a/b)` -- for
 * the RD constants, `M ~ 73` -- above which it yields a negative time.
 * Beyond that the characteristic says nothing, and `Infinity` is how
 * this module spells that: the curve stops being drawn and grading
 * reports no operation. Clamping to `0` instead would assert
 * instantaneous operation, which is the one answer that is certainly
 * wrong and the one that flatters every margin computed from it.
 */
export function tTripLog(M: number, a: number, b: number, tms: number): number {
  if (!Number.isFinite(M) || M <= 1) return Infinity;
  const t = a - b * Math.log(M);
  return t > 0 ? tms * t : Infinity;
}

/**
 * Reset time for a dependent / disk-emulation reset characteristic.
 * Only defined below pickup, where the disc is travelling back.
 */
export function tReset(M: number, t_r: number, tms: number): number {
  if (!Number.isFinite(M) || M >= 1 || M < 0) return 0;
  return tms * (t_r / (1 - M * M));
}

/**
 * Piecewise (FlexCurve) interpolation, linear in `(log10 I, log10 t)`.
 *
 * Below the smallest tabulated current the curve does not operate;
 * above the largest it holds at the last tabulated time (spec:
 * _Piecewise / FlexCurve_).
 */
export function tTripFlex(I: number, points: FlexPoint[], tms = 1): number {
  if (!points || points.length === 0 || !Number.isFinite(I)) return Infinity;
  const pts = points;
  if (I < pts[0].I_A) return Infinity;
  const last = pts[pts.length - 1];
  if (I >= last.I_A) return last.t_s * tms;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (I >= a.I_A && I <= b.I_A) {
      if (a.I_A === b.I_A) return b.t_s * tms;
      if (a.t_s <= 0 || b.t_s <= 0) {
        /* A zero/negative time cannot be interpolated in log space. */
        const f = (I - a.I_A) / (b.I_A - a.I_A);
        return (a.t_s + f * (b.t_s - a.t_s)) * tms;
      }
      const la = Math.log10(a.I_A);
      const lb = Math.log10(b.I_A);
      const f = (Math.log10(I) - la) / (lb - la);
      return Math.pow(10, Math.log10(a.t_s) + f * (Math.log10(b.t_s) - Math.log10(a.t_s))) * tms;
    }
  }
  return Infinity;
}

/* ------------------------------------------------------------------ */
/* Stage evaluation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Operate time of a single stage at a total fault current.
 *
 * `I_total` is the *system* fault current in primary amps, already
 * projected into the stage's own voltage frame. `current_pct` then
 * takes the share this particular stage actually measures (spec:
 * _Current-share factor_).
 */
export function tTripStage(stage: Stage, I_total: number, sharePct?: number): number {
  const producer = stage.producer;
  if (!producer || !Number.isFinite(I_total)) return Infinity;

  /*
   * Past its cutoff a stage does not operate, because it is not there.
   *
   * `I_cutoff` used to be read only where a curve was *drawn*, so a
   * high-set blocked above the maximum through-fault was drawn
   * stopping at its ceiling and then evaluated well past it -- the
   * composite kept returning the blocked stage's 50 ms, and that was
   * the figure the grade report printed. The sheet and the report
   * disagreed about the same element and nothing said so.
   *
   * Answered here rather than in each caller so that every reader of a
   * stage time -- composite, grading, solver, hover -- gets the same
   * answer.
   */
  if (stage.I_cutoff_A != null && I_total > stage.I_cutoff_A) return Infinity;

  /*
   * `sharePct` overrides the element's own `share`.
   *
   * A `scenario { sees R { share } }` states what this relay takes of
   * that condition's current, and the element's `share` states the
   * same thing generally. Both used to apply, multiplying: a 50/50
   * pair came out at a quarter. The caller passes 100 where the
   * current it handed in already carries the scenario's share.
   */
  const I = I_total * ((sharePct ?? stage.current_pct) / 100);
  const I_pu = stage.I_pu_A;

  if (producer.kind === 'definite') {
    const delay = stage.t_delay_s ?? 0;
    if (I_pu == null) return Infinity;
    return tTripDefinite(I, I_pu, delay);
  }

  if (producer.kind === 'flex') {
    /* A flex table is absolute in amps; `tms` scales it linearly. */
    return tTripFlex(I, producer.points, stage.tms ?? 1);
  }

  if (I_pu == null || I_pu <= 0) return Infinity;
  const M = I / I_pu;
  const tms = stage.tms ?? 1;

  if (producer.kind === 'formula') {
    return tTripIDMT(M, { k: producer.k, c: producer.c, alpha: producer.alpha }, tms);
  }

  const c = producer.constants;
  if (c.form === 'ri') return tTripRI(M, c.a ?? 0, c.b ?? 0, tms);
  if (c.form === 'log') return tTripLog(M, c.a ?? 0, c.b ?? 0, tms);
  return tTripIDMT(M, { k: c.k, c: c.c, alpha: c.alpha, G_D: c.G_D }, tms);
}

/**
 * The `[k, c, alpha]` bracket a stage contributes at a current, with
 * `tms` factored *out*: `t = tms * bracket`. The solver inverts this
 * to get `tms` in closed form, so it has to agree exactly with
 * `tTripStage`.
 *
 * Returns `undefined` for stages whose time does not scale linearly
 * with `tms` (definite time), which the solver cannot adjust.
 */
export function tmsBracket(
  stage: Stage,
  I_total: number,
  /* Overrides the stage's own share, exactly as `tTripStage` does: the
   * solver has to divide by the current the element actually carries,
   * or it dials the backup for a fault twice the one being graded. */
  sharePct?: number,
): number | undefined {
  const producer = stage.producer;
  if (!producer || producer.kind === 'definite') return undefined;

  const I = I_total * ((sharePct ?? stage.current_pct) / 100);
  if (producer.kind === 'flex') {
    const t = tTripFlex(I, producer.points, 1);
    return Number.isFinite(t) ? t : undefined;
  }

  const I_pu = stage.I_pu_A;
  if (I_pu == null || I_pu <= 0) return undefined;
  const M = I / I_pu;

  let t: number;
  if (producer.kind === 'formula') {
    t = tTripIDMT(M, { k: producer.k, c: producer.c, alpha: producer.alpha }, 1);
  } else {
    const c = producer.constants;
    t = c.form === 'ri' ? tTripRI(M, c.a ?? 0, c.b ?? 0, 1)
      : c.form === 'log' ? tTripLog(M, c.a ?? 0, c.b ?? 0, 1)
      : tTripIDMT(M, { k: c.k, c: c.c, alpha: c.alpha, G_D: c.G_D }, 1);
  }
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** True when a stage's operate time scales linearly with `tms`. */
export function isTmsAdjustable(stage: Stage): boolean {
  return stage.producer != null && stage.producer.kind !== 'definite';
}

/* ------------------------------------------------------------------ */
/* Curve-id conveniences                                               */
/* ------------------------------------------------------------------ */

export function curveParamsFromId(id: string): IecParams | undefined {
  const c = constantsFromId(id);
  if (!c || c.form === 'ri' || c.form === 'log') return undefined;
  return { k: c.k, c: c.c, alpha: c.alpha, G_D: c.G_D };
}

export function constantsFromId(id: string): CurveConstants | undefined {
  const ix = id.indexOf('.');
  if (ix < 0) return undefined;
  return lookupCurve(id.slice(0, ix), id.slice(ix + 1));
}

export function describeCurve(id: string): string | undefined {
  return constantsFromId(id)?.name;
}
