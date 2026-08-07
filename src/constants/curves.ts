/**
 * Curve constants tables.
 *
 * Every row here is transcribed from
 * `spec/sections/semantics.adoc` -- _Standard curve identifiers_.
 * That section is normative: the table is part of the processor, not
 * the user source, so that a study renders identically everywhere.
 *
 * The standard dependent-time (IDMT) form is:
 *
 *   t_trip(M) = TMS * [ k / (M^alpha - 1) + c ]      for M < G_D
 *             = TMS * [ k / (G_D^alpha - 1) + c ]    for M >= G_D
 *
 * The reset (disk emulation) form is:
 *
 *   t_reset(M) = TMS * [ t_r / (1 - M^2) ]           for M < 1
 *
 * ABB RI / RD are *not* IDMT: they carry `form: 'ri'` /
 * `form: 'log'` and are evaluated by their own closed forms
 * (see `src/semantics/curves.ts`).
 *
 * Curves are namespaced `namespace.family` (e.g. `iec.si`,
 * `ansi.mi`, `ge.ur.vi`). `lookupCurve` splits on the *first* dot,
 * so a family may itself contain dots (`ur.vi`).
 *
 * `t_r: null` means the standard leaves the reset time to the
 * manufacturer (spec writes this as `_mfr_`).
 *
 * Nothing reads `t_r`. The `reset` key that did was removed on
 * 2026-08-08, having been stored and never drawn. The column stays
 * because this table's purpose is to be a *transcription* a reader can
 * check line by line against IEC 60255-151 and IEEE C37.112 -- dropping
 * a published constant because the current code path does not use it
 * would make it a worse copy of the standard, and the reset
 * characteristic is the obvious thing to draw next.
 */

export type CurveForm = 'idmt' | 'ri' | 'log';

/**
 * Which dial the multiplier is turned in.
 *
 * `iec` is the IEC 60255-151 time multiplier setting, `0.025 .. 1.5`;
 * `ansi` is the IEEE C37.112 *time dial*, `0.5 .. 15`. They are
 * different scales on different relays, and a study that mixes them up
 * is out by a factor of ten.
 *
 * Declared per curve, not inferred from the namespace it is filed
 * under. The namespace is a *vendor*, and vendors ship both: GE's UR
 * series carries `ur.mi` (C37.112, time dial) beside `ur.si` (IEC,
 * TMS), and SEL's `u`-curves are dialled in one while its `c`-curves
 * are dialled in the other. Keying on the string `'ansi'` made
 * `ge.ur.mi` reject a perfectly legal dial of 3.0 as outside
 * `[0.025, 1.5]` -- and the obvious response to that error is to
 * divide by ten, which gives a curve ten times fast.
 *
 * It correlates exactly with a non-zero `c` (the additive term is what
 * makes a characteristic the C37.112 shape), but it is written out
 * rather than derived: this table exists to be checked line by line
 * against the standards, and a reader should not have to infer a dial
 * range from a coefficient.
 */
export type DialFamily = 'iec' | 'ansi';

export interface CurveConstants {
  /** family name as written after the namespace (e.g. "si", "ur.vi") */
  family: string;
  /** long, human-readable name */
  name: string;
  /** evaluation form; defaults to IDMT */
  form?: CurveForm;
  /** k coefficient (seconds) -- IDMT only */
  k: number;
  /** c offset (seconds) -- IDMT only */
  c: number;
  /** alpha exponent -- IDMT only */
  alpha: number;
  /**
   * reset time constant (seconds). `null` = manufacturer-defined
   * (`_mfr_` in the spec table); 0 = instantaneous reset.
   */
  t_r: number | null;
  /** `a` constant for the linear / logarithmic ABB forms */
  a?: number;
  /** Which dial the multiplier is turned in; see `DialFamily`. */
  dial: DialFamily;
  /** `b` constant for the linear / logarithmic ABB forms */
  b?: number;
  /** ceiling multiple G_D; undefined means "use the default of 20" */
  G_D?: number;
  /** G_S reference multiple */
  G_S?: number;
  /** IEC 60255-151 curve type discriminator */
  type?: 'dependent' | 'instant' | 'definite' | 'disk_emulation';
  /** Standard reference footnote, for audit */
  ref?: string;
}

export type CurveTable = Record<string, CurveConstants>;

/* ------------------------------------------------------------------ */
/* IEC 60255-151:2009 Annex A (curves A-F)                             */
/*   ...plus the withdrawn IEC 60255-3:1989 LTI / STI legacy pair,     */
/*   which modern relays still carry.                                  */
/* ------------------------------------------------------------------ */

const iec: CurveTable = {
  si:  { family: 'si',  name: 'IEC standard inverse',    k: 0.14, c: 0, alpha: 0.02, dial: 'iec', t_r: null, type: 'dependent', ref: 'IEC 60255-151:2009 Annex A.1 A' },
  vi:  { family: 'vi',  name: 'IEC very inverse',        k: 13.5, c: 0, alpha: 1.0,  dial: 'iec', t_r: null, type: 'dependent', ref: 'IEC 60255-151:2009 Annex A.1 B' },
  ei:  { family: 'ei',  name: 'IEC extremely inverse',   k: 80,   c: 0, alpha: 2.0,  dial: 'iec', t_r: null, type: 'dependent', ref: 'IEC 60255-151:2009 Annex A.1 C' },
  lti: { family: 'lti', name: 'IEC long-time inverse',   k: 120,  c: 0, alpha: 1.0,  dial: 'iec', t_r: null, type: 'dependent', ref: 'IEC 60255-3:1989 §3.5.2 char. 1 (legacy)' },
  sti: { family: 'sti', name: 'IEC short-time inverse',  k: 0.05, c: 0, alpha: 0.04, dial: 'iec', t_r: null, type: 'dependent', ref: 'IEC 60255-3:1989 §3.5.2 char. 2 (legacy)' },
};

/* ------------------------------------------------------------------ */
/* IEEE C37.112-1996 / ANSI -- IEC 60255-151 Annex A rows D, E, F      */
/* ------------------------------------------------------------------ */

const ansi: CurveTable = {
  mi: { family: 'mi', name: 'ANSI/IEEE moderately inverse', k: 0.0515, c: 0.114,  alpha: 0.02, dial: 'ansi', t_r: 4.85, type: 'dependent', ref: 'IEC 60255-151:2009 Annex A.1 D; IEEE C37.112 Table III' },
  vi: { family: 'vi', name: 'ANSI/IEEE very inverse',       k: 19.61,  c: 0.491,  alpha: 2.0,  dial: 'ansi', t_r: 21.6, type: 'dependent', ref: 'IEC 60255-151:2009 Annex A.1 E; IEEE C37.112 Table III' },
  ei: { family: 'ei', name: 'ANSI/IEEE extremely inverse',  k: 28.2,   c: 0.1217, alpha: 2.0,  dial: 'ansi', t_r: 29.1, type: 'dependent', ref: 'IEC 60255-151:2009 Annex A.1 F; IEEE C37.112 Table III' },
};

/* ------------------------------------------------------------------ */
/* SEL -- SEL-451 / SEL-751 family (modern)                            */
/*                                                                     */
/* SEL's `u1` is the CO-2 electromechanical emulation and is NOT       */
/* numerically identical to IEEE C37.112 U1 (exposed as `ansi.mi`).    */
/* ------------------------------------------------------------------ */

const sel: CurveTable = {
  c1: { family: 'c1', name: 'SEL C1 (IEC SI)',            k: 0.14,    c: 0,       alpha: 0.02, dial: 'iec', t_r: 13.5,  type: 'dependent', ref: 'SEL-451 IM; SEL IEC SI' },
  c2: { family: 'c2', name: 'SEL C2 (IEC VI)',            k: 13.5,    c: 0,       alpha: 1.0,  dial: 'iec', t_r: 47.3,  type: 'dependent', ref: 'SEL-451 IM; SEL IEC VI' },
  c3: { family: 'c3', name: 'SEL C3 (IEC EI)',            k: 80,      c: 0,       alpha: 2.0,  dial: 'iec', t_r: 80,    type: 'dependent', ref: 'SEL-451 IM; SEL IEC EI' },
  c4: { family: 'c4', name: 'SEL C4 (IEC LTI, legacy)',   k: 120,     c: 0,       alpha: 1.0,  dial: 'iec', t_r: 120,   type: 'dependent', ref: 'SEL-451 IM; SEL IEC LTI' },
  c5: { family: 'c5', name: 'SEL C5 (IEC STI, legacy)',   k: 0.05,    c: 0,       alpha: 0.04, dial: 'iec', t_r: 4.85,  type: 'dependent', ref: 'SEL-451 IM; SEL IEC STI' },
  u1: { family: 'u1', name: 'SEL U1 (CO-2 emulation)',    k: 0.0226,  c: 0.0104,  alpha: 0.02, dial: 'ansi', t_r: 1.08,  type: 'dependent', ref: 'SEL-451 IM; CO-2 emulation (NOT C37.112 U1)' },
  u2: { family: 'u2', name: 'SEL U2 (IAC emulation)',     k: 0.180,   c: 5.95,    alpha: 2.0,  dial: 'ansi', t_r: 5.95,  type: 'dependent', ref: 'SEL-451 IM; SEL IAC emulation' },
  u3: { family: 'u3', name: 'SEL U3 (very inverse)',      k: 0.0963,  c: 3.88,    alpha: 2.0,  dial: 'ansi', t_r: 3.88,  type: 'dependent', ref: 'SEL-451 IM; SEL very inverse' },
  u4: { family: 'u4', name: 'SEL U4 (extreme inverse)',   k: 0.0352,  c: 5.67,    alpha: 2.0,  dial: 'ansi', t_r: 5.67,  type: 'dependent', ref: 'SEL-451 IM; SEL extreme inverse' },
  u5: { family: 'u5', name: 'SEL U5 (short-time inverse)', k: 0.00262, c: 0.00342, alpha: 0.02, dial: 'ansi', t_r: 0.323, type: 'dependent', ref: 'SEL-451 IM; SEL short-time inverse' },
};

/* ------------------------------------------------------------------ */
/* Siemens -- SIPROTEC 5 platform (modern)                             */
/*                                                                     */
/* The ANSI long-time inverse variants are vendor extensions in        */
/* addition to the IEC 60255-151 standard set.                         */
/* ------------------------------------------------------------------ */

const siemens: CurveTable = {
  inv:      { family: 'inv',      name: 'Siemens inverse',              k: 0.0086, c: 0.0185, alpha: 0.02, dial: 'ansi', t_r: 9.7,  type: 'dependent', ref: 'SIPROTEC 5 7SJ85 manual (vendor ext.; NOT C37.112 U1)' },
  long_inv: { family: 'long_inv', name: 'Siemens long inverse',         k: 0.086,  c: 0.185,  alpha: 0.02, dial: 'ansi', t_r: 9.7,  type: 'dependent', ref: 'SIPROTEC 5 7SJ85 manual' },
  long_vi:  { family: 'long_vi',  name: 'Siemens long very inverse',    k: 28.55,  c: 0.712,  alpha: 2.0,  dial: 'ansi', t_r: 43.2, type: 'dependent', ref: 'SIPROTEC 5 7SJ85 manual' },
  long_ei:  { family: 'long_ei',  name: 'Siemens long extremely inv.',  k: 64.07,  c: 0.250,  alpha: 2.0,  dial: 'ansi', t_r: 58.2, type: 'dependent', ref: 'SIPROTEC 5 7SJ85 manual' },
};

/* ------------------------------------------------------------------ */
/* GE -- UR-series (modern)                                            */
/*                                                                     */
/* The GE Multilin 745 IAC family is deliberately absent: it is now    */
/* expressed as a FlexCurve piecewise table instead.                   */
/* ------------------------------------------------------------------ */

const ge: CurveTable = {
  'ur.mi': { family: 'ur.mi', name: 'GE UR moderately inverse',  k: 0.0515, c: 0.114,  alpha: 0.02, dial: 'ansi', t_r: 4.85, type: 'dependent', ref: 'UR-series T60 IM (C37.112 mi, default)' },
  'ur.vi': { family: 'ur.vi', name: 'GE UR very inverse',        k: 19.61,  c: 0.491,  alpha: 2.0,  dial: 'ansi', t_r: 21.6, type: 'dependent', ref: 'UR-series T60 IM (C37.112 vi)' },
  'ur.ei': { family: 'ur.ei', name: 'GE UR extremely inverse',   k: 28.2,   c: 0.1217, alpha: 2.0,  dial: 'ansi', t_r: 29.1, type: 'dependent', ref: 'UR-series T60 IM (C37.112 ei)' },
  'ur.si': { family: 'ur.si', name: 'GE UR standard inverse',    k: 0.14,   c: 0,      alpha: 0.02, dial: 'iec', t_r: null, type: 'dependent', ref: 'UR-series T60 IM (IEC SI)' },
};

/* ------------------------------------------------------------------ */
/* ABB -- Relion 615/620/630 platform (modern)                         */
/*                                                                     */
/* RI / RD are NOT IDMT. They are evaluated as                         */
/*   RI (linear): t = a - b * M                                        */
/*   RD (log):    t = a - b * ln(M)                                    */
/* and are kept separate from the IEC 60255-151 set; the linter warns  */
/* on mixing RI/RD with IDMT in the same grading pair.                 */
/* ------------------------------------------------------------------ */

const abb: CurveTable = {
  /* RI is hyperbolic: `t = tms / (0.339 - 0.236/M)`. It falls from
   * ~9.7*tms at pickup towards an asymptote of ~2.95*tms, so it never
   * reaches zero. It previously carried RD's constants in a linear
   * form and so operated in 0.000 s above M ~ 4.3. */
  ri: { family: 'ri', name: 'ABB RI-type (inverse)',     form: 'ri',  a: 0.339, b: 0.236, k: 0, c: 0, alpha: 0, dial: 'iec', t_r: null, ref: 'ABB RI (ASEA) inverse-time characteristic' },
  rd: { family: 'rd', name: 'ABB RD-type (logarithmic)', form: 'log',    a: 5.8, b: 1.35, k: 0, c: 0, alpha: 0, dial: 'iec', t_r: null, ref: 'Relion 615 IM, RD-type' },
};

/* ------------------------------------------------------------------ */
/* Schneider -- Sepam / MiCOM family                                   */
/*                                                                     */
/* Not tabulated in the spec's normative section; retained because the */
/* `schneider` namespace is listed as processor-known in              */
/* _Extensibility and user-defined curves_. The three entries are the  */
/* vendor's IEC 60255-151 aliases and carry identical constants.       */
/* ------------------------------------------------------------------ */

const schneider: CurveTable = {
  sit: { family: 'sit', name: 'Schneider SIT (standard inverse)',  k: 0.14, c: 0, alpha: 0.02, dial: 'iec', t_r: null, type: 'dependent', ref: 'Sepam/MiCOM IEC SI alias' },
  vit: { family: 'vit', name: 'Schneider VIT (very inverse)',      k: 13.5, c: 0, alpha: 1.0,  dial: 'iec', t_r: null, type: 'dependent', ref: 'Sepam/MiCOM IEC VI alias' },
  eit: { family: 'eit', name: 'Schneider EIT (extremely inverse)', k: 80,   c: 0, alpha: 2.0,  dial: 'iec', t_r: null, type: 'dependent', ref: 'Sepam/MiCOM IEC EI alias' },
};

/* ------------------------------------------------------------------ */
/* Combined registry                                                   */
/* ------------------------------------------------------------------ */

export const CURVES: Record<string, CurveTable> = {
  iec, ansi, sel, siemens, ge, abb, schneider,
};

/** Default ceiling multiple at which dependent time ends (IEC 60255-151). */
export const DEFAULT_G_D = 20;

/**
 * TMS ranges used by the validator. IEC curves accept
 * `0.025 <= tms <= 1.5`; ANSI curves accept `0.5 <= tms <= 15`.
 */
export const TMS_RANGE_IEC = { min: 0.025, max: 1.5, step: 0.025 } as const;
export const TMS_RANGE_ANSI = { min: 0.5, max: 15, step: 0.05 } as const;

/**
 * The dial range a curve is set in.
 *
 * Looked up on the curve, not on the namespace it is filed under. The
 * namespace is a vendor and vendors ship both dials -- `ge.ur.mi` is
 * C37.112 (time dial 0.5 .. 15) and `ge.ur.si` is IEC (TMS
 * 0.025 .. 1.5), in the same table under the same name.
 *
 * An unknown id falls back to IEC, which is what the validator wants:
 * the curve itself is already `CURVE_UNKNOWN`, and a second complaint
 * about a dial range for a curve that does not exist would send the
 * reader after the wrong thing.
 */
export function tmsRangeFor(curveId: string): typeof TMS_RANGE_IEC | typeof TMS_RANGE_ANSI {
  const known = isKnownCurveId(curveId);
  const constants = known ? lookupCurve(known.ns, known.family) : undefined;
  return constants?.dial === 'ansi' ? TMS_RANGE_ANSI : TMS_RANGE_IEC;
}

export function lookupCurve(namespace: string, family: string): CurveConstants | undefined {
  return CURVES[namespace]?.[family];
}

export function isKnownCurveId(id: string): { ns: string; family: string } | undefined {
  const ix = id.indexOf('.');
  if (ix < 0) return undefined;
  const ns = id.slice(0, ix);
  const family = id.slice(ix + 1);
  return lookupCurve(ns, family) ? { ns, family } : undefined;
}

/** Every `namespace.family` identifier the processor accepts. */
export function allCurveIds(): string[] {
  const out: string[] = [];
  for (const [ns, table] of Object.entries(CURVES)) {
    for (const family of Object.keys(table)) out.push(`${ns}.${family}`);
  }
  return out.sort();
}

/**
 * Closest known curve id within a Levenshtein distance of `maxDistance`,
 * used by the validator's "did you mean" suggestion.
 */
export function suggestCurveId(id: string, maxDistance = 2): string | undefined {
  let best: string | undefined;
  let bestD = maxDistance + 1;
  for (const candidate of allCurveIds()) {
    const d = levenshtein(id.toLowerCase(), candidate.toLowerCase());
    if (d < bestD) { bestD = d; best = candidate; }
  }
  return bestD <= maxDistance ? best : undefined;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}
