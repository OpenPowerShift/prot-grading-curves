/**
 * Semantic validation.
 *
 * Implements the rules in `spec/sections/validation.adoc`. These are
 * the checks that need a *resolved* study -- cross-references, unit
 * conversions, curve-table lookups -- as opposed to the shape errors
 * the parser already reports.
 *
 * Every finding carries a stable `code` so the editor's lint gutter,
 * the CLI's exit status, and the conformance suite can all key off the
 * same identifier. Findings are ordered by source position.
 */

import type { Document, SourceLocation } from '../parser/ast.js';
import {
  isKnownCurveId,
  suggestCurveId,
  tmsRangeFor,
  levenshtein,
} from '../constants/curves.js';
import { allElements, resolveRef, type Element, type Stage, type Study } from './model.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  line: number;
  column: number;
  offset: number;
  length: number;
}

interface Ctx {
  study: Study;
  out: Diagnostic[];
}

const NOWHERE: SourceLocation = { line: 1, column: 1, offset: 0 };

function add(
  ctx: Ctx,
  code: string,
  severity: Severity,
  message: string,
  loc: SourceLocation | undefined,
  length = 1,
): void {
  const at = loc ?? NOWHERE;
  ctx.out.push({
    code,
    severity,
    message,
    line: at.line,
    column: at.column,
    offset: at.offset,
    length,
  });
}

/** Closest match among a set of declared names, for "did you mean". */
function suggest(name: string, candidates: Iterable<string>, maxDistance = 2): string | undefined {
  let best: string | undefined;
  let bestD = maxDistance + 1;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxDistance ? best : undefined;
}

const didYouMean = (s: string | undefined): string => (s ? ` -- did you mean "${s}"?` : '');

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function validate(study: Study): Diagnostic[] {
  const ctx: Ctx = { study, out: [] };

  validateVoltages(ctx);
  validateFaults(ctx);
  validateElements(ctx);
  validateDevices(ctx);
  validateCombines(ctx);
  validateGrades(ctx);
  validatePoints(ctx);
  validateView(ctx);
  validatePage(ctx);

  return ctx.out.sort((a, b) => a.offset - b.offset || a.code.localeCompare(b.code));
}

/** Convenience: parse-tree to diagnostics in one call. */
export function validateDocument(doc: Document, study: Study): Diagnostic[] {
  void doc;
  return validate(study);
}

/* ------------------------------------------------------------------ */
/* Voltage levels                                                      */
/* ------------------------------------------------------------------ */

function validateVoltages(ctx: Ctx): void {
  const { study } = ctx;
  const names = [...study.voltages.keys()];

  for (const level of study.voltages.values()) {
    if (!(level.kV > 0)) {
      add(ctx, 'VOLTAGE_LEVEL_INVALID', 'error',
        `voltage level "${level.name}" has kV = ${level.kV}; it must be strictly positive`,
        undefined);
    }
  }

  for (const relay of study.relays.values()) {
    if (relay.voltage && !study.voltages.has(relay.voltage)) {
      add(ctx, 'VOLTAGE_UNKNOWN', 'error',
        `relay ${relay.id} references voltage level "${relay.voltage}", which is not declared in system.voltages` +
        didYouMean(suggest(relay.voltage, names)),
        undefined);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Faults                                                              */
/* ------------------------------------------------------------------ */

function validateFaults(ctx: Ctx): void {
  const { study } = ctx;
  const names = [...study.voltages.keys()];

  for (const fault of study.faults.values()) {
    if (fault.voltage && !study.voltages.has(fault.voltage)) {
      add(ctx, 'VOLTAGE_UNKNOWN', 'error',
        `fault "${fault.name}" references voltage level "${fault.voltage}", which is not declared in system.voltages` +
        didYouMean(suggest(fault.voltage, names)),
        undefined);
    }
    if (!(fault.I_A > 0)) {
      add(ctx, 'FAULT_CURRENT_INVALID', 'error',
        `fault "${fault.name}" declares I_A = ${fault.I_A}; it must be strictly positive`,
        undefined);
    }
    if (fault.min_A === fault.I_A && fault.max_A === fault.I_A) {
      add(ctx, 'FAULT_SINGLE_POINT', 'info',
        `fault "${fault.name}" declares only I_A; min_A and max_A default to it`,
        undefined);
    }
    if (fault.min_A > fault.max_A) {
      add(ctx, 'FAULT_RANGE_INVERTED', 'error',
        `fault "${fault.name}" has min_A (${fault.min_A}) above max_A (${fault.max_A})`,
        undefined);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Elements and stages                                                 */
/* ------------------------------------------------------------------ */

function memberKeys(host: { members: Array<{ kind: string; key?: string }> }): Set<string> {
  const out = new Set<string>();
  for (const m of host.members) if (m.kind === 'scalar' && m.key) out.add(m.key);
  return out;
}

function validateElements(ctx: Ctx): void {
  const { study } = ctx;

  for (const relay of study.relays.values()) {
    /* Duplicate-element double-trip: same pickup, tms and curve. */
    const seen = new Map<string, string>();
    for (const element of relay.elements) {
      for (const stage of element.stages) {
        const producer = stage.producer;
        const curveKey =
          producer?.kind === 'standard' ? producer.id
          : producer?.kind === 'formula' ? `formula:${producer.k}/${producer.c}/${producer.alpha}`
          : producer?.kind ?? 'none';
        const key = `${curveKey}|${stage.I_pu_A}|${stage.tms}`;
        if (curveKey === 'none' || stage.I_pu_A == null) continue;
        const prior = seen.get(key);
        if (prior && prior !== element.id) {
          add(ctx, 'DUPLICATE_ELEMENT', 'error',
            `relay ${relay.id} declares elements ${prior} and ${element.id} with the same ` +
            `(I_pu, tms, curve) -- they would double-trip identically`,
            element.node.loc, element.id.length);
        } else if (!prior) {
          seen.set(key, element.id);
        }
      }
    }

    for (const element of relay.elements) {
      validateElementShape(ctx, element, relay.ct_ratio, relay.id, relay.voltage_kV);
    }
  }

  for (const element of study.looseElements) {
    validateElementShape(ctx, element, undefined, undefined, undefined);
  }
}

function validateElementShape(
  ctx: Ctx,
  element: Element,
  ctRatio: number | undefined,
  relayId: string | undefined,
  relayKv: number | undefined,
): void {
  const keys = memberKeys(element.node);
  const hasShorthand = keys.has('curve') || keys.has('formula') || keys.has('flex_points');

  if (element.staged && hasShorthand) {
    add(ctx, 'ELEMENT_MIXED_FORMS', 'error',
      `element ${element.ref} mixes the shorthand curve form with a stages { ... } block; ` +
      'use one or the other',
      element.node.loc, element.id.length);
  }

  if (!element.staged && !hasShorthand && !keys.has('t_delay')) {
    add(ctx, 'ELEMENT_NO_CURVE', 'error',
      `element ${element.ref} defines neither a curve producer nor a stages { ... } block`,
      element.node.loc, element.id.length);
  }

  if (element.staged && element.stages.length === 0) {
    add(ctx, 'ELEMENT_EMPTY_STAGES', 'error',
      `element ${element.ref} declares an empty stages { ... } block`,
      element.node.loc, element.id.length);
  }

  for (const stage of element.stages) {
    validateStage(ctx, element, stage, ctRatio, relayId, relayKv);
  }
}

function validateStage(
  ctx: Ctx,
  element: Element,
  stage: Stage,
  ctRatio: number | undefined,
  relayId: string | undefined,
  relayKv: number | undefined,
): void {
  const where = element.staged ? `${element.ref} stage ${stage.id}` : element.ref;
  const loc = stage.node.loc;
  const keys = memberKeys(stage.node);

  /* ---- curve identifier ------------------------------------------ */
  const rawCurve = rawCurveId(stage);
  if (rawCurve && rawCurve !== 'definite' && !isKnownCurveId(rawCurve)) {
    add(ctx, 'CURVE_UNKNOWN', 'error',
      `${where} declares curve = ${rawCurve}, which is not in the constants table` +
      didYouMean(suggestCurveId(rawCurve)),
      loc, rawCurve.length);
  }

  /* ---- stage / definite-time consistency ------------------------- */
  if (!stage.producer) {
    add(ctx, 'STAGE_NO_CURVE', 'error',
      `${where} has no curve, formula, flex_points, or definite-time delay`,
      loc);
  }
  if (stage.producer?.kind === 'definite' && keys.has('tms')) {
    add(ctx, 'DEFINITE_WITH_TMS', 'error',
      `${where} mixes curve = definite with tms; a definite-time stage has no time multiplier`,
      loc);
  }
  if (stage.producer?.kind === 'definite' && stage.t_delay_s == null && !keys.has('t_delay')) {
    add(ctx, 'DEFINITE_NO_DELAY', 'warning',
      `${where} is definite-time but declares no t_delay; it is treated as t = 0 s above pickup`,
      loc);
  }

  /* ---- pickup ----------------------------------------------------- */
  if (stage.I_pu_declared != null && !(stage.I_pu_declared > 0)) {
    add(ctx, 'PICKUP_NOT_POSITIVE', 'error',
      `${where} declares I_pu = ${stage.I_pu_declared}; it must be strictly positive`,
      loc);
  }
  if (stage.I_units === 'secondary' && ctRatio == null) {
    add(ctx, 'CT_RATIO_MISSING', 'error',
      `${where} declares I_units = "secondary" but relay ${relayId ?? '?'} has no ct_ratio ` +
      'to convert the pickup to primary amps',
      loc);
  }

  /*
   * Pickup plausibility against the voltage base -- catches the common
   * `720 A` where `7.20 kA` was meant.
   */
  if (
    stage.I_pu_A != null && relayKv != null && ctx.study.base_MVA != null &&
    relayKv > 0 && ctx.study.base_MVA > 0
  ) {
    const I_base = (ctx.study.base_MVA * 1e6) / (relayKv * 1e3 * Math.sqrt(3));
    if (stage.I_pu_A < 0.05 * I_base) {
      add(ctx, 'PICKUP_TOO_LOW_FOR_VOLTAGE', 'warning',
        `${where} pickup ${stage.I_pu_A.toFixed(0)} A is below 5% of the ${relayKv} kV base ` +
        `current (${I_base.toFixed(0)} A) -- check the unit suffix`,
        loc);
    }
  }

  /* ---- tms -------------------------------------------------------- */
  if (stage.tms != null && stage.producer && stage.producer.kind !== 'definite') {
    const curveId = stage.producer.kind === 'standard' ? stage.producer.id : undefined;
    const range = tmsRangeFor(curveId ?? 'iec.si');
    if (stage.tms < range.min || stage.tms > range.max) {
      add(ctx, 'TMS_OUT_OF_RANGE', 'error',
        `${where} declares tms = ${stage.tms}, outside the valid range ` +
        `[${range.min}, ${range.max}] for ${curveId ? `${curveId} ` : ''}curves`,
        loc);
    }
  }

  /* ---- flex points ------------------------------------------------ */
  if (stage.producer?.kind === 'flex') {
    const pts = stage.producer.points;
    if (pts.length < 2) {
      add(ctx, 'FLEX_TOO_FEW_POINTS', 'error',
        `${where} declares flex_points with ${pts.length} entry; at least 2 are required`,
        loc);
    }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].I_A === pts[i - 1].I_A) {
        add(ctx, 'FLEX_NOT_MONOTONE', 'error',
          `${where} declares flex_points with a repeated current (${pts[i].I_A} A); ` +
          'the table must be strictly increasing in I',
          loc);
        break;
      }
    }
    if (pts.some((p) => !(p.t_s > 0))) {
      add(ctx, 'FLEX_TIME_NOT_POSITIVE', 'warning',
        `${where} declares a flex_points entry with a non-positive time; ` +
        'log-log interpolation falls back to linear across that segment',
        loc);
    }
  }

  /* ---- formula ---------------------------------------------------- */
  if (stage.producer?.kind === 'formula') {
    const { k, c, alpha } = stage.producer;
    if (!(k > 0)) {
      add(ctx, 'FORMULA_K_INVALID', 'error',
        `${where} declares formula k = ${k}; k must be strictly positive`, loc);
    }
    if (!(alpha >= 0 && alpha <= 5)) {
      add(ctx, 'FORMULA_ALPHA_INVALID', 'error',
        `${where} declares formula alpha = ${alpha}; the accepted range is [0, 5]`, loc);
    }
    if (!(c >= 0)) {
      add(ctx, 'FORMULA_C_INVALID', 'error',
        `${where} declares formula c = ${c}; c must be zero or positive`, loc);
    }
  }

  /* ---- reset ------------------------------------------------------ */
  if (stage.reset === 'dependent' && stage.producer?.kind === 'standard') {
    const t_r = stage.producer.constants.t_r;
    if (t_r == null) {
      add(ctx, 'RESET_NO_TR', 'error',
        `${where} declares reset = "dependent" but ${stage.producer.id} has no published ` +
        'reset constant; use "instant", or "disk_emulation" with an explicit t_reset',
        loc);
    }
  }
  if (stage.reset === 'disk_emulation' && stage.t_reset_s == null &&
      stage.producer?.kind === 'standard' && stage.producer.constants.t_r == null) {
    add(ctx, 'RESET_NO_TR', 'error',
      `${where} declares reset = "disk_emulation" without an explicit t_reset, and ` +
      `${stage.producer.id} has no published reset constant`,
      loc);
  }

  /* ---- current share ---------------------------------------------- */
  if (!(stage.current_pct > 0 && stage.current_pct <= 100)) {
    add(ctx, 'CURRENT_PCT_OUT_OF_RANGE', 'error',
      `${where} declares current_pct = ${stage.current_pct}; the accepted range is (0, 100]`,
      loc);
  }
}

/** The `curve = ...` identifier exactly as written, before resolution. */
function rawCurveId(stage: Stage): string | undefined {
  for (const m of stage.node.members) {
    if (m.kind === 'scalar' && m.key === 'curve') {
      return typeof m.value === 'string' ? m.value : undefined;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

function validateDevices(ctx: Ctx): void {
  for (const device of ctx.study.devices.values()) {
    const isFuse = device.kind === 'fuse';
    const isBreaker = device.kind === 'breaker';
    const hasBand = device.min_melt != null && device.total_clear != null;
    const hasTable = device.flex_points != null;

    if (!device.kind) {
      add(ctx, 'DEVICE_NO_KIND', 'error',
        `device "${device.id}" declares no kind; the catalog fallback needs one`, undefined);
    }
    if (isBreaker) {
      if (device.t_delay_s == null && !hasTable) {
        add(ctx, 'DEVICE_NO_CURVE', 'error',
          `breaker device "${device.id}" declares neither t_delay nor flex_points`, undefined);
      }
      continue;
    }
    if (isFuse && !hasBand && !hasTable) {
      add(ctx, 'DEVICE_NO_CURVE', 'error',
        `fuse device "${device.id}" declares neither a min_melt/total_clear band nor flex_points`,
        undefined);
    } else if (!isFuse && !hasTable && !hasBand) {
      add(ctx, 'DEVICE_NO_CURVE', 'error',
        `device "${device.id}" declares no flex_points; device TCCs are piecewise by definition`,
        undefined);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Combines                                                            */
/* ------------------------------------------------------------------ */

function validateCombines(ctx: Ctx): void {
  const { study } = ctx;
  const synthetic = new Set(study.combines.map((c) => c.name));

  for (const combine of study.combines) {
    if (combine.sources.length === 0) {
      add(ctx, 'COMBINE_NO_SOURCES', 'error',
        `combine "${combine.name}" declares an empty sources list`, undefined);
      continue;
    }
    for (const ref of combine.sources) {
      const name = ref.text;
      if (synthetic.has(name)) {
        add(ctx, 'COMBINE_CHAINED', 'error',
          `combine "${combine.name}" references synthetic curve "${name}"; ` +
          'combines cannot be chained',
          undefined);
        continue;
      }
      const { element, device } = resolveRef(study, ref);
      if (!element && !device) {
        add(ctx, 'UNRESOLVED_REFERENCE', 'error',
          `combine "${combine.name}" references "${name}", which is not a declared ` +
          'relay element or device',
          undefined);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Grades                                                              */
/* ------------------------------------------------------------------ */

function validateGrades(ctx: Ctx): void {
  const { study } = ctx;
  const synthetic = new Set(study.combines.map((c) => c.name));
  const faultNames = [...study.faults.keys()];
  const pairs = new Set<string>();

  for (const grade of study.grades) {
    const loc = grade.node.loc;

    for (const [role, ref] of [['primary', grade.primary], ['backup', grade.backup]] as const) {
      if (!ref) {
        add(ctx, 'GRADE_MISSING_SIDE', 'error',
          `grade block declares no ${role}`, loc);
        continue;
      }
      if (synthetic.has(ref.text)) {
        add(ctx, 'GRADE_ON_COMBINE', 'error',
          `grade ${role} "${ref.text}" is a synthetic combine curve; combines cannot be graded`,
          loc, ref.text.length);
        continue;
      }
      const { element, device } = resolveRef(study, ref);
      if (!element && !device) {
        const candidates = [
          ...allElements(study).map((e) => e.ref),
          ...study.devices.keys(),
        ];
        add(ctx, 'UNRESOLVED_REFERENCE', 'error',
          `grade ${role} "${ref.text}" does not resolve to a relay element or device` +
          didYouMean(suggest(ref.text, candidates)),
          loc, ref.text.length);
      }
    }

    if (grade.primary && grade.backup) {
      /*
       * Keyed on the *fault* as well as the pair. Grading one pair at
       * several fault levels -- maximum and minimum, or a bus fault
       * and a remote one -- is normal practice and produces a row per
       * check. Only a genuinely repeated check is a duplicate.
       */
      const key = `${grade.primary.text}|${grade.backup.text}|${grade.fault ?? ''}`;
      if (pairs.has(key)) {
        add(ctx, 'DUPLICATE_GRADE', 'error',
          `a grade block for ${grade.primary.text} / ${grade.backup.text}` +
          `${grade.fault ? ` at ${grade.fault}` : ''} is already declared`,
          loc);
      }
      pairs.add(key);
    }

    if (!grade.fault) {
      add(ctx, 'FAULT_OPTIONAL_NO_GRADE_CHECK', 'warning',
        'grade block declares no fault; the curves render but no margin is computed', loc);
    } else if (!study.faults.has(grade.fault)) {
      add(ctx, 'UNRESOLVED_REFERENCE', 'error',
        `grade references fault "${grade.fault}", which is not declared in faults { ... }` +
        didYouMean(suggest(grade.fault, faultNames)),
        loc, grade.fault.length);
    }

    if (grade.margin_s != null && grade.CTI_min_s != null && grade.margin_s < grade.CTI_min_s) {
      add(ctx, 'MARGIN_BELOW_CTI', 'error',
        `grade declares margin_s = ${grade.margin_s} s below CTI_min_s = ${grade.CTI_min_s} s; ` +
        'the design target asks for less margin than the constraint allows',
        loc);
    }

    if (grade.upstream_to_A != null && !(grade.upstream_to_A > 0)) {
      add(ctx, 'UPSTREAM_TO_INVALID', 'error',
        `grade declares upstream_to = ${grade.upstream_to_A}; it must be a positive current`,
        loc);
    }
    if (grade.upstream === false && grade.upstream_to_A != null) {
      add(ctx, 'UPSTREAM_DISABLED_WITH_CEILING', 'warning',
        'grade declares upstream_to together with upstream = false; the ceiling is ignored',
        loc);
    }
    if ((grade.upstream || grade.upstream_to_A != null) && grade.CTI_min_s == null) {
      add(ctx, 'UPSTREAM_WITHOUT_CTI', 'warning',
        'the upstream sweep reports the tightest margin but has no CTI_min_s to judge it against',
        loc);
    }

    if (grade.margin_s != null && !grade.solve) {
      add(ctx, 'MARGIN_NO_SOLVE', 'warning',
        'margin_s is declared without a solve block; it is reported as a target only. ' +
        'Add solve { ... } to act on it, or use CTI_min_s for a constraint',
        loc);
    }

    if (grade.solve) {
      if (grade.margin_s == null && grade.CTI_min_s == null) {
        add(ctx, 'SOLVE_WITHOUT_TARGET', 'error',
          'solve block declared with neither margin_s nor CTI_min_s; the solver has no target',
          loc);
      }
      const tol = grade.solve.tolerance_pct;
      if (tol != null && (tol < 0 || tol > 50)) {
        add(ctx, 'TOLERANCE_OUT_OF_RANGE', 'error',
          `solve declares tolerance_pct = ${tol}; the accepted range is [0, 50]`, loc);
      }
      for (const free of grade.solve.free) {
        if (free !== 'tms' && free !== 't_delay' && free !== 'I_pu') {
          add(ctx, 'SOLVE_FREE_UNKNOWN', 'error',
            `solve declares free variable "${free}"; accepted values are tms, t_delay, I_pu`, loc);
        }
      }
      const backupEl = resolveRef(study, grade.backup).element;
      if (backupEl?.staged && grade.solve.free.length > 1) {
        add(ctx, 'MULTISTAGE_MULTIVAR_SOLVE', 'warning',
          `backup ${backupEl.ref} is multi-stage; solving more than one free variable is ` +
          'deferred to v0.2, so only tms is adjusted',
          loc);
      }
    }

    /* Cross-voltage sanity: a grade spanning levels needs both. */
    const p = resolveRef(study, grade.primary).element;
    const b = resolveRef(study, grade.backup).element;
    if (p && b && p.voltage && b.voltage && p.voltage !== b.voltage) {
      if (p.voltage_kV == null || b.voltage_kV == null) {
        add(ctx, 'VOLTAGE_RATIO_UNRESOLVED', 'error',
          `grade ${p.ref} / ${b.ref} spans voltage levels "${p.voltage}" and "${b.voltage}", ` +
          'but at least one has no declared kV',
          loc);
      }
    }
    if (p && !p.voltage && b?.voltage) {
      add(ctx, 'RELAY_VOLTAGE_UNSPECIFIED', 'warning',
        `relay ${p.relayId ?? p.ref} declares no voltage but is graded against ` +
        `${b.ref} on "${b.voltage}"`,
        loc);
    }
  }
}

/* ------------------------------------------------------------------ */
/* View and page                                                       */
/* ------------------------------------------------------------------ */

function validatePoints(ctx: Ctx): void {
  const names = [...ctx.study.voltages.keys()];
  const seen = new Set<string>();

  for (const point of ctx.study.points) {
    if (seen.has(point.id)) {
      add(ctx, 'DUPLICATE_POINT', 'error',
        `point "${point.id}" is declared more than once`, undefined);
    }
    seen.add(point.id);

    if (!(point.I_A > 0)) {
      add(ctx, 'POINT_CURRENT_INVALID', 'error',
        `point "${point.id}" declares I_A = ${point.I_A}; it must be strictly positive`,
        undefined);
    }
    if (!(point.t_s > 0)) {
      add(ctx, 'POINT_TIME_INVALID', 'error',
        `point "${point.id}" declares t_s = ${point.t_s}; it must be strictly positive`,
        undefined);
    }
    if (point.voltage && !ctx.study.voltages.has(point.voltage)) {
      add(ctx, 'VOLTAGE_UNKNOWN', 'error',
        `point "${point.id}" references voltage level "${point.voltage}", which is not declared` +
        didYouMean(suggest(point.voltage, names)),
        undefined);
    }
  }
}

function validateView(ctx: Ctx): void {
  const view = ctx.study.view;
  if (!view) return;

  if (view.two_axes === true && view.axis === 'multiples') {
    add(ctx, 'TWO_AXES_WITH_MULTIPLES', 'error',
      'view declares two_axes = true with axis = "multiples"; the second axis has no meaning ' +
      'in multiples mode',
      view.loc);
  }
  if (view.current_min != null && view.current_max != null && view.current_min >= view.current_max) {
    add(ctx, 'VIEW_RANGE_INVERTED', 'error',
      `view declares current_min (${view.current_min}) at or above current_max (${view.current_max})`,
      view.loc);
  }
  if (view.time_min != null && view.time_max != null && view.time_min >= view.time_max) {
    add(ctx, 'VIEW_RANGE_INVERTED', 'error',
      `view declares time_min (${view.time_min}) at or above time_max (${view.time_max})`,
      view.loc);
  }

  /* A wide CT spread makes a single secondary axis unreadable. */
  if (view.axis === 'secondary') {
    const ratios = [...ctx.study.relays.values()]
      .map((r) => r.ct_ratio)
      .filter((r): r is number => r != null && r > 0);
    if (ratios.length > 1) {
      const spread = Math.max(...ratios) / Math.min(...ratios);
      if (spread > 5) {
        add(ctx, 'CT_SPREAD_WIDE', 'warning',
          `CT ratios in this study span ${spread.toFixed(1)}:1; a single secondary axis will be ` +
          'hard to read -- consider axis = "multiples"',
          view.loc);
      }
    }
  }
}

const PAPER_SIZES = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'];

function validatePage(ctx: Ctx): void {
  const page = ctx.study.page;
  if (!page) return;

  if (typeof page.size === 'string') {
    if (!PAPER_SIZES.some((s) => s.toLowerCase() === page.size!.toString().toLowerCase())) {
      add(ctx, 'PAGE_SIZE_UNKNOWN', 'error',
        `page declares size = "${page.size}"; valid keywords are ${PAPER_SIZES.join(', ')}`,
        page.loc);
    }
  } else if (page.size && typeof page.size === 'object') {
    const { width_mm, height_mm } = page.size;
    if (width_mm == null || height_mm == null) {
      add(ctx, 'PAGE_SIZE_INCOMPLETE', 'error',
        'page declares a custom size with only one of width_mm / height_mm', page.loc);
    }
  }

  if (page.margins_mm) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const v = page.margins_mm[side];
      if (v != null && v < 0) {
        add(ctx, 'PAGE_MARGIN_NEGATIVE', 'error',
          `page declares a negative ${side} margin (${v} mm)`, page.loc);
      }
    }
  }

  const scale = page.scale;
  if (scale && scale.auto === false) {
    if (scale.x_min != null && scale.x_max != null && scale.x_min >= scale.x_max) {
      add(ctx, 'PAGE_SCALE_INVERTED', 'error',
        `page scale declares x_min (${scale.x_min}) at or above x_max (${scale.x_max})`, page.loc);
    }
    if (scale.y_min != null && scale.y_max != null && scale.y_min >= scale.y_max) {
      add(ctx, 'PAGE_SCALE_INVERTED', 'error',
        `page scale declares y_min (${scale.y_min}) at or above y_max (${scale.y_max})`, page.loc);
    }
  }

  if (page.watermark && String(ctx.study.meta.study ?? '').toLowerCase() === 'final') {
    add(ctx, 'WATERMARK_ON_FINAL', 'warning',
      `page carries the watermark "${page.watermark}" while meta.study is "final"; ` +
      'the export risks being mis-archived',
      page.loc);
  }
}
