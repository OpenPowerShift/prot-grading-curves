/**
 * Study model -- the resolved form of a parsed `.tc` document.
 *
 * The AST is a faithful record of what the engineer *wrote*; the study
 * model is what those words *mean*. Resolution happens once, here, so
 * that the solver, the margin report, the validator, and the renderer
 * all read the same numbers instead of each re-deriving them from raw
 * AST members (which is how the two sides drift apart).
 *
 * What resolution does:
 *
 *   - folds unit suffixes into base units (A, s, kV) -- see `units.ts`;
 *   - converts `I_units = "secondary"` pickups into primary amps using
 *     the parent relay's `ct_ratio`
 *     (spec: _Units and axes -- Input units_);
 *   - expands the shorthand element form into a single implicit stage
 *     named `main` (spec: _Stages and composite curves_);
 *   - resolves `curve = ns.family` against the constants table into
 *     the constants actually used for evaluation;
 *   - carries `current_pct` down to the stage that owns it
 *     (spec: _Current-share factor_).
 *
 * Resolution is deliberately *total*: anything malformed is left
 * `undefined` rather than throwing, and the validator reports it. A
 * half-broken study still renders the curves that are well-formed.
 */

import type {
  Document,
  ElementBlock,
  FlexPoint,
  GradeBlock,
  Ref,
  SourceLocation,
  SpanEnd,
  StageBlock,
  TopLevel,
} from '../parser/ast.js';
import { lookupCurve, type CurveConstants } from '../constants/curves.js';
import { amps, rawNumber, readBoolean, readRatio, readString, seconds } from './units.js';
import { isFaultType, type FaultType } from '../constants/sequence.js';

/** Key for a level pair, order-independent. */
export function levelPairKey(a: string, b: string): string {
  return [a, b].sort().join('\u0000');
}

/* ------------------------------------------------------------------ */
/* Model types                                                         */
/* ------------------------------------------------------------------ */

export interface VoltageLevel {
  name: string;
  kV: number;
  description?: string;
}

export interface Fault {
  /** Sheets this belongs to, by `view` name. Absent means every sheet. */
  views?: string[];

  name: string;
  /** Fault type, supplying the ratios between quantities. */
  type?: FaultType;
  /** Declared current, in primary amps *at its own voltage level*. */
  I_A: number;
  /** Range endpoints; both default to `I_A` (spec: _CTI computation_). */
  min_A: number;
  max_A: number;
  I1_A?: number;
  earth_A?: number;
  I0_A?: number;
  I2_A?: number;
  voltage?: string;
  voltage_kV?: number;
  description?: string;
}

/** The four ways a stage can produce a time-current characteristic. */
export type CurveProducer =
  | { kind: 'standard'; id: string; constants: CurveConstants }
  | { kind: 'formula'; k: number; c: number; alpha: number }
  | { kind: 'flex'; points: FlexPoint[] }
  | { kind: 'definite' };

export interface Stage {
  /** `main` for the shorthand (single-curve) element form. */
  id: string;
  producer?: CurveProducer;
  /** Pickup in *primary* amps, after any secondary->primary conversion. */
  I_pu_A?: number;
  /** Pickup exactly as written, for diagnostics and legends. */
  I_pu_declared?: number;
  /**
   * The declared pickup needs the CT ratio to reach primary amps --
   * because of `I_units`, an `A_sec` suffix, or a per-unit multiple.
   * The validator uses it to catch a missing `ct_ratio`, which would
   * otherwise leave the pickup silently undefined.
   */
  I_pu_in_secondary?: boolean;
  I_units?: 'primary' | 'secondary';
  tms?: number;
  /** `true` when the solver, not the source, set `tms`. */
  tms_auto?: boolean;
  /**
   * The dial the study declared, kept when the solver replaced it.
   *
   * What is drawn is what is used, so a solved value supersedes the
   * declared one -- but silently discarding it left the sheet showing
   * 0.175 while the file said 0.45, and a commissioning engineer
   * setting from the drawing against a settings sheet from the file.
   * Both figures are now on the sheet.
   */
  tms_declared?: number;
  t_delay_s?: number;
  t_reset_s?: number;
  reset?: 'instant' | 'dependent' | 'disk_emulation';
  /** Share of the total fault current this stage sees, in percent. */
  current_pct: number;
  function?: string;
  /**
   * Current this stage's pickup is expressed in, as written. Resolved
   * against `function` by `measuredQuantityOf` -- see
   * `src/semantics/quantity.ts`.
   */
  measures?: string;
  directional?: boolean;
  char_angle_deg?: number;
  /**
   * Current this stage's curve stops at, in primary amps.
   *
   * Falls back to the element's. A stage routinely has a narrower
   * ceiling than the element that owns it -- an instantaneous stage
   * that is blocked above a certain current, a thermal stage only
   * characterised to a few multiples -- and before this the only
   * ceiling available was the element's, which drew every stage to the
   * same place whatever its own datasheet said.
   */
  current_max_A?: number;
  /** Per-stage drawing overrides; fall back to the element's. */
  color?: string;
  style?: CurveStyle;
  width_px?: number;
  /** Source AST node, for error locations. */
  node: ElementBlock | StageBlock;
}

export interface Element {
  id: string;
  /** Display name, as for {@link Relay.name}. */
  name?: string;
  /**
   * What the drawing calls this characteristic: the declared names
   * where given, otherwise `ref`. Legend entries, direct labels, and
   * the hover readout all use it.
   */
  label: string;
  relayId?: string;
  /** Relay make and model, carried down for the legend. */
  maker?: string;
  model?: string;
  /** Parent relay's CT ratio, for secondary-amp display. */
  ct_ratio?: number;
  /** `R_FDR_1:51`, or just `51` for a top-level element block. */
  ref: string;
  /** One entry; or one per `stage` in a `stages { ... }` block. */
  stages: Stage[];
  /** True when the element used the `stages { ... }` form. */
  staged: boolean;
  /**
   * Current the curve stops at, in this element's own primary amps.
   *
   * A characteristic is defined for any multiple, but the *network* is
   * not: past the maximum fault the bus can deliver, the curve is
   * describing a current that cannot flow. Drawing it there invites a
   * margin to be read at a fault that does not exist.
   */
  current_max_A?: number;
  /**
   * How this one curve is drawn, overriding the palette.
   *
   * The automatic palette is right for an ordinary study, and wrong
   * whenever a drawing has to match something outside itself: a house
   * standard that colours the incomer red, a figure whose colours are
   * already fixed by the report it sits in, a curve that must be
   * subdued because it is context rather than argument.
   */
  color?: string;
  style?: CurveStyle;
  width_px?: number;
  voltage?: string;
  voltage_kV?: number;
  node: ElementBlock;
}

/**
 * How a characteristic's stroke is drawn.
 *
 * Same vocabulary as `page { faults }` and `page { times }` use, so
 * one word means one thing wherever a line is styled.
 */
export type CurveStyle = 'solid' | 'dashed' | 'dotted';

export function isCurveStyle(value: unknown): value is CurveStyle {
  return value === 'solid' || value === 'dashed' || value === 'dotted';
}

export interface Relay {
  id: string;
  /**
   * Display name. Free text -- spaces, punctuation, panel references
   * -- shown wherever the relay is named on the drawing. The `id`
   * stays the identifier that `grade` and `annotate` resolve against,
   * so renaming for the reader never breaks a reference.
   */
  name?: string;
  maker?: string;
  model?: string;
  voltage?: string;
  voltage_kV?: number;
  /** `600/5` resolved to 120. */
  ct_ratio?: number;
  direction?: string;
  faults: string[];
  elements: Element[];
}

/** One level's symmetrical components under a scenario. */
export interface ScenarioLevel {
  voltage: string;
  /** Source position, so a diagnostic can point at the declaration. */
  loc?: SourceLocation;
  voltage_kV?: number;
  I_A?: number;
  I1_A?: number;
  I2_A?: number;
  I0_A?: number;
  /** Residual `3*I0`, when declared directly. */
  earth_A?: number;
}

/**
 * A named system condition, described at every level it is measured.
 *
 * The alternative to referring one figure across a transformer, which
 * cannot be done for zero sequence. Declared, never derived.
 */
export interface Scenario {
  name: string;
  /** Fault type, as on a `Fault`. */
  type?: FaultType;
  description?: string;
  loc?: SourceLocation;
  levels: Map<string, ScenarioLevel>;
  /** Share of a level's current a given relay carries, in percent. */
  shares: Map<string, number>;
}

export interface Device {
  id: string;
  kind?: string;
  /** Level this device sits on, as named in `system.voltages`. */
  voltage?: string;
  /** That level's kV, resolved. */
  voltage_kV?: number;
  maker?: string;
  model?: string;
  rating_A?: number;
  rating_kV?: number;
  rating_MVA?: number;
  flex_points?: FlexPoint[];
  min_melt?: FlexPoint[];
  total_clear?: FlexPoint[];
  t_delay_s?: number;
  description?: string;
}

export interface Combine {
  name: string;
  sources: Ref[];
  as: 'envelope_min' | 'envelope_max' | 'sum' | 'select_first';
  color?: string;
  style?: string;
  label?: string;
}

export interface Grade {
  primary?: Ref;
  backup?: Ref;
  fault?: string;
  /** Named `scenario`, as an alternative to `fault`. */
  scenario?: string;
  CTI_min_s?: number;
  margin_s?: number;
  tolerance_pct?: number;
  comment?: string;
  /** Sweep the margin above the declared fault as well. */
  upstream?: boolean;
  /** Ceiling for that sweep, in primary amps at the fault's level. */
  upstream_to_A?: number;
  solve?: {
    strategy: 'tight' | 'loose' | 'safety_factor';
    tolerance_pct?: number;
    free: Array<'tms' | 't_delay' | 'I_pickup'>;
  };
  node: GradeBlock;
}

/**
 * A required time, drawn as a horizontal rule.
 *
 * The other axis's answer to a {@link Fault}: a limit the curves are
 * judged against rather than a current they are evaluated at.
 */
export interface RequiredTime {
  /** Sheets this belongs to, by `view` name. Absent means every sheet. */
  views?: string[];

  name: string;
  t_s: number;
  /** Caption anchor along the rule, in the sheet's own axis current. */
  at_I_A?: number;
  description?: string;
  loc?: SourceLocation;
}

/** A marked (I, t) coordinate -- inrush, motor start, damage point. */
export interface StudyPoint {
  /** Sheets this belongs to, by `view` name. Absent means every sheet. */
  views?: string[];

  id: string;
  /**
   * Phase current in primary amps at `voltage`, or `NaN` when
   * `condition` supplies it instead.
   *
   * Declared as a `fault` and a `scenario` level declare theirs, so the
   * sheet takes whichever component its axis is drawn in rather than
   * plotting one number against every axis alike.
   */
  I_A: number;
  I1_A?: number;
  I2_A?: number;
  I0_A?: number;
  /** Residual `3*I0`, when declared directly. */
  earth_A?: number;
  /** Fault type, supplying the ratios between the components. */
  type?: FaultType;
  t_s: number;
  /**
   * Named condition -- a fault or a scenario -- this marker stands at.
   *
   * One per point after resolution: a `point` naming several conditions
   * becomes one `StudyPoint` each, so everything downstream handles a
   * single current without knowing about the plural spelling.
   */
  condition?: string;
  label?: string;
  voltage?: string;
  voltage_kV?: number;
  color?: string;
  shape?: 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'x';
  coords?: boolean;
  description?: string;
}

/** A resolved annotation: either a point on a curve, or a margin. */
export interface Annotation {
  /** Sheets this belongs to, by `view` name. Absent means every sheet. */
  views?: string[];

  /**
   * `margin` spans the two curves vertically at one current and reports
   * a time; `current_margin` spans them horizontally at one time and
   * reports a percentage of current; `span` spans two figures the study
   * simply names, with no curve at either end.
   */
  kind: 'point' | 'margin' | 'current_margin' | 'span';
  /**
   * The two ends of a `span`, both on the same axis.
   *
   * A required grading band, the window a setting has to sit inside,
   * a range a supplier quotes -- none of these is a characteristic, so
   * before this none could be drawn at all.
   */
  span?: { quantity: 'current' | 'time'; from: number; to: number };
  on_curve?: Ref;
  primary?: Ref;
  backup?: Ref;
  /**
   * Named condition supplying the current, a fault or a scenario.
   *
   * One per annotation after resolution, as for {@link StudyPoint}: an
   * `annotate` block naming several becomes one annotation each.
   */
  condition?: string;
  at_I_A?: number;
  /** Time a current margin is measured at, in seconds. */
  at_t_s?: number;
  /** A marked point the current margin is measured to, by id. */
  pointRef?: string;
  /** Level `at_I_A` is measured at; defaults to the view's. */
  voltage?: string;
  /** The component vocabulary, as a fault and a point use it. */
  at_I1_A?: number;
  at_I2_A?: number;
  at_I0_A?: number;
  at_earth_A?: number;
  type?: FaultType;
  label?: string;
  style: 'leader' | 'pin' | 'tag';
  color?: string;
  coords?: boolean;
}

export interface Study {
  meta: Record<string, string | number | boolean>;
  voltages: Map<string, VoltageLevel>;
  /** Study MVA base, for the pickup-plausibility check. */
  base_S?: number;
  /**
   * Whether zero sequence crosses a pair of levels, keyed on the
   * unordered pair. Declared, because a delta blocks it and a
   * star-star with both neutrals earthed does not.
   */
  zeroSequence: Map<string, 'blocked' | 'continuous'>;
  I_base_A?: number;
  I_units: 'primary' | 'secondary';
  faults: Map<string, Fault>;
  /** Named conditions with their currents at every level. */
  scenarios: Map<string, Scenario>;
  /** Named times the sheet rules across, keyed by name. */
  times: Map<string, RequiredTime>;
  relays: Map<string, Relay>;
  /** Elements declared at the top level, outside any relay. */
  looseElements: Element[];
  devices: Map<string, Device>;
  combines: Combine[];
  grades: Grade[];
  points: StudyPoint[];
  annotations: Annotation[];
  /**
   * The sheet being drawn: the first view unless one is selected.
   *
   * Kept as a single field so everything downstream reads one view and
   * knows nothing about there being others.
   */
  view?: Extract<TopLevel, { type: 'view' }>;
  /**
   * Every declared view, in source order -- one per sheet.
   *
   * A study routinely wants several sheets of one network: a phase
   * sheet and a negative-sequence sheet, or the same grading under two
   * conditions. Presentation stays in the presentation layer; a
   * `scenario` remains purely what the fault study measured, and a
   * view names the condition it depicts.
   */
  views: Array<Extract<TopLevel, { type: 'view' }>>;
  page?: Extract<TopLevel, { type: 'page' }>;
  notes: Record<string, string | number | boolean>;
  document: Document;
}

/* ------------------------------------------------------------------ */
/* Member access helpers                                               */
/* ------------------------------------------------------------------ */

type AnyMembered = { members: Array<{ kind: string; key?: string; value?: unknown }> };

function member(host: AnyMembered, key: string): unknown {
  for (const m of host.members) {
    if (m.kind === 'scalar' && m.key === key) return m.value;
  }
  return undefined;
}

function has(host: AnyMembered, key: string): boolean {
  return host.members.some((m) => m.kind === 'scalar' && m.key === key);
}

/**
 * The conditions one `annotate` or `point` block stands for.
 *
 * Always at least one entry, so the caller is a plain loop: a block
 * naming no condition yields a single `undefined`, which is the
 * unconditional form the language began with. Repeats are dropped --
 * naming a fault twice should draw one annotation, not two on top of
 * each other.
 */
function expandConditions(names: string[] | undefined): Array<string | undefined> {
  if (!names || names.length === 0) return [undefined];
  return [...new Set(names)];
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export function buildStudy(doc: Document): Study {
  const study: Study = {
    meta: {},
    voltages: new Map(),
    I_units: 'primary',
    faults: new Map(),
    scenarios: new Map(),
    times: new Map(),
    zeroSequence: new Map(),
    relays: new Map(),
    looseElements: [],
    devices: new Map(),
    combines: [],
    grades: [],
    views: [],
    points: [],
    annotations: [],
    notes: {},
    document: doc,
  };

  /* Pass 1 -- everything that later passes need to look things up in. */
  for (const item of doc.items) {
    switch (item.type) {
      case 'meta':
        for (const [k, v] of Object.entries(item.entries)) {
          study.meta[k] = scalarToPrimitive(v);
        }
        break;
      case 'system':
        study.base_S = item.base_S;
    for (const link of item.zero_sequence ?? []) {
      study.zeroSequence.set(levelPairKey(link.from, link.to), link.link);
    }
        study.I_base_A = item.I_base_A;
        if (item.I_units) study.I_units = item.I_units;
        for (const lvl of item.voltages) {
          study.voltages.set(lvl.name, {
            name: lvl.name,
            kV: lvl.kV,
            description: lvl.description,
          });
        }
        break;
      case 'times':
        for (const t of item.times) {
          study.times.set(t.name, {
            name: t.name,
            t_s: t.t_s,
            at_I_A: t.at_I_A,
            views: t.views,
            description: t.description,
            loc: t.loc,
          });
        }
        break;
      case 'view':
        study.views.push(item);
        /*
         * The sheet a plain render draws: the one marked `default`, or
         * the first declared. A caller may still pick another.
         */
        if (item.isDefault) study.view = item;
        else study.view ??= item;
        break;
      case 'page':
        study.page = item;
        break;
      case 'notes':
        for (const [k, v] of Object.entries(item.entries)) {
          study.notes[k] = scalarToPrimitive(v);
        }
        break;
      default:
        break;
    }
  }

  /* Pass 2 -- scenarios, which resolve their levels the same way. */
  for (const item of doc.items) {
    if (item.type !== 'scenario') continue;
    const levels = new Map<string, ScenarioLevel>();
    for (const level of item.levels) {
      levels.set(level.voltage, {
        voltage: level.voltage,
        loc: level.loc,
        voltage_kV: study.voltages.get(level.voltage)?.kV,
        I_A: level.I_A,
        I1_A: level.I1_A,
        I2_A: level.I2_A,
        I0_A: level.I0_A,
        earth_A: level.earth_A,
      });
    }
    study.scenarios.set(item.name, {
      name: item.name,
      type: isFaultType(item.faultType) ? item.faultType : undefined,
      description: item.description,
      loc: item.loc,
      levels,
      shares: new Map(item.shares.map((sh) => [sh.relay, sh.current_pct])),
    });
  }

  /* Pass 2 -- faults, now that voltage levels resolve. */
  for (const item of doc.items) {
    if (item.type !== 'faults') continue;
    for (const f of item.faults) {
      const kV = f.voltage ? study.voltages.get(f.voltage)?.kV : undefined;
      study.faults.set(f.name, {
        name: f.name,
        type: isFaultType(f.type) ? f.type : undefined,
        I_A: f.I_A,
        min_A: f.min_A ?? f.I_A,
        max_A: f.max_A ?? f.I_A,
        views: f.views,
        I1_A: f.I1_A,
        earth_A: f.earth_A,
        I0_A: f.I0_A,
        I2_A: f.I2_A,
        voltage: f.voltage,
        voltage_kV: kV,
        description: f.description,
      });
    }
  }

  /* Pass 3 -- relays, elements, devices, combines, grades. */
  for (const item of doc.items) {
    switch (item.type) {
      case 'relay': {
        const relay = resolveRelay(item, study);
        study.relays.set(relay.id, relay);
        break;
      }
      case 'element':
        study.looseElements.push(
          resolveElement(item, undefined, study, undefined, undefined),
        );
        break;
      case 'device':
        study.devices.set(item.id, {
          id: item.id,
          kind: item.kind,
          voltage: item.voltage,
          voltage_kV: item.voltage ? study.voltages.get(item.voltage)?.kV : undefined,
          maker: item.maker,
          model: item.model,
          rating_A: item.rating_A,
          rating_kV: item.rating_kV,
          rating_MVA: item.rating_MVA,
          flex_points: sortPoints(item.flex_points),
          min_melt: sortPoints(item.min_melt),
          total_clear: sortPoints(item.total_clear),
          t_delay_s: item.t_delay,
          description: item.description,
        });
        break;
      case 'point':
        /*
         * One `StudyPoint` per condition named, so that nothing
         * downstream has to know a point could stand for several. With
         * more than one the id is qualified, because it is the key
         * duplicate detection and the hover readout work from.
         */
        {
          /* Counted after de-duplication, so a name written twice still
           * produces one unqualified marker. */
          const conditions = expandConditions(item.conditions);
          for (const condition of conditions) {
            const suffix = conditions.length > 1 && condition ? ` · ${condition}` : '';
            study.points.push({
              id: `${item.id}${suffix}`,
              views: item.views,
              I_A: item.I_A,
              I1_A: item.I1_A,
              I2_A: item.I2_A,
              I0_A: item.I0_A,
              earth_A: item.earth_A,
              type: isFaultType(item.faultType) ? item.faultType : undefined,
              t_s: item.t_s,
              condition,
              label: item.label ? `${item.label}${suffix}` : undefined,
              voltage: item.voltage,
              voltage_kV: item.voltage ? study.voltages.get(item.voltage)?.kV : undefined,
              color: item.color,
              shape: item.shape,
              coords: item.coords,
              description: item.description,
            });
          }
        }
        break;
      case 'annotate':
        for (const condition of expandConditions(item.conditions)) {
          study.annotations.push({
            /* Two references means a margin; one means a point. */
            /* Two references and a time is a current margin; two and a
             * current (or a condition) is the usual time margin. */
            /*
             * A time margin spans two curves vertically at one current.
             * A current margin spans horizontally at one time, from a
             * curve to another curve, a condition, or a marked point.
             */
            /*
             * A span names both its ends outright, so it is decided
             * first: it needs neither a curve nor a reference, and
             * asking about `primary` before `from` would file one as a
             * point with no position.
             */
            kind: spanOf(item) != null
              ? 'span'
              : item.at_t_s != null && item.primary
                ? 'current_margin'
                : (item.primary && item.backup ? 'margin' : 'point'),
            span: spanOf(item),
            on_curve: item.on_curve,
            primary: item.primary,
            backup: item.backup,
            condition,
            at_I_A: item.at_I_A,
            at_t_s: item.at_t_s,
            pointRef: item.pointRef,
            voltage: item.voltage,
            views: item.views,
            at_I1_A: item.at_I1_A,
            at_I2_A: item.at_I2_A,
            at_I0_A: item.at_I0_A,
            at_earth_A: item.at_earth_A,
            type: isFaultType(item.faultType) ? item.faultType : undefined,
            label: item.label,
            style: item.style ?? 'leader',
            color: item.color,
            coords: item.coords,
          });
        }
        break;
      case 'combine':
        study.combines.push({
          name: item.name,
          sources: item.sources,
          as: item.as,
          color: item.color,
          style: item.style,
          label: item.label,
        });
        break;
      case 'grade':
        study.grades.push({
          primary: item.primary,
          backup: item.backup,
          fault: item.fault,
          scenario: item.scenario,
          CTI_min_s: item.CTI_min_s,
          margin_s: item.margin_s,
          tolerance_pct: item.tolerance_pct,
          comment: item.comment,
          upstream: item.upstream,
          upstream_to_A: item.upstream_to_A,
          solve: item.solve
            ? {
                strategy: item.solve.strategy ?? 'tight',
                tolerance_pct: item.solve.tolerance_pct,
                free: item.solve.free?.length ? item.solve.free : ['tms'],
              }
            : undefined,
          node: item,
        });
        break;
      default:
        break;
    }
  }

  return study;
}

function resolveRelay(node: Extract<TopLevel, { type: 'relay' }>, study: Study): Relay {
  const scalars = node.members.filter((m) => m.kind === 'scalar') as Array<{
    kind: 'scalar'; key: string; value: unknown;
  }>;
  const get = (key: string): unknown => scalars.find((m) => m.key === key)?.value;

  const voltage = readString(get('voltage'));
  const relay: Relay = {
    id: node.id,
    name: readString(get('name')),
    maker: readString(get('maker')),
    model: readString(get('model')),
    voltage,
    voltage_kV: voltage ? study.voltages.get(voltage)?.kV : undefined,
    ct_ratio: readRatio(get('ct_ratio')),
    direction: readString(get('direction')),
    faults: readStringList(get('faults')),
    elements: [],
  };

  /*
   * Spec _Defaults_: a relay with no `voltage` in a study that has
   * exactly one level sits on that level. With several levels the
   * validator warns (RELAY_VOLTAGE_UNSPECIFIED) and the grade falls
   * back to the fault's own level.
   */
  if (!relay.voltage && study.voltages.size === 1) {
    const only = [...study.voltages.values()][0];
    relay.voltage = only.name;
    relay.voltage_kV = only.kV;
  }

  for (const m of node.members) {
    if (m.kind !== 'element') continue;
    relay.elements.push(
      resolveElement(m.element, relay.id, study, relay.ct_ratio, relay),
    );
  }
  return relay;
}

/**
 * A declared ceiling on where a curve stops, in primary amps.
 *
 * Zero and negative are dropped rather than honoured: a curve that
 * stops at or before nothing is not a shorter curve, it is no curve,
 * and silently drawing none is worse than ignoring the figure.
 */
function currentCeiling(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const read = amps(raw);
  return Number.isFinite(read.value) && read.value > 0 ? read.value : undefined;
}

/**
 * How one curve is drawn, where the study overrides the palette.
 *
 * Read the same way for an element and for a stage, so a stage
 * inherits whatever its element declared unless it says otherwise --
 * which is what lets a multi-stage element be given one colour and one
 * of its stages a different dash.
 */
function drawingOverrides(
  pick: (key: string) => unknown,
): { color?: string; style?: CurveStyle; width_px?: number } {
  const style = readString(pick('style'));
  const width = rawNumber(pick('width_px'));
  return {
    color: readString(pick('color')),
    /* An unrecognised word is dropped here and reported by the
     * validator, so a typo cannot silently produce a solid line. */
    style: isCurveStyle(style) ? style : undefined,
    width_px: Number.isFinite(width) && width > 0 ? width : undefined,
  };
}

/**
 * The two ends of an annotate span, when both are present and agree.
 *
 * A `from` in amps against a `to` in seconds is not a span at all --
 * there is no line between a current and a time -- so it resolves to
 * nothing here and is reported by the validator.
 */
function spanOf(
  item: { from?: SpanEnd; to?: SpanEnd },
): { quantity: 'current' | 'time'; from: number; to: number } | undefined {
  const { from, to } = item;
  if (!from || !to) return undefined;
  if (from.quantity !== to.quantity) return undefined;
  if (!Number.isFinite(from.value) || !Number.isFinite(to.value)) return undefined;
  return { quantity: from.quantity, from: from.value, to: to.value };
}

function resolveElement(
  node: ElementBlock,
  relayId: string | undefined,
  study: Study,
  ctRatio: number | undefined,
  relay: Relay | undefined,
): Element {
  const stagesValue = member(node, 'stages') as { stages?: StageBlock[] } | undefined;
  const staged = Array.isArray(stagesValue?.stages) && stagesValue.stages.length > 0;

  const elementName = readString(
    (node.members.find((m) => m.kind === 'scalar' && m.key === 'name') as
      { value?: unknown } | undefined)?.value,
  );
  const ref = relayId ? `${relayId}:${node.id}` : node.id;

  const element: Element = {
    id: node.id,
    name: elementName,
    label: displayLabel(relay?.name, relayId, elementName, node.id, ref),
    relayId,
    maker: relay?.maker,
    model: relay?.model,
    ct_ratio: ctRatio,
    ref,
    stages: [],
    staged,
    current_max_A: currentCeiling(member(node, 'current_max')),
    ...drawingOverrides((key) => member(node, key)),
    voltage: relay?.voltage,
    voltage_kV: relay?.voltage_kV,
    node,
  };

  if (staged) {
    /*
     * Stage-level fields fall back to the element that owns them, so
     * a pickup declared once on the element applies to every stage
     * that does not restate it.
     */
    for (const st of stagesValue!.stages!) {
      element.stages.push(resolveStage(st, node, ctRatio, study));
    }
  } else {
    element.stages.push(resolveStage(node, undefined, ctRatio, study));
  }
  return element;
}

function resolveStage(
  node: ElementBlock | StageBlock,
  fallback: ElementBlock | undefined,
  ctRatio: number | undefined,
  study: Study,
): Stage {
  const pick = (key: string): unknown => {
    const own = member(node, key);
    if (own !== undefined) return own;
    return fallback ? member(fallback, key) : undefined;
  };
  const declared = (key: string): boolean =>
    has(node, key) || (fallback ? has(fallback, key) : false);

  const id = node.type === 'stage' ? node.id : 'main';

  const I_units =
    (readString(pick('I_units')) as 'primary' | 'secondary' | undefined) ?? study.I_units;
  const pickup = amps(pick('I_pickup'));
  const I_pu_declared = Number.isFinite(pickup.value) ? pickup.value : undefined;

  /*
   * Spec _Input units_: `I_pu_primary = I_pu_declared * n_CT` when the
   * element is dialled in secondary amps. A `pu` / `xCT` / `xIn`
   * suffix means the same multiplication regardless of `I_units`.
   *
   * An `A_sec` / `A_pri` suffix decides it for this value alone and
   * outranks `I_units`, so one primary figure can sit in an element
   * otherwise dialled in secondary amps without restating the block.
   */
  const inSecondary = pickup.secondary
    || pickup.perUnit
    || (I_units === 'secondary' && !pickup.primary);

  let I_pu_A = I_pu_declared;
  if (I_pu_declared != null && inSecondary) {
    I_pu_A = ctRatio != null ? I_pu_declared * ctRatio : undefined;
  }

  const tmsRaw = rawNumber(pick('tms'));
  const tDelay = seconds(pick('t_delay'));
  const tReset = seconds(pick('t_reset'));
  const currentPct = rawNumber(pick('share'));
  const charAngle = rawNumber(pick('char_angle'));

  return {
    id,
    producer: resolveProducer(node, fallback, declared),
    I_pu_A,
    I_pu_declared,
    I_pu_in_secondary: I_pu_declared != null ? inSecondary : undefined,
    I_units,
    tms: Number.isFinite(tmsRaw) ? tmsRaw : undefined,
    t_delay_s: Number.isFinite(tDelay.value) ? tDelay.value : undefined,
    t_reset_s: Number.isFinite(tReset.value) ? tReset.value : undefined,
    reset: readString(pick('reset')) as Stage['reset'],
    current_pct: Number.isFinite(currentPct) ? currentPct : 100,
    function: readString(pick('function')),
    measures: readString(pick('measures')),
    directional: readBoolean(pick('directional')),
    char_angle_deg: Number.isFinite(charAngle) ? charAngle : undefined,
    /* `pick` already falls back to the owning element, so a stage
     * inherits its ceiling and its ink without restating either. */
    current_max_A: currentCeiling(pick('current_max')),
    ...drawingOverrides(pick),
    node,
  };
}

function resolveProducer(
  node: ElementBlock | StageBlock,
  fallback: ElementBlock | undefined,
  declared: (key: string) => boolean,
): CurveProducer | undefined {
  const pick = (key: string): unknown => {
    const own = member(node, key);
    if (own !== undefined) return own;
    return fallback ? member(fallback, key) : undefined;
  };

  const flex = pick('flex_points') as { points?: FlexPoint[] } | undefined;
  if (flex?.points && flex.points.length > 0) {
    return { kind: 'flex', points: sortPoints(flex.points)! };
  }

  const formula = pick('formula') as Record<string, number> | undefined;
  if (formula && typeof formula === 'object' && !('kind' in formula)) {
    const k = rawNumber(formula.k);
    if (Number.isFinite(k)) {
      return {
        kind: 'formula',
        k,
        c: Number.isFinite(rawNumber(formula.c)) ? rawNumber(formula.c) : 0,
        alpha: Number.isFinite(rawNumber(formula.alpha)) ? rawNumber(formula.alpha) : 0,
      };
    }
  }

  const curveId = readString(pick('curve'));
  if (curveId === 'definite') return { kind: 'definite' };
  if (curveId) {
    const ix = curveId.indexOf('.');
    if (ix > 0) {
      const constants = lookupCurve(curveId.slice(0, ix), curveId.slice(ix + 1));
      if (constants) return { kind: 'standard', id: curveId, constants };
    }
    /* Unknown identifier: the validator reports it; no curve is drawn. */
    return undefined;
  }

  /*
   * Spec _Stage idempotency_: a stage carrying only `t_delay` is a
   * legacy spelling of `curve = definite`.
   */
  if (declared('t_delay')) return { kind: 'definite' };
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function scalarToPrimitive(v: unknown): string | number | boolean {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.kind === 'number') return o.value as number;
    if (o.kind === 'string') return o.value as string;
    if (o.kind === 'boolean') return o.value as boolean;
    if (Array.isArray(o)) return (o as unknown[]).join(', ');
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/**
 * What to call a characteristic on the drawing.
 *
 * With no names declared this is exactly the reference (`R_FDR:51`),
 * so nothing changes for a study that does not use them. Once either
 * side is named the parts are joined with a middot instead: a name is
 * free text, and `Incomer 11 kV, panel 3:Phase OC` reads as though the
 * colon were structural when it is not.
 */
function displayLabel(
  relayName: string | undefined,
  relayId: string | undefined,
  elementName: string | undefined,
  elementId: string,
  ref: string,
): string {
  if (!relayName && !elementName) return ref;
  const parts = [relayId ? (relayName ?? relayId) : relayName, elementName ?? elementId];
  return parts.filter(Boolean).join(' · ');
}

function readStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => readString(x) ?? '').filter(Boolean);
  const s = readString(v);
  return s ? [s] : [];
}

function sortPoints(points: FlexPoint[] | undefined): FlexPoint[] | undefined {
  if (!points || points.length === 0) return undefined;
  return [...points].sort((a, b) => a.I_A - b.I_A);
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

/** Every element in the study, whether nested in a relay or top-level. */
export function allElements(study: Study): Element[] {
  const out: Element[] = [];
  for (const relay of study.relays.values()) out.push(...relay.elements);
  out.push(...study.looseElements);
  return out;
}

/**
 * Resolve a `R_FDR_1:51` / `51` / `ferraz_abc_100a` reference to the
 * element or device it names.
 */
export function resolveRef(
  study: Study,
  ref: Ref | undefined,
): { element?: Element; device?: Device } {
  if (!ref) return {};
  if (ref.deviceId && ref.elementId) {
    const relay = study.relays.get(ref.deviceId);
    const element = relay?.elements.find((e) => e.id === ref.elementId);
    if (element) return { element };
    return {};
  }
  const id = ref.deviceId ?? ref.text;
  if (!id) return {};
  const device = study.devices.get(id);
  if (device) return { device };
  const loose = study.looseElements.find((e) => e.id === id);
  if (loose) return { element: loose };
  return {};
}
