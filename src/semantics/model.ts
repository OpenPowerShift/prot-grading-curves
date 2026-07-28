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
  StageBlock,
  TopLevel,
} from '../parser/ast.js';
import { lookupCurve, type CurveConstants } from '../constants/curves.js';
import { amps, rawNumber, readBoolean, readRatio, readString, seconds } from './units.js';

/* ------------------------------------------------------------------ */
/* Model types                                                         */
/* ------------------------------------------------------------------ */

export interface VoltageLevel {
  name: string;
  kV: number;
  description?: string;
}

export interface Fault {
  name: string;
  /** Declared current, in primary amps *at its own voltage level*. */
  I_A: number;
  /** Range endpoints; both default to `I_A` (spec: _CTI computation_). */
  min_A: number;
  max_A: number;
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
  I_units?: 'primary' | 'secondary';
  tms?: number;
  /** `true` when the solver, not the source, set `tms`. */
  tms_auto?: boolean;
  t_delay_s?: number;
  t_reset_s?: number;
  reset?: 'instant' | 'dependent' | 'disk_emulation';
  /** Share of the total fault current this stage sees, in percent. */
  current_pct: number;
  function?: string;
  directional?: boolean;
  char_angle_deg?: number;
  /** Source AST node, for error locations. */
  node: ElementBlock | StageBlock;
}

export interface Element {
  id: string;
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
  voltage?: string;
  voltage_kV?: number;
  node: ElementBlock;
}

export interface Relay {
  id: string;
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

export interface Device {
  id: string;
  kind?: string;
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
    free: Array<'tms' | 't_delay' | 'I_pu'>;
  };
  node: GradeBlock;
}

/** A marked (I, t) coordinate -- inrush, motor start, damage point. */
export interface StudyPoint {
  id: string;
  I_A: number;
  t_s: number;
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
  kind: 'point' | 'margin';
  on_curve?: Ref;
  primary?: Ref;
  backup?: Ref;
  fault?: string;
  at_I_A?: number;
  label?: string;
  style: 'leader' | 'pin' | 'tag';
  color?: string;
  coords?: boolean;
}

export interface Study {
  meta: Record<string, string | number | boolean>;
  voltages: Map<string, VoltageLevel>;
  frequency_Hz?: number;
  base_MVA?: number;
  grounding?: string;
  I_base_A?: number;
  I_units: 'primary' | 'secondary';
  faults: Map<string, Fault>;
  relays: Map<string, Relay>;
  /** Elements declared at the top level, outside any relay. */
  looseElements: Element[];
  devices: Map<string, Device>;
  combines: Combine[];
  grades: Grade[];
  points: StudyPoint[];
  annotations: Annotation[];
  view?: Extract<TopLevel, { type: 'view' }>;
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

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export function buildStudy(doc: Document): Study {
  const study: Study = {
    meta: {},
    voltages: new Map(),
    I_units: 'primary',
    faults: new Map(),
    relays: new Map(),
    looseElements: [],
    devices: new Map(),
    combines: [],
    grades: [],
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
        study.frequency_Hz = item.frequency_Hz;
        study.base_MVA = item.base_MVA;
        study.grounding = item.grounding;
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
      case 'view':
        study.view = item;
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

  /* Pass 2 -- faults, now that voltage levels resolve. */
  for (const item of doc.items) {
    if (item.type !== 'faults') continue;
    for (const f of item.faults) {
      const kV = f.voltage ? study.voltages.get(f.voltage)?.kV : undefined;
      study.faults.set(f.name, {
        name: f.name,
        I_A: f.I_A,
        min_A: f.min_A ?? f.I_A,
        max_A: f.max_A ?? f.I_A,
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
        study.points.push({
          id: item.id,
          I_A: item.I_A,
          t_s: item.t_s,
          label: item.label,
          voltage: item.voltage,
          voltage_kV: item.voltage ? study.voltages.get(item.voltage)?.kV : undefined,
          color: item.color,
          shape: item.shape,
          coords: item.coords,
          description: item.description,
        });
        break;
      case 'annotate':
        study.annotations.push({
          /* Two references means a margin; one means a point. */
          kind: item.primary && item.backup ? 'margin' : 'point',
          on_curve: item.on_curve,
          primary: item.primary,
          backup: item.backup,
          fault: item.fault,
          at_I_A: item.at_I_A,
          label: item.label,
          style: item.style ?? 'leader',
          color: item.color,
          coords: item.coords,
        });
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

function resolveElement(
  node: ElementBlock,
  relayId: string | undefined,
  study: Study,
  ctRatio: number | undefined,
  relay: Relay | undefined,
): Element {
  const stagesValue = member(node, 'stages') as { stages?: StageBlock[] } | undefined;
  const staged = Array.isArray(stagesValue?.stages) && stagesValue.stages.length > 0;

  const element: Element = {
    id: node.id,
    relayId,
    maker: relay?.maker,
    model: relay?.model,
    ct_ratio: ctRatio,
    ref: relayId ? `${relayId}:${node.id}` : node.id,
    stages: [],
    staged,
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
  const pickup = amps(pick('I_pu'));
  const I_pu_declared = Number.isFinite(pickup.value) ? pickup.value : undefined;

  /*
   * Spec _Input units_: `I_pu_primary = I_pu_declared * n_CT` when the
   * element is dialled in secondary amps. A `pu` / `xCT` / `xIn`
   * suffix means the same multiplication regardless of `I_units`.
   */
  let I_pu_A = I_pu_declared;
  if (I_pu_declared != null && (I_units === 'secondary' || pickup.perUnit)) {
    I_pu_A = ctRatio != null ? I_pu_declared * ctRatio : undefined;
  }

  const tmsRaw = rawNumber(pick('tms'));
  const tDelay = seconds(pick('t_delay'));
  const tReset = seconds(pick('t_reset'));
  const currentPct = rawNumber(pick('current_pct'));
  const charAngle = rawNumber(pick('char_angle'));

  return {
    id,
    producer: resolveProducer(node, fallback, declared),
    I_pu_A,
    I_pu_declared,
    I_units,
    tms: Number.isFinite(tmsRaw) ? tmsRaw : undefined,
    t_delay_s: Number.isFinite(tDelay.value) ? tDelay.value : undefined,
    t_reset_s: Number.isFinite(tReset.value) ? tReset.value : undefined,
    reset: readString(pick('reset')) as Stage['reset'],
    current_pct: Number.isFinite(currentPct) ? currentPct : 100,
    function: readString(pick('function')),
    directional: readBoolean(pick('directional')),
    char_angle_deg: Number.isFinite(charAngle) ? charAngle : undefined,
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
