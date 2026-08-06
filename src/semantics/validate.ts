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

import type { AnnotateBlock, Document, Ref, SourceLocation } from '../parser/ast.js';
import {
  isKnownCurveId,
  suggestCurveId,
  tmsRangeFor,
  levenshtein,
} from '../constants/curves.js';
import { isFaultType } from '../constants/sequence.js';
import {
  allElements, isCurveStyle, resolveRef,
  type Device, type Element, type Stage, type Study,
} from './model.js';
import {
  MEASURED_QUANTITIES,
  currentFor,
  elementQuantity,
  isMeasuredQuantity,
  measuredQuantityOf,
  quantityField,
  quantityLabel,
  resolveCurrent,
  type MeasuredQuantity,
} from './quantity.js';
import { conditionNames, resolveCondition } from './condition.js';
import { FIELD_QUANTITY, KNOWN_UNITS, suffixFits, suffixesFor } from './units.js';
/*
 * The editor's value tables, read here so the values offered and the
 * values accepted are the same list. `help-data` is pure data with no
 * editor dependency of its own.
 */
import { FIELD_VALUES } from '../help/help-data.js';

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
  /**
   * The source document, where one is available.
   *
   * The resolved study keys its faults and scenarios by name, so a
   * repeated declaration is already gone by the time it is inspected.
   * Only the document still holds both.
   */
  doc?: Document;
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

export function validate(study: Study, doc?: Document): Diagnostic[] {
  const ctx: Ctx = { study, out: [], doc };

  validateVoltages(ctx);
  validateFaults(ctx);
  validateScenarios(ctx);
  validateElements(ctx);
  validateDevices(ctx);
  validateCombines(ctx);
  validateGrades(ctx);
  validateUnits(ctx);
  validateTimes(ctx);
  validateAnnotations(ctx);
  validatePoints(ctx);
  validateView(ctx);
  validatePage(ctx);
  validateStageRefs(ctx);
  validateTimeMultipliers(ctx);
  validateViewScopes(ctx);

  return ctx.out.sort((a, b) => a.offset - b.offset || a.code.localeCompare(b.code));
}

/* ------------------------------------------------------------------ */
/* Sheet scoping                                                       */
/* ------------------------------------------------------------------ */

/**
 * A `views` entry naming no declared sheet.
 *
 * `views` is an *include* list, so a name that matches nothing removes
 * the thing from every sheet -- and did so in silence. A curve scoped
 * to a misspelt sheet simply was not drawn anywhere, on a study whose
 * author had every reason to think they had said where it belonged.
 *
 * Checked for everything that can be scoped, in one pass, so a new
 * drawable block cannot forget it.
 */
function validateViewScopes(ctx: Ctx): void {
  const { study } = ctx;
  const declared = new Set<string>();
  for (const [i, v] of study.views.entries()) {
    declared.add(v.id ?? v.name ?? String(i + 1));
    if (v.name) declared.add(v.name);
  }
  /* A study with no `view` block draws one default sheet, which
   * nothing can name -- so scoping is meaningless rather than wrong,
   * and saying so once is the `views` key's own problem. */
  if (study.views.length === 0) return;

  const check = (views: string[] | undefined, what: string, loc?: SourceLocation): void => {
    for (const name of views ?? []) {
      if (declared.has(name)) continue;
      add(ctx, 'UNRESOLVED_VIEW', 'error',
        `${what} is scoped to view ${name}, which is not declared; `
        + `it would be drawn on no sheet at all. Declared: `
        + [...declared].map((d) => d).join(', ')
        + didYouMean(suggest(name, declared)),
        loc, name.length);
    }
  };

  for (const relay of study.relays.values()) {
    for (const element of relay.elements) check(element.views, `element ${element.ref}`);
  }
  for (const element of study.looseElements) check(element.views, `element ${element.ref}`);
  for (const t of study.times.values()) check(t.views, `time ${t.id}`);
  for (const f of study.faults.values()) check(f.views, `fault ${f.id}`);
  for (const sc of study.scenarios.values()) check(sc.views, `scenario ${sc.id}`);

  /*
   * A nested block that also names a scope.
   *
   * It is already scoped by where it sits, so the `views` or `group`
   * beside it is dead text -- and dead text that looks load-bearing is
   * worse than none. Refused rather than merged: honouring both would
   * need a precedence rule between two ways of saying the same thing.
   */
  for (const item of ctx.doc?.items ?? []) {
    if (item.type !== 'view' || !item.nested?.length) continue;
    for (const block of item.nested) {
      const entries: Array<{ views?: string[]; group?: string }> =
        block.type === 'times' ? block.times : [block as { views?: string[] }];
      for (const entry of entries) {
        if (!entry.views?.length && !entry.group) continue;
        add(ctx, 'NESTED_BLOCK_SCOPED', 'error',
          `a ${block.type} declared inside view ${item.id ?? item.name ?? '(unnamed)'} `
          + 'also names a scope; it is already scoped by where it sits. Remove the '
          + 'views/group, or move the block to the top level',
          block.loc);
      }
    }
  }

  /*
   * A sheet naming a chain that does not exist would draw nothing at
   * all -- the group resolves to an empty set of relays, and every
   * curve is filtered out. Silent, and indistinguishable from a study
   * whose relays are all misconfigured.
   */
  for (const v of study.views) {
    if (!v.group) continue;
    if (study.groups.has(v.group)) continue;
    const known = [...study.groups.keys()];
    add(ctx, 'UNRESOLVED_GROUP', 'error',
      `view ${v.id ?? v.name ?? '(unnamed)'} draws group ${v.group}, which is not `
      + `declared; the sheet would carry no curves at all. Declared: `
      + (known.length > 0 ? known.join(', ') : 'none')
      + didYouMean(suggest(v.group, known)),
      v.loc);
  }

  /* A group naming a relay that does not exist quietly shrinks every
   * sheet that draws it. */
  for (const g of study.groups.values()) {
    for (const member of g.members) {
      if (study.relays.has(member)) continue;
      if (study.devices.has(member)) continue;
      add(ctx, 'UNRESOLVED_GROUP_MEMBER', 'error',
        `group ${g.id} lists ${member}, which is not a declared relay or device`
        + didYouMean(suggest(member, [...study.relays.keys(), ...study.devices.keys()])),
        undefined);
    }
  }
  for (const p of study.points) check(p.views, `point ${p.id}`);
  for (const a of study.annotations) check(a.views, `annotation "${a.label ?? '(unlabelled)'}"`);
}

/* ------------------------------------------------------------------ */
/* Time multipliers                                                    */
/* ------------------------------------------------------------------ */

/**
 * An inverse-time curve with no time multiplier.
 *
 * `tms` was defaulting to 1 and saying nothing. On an IEC standard
 * inverse that is roughly ten times a normal setting, so a study that
 * simply omitted it drew a curve an order of magnitude slow, graded
 * against it, and reported a comfortable margin. The guide already
 * names the stakes -- it warns that mistyping `tms` as `tsm` leaves
 * "the margin out by a factor of ten" -- but that hazard was only
 * caught because the typo produced an unknown key. Omitting the
 * setting outright produced nothing at all.
 *
 * An error rather than a warning. There is no reading of a missing
 * time multiplier under which 1.0 is a good guess: a relay always has
 * one, and an author who means 1.0 can write it. The remedy is to type
 * the number the relay is set to.
 *
 * Three cases are not faults:
 *
 *   - a definite-time stage has no multiplier, and mixing the two is
 *     already refused elsewhere;
 *   - a `flex_points` table is absolute in amps and `tms` scales it,
 *     so omitting it means "the table as printed", which is an honest
 *     identity rather than a guess;
 *   - an element whose `tms` the solver is going to compute. That is
 *     the whole point of `solve { free = ["tms"] }`, and the figure it
 *     arrives at is reported.
 */
function validateTimeMultipliers(ctx: Ctx): void {
  const { study } = ctx;

  /*
   * Elements the solver will set. `free` defaults to `['tms']`, and
   * the backup is the side it adjusts.
   */
  const solved = new Set<string>();
  for (const grade of study.grades) {
    if (!grade.solve?.free.includes('tms')) continue;
    const backup = resolveRef(study, grade.backup).element;
    if (backup) solved.add(backup.ref);
  }

  for (const element of allElements(study)) {
    if (solved.has(element.ref)) continue;
    for (const stage of element.stages) {
      const kind = stage.producer?.kind;
      if (kind !== 'standard' && kind !== 'formula') continue;
      if (stage.tms != null) continue;

      const where = stage.id ? `${element.ref}/${stage.id}` : element.ref;
      const at = stage.node?.loc ?? element.node?.loc;
      add(ctx, 'TMS_MISSING', 'error',
        `${where} declares an inverse-time curve with no tms; it would be drawn and `
        + 'graded at 1.0, which on a standard inverse is about ten times a usual '
        + 'setting. Give the multiplier the relay is set to, or let a grade solve '
        + 'for it with solve { free = ["tms"]; }',
        at);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Piecewise tables                                                    */
/* ------------------------------------------------------------------ */

/**
 * A hand-entered time-current table.
 *
 * Shared by stages and by devices, because the failure is the same
 * wherever the table came from and only stages were being checked. A
 * device carries up to three tables -- `flex_points`, `min_melt`,
 * `total_clear` -- and none of them was looked at, so a fuse with a
 * repeated current or a one-row band validated clean. A fuse is the
 * thing most likely to be typed straight off a datasheet, so it is the
 * one that most needed checking.
 *
 * Row *order* is not checked, because `buildStudy` sorts every table by
 * current before anything sees it (`sortPoints`). A datasheet printed
 * highest-current-first can therefore be typed in as it is read. The
 * entries are a set and their order carries no meaning, so normalising
 * rather than refusing is right -- and it means the only ordering fault
 * left is a repeated current, which sorting cannot resolve.
 *
 * Whether that is a fault depends on what the table *is*. A curve that
 * answers "how long at this current?" -- a relay stage, a fuse melting
 * or clearing, a damage curve -- is multi-valued at a repeated current
 * and therefore wrong. An envelope that is drawn rather than evaluated
 * is not: a direct-on-line motor start is a vertical line at the
 * starting current, held from the accelerating time down to nothing,
 * and `examples/14` says so deliberately. `allowVertical` marks the
 * second kind, and it is the caller that knows which it has.
 */
function checkFlexTable(
  ctx: Ctx,
  pts: ReadonlyArray<{ I_A: number; t_s: number }>,
  where: string,
  field: string,
  loc: SourceLocation | undefined,
  allowVertical = false,
): void {
  if (pts.length < 2) {
    add(ctx, 'FLEX_TOO_FEW_POINTS', 'error',
      `${where} declares ${field} with ${pts.length} entry; at least 2 are required`,
      loc);
    return;
  }

  for (let i = 1; i < pts.length && !allowVertical; i++) {
    if (pts[i].I_A !== pts[i - 1].I_A) continue;
    add(ctx, 'FLEX_NOT_MONOTONE', 'error',
      `${where} declares ${field} with a repeated current (${pts[i].I_A} A); `
      + 'the table must be strictly increasing in current, and two times at one '
      + 'current leave the curve undefined there -- drop one row, or move it to '
      + 'the current it belongs at',
      loc);
    break;
  }

  if (pts.some((p) => !(p.t_s > 0))) {
    add(ctx, 'FLEX_TIME_NOT_POSITIVE', 'warning',
      `${where} declares a ${field} entry with a non-positive time; ` +
      'log-log interpolation falls back to linear across that segment',
      loc);
  }
}

/* ------------------------------------------------------------------ */
/* Stage references                                                    */
/* ------------------------------------------------------------------ */

/**
 * A reference naming a stage that does not exist.
 *
 * `resolveRef` falls back to the whole element when the stage name
 * matches nothing, which is the right behaviour -- grading nothing
 * because of a typo would be worse than grading the composite. But the
 * fallback has to be *said*, or the study quietly answers a different
 * question from the one it asked: `R_A:51/toc` mistyped as
 * `R_A:51/tocc` grades the high-set and reports a comfortable margin.
 *
 * Checked in one pass over every reference that can carry a stage --
 * grades, annotations and combines -- rather than at each site, so a
 * new directive taking a `Ref` cannot forget it.
 */
function validateStageRefs(ctx: Ctx): void {
  const study = ctx.study;

  const check = (ref: Ref | undefined, where: string): void => {
    if (!ref?.stageId) return;
    const { element } = resolveRef(study, ref);
    /* An unresolvable element is already reported by its own site. */
    if (!element) return;
    if (element.stages.some((st) => st.id === ref.stageId)) return;

    const names = element.stages.map((st) => st.id).filter(Boolean);
    add(ctx, 'UNRESOLVED_STAGE', 'error',
      `${where} references stage "${ref.stageId}" of ${element.ref}, which has no such `
      + `stage; it declares ${names.length > 0 ? names.map((n) => `"${n}"`).join(', ') : 'none'}`
      + didYouMean(suggest(ref.stageId, names)),
      ref.loc, ref.text.length);
  };

  for (const grade of study.grades) {
    check(grade.primary, 'grade primary');
    check(grade.backup, 'grade backup');
  }
  for (const a of study.annotations) {
    check(a.primary, 'annotate primary');
    check(a.backup, 'annotate backup');
    check(a.on_curve, 'annotate on_curve');
  }
  for (const c of study.combines) {
    for (const source of c.sources) check(source, `combine "${c.name}"`);
  }
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

/**
 * Scenario blocks.
 *
 * A scenario exists so that no sequence component has to be referred
 * across a transformer, so the checks are about the data being
 * complete and self-consistent at each level it declares.
 */
function validateScenarios(ctx: Ctx): void {
  const { study } = ctx;
  const names = [...study.voltages.keys()];

  /*
   * Scenarios are keyed by name, so a repeat replaced the first with
   * nothing said -- and which set of currents a grade was judged
   * against became a question of declaration order.
   */
  const declared = new Map<string, number>();
  for (const item of ctx.doc?.items ?? []) {
    if (item.type !== 'scenario') continue;
    const seen = declared.get(item.id);
    if (seen != null) {
      add(ctx, 'DUPLICATE_SCENARIO', 'error',
        `scenario ${item.id} is declared more than once (first at line ${seen}); ` +
        'the later declaration silently replaces the earlier',
        item.loc, item.id.length);
    } else {
      declared.set(item.id, item.loc?.line ?? 0);
    }
  }

  for (const scenario of study.scenarios.values()) {
    if (scenario.levels.size === 0) {
      add(ctx, 'SCENARIO_NO_LEVELS', 'error',
        `scenario "${scenario.name}" declares no level { ... } block, so no relay can be ` +
        'evaluated against it', scenario.loc);
      continue;
    }

    for (const level of scenario.levels.values()) {
      if (!level.voltage || !study.voltages.has(level.voltage)) {
        add(ctx, 'VOLTAGE_UNKNOWN', 'error',
          `scenario "${scenario.name}" declares a level "${level.voltage}" that is not in ` +
          `system.voltages (known: ${names.join(', ') || 'none'})`, level.loc);
      }

      /*
       * `earth_A` is the residual and `I0_A` its component, so one
       * implies the other. Declaring both differently means one of the
       * two figures is wrong and there is no way to tell which.
       */
      if (level.earth_A != null && level.I0_A != null) {
        const implied = level.I0_A * 3;
        const tolerance = Math.max(1e-6, Math.abs(implied) * 0.01);
        if (Math.abs(level.earth_A - implied) > tolerance) {
          add(ctx, 'SEQUENCE_RESIDUAL_CONFLICT', 'error',
            `scenario "${scenario.name}" level ${level.voltage} declares earth_A = ` +
            `${level.earth_A} A and I0_A = ${level.I0_A} A, but the residual is 3 x I0 ` +
            `(${implied} A); declare one or make them agree`, level.loc);
        }
      }

      for (const [field, value] of [
        ['I_A', level.I_A], ['I1_A', level.I1_A], ['I2_A', level.I2_A],
        ['I0_A', level.I0_A], ['earth_A', level.earth_A],
      ] as Array<[string, number | undefined]>) {
        if (value != null && (!Number.isFinite(value) || value < 0)) {
          add(ctx, 'FAULT_CURRENT_INVALID', 'error',
            `scenario "${scenario.name}" level ${level.voltage} declares ${field} = ${value}; ` +
            'a current must be finite and not negative', level.loc);
        }
      }
    }

    for (const [relayId, pct] of scenario.shares) {
      if (!study.relays.has(relayId)) {
        add(ctx, 'UNRESOLVED_REFERENCE', 'error',
          `scenario "${scenario.name}" gives a current share for relay ${relayId}, which is ` +
          'not declared', scenario.loc);
      }
      if (!(pct > 0) || pct > 100) {
        add(ctx, 'CURRENT_PCT_OUT_OF_RANGE', 'error',
          `scenario "${scenario.name}" gives relay ${relayId} a share of ${pct}%; it must be ` +
          'greater than 0 and at most 100', scenario.loc);
      }
    }
  }
}

function validateFaults(ctx: Ctx): void {
  const { study } = ctx;
  const names = [...study.voltages.keys()];

  /*
   * Faults are keyed by name, so a repeat replaced the first with
   * nothing said -- and since grading is pinned to a fault by name,
   * every margin referencing it silently changed with declaration
   * order.
   */
  const seen = new Map<string, number>();
  for (const item of ctx.doc?.items ?? []) {
    if (item.type !== 'faults') continue;
    for (const f of item.faults) {
      const first = seen.get(f.id);
      if (first != null) {
        add(ctx, 'DUPLICATE_FAULT', 'error',
          `fault ${f.id} is declared more than once (first at line ${first}); ` +
          'the later declaration silently replaces the earlier, changing every margin ' +
          'that references it',
          f.loc, f.id.length);
      } else {
        seen.set(f.id, f.loc?.line ?? 0);
      }
    }
  }

  for (const fault of study.faults.values()) {
    if (fault.voltage && !study.voltages.has(fault.voltage)) {
      add(ctx, 'VOLTAGE_UNKNOWN', 'error',
        `fault ${fault.id} references voltage level "${fault.voltage}", which is not declared in system.voltages` +
        didYouMean(suggest(fault.voltage, names)),
        undefined);
    }
    if (!(fault.I_A > 0)) {
      add(ctx, 'FAULT_CURRENT_INVALID', 'error',
        `fault ${fault.id} declares I_A = ${fault.I_A}; it must be strictly positive`,
        undefined);
    }
    if (fault.min_A === fault.I_A && fault.max_A === fault.I_A) {
      add(ctx, 'FAULT_SINGLE_POINT', 'info',
        `fault ${fault.id} declares only I_A; min_A and max_A default to it`,
        undefined);
    }
    if (fault.min_A > fault.max_A) {
      add(ctx, 'FAULT_RANGE_INVERTED', 'error',
        `fault ${fault.id} has min_A (${fault.min_A}) above max_A (${fault.max_A})`,
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

/**
 * A number written without its unit, inside an element or a stage.
 *
 * These members are stored as generic scalars and converted by the
 * model, so they never pass through the parser's unit check -- which
 * left the worst case of all uncovered: `t_delay = 50;` on an
 * instantaneous element meant fifty *seconds* where the author meant
 * fifty milliseconds, and the sheet drew it in silence.
 *
 * No key names its own unit, which was done so that the author states
 * it. This is what makes them.
 */
function checkUnitsOn(
  ctx: Ctx,
  node: { members: Array<{ kind: string; key?: string; value?: unknown }>; loc?: SourceLocation },
  what: string,
): void {
  for (const member of node.members) {
    if (member.kind !== 'scalar' || !member.key) continue;
    const quantity = FIELD_QUANTITY[member.key];
    if (quantity == null) continue;
    const value = member.value as { kind?: string; unit?: string } | undefined;
    if (value?.kind !== 'number' || value.unit != null) continue;
    add(ctx, 'UNIT_MISSING', 'error',
      `${what} declares "${member.key}" without a unit; write one of `
      + suffixesFor(quantity).map((k) => `"${k}"`).join(', ')
      + ' -- a bare number is read as the base unit, which for a trip time '
      + 'is the difference between milliseconds and seconds',
      node.loc);
  }
}

/**
 * The per-curve drawing overrides, which are dropped when unusable.
 *
 * A setting the tool cannot act on is worse here than elsewhere,
 * because the sheet still renders and looks deliberate: `style =
 * dashed_line` produces a solid curve that the source claims is
 * dashed, and nothing in the drawing says otherwise.
 */
function checkDrawingOn(
  ctx: Ctx,
  node: { members: Array<{ kind: string; key?: string; value?: unknown }>; loc?: SourceLocation },
  what: string,
): void {
  for (const member of node.members) {
    if (member.kind !== 'scalar' || !member.key) continue;

    if (member.key === 'style') {
      const value = typeof member.value === 'string' ? member.value : '';
      if (!isCurveStyle(value)) {
        add(ctx, 'CURVE_STYLE_INVALID', 'error',
          `${what} declares style = "${value}"; a curve is drawn solid, dashed or dotted`,
          node.loc);
      }
    }

    if (member.key === 'width_px') {
      const value = member.value as { kind?: string; value?: number } | undefined;
      const width = value?.kind === 'number' ? value.value : Number(member.value);
      if (!Number.isFinite(width) || (width as number) <= 0) {
        add(ctx, 'CURVE_WIDTH_INVALID', 'error',
          `${what} declares a width_px that is not a positive number`,
          node.loc);
      }
    }
  }
}

function validateElements(ctx: Ctx): void {
  const { study } = ctx;

  for (const relay of study.relays.values()) {
    /* Duplicate-element double-trip: same pickup, tms and curve. */
    const seen = new Map<string, string>();
    for (const element of relay.elements) {
      for (const stage of element.stages) {
        const producer = stage.producer;

        /*
         * A characteristic is read at a multiple of pickup, so without
         * one there is no multiple and no operate time. The element was
         * simply absent from the sheet and from every margin, with
         * nothing said -- the quietest way to lose a relay from a
         * study.
         */
        if (producer && producer.kind !== 'flex'
            && (stage.I_pu_A == null || !Number.isFinite(stage.I_pu_A))
            && !stage.I_pu_in_secondary) {
          add(ctx, 'PICKUP_MISSING', 'error',
            `${element.ref}${element.staged ? ` stage "${stage.id}"` : ''} has no `
            + 'I_pickup, so it has no multiple to read its curve at and cannot operate',
            stage.node.loc);
        }
        const curveKey =
          producer?.kind === 'standard' ? producer.id
          : producer?.kind === 'formula' ? `formula:${producer.k}/${producer.c}/${producer.alpha}`
          : producer?.kind ?? 'none';
        /*
         * The measured current is part of what makes two elements
         * distinct. Without it a `51` and a `51G` with the same
         * settings were reported as a double trip, when they respond
         * to entirely different currents and routinely do share
         * settings.
         */
        const quantity = measuredQuantityOf(stage) ?? 'undeclared';
        const key = `${curveKey}|${stage.I_pu_A}|${stage.tms}|${quantity}`;
        if (curveKey === 'none' || stage.I_pu_A == null) continue;
        const prior = seen.get(key);
        if (prior && prior !== element.id) {
          add(ctx, 'DUPLICATE_ELEMENT', 'error',
            `relay ${relay.id} declares elements ${prior} and ${element.id} with the same ` +
            `(I_pu, tms, curve, measured current) -- they would double-trip identically`,
            element.node.loc, element.id.length);
        } else if (!prior) {
          seen.set(key, element.id);
        }
      }
    }

    /*
     * A malformed ratio -- `400/` with the denominator still being
     * typed -- resolved to NaN and said nothing, which then made every
     * secondary-amp pickup on the relay NaN in turn. A number that is
     * not a number is worth one diagnostic at the place it came from,
     * rather than a curve that quietly fails to draw.
     */
    if (relay.ct_ratio !== undefined
        && (!Number.isFinite(relay.ct_ratio) || relay.ct_ratio <= 0)) {
      add(ctx, 'CT_RATIO_INVALID', 'error',
        `relay ${relay.id} has a ct_ratio that is not a positive number`,
        relay.elements[0]?.node.loc);
    }

    for (const element of relay.elements) {
      checkUnitsOn(ctx, element.node, `${relay.id}:${element.id}`);
      checkDrawingOn(ctx, element.node, `${relay.id}:${element.id}`);
      for (const stage of element.stages) {
        if (stage.node !== element.node) {
          checkUnitsOn(ctx, stage.node, `${relay.id}:${element.id} stage "${stage.id}"`);
          checkDrawingOn(ctx, stage.node, `${relay.id}:${element.id} stage "${stage.id}"`);
        }
      }
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

  /*
   * Stages of one element are stages of one protection function, so
   * they measure one current. Disagreeing means the element cannot be
   * graded or plotted as a single characteristic.
   */
  if (element.stages.length > 1 && elementQuantity(element.stages) === 'mixed') {
    add(ctx, 'MEASURES_MIXED', 'error',
      `element ${element.ref} has stages measuring different currents; split them into ` +
      'separate elements, one per measured quantity',
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

  /* ---- measured current ------------------------------------------ */
  /*
   * Which current a pickup is in decides the multiple, so it decides
   * the operate time. Left to a guess it is a silent numerical error,
   * which is what happened while `function` was parsed and never read.
   */
  if (stage.measures != null && !isMeasuredQuantity(stage.measures)) {
    add(ctx, 'MEASURES_UNKNOWN', 'error',
      `${where} declares measures = "${stage.measures}"; expected one of ` +
      MEASURED_QUANTITIES.join(', '),
      loc);
  } else if (measuredQuantityOf(stage) == null) {
    add(ctx, 'MEASURES_REQUIRED', 'error',
      `${where} has function "${stage.function}" but does not say which current its pickup ` +
      'is in; IEDs differ over the factor of three, so declare measures = "I2" or "3I2"',
      loc);
  }

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
  /*
   * Any route to a secondary-side pickup needs the ratio: `I_units`,
   * an `A_sec` suffix, or a per-unit multiple. Without it the pickup
   * cannot be converted and resolves to nothing at all, so this is an
   * error rather than a warning.
   */
  /*
   * A definite stage set to zero seconds cannot be drawn: the time
   * axis is logarithmic, and log(0) has no position on it. The curve
   * disappeared from the plot *and* the legend with nothing said,
   * which reads as the tool losing an element. A real relay has an
   * operate time -- typically 10 to 40 ms for an instantaneous stage
   * -- and entering it puts the curve back.
   */
  if (stage.t_delay_s === 0) {
    add(ctx, 'ZERO_DELAY_NOT_PLOTTABLE', 'warning',
      `${where} declares t_delay = 0 s, which cannot be placed on a logarithmic ` +
      'time axis, so the stage is not drawn; enter the relay\'s actual operate time',
      loc);
  }

  if (stage.I_pu_in_secondary && ctRatio == null) {
    add(ctx, 'CT_RATIO_MISSING', 'error',
      `${where} gives its pickup on the secondary side, but relay ${relayId ?? '?'} has no ` +
      'ct_ratio to convert it to primary amps',
      loc);
  }

  /*
   * Pickup plausibility against the voltage base -- catches the common
   * `720 A` where `7.20 kA` was meant.
   */
  if (
    stage.I_pu_A != null && relayKv != null && ctx.study.base_S != null &&
    relayKv > 0 && ctx.study.base_S > 0
  ) {
    const I_base = (ctx.study.base_S * 1e6) / (relayKv * 1e3 * Math.sqrt(3));
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
    checkFlexTable(ctx, stage.producer.points, where, 'flex_points', loc);
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
  /* A device names a level like a relay does; an unknown one would be
   * silently ignored and the characteristic drawn unreferred. */
  for (const device of ctx.study.devices.values()) {
    if (device.voltage && !ctx.study.voltages.has(device.voltage)) {
      add(ctx, 'VOLTAGE_UNKNOWN', 'error',
        `device "${device.id}" declares voltage "${device.voltage}", which is not in ` +
        `system.voltages (known: ${[...ctx.study.voltages.keys()].join(', ') || 'none'})`,
        undefined);
    }
  }

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

    /*
     * The tables themselves. A device carries up to three and none of
     * them was checked, so a fuse band typed off a datasheet in
     * descending order drew and graded as though the fuse never blew.
     */
    const tables: Array<[string, ReadonlyArray<{ I_A: number; t_s: number }> | undefined]> = [
      ['flex_points', device.flex_points],
      ['min_melt', device.min_melt],
      ['total_clear', device.total_clear],
    ];
    /*
     * A motor start is an envelope the relay must sit above, not a
     * characteristic anyone reads a time off, so its vertical segment
     * at the starting current is meaningful rather than malformed.
     */
    const allowVertical = device.kind === 'motor_startup';
    for (const [field, pts] of tables) {
      if (pts) {
        checkFlexTable(ctx, pts, `device "${device.id}"`, field, undefined, allowVertical);
      }
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
          ref.loc, ref.text.length);
        continue;
      }
      const { element, device } = resolveRef(study, ref);
      if (!element && !device) {
        add(ctx, 'UNRESOLVED_REFERENCE', 'error',
          `combine "${combine.name}" references "${name}", which is not a declared ` +
          'relay element or device',
          ref.loc, ref.text.length);
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
       * Keyed on the *condition* as well as the pair. Grading one pair
       * at several fault levels -- maximum and minimum, a bus fault and
       * a remote one -- or under several scenarios -- system normal and
       * an outage -- is normal practice and produces a row per check.
       * Only a genuinely repeated check is a duplicate.
       *
       * The scenario has to be part of the key for the same reason the
       * fault does: without it, two grades for one pair under different
       * scenarios both keyed on an empty string and the second was
       * reported as a duplicate of the first.
       */
      /*
       * A pair that is the same element twice always answers zero, and
       * reports it as a failure -- so a transposed reference read as a
       * grading failure to be chased rather than as the typo it was.
       */
      if (grade.primary.text === grade.backup.text) {
        add(ctx, 'GRADE_SELF_PAIR', 'error',
          `${grade.primary.text} is graded against itself; the margin between an `
          + 'element and itself is always zero',
          loc);
      }

      const condition = grade.scenario ? `scenario:${grade.scenario}` : `fault:${grade.fault ?? ''}`;
      const key = `${grade.primary.text}|${grade.backup.text}|${condition}`;
      if (pairs.has(key)) {
        add(ctx, 'DUPLICATE_GRADE', 'error',
          `a grade block for ${grade.primary.text} / ${grade.backup.text}` +
          `${grade.fault ? ` at ${grade.fault}` : ''} is already declared`,
          loc);
      }
      pairs.add(key);
    }

    if (grade.fault && grade.scenario) {
      add(ctx, 'GRADE_FAULT_AND_SCENARIO', 'error',
        'grade declares both `fault` and `scenario`; they are alternatives -- a fault is one ' +
        'current at one level, a scenario the same condition at every level', loc);
    } else if (grade.scenario) {
      /* A scenario is the condition, so nothing is missing here. */
      if (!study.scenarios.has(grade.scenario)) {
        add(ctx, 'UNRESOLVED_REFERENCE', 'error',
          `grade references scenario "${grade.scenario}", which is not declared`, loc);
      }
    } else if (!grade.fault) {
      add(ctx, 'FAULT_OPTIONAL_NO_GRADE_CHECK', 'warning',
        'grade block declares no fault or scenario; the curves render but no margin is computed',
        loc);
    } else if (!study.faults.has(grade.fault)) {
      add(ctx, 'UNRESOLVED_REFERENCE', 'error',
        `grade references fault "${grade.fault}", which is not declared in faults { ... }` +
        didYouMean(suggest(grade.fault, faultNames)),
        loc, grade.fault.length);
    }

    if (grade.margin_s != null && grade.CTI_min_s != null && grade.margin_s < grade.CTI_min_s) {
      add(ctx, 'MARGIN_BELOW_CTI', 'error',
        `grade declares margin_target = ${grade.margin_s} s below margin = ${grade.CTI_min_s} s; ` +
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
        'the upstream sweep reports the tightest margin but has no margin to judge it against',
        loc);
    }

    if (grade.margin_s != null && !grade.solve) {
      add(ctx, 'MARGIN_NO_SOLVE', 'warning',
        'margin_target is declared without a solve block; it is reported as a target only. ' +
        'Add solve { ... } to act on it, or use margin for a constraint',
        loc);
    }

    if (grade.solve) {
      if (grade.margin_s == null && grade.CTI_min_s == null) {
        add(ctx, 'SOLVE_WITHOUT_TARGET', 'error',
          'solve block declared with neither margin_target nor margin; the solver has no target',
          loc);
      }
      const tol = grade.solve.tolerance_pct;
      if (tol != null && (tol < 0 || tol > 50)) {
        add(ctx, 'TOLERANCE_OUT_OF_RANGE', 'error',
          `solve declares tolerance_pct = ${tol}; the accepted range is [0, 50]`, loc);
      }
      for (const free of grade.solve.free) {
        if (free !== 'tms' && free !== 't_delay' && free !== 'I_pickup') {
          add(ctx, 'SOLVE_FREE_UNKNOWN', 'error',
            `solve declares free variable "${free}"; accepted values are ` +
            'tms, t_delay, I_pickup', loc);
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
          'but at least one has no declared voltage',
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

/**
 * A named condition exists, and has something to say where it is used.
 *
 * Shared by `point` and `annotate`, which refer to conditions the same
 * way. The second check is the one worth having: a scenario declares
 * its currents per level, so naming one from a marker on a level it is
 * silent about is not a rendering nicety to skip quietly -- it means
 * the study asked for a position that was never measured.
 */
function checkConditionReference(
  ctx: Ctx,
  name: string,
  where: string,
  level: string | undefined,
  loc: SourceLocation | undefined,
): void {
  const resolved = resolveCondition(ctx.study, name, level);
  if (!resolved) {
    add(ctx, 'UNRESOLVED_REFERENCE', 'error',
      `${where} references "${name}", which is declared as neither a fault nor a scenario` +
      didYouMean(suggest(name, conditionNames(ctx.study))),
      loc, name.length);
    return;
  }

  if (resolved.kind === 'scenario' && resolved.voltage == null) {
    add(ctx, 'SCENARIO_LEVEL_MISSING', 'error',
      `${where} references scenario "${name}", which declares no currents at ` +
      `${level ?? 'the level it is drawn on'}` +
      (resolved.levels.length > 0 ? ` (it declares ${resolved.levels.join(', ')})` : ''),
      loc, name.length);
  }
}

/**
 * `times` blocks: the horizontal counterpart of `faults`.
 *
 * Keyed by name like the faults are, so a repeat replaces the first
 * with nothing said -- and which limit the sheet rules at becomes a
 * question of declaration order.
 */
/**
 * Unit suffixes the language does not know.
 *
 * `readNumber` leaves an unrecognised suffix alone rather than guessing
 * -- deliberately, and its comment has always said the validator would
 * complain. Nothing did, so `I_pu = 4 KA` was read as 4 A and
 * `t_delay = 60 msec` as 60 seconds: a thousandfold error, silent, in
 * the two fields that decide whether a relay operates.
 *
 * Checked against the union of every suffix rather than the one the
 * field expects, because that catches the whole dangerous class -- a
 * misspelling or the wrong case -- without the validator having to
 * carry a second copy of which key means which quantity. A suffix that
 * is real but wrong for its field (`I_pu = 5 ms`) still slips through;
 * that is a narrower hole and a rarer mistake.
 */
/** A node's own source location, when the parser recorded one. */
function at_(node: unknown): SourceLocation | undefined {
  const loc = (node as { loc?: SourceLocation } | undefined)?.loc;
  return loc && typeof loc.line === 'number' ? loc : undefined;
}

function validateUnits(ctx: Ctx): void {
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }

    const o = node as Record<string, unknown>;

    /*
     * A `{ kind: 'scalar', key, value }` member carries the field name
     * beside the number, which is what lets the suffix be judged
     * against the quantity the field actually takes rather than
     * against the union of every suffix. `I_pickup = 5 ms` is a real
     * suffix in the wrong place, and the union check passed it.
     */
    const value = o.value as Record<string, unknown> | undefined;
    if (o.kind === 'scalar' && typeof o.key === 'string'
        && value?.kind === 'number' && typeof value.unit === 'string') {
      const fits = suffixFits(o.key, value.unit);
      /*
       * The walker knows where it is, and used to throw that away.
       *
       * The width of the highlight was computed correctly and the
       * anchor passed as `undefined`, so every unit error reported at
       * 1:1 -- and 1:1 is a clickable go-to-line that lands the reader
       * at the top of the file. On a three-hundred-line study they were
       * then told a suffix was wrong and left to find which one.
       */
      const at = at_(value) ?? at_(o);
      if (fits === false) {
        add(ctx, 'UNIT_WRONG_QUANTITY', 'error',
          `"${value.unit}" is not a unit of ${FIELD_QUANTITY[o.key]}; "${o.key}" takes ` +
          suffixesFor(FIELD_QUANTITY[o.key]!).map((u) => `"${u}"`).join(', '),
          at, value.unit.length);
        return;
      }
      if (fits == null && !KNOWN_UNITS.has(value.unit)) {
        add(ctx, 'UNIT_UNKNOWN', 'error',
          `"${value.unit}" is not a unit this language knows. Units are ` +
          'case-sensitive -- "kA" not "KA", "ms" not "msec"',
          at, value.unit.length);
      }
      return;
    }

    if (o.kind === 'number' && typeof o.unit === 'string' && !KNOWN_UNITS.has(o.unit)) {
      add(ctx, 'UNIT_UNKNOWN', 'error',
        `"${o.unit}" is not a unit this language knows. Units are case-sensitive ` +
        '-- "kA" not "KA", "ms" not "msec"',
        at_(o), o.unit.length);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };

  walk(ctx.doc?.items ?? []);
}

function validateTimes(ctx: Ctx): void {
  const seen = new Map<string, number>();
  for (const item of ctx.doc?.items ?? []) {
    if (item.type !== 'times') continue;
    for (const t of item.times) {
      const first = seen.get(t.id);
      if (first != null) {
        add(ctx, 'DUPLICATE_TIME', 'error',
          `time ${t.id} is declared more than once (first at line ${first}); ` +
          'the later declaration silently replaces the earlier',
          t.loc, t.id.length);
      } else {
        seen.set(t.id, t.loc?.line ?? 0);
      }
    }
  }

  for (const t of ctx.study.times.values()) {
    if (!Number.isFinite(t.t_s) || t.t_s <= 0) {
      add(ctx, 'TIME_INVALID', 'error',
        `time "${t.name}" declares t = ${t.t_s}; it must be strictly positive to have ` +
        'a place on a logarithmic axis',
        t.loc, t.name.length);
    }
  }
}

function validateAnnotations(ctx: Ctx): void {
  if (!ctx.doc) return;

  for (const item of ctx.doc.items) {
    if (item.type !== 'annotate') continue;
    /*
     * A condition and a bare current are two ways to say where the
     * annotation goes, and the condition silently won -- so adding
     * `at_I_A` to an annotation that already named a scenario did
     * nothing at all, and gave no reason. Refused rather than ranked,
     * as `point` refuses the same pair.
     */
    /*
     * `on_curve` naming something the study does not declare drew
     * nothing and said nothing, so a renamed relay quietly took its
     * annotations with it.
     */
    const target = item.on_curve ? resolveRef(ctx.study, item.on_curve) : undefined;
    if (item.on_curve && target && !target.element && !target.device) {
      add(ctx, 'UNRESOLVED_REFERENCE', 'error',
        `annotate points at ${item.on_curve.text}, which this study does not declare`,
        item.loc);
    }

    /*
     * A `point` naming a marker the study does not declare.
     *
     * The commonest way to get this wrong is to write the marker's
     * *label* where its id belongs -- they are usually near-identical
     * sentences, and only one of them resolves. The sheet reports the
     * mark as unplaceable, but that is a note on a drawing; the editor
     * said nothing at all, so the typo survived until someone noticed
     * an annotation missing.
     */
    if (item.pointRef != null) {
      const known = ctx.study.points.some(
        (pt) => pt.id === item.pointRef || pt.label === item.pointRef);
      if (!known) {
        const names = ctx.study.points.map((pt) => pt.id);
        add(ctx, 'UNRESOLVED_REFERENCE', 'error',
          `annotate names point "${item.pointRef}", which this study does not declare`
          + didYouMean(suggest(item.pointRef, names, 8)),
          item.loc);
      }
    }

    if ((item.conditions?.length ?? 0) > 0 && item.at_I_A != null) {
      add(ctx, 'ANNOTATE_CURRENT_AND_CONDITION', 'error',
        'annotate declares at_I and names a condition; they are alternatives -- ' +
        'a condition supplies the current, so at_I would be ignored',
        item.loc);
    }

    checkAnnotationSpan(ctx, item);
    checkAnnotationPlacement(ctx, item, target);

    for (const name of item.conditions ?? []) {
      /*
       * Judged at the level of whatever the annotation points at: each
       * side of a margin is evaluated in its own frame, exactly as
       * grading does, so that is the level a scenario has to cover.
       */
      const ref = item.on_curve ?? item.primary ?? item.backup;
      const target = ref ? resolveRef(ctx.study, ref) : undefined;
      const level = target?.element?.voltage ?? target?.device?.voltage;
      checkConditionReference(ctx, name, 'annotate', level, item.loc);
    }
  }
}

/**
 * A `from` / `to` dimension between two figures the study names.
 *
 * Unlike either margin form there is no curve at either end, so
 * nothing else constrains it: every way of getting it wrong has to be
 * caught here or it becomes a mark that does not appear.
 */
function checkAnnotationSpan(ctx: Ctx, item: AnnotateBlock): void {
  const { from, to } = item;
  if (!from && !to) return;

  if (!from || !to) {
    add(ctx, 'SPAN_INCOMPLETE', 'error',
      `annotate declares ${from ? 'from' : 'to'} without ${from ? 'to' : 'from'}; ` +
      'a span needs both of its ends',
      item.loc);
    return;
  }

  /*
   * The unit is what says which way the dimension runs, so two units
   * from different quantities describe no line at all -- there is no
   * distance between a current and a time.
   */
  if (from.quantity !== to.quantity) {
    add(ctx, 'SPAN_MIXED_QUANTITIES', 'error',
      `annotate spans from a ${from.quantity} to a ${to.quantity}; ` +
      'both ends must be currents or both times, since the unit is what ' +
      'decides whether the span is drawn across the sheet or up it',
      item.loc);
    return;
  }

  if (from.value === to.value) {
    add(ctx, 'SPAN_EMPTY', 'warning',
      'annotate spans from a figure to itself, which draws a dimension of nothing',
      item.loc);
  }

  /* The other coordinate: where along the perpendicular axis it sits. */
  if (from.quantity === 'time') {
    if (item.at_I_A == null && (item.conditions?.length ?? 0) === 0) {
      add(ctx, 'SPAN_NO_ANCHOR', 'error',
        'a span between two times is drawn vertically, so it needs a current ' +
        'to stand at: give at_I, or name a fault or scenario',
        item.loc);
    }
    return;
  }

  if (item.at_t_s == null) {
    add(ctx, 'SPAN_NO_ANCHOR', 'error',
      'a span between two currents is drawn horizontally, so it needs a time ' +
      'to sit at: give at_t',
      item.loc);
  }
}

/**
 * Whether a point annotation can be placed at all, and whether every
 * part of it will be drawn.
 *
 * An annotation that resolves to no position used to be dropped by the
 * renderer with a bare `continue`: nothing on the sheet, nothing in the
 * report, and a study that looked complete. Three of the five in the
 * shipped sequence sample were being lost that way. These are the
 * failures that can be seen without a viewport, so they are said here
 * rather than as a note on one sheet.
 */
function checkAnnotationPlacement(
  ctx: Ctx,
  item: AnnotateBlock,
  target: { element?: Element; device?: Device } | undefined,
): void {
  /* Only the point form; a margin is positioned by its two references,
   * and a span by its own two ends. */
  if (item.primary || item.backup) return;
  if (item.from || item.to) return;
  if (!item.on_curve) return;

  /*
   * `pin` is specified as a marker and nothing else. A label written
   * beside one is therefore never drawn -- which is indistinguishable,
   * from the sheet, from the annotation having failed entirely.
   */
  if (item.style === 'pin' && item.label != null) {
    add(ctx, 'ANNOTATE_LABEL_NOT_DRAWN', 'warning',
      'style = pin draws a marker only, so this label will not appear; ' +
      'use leader or tag to show it',
      item.loc);
  }

  const declared: Array<[string, MeasuredQuantity, number | undefined]> = [
    ['at_I', 'phase', item.at_I_A],
    ['at_I1', 'I1', item.at_I1_A],
    ['at_I2', 'I2', item.at_I2_A],
    ['at_I0', 'I0', item.at_I0_A],
    ['at_residual', '3I0', item.at_earth_A],
  ];
  const given = declared.filter(([, , value]) => value != null);

  /* No current, no time, no condition: nothing says where it goes. */
  if (given.length === 0 && item.at_t_s == null && (item.conditions?.length ?? 0) === 0) {
    add(ctx, 'ANNOTATE_NO_POSITION', 'error',
      `annotate on ${item.on_curve.text} says where to point but not where to put it: ` +
      'give at_I (or at_I1, at_I2, at_I0, at_residual), at_t, or a fault or scenario',
      item.loc);
    return;
  }

  if (given.length === 0) return;

  /*
   * The component written has to be one the annotated element measures.
   * `at_I1` beside an element scaled in `3I2` resolves to nothing --
   * positive sequence is not negative sequence, and the tool will not
   * substitute one for the other -- so the mark silently vanished.
   */
  const measured = target?.element ? elementQuantity(target.element.stages) : 'phase';
  if (measured == null || measured === 'mixed') return;

  const currents = {
    phase: item.at_I_A, I1: item.at_I1_A, I2: item.at_I2_A,
    I0: item.at_I0_A, residual: item.at_earth_A,
  };
  if (currentFor(measured, currents) != null) return;

  /*
   * A fault type can bridge the gap -- for a solid phase-earth fault
   * `I1` and `I0` are the same figure -- but only if the annotation
   * says which type it is talking about.
   */
  if (isFaultType(item.faultType)
    && resolveCurrent(measured, currents, item.faultType) != null) return;

  add(ctx, 'ANNOTATE_QUANTITY_MISMATCH', 'error',
    `annotate places a mark on ${item.on_curve.text}, which measures ` +
    `${quantityLabel(measured)}, but declares only ` +
    `${given.map(([name]) => name).join(' and ')}; ` +
    `give at_${quantityField(measured).replace(' (or residual)', '')}` +
    `${measured === 'I0' || measured === '3I0' ? ' or at_residual' : ''}, ` +
    'or add a type so the components can be derived',
    item.loc);
}

function validatePoints(ctx: Ctx): void {
  const names = [...ctx.study.voltages.keys()];
  const seen = new Set<string>();
  const viewLevel = ctx.study.view?.voltage?.trim().replace(/^"|"$/g, '');

  for (const point of ctx.study.points) {
    if (seen.has(point.id)) {
      add(ctx, 'DUPLICATE_POINT', 'error',
        `point "${point.id}" is declared more than once`, undefined);
    }
    seen.add(point.id);

    /*
     * The current comes from one place or the other. Two sources for one
     * number is a precedence rule a reader would have to remember, and
     * whichever way it fell the other figure would sit in the source
     * looking as though it did something.
     */
    const statesCurrent = [point.I_A, point.I1_A, point.I2_A, point.I0_A, point.earth_A]
      .some((v) => v != null && Number.isFinite(v));
    if (point.condition && statesCurrent) {
      add(ctx, 'POINT_CURRENT_AND_CONDITION', 'error',
        `point "${point.id}" declares I and names the condition ` +
        `"${point.condition}"; they are alternatives -- drop one`,
        undefined);
    } else if (point.condition) {
      checkConditionReference(ctx, point.condition, `point "${point.id}"`,
        point.voltage ?? viewLevel, undefined);
    } else {
      /*
       * Any one component will do. A point declares its current the way
       * a fault does, so a marker known only in negative sequence is
       * written `I2_A` and has no phase figure to check.
       */
      const declared = [point.I_A, point.I1_A, point.I2_A, point.I0_A, point.earth_A]
        .filter((v): v is number => v != null && Number.isFinite(v));
      if (declared.length === 0) {
        add(ctx, 'POINT_CURRENT_INVALID', 'error',
          `point "${point.id}" declares no current; give it I (or I1, I2, I0, ` +
          'residual), or name a fault or scenario to take it from',
          undefined);
      } else if (declared.some((v) => v <= 0)) {
        add(ctx, 'POINT_CURRENT_INVALID', 'error',
          `point "${point.id}" declares a non-positive current; currents must be ` +
          'strictly positive to have a place on a logarithmic axis',
          undefined);
      }
    }
    if (!(point.t_s > 0)) {
      add(ctx, 'POINT_TIME_INVALID', 'error',
        `point "${point.id}" declares t = ${point.t_s}; it must be strictly positive`,
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

/**
 * Enumerated `page` values, checked against the list `?` offers.
 *
 * `legend { style = "insnide" }` parsed, validated, rendered, and
 * silently used the default -- so a drawing office that set its house
 * style got something else and nothing anywhere said why. A cosmetic
 * key is not a margin, but a study can still be issued looking nothing
 * like the standard its author thought they had applied.
 *
 * Read from `FIELD_VALUES`, which is the same table the editor offers
 * from. One table with two readers cannot drift; two tables would.
 */
const PAGE_ENUMS: ReadonlyArray<readonly [string, string, string]> = [
  /* [sub-block, field, FIELD_VALUES key] -- '' means the page itself. */
  ['', 'theme', 'theme'],
  ['', 'orientation', 'orientation'],
  ['legend', 'style', 'legend.style'],
  ['legend', 'position', 'position'],
  ['legend', 'swatch', 'swatch'],
  ['legend', 'currents', 'currents'],
  ['curves', 'palette', 'palette'],
  ['points', 'shape', 'shape'],
  ['leaders', 'style', 'leaders.style'],
  ['faults', 'style', 'faults.style'],
  ['times', 'style', 'times.style'],
  ['title', 'align', 'align'],
  ['scale', 'tick_density', 'tick_density'],
];

function checkPageEnums(ctx: Ctx): void {
  const page = ctx.study.page;
  if (!page) return;
  const blocks = page as unknown as Record<string, Record<string, unknown> | undefined>;

  for (const [block, field, key] of PAGE_ENUMS) {
    const holder = block === '' ? blocks : blocks[block];
    if (holder == null || typeof holder !== 'object') continue;
    const written = holder[field];
    if (typeof written !== 'string' || written === '') continue;

    const allowed = (FIELD_VALUES[key] ?? []).map((c) => c.value.replace(/^"|"$/g, ''));
    if (allowed.length === 0 || allowed.includes(written)) continue;

    const where = block === '' ? 'page' : `page ${block}`;
    add(ctx, 'PAGE_VALUE_UNKNOWN', 'error',
      `${where} sets ${field} = "${written}", which is not one of `
      + allowed.map((a) => `"${a}"`).join(', ')
      + didYouMean(suggest(written, allowed)),
      page.loc);
  }
}

function validatePage(ctx: Ctx): void {
  const page = ctx.study.page;
  if (!page) return;
  checkPageEnums(ctx);

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
