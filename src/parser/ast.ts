/**
 * AST types for the .tc (time-current grading) language.
 *
 * The AST is *pure data* with no behaviour -- resolution, computation,
 * and rendering are separate phases over the same shape.
 */

export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
}

export interface BaseNode {
  loc: SourceLocation;
}

export type ScalarValue =
  | { kind: 'number'; value: number; unit?: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'ratio'; numerator: number; denominator: number };

/* ------------------------------------------------------------------ */
/* Top-level blocks                                                    */
/* ------------------------------------------------------------------ */

export interface MetaBlock extends BaseNode {
  type: 'meta';
  entries: Record<string, ScalarValue>;
}

export interface VoltageLevelDecl extends BaseNode {
  name: string;
  kV: number;
  description?: string;
}

export interface SystemBlock extends BaseNode {
  type: 'system';
  frequency_Hz?: number;
  base_MVA?: number;
  grounding?: string;
  /**
   * Whether zero sequence crosses between two levels.
   *
   * A delta winding blocks it; a star-star with both neutrals earthed
   * passes it. The tool cannot know which, so the study says.
   */
  zero_sequence?: ZeroSequenceDecl[];
  I_base_A?: number;
  I_units?: 'primary' | 'secondary';
  voltages: VoltageLevelDecl[];
}

export interface FaultDecl extends BaseNode {
  name: string;
  /**
   * What kind of fault this is. Supplies the ratios between phase
   * current and the sequence components, so a component the study does
   * not declare can be derived and a curve can be placed on an axis
   * drawn in another quantity. A declared component always wins.
   */
  type?: FaultTypeKeyword;
  I_A: number;
  min_A?: number;
  max_A?: number;
  earth_A?: number;
  I0_A?: number;
  I2_A?: number;
  voltage?: string;
  description?: string;
}

/**
 * Symmetrical components of one condition at one voltage level.
 *
 * Declared, never derived. Sequence components do not all transform
 * the same way across a transformer -- zero sequence does not cross a
 * delta at all -- so the engineer supplies the figures their fault
 * study produced at each level, and the processor selects rather than
 * transforms.
 */
export interface ScenarioLevelDecl extends BaseNode {
  /** Named level from `system.voltages`. */
  voltage: string;
  /** Phase current, primary amps at this level. */
  I_A?: number;
  I1_A?: number;
  I2_A?: number;
  /** Zero-sequence component. */
  I0_A?: number;
  /** Residual `3*I0` declared directly, as an alternative to `I0_A`. */
  earth_A?: number;
}

/** Share of a level's current one relay carries. */
export interface ScenarioShareDecl extends BaseNode {
  relay: string;
  current_pct: number;
}

/**
 * One named system condition, with its currents at every level.
 *
 * A `fault` is one current at one level; a `scenario` is the same
 * condition described wherever it is measured, which is what lets an
 * earth-fault element on one side of a transformer and a
 * negative-sequence element on the other both be evaluated against
 * what they actually see.
 */
export interface ScenarioBlock extends BaseNode {
  type: 'scenario';
  name: string;
  /** Fault type, as on a `fault`. */
  faultType?: FaultTypeKeyword;
  description?: string;
  levels: ScenarioLevelDecl[];
  shares: ScenarioShareDecl[];
}

export interface FaultsBlock extends BaseNode {
  type: 'faults';
  faults: FaultDecl[];
}

/**
 * A required time, drawn as a horizontal rule.
 *
 * The other axis's answer to a `fault`. A coordination study is judged
 * against currents *and* against times -- an arc-flash limit, a
 * withstand, a grid-code clearance, a bus-zone requirement -- and those
 * are lines the curves must sit under or over. Written down, the sheet
 * shows the requirement beside the characteristic that has to meet it,
 * instead of the reader holding the number in their head.
 *
 * No voltage level: a second is a second on every winding, which is
 * the one way this is simpler than a fault.
 */
export interface TimeDecl extends BaseNode {
  name: string;
  /** The required time, in seconds. */
  t_s: number;
  description?: string;
}

export interface TimesBlock extends BaseNode {
  type: 'times';
  times: TimeDecl[];
}

export type RelayMember = RelayScalarMember | RelayElementMember;

export interface RelayScalarMember {
  kind: 'scalar';
  key: RelayScalarKey;
  value: ScalarValue | string[] | string;
}

export interface RelayElementMember {
  kind: 'element';
  element: ElementBlock;
}

export type RelayScalarKey =
  | 'name'
  | 'maker' | 'model' | 'voltage' | 'ct_ratio' | 'direction'
  | 'faults' | 'comment' | 'description' | 'reference';

export interface RelayBlock extends BaseNode {
  type: 'relay';
  id: string;
  members: RelayMember[];
}

/* ------------------------------------------------------------------ */
/* Element / stage                                                     */
/* ------------------------------------------------------------------ */

export type FunctionKeyword =
  | 'phase_oc' | 'earth_fault' | 'neg_seq' | 'thermal' | 'breaker_fail';

export type ResetKeyword = 'instant' | 'dependent' | 'disk_emulation';

/**
 * Current an element's pickup is expressed in.
 *
 * Defaulted from `function` where the standards make it unambiguous;
 * stated explicitly for negative sequence, where IEDs differ over the
 * factor of three. See `src/semantics/quantity.ts`.
 */
export type MeasuredQuantityKeyword =
  | 'phase' | 'I1' | 'I2' | '3I2' | 'I0' | '3I0';

/**
 * What the x axis of a sheet is.
 *
 * `any` -- the default -- draws every curve against the current axis
 * whatever it measures: no filtering, no conversion, no suppression.
 * That is the case where you simply want several curves on one sheet,
 * and the legend stating each curve's quantity is what keeps it honest.
 * Naming a specific quantity opts into strictness.
 */
export type AxisQuantityKeyword = 'any' | MeasuredQuantityKeyword;

/** What kind of fault a condition is; see `src/constants/sequence.ts`. */
export type FaultTypeKeyword =
  | 'three_phase' | 'two_phase' | 'two_phase_earth' | 'single_phase_earth';

/** Whether zero sequence is continuous between two voltage levels. */
export type ZeroSequenceLink = 'blocked' | 'continuous';

export interface ZeroSequenceDecl extends BaseNode {
  from: string;
  to: string;
  link: ZeroSequenceLink;
}

export interface ElementMember {
  kind: 'scalar';
  key: string;
  value: ScalarValue | string | number |
        { kind: 'flex_points'; points: FlexPoint[] } |
        { kind: 'flex_points_pair'; min: FlexPoint[]; total: FlexPoint[] } |
        { kind: 'stages'; stages: StageBlock[] };
}

export interface FlexPoint {
  I_A: number;
  t_s: number;
}

export interface ElementBlock extends BaseNode {
  type: 'element';
  id: string;
  members: ElementMember[];
}

export interface StageBlock extends BaseNode {
  type: 'stage';
  id: string;
  members: ElementMember[];
}

/* ------------------------------------------------------------------ */
/* Grade                                                              */
/* ------------------------------------------------------------------ */

export type SolveStrategyKeyword = 'tight' | 'loose' | 'safety_factor';
export type SolveFreeKeyword = 'tms' | 't_delay' | 'I_pu';

export interface SolveBlock extends BaseNode {
  type: 'solve';
  strategy?: SolveStrategyKeyword;
  tolerance_pct?: number;
  free?: SolveFreeKeyword[];
}

export interface GradeBlock extends BaseNode {
  type: 'grade';
  primary?: Ref;
  backup?: Ref;
  fault?: string;
  /** Named `scenario`, as an alternative to `fault`. */
  scenario?: string;
  CTI_min_s?: number;
  margin_s?: number;
  tolerance_pct?: number;
  comment?: string;
  /**
   * Sweep the margin *above* the declared fault current, not only at
   * the fault's own points. Grading that holds at the declared fault
   * can still fail further up the curve, where the two
   * characteristics converge.
   */
  upstream?: boolean;
  /** Ceiling for the upstream sweep, in primary amps at the fault's level. */
  upstream_to_A?: number;
  solve?: SolveBlock;
}

/* ------------------------------------------------------------------ */
/* Annotate                                                           */
/* ------------------------------------------------------------------ */

/**
 * A label placed on the plot.
 *
 * Two forms, distinguished by which references are present:
 *
 *   *point*  -- `on_curve` + `at_I_A`: marks one curve at one current.
 *   *margin* -- `primary` + `backup` (+ `fault` or `at_I_A`): draws the
 *               vertical gap between two curves and labels it with the
 *               computed margin. This is the annotation a coordination
 *               study is usually *for*: it puts the number the grading
 *               argument turns on directly onto the chart.
 */
export interface AnnotateBlock extends BaseNode {
  type: 'annotate';
  /** Point form: the curve being marked. */
  on_curve?: Ref;
  /** Current at which to place the annotation, in primary amps. */
  at_I_A?: number;
  /** Margin form: the faster device. */
  primary?: Ref;
  /** Margin form: the slower device. */
  backup?: Ref;
  /**
   * Named conditions instead of a bare current.
   *
   * Collected from `fault`, `faults`, `scenario` and `scenarios`, each
   * of which takes one name or a bracketed list -- they are alternative
   * spellings of one idea, so one field records them all. Naming more
   * than one draws the annotation once per condition, which is how a
   * margin is shown at both the maximum and the minimum fault on one
   * sheet.
   */
  conditions?: string[];
  label?: string;
  style?: 'leader' | 'pin' | 'tag';
  color?: string;
  /** Append the `(current, time)` coordinate to the drawn label. */
  coords?: boolean;
}

/* ------------------------------------------------------------------ */
/* Device                                                             */
/* ------------------------------------------------------------------ */

export type DeviceKind =
  | 'fuse' | 'recloser' | 'cable' | 'transformer_damage'
  | 'motor_startup' | 'breaker';

export interface DeviceBlock extends BaseNode {
  type: 'device';
  id: string;
  /**
   * Voltage level this device sits on, named in `system.voltages`.
   *
   * Distinct from `rating_kV`, which is the equipment's own insulation
   * rating. Without it a device's currents are taken as already being
   * in the view frame, so a fuse on the low side of a transformer is
   * drawn at its own amps on a sheet in the high-side frame -- out by
   * the turns ratio.
   */
  voltage?: string;
  kind?: DeviceKind;
  maker?: string;
  model?: string;
  rating_A?: number;
  rating_kV?: number;
  rating_MVA?: number;
  flex_points?: FlexPoint[];
  min_melt?: FlexPoint[];
  total_clear?: FlexPoint[];
  t_delay?: number;
  comment?: string;
  description?: string;
  reference?: string;
}

/* ------------------------------------------------------------------ */
/* Combine / view / page / notes                                      */
/* ------------------------------------------------------------------ */

export type CombineAsKeyword =
  | 'envelope_min' | 'envelope_max' | 'sum' | 'select_first';

export interface CombineBlock extends BaseNode {
  type: 'combine';
  name: string;
  sources: Ref[];
  as: CombineAsKeyword;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  label?: string;
}

export interface ViewBlock extends BaseNode {
  type: 'view';
  /**
   * Sheet name, when a study declares more than one view.
   *
   * A study routinely wants several sheets of one network -- a phase
   * sheet and a negative-sequence sheet, or the same grading under
   * two conditions. Each `view` is one sheet; naming them is what
   * lets a reader (and the playground's picker) tell them apart.
   * Unnamed views are numbered.
   */
  name?: string;
  /**
   * Title for this sheet, overriding `page { title }`.
   *
   * Per-sheet because the title is the one thing that must change
   * when the condition does -- a negative-sequence sheet headed
   * "Phase grading" is worse than no title. `page` keeps the paper
   * and the decoration; the sheet keeps what it is *of*.
   */
  title?: string;
  subtitle?: string;
  /** View the TCC in a chosen voltage frame. */
  voltage?: string;            // 'pickup', 'HV', '33 kV', '0.48 kV'...
  stages?: 'composite' | 'individual';
  axis?: 'primary' | 'secondary' | 'multiples';
  /**
   * Which current the abscissa represents.
   *
   * A TCC's x axis is one quantity. Phase current is the default, and
   * an element measuring something else -- residual `3I0`, negative
   * sequence -- has no meaningful position on it. Setting this makes
   * the sheet an earth-fault or negative-sequence sheet: the curves
   * that measure it are drawn, the fault rules stand at that
   * component's value, and the axis says so.
   */
  quantity?: AxisQuantityKeyword;
  /**
   * The condition -- a `fault` or `scenario` name -- this sheet
   * depicts. Naming it gives the renderer the fault type, and so the
   * ratios needed to convert curves onto the axis and to suppress
   * elements whose quantity that condition does not carry.
   */
  condition?: string;
  two_axes?: boolean;
  reference_ct?: Ref;
  /** Optional explicit axis bounds in seconds / amps. */
  current_min?: number;
  current_max?: number;
  time_min?: number;
  time_max?: number;
  /**
   * Extra room around the auto-fitted domain, in *decades*.
   *
   * `current_pad` / `time_pad` apply to both ends of their axis; the
   * `_low` / `_high` forms override one end. Padding is ignored on an
   * end whose bound is declared explicitly -- an explicit bound is
   * already the answer.
   */
  current_pad?: number;
  current_pad_low?: number;
  current_pad_high?: number;
  time_pad?: number;
  time_pad_low?: number;
  time_pad_high?: number;
}

export interface PageMargins extends BaseNode {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface PageScale extends BaseNode {
  auto?: boolean;
  x_min?: number;
  x_max?: number;
  y_min?: number;
  y_max?: number;
  tick_density?: 'sparse' | 'normal' | 'dense';
}

/** Where the legend lives, and whether there is one at all. */
export type LegendStyle = 'column' | 'inside' | 'direct' | 'none';

/** Corner an inside legend panel is pinned to. */
export type LegendCorner = 'top_right' | 'top_left' | 'bottom_right' | 'bottom_left';

export interface PageLegend extends BaseNode {
  show?: boolean;
  /**
   * `column` (default) reserves a gutter down the right-hand side.
   * `inside` floats the same panel over a corner of the plot, giving
   * the curves the full width of the sheet -- which is what a
   * portrait study wants, having little width to spare. `direct`
   * drops the panel and labels each characteristic in place, with a
   * leader to the curve. `none` draws no identification at all.
   */
  style?: LegendStyle;
  position?: 'right' | 'left' | 'top' | 'bottom' | LegendCorner;
  color?: string;
  swatch?: 'line' | 'box' | 'circle';
  title?: string;
  /**
   * Which amps the legend quotes a pickup in.
   *
   * Independent of `view { axis }`, which decides what the *abscissa*
   * is. A study is normally written in primary amps because that is
   * what the fault study gives, but the figure an engineer types into
   * the relay is the secondary one -- so a sheet used for commissioning
   * wants both, whatever the axis is doing. Needs the relay's
   * `ct_ratio`; without one there is nothing to convert and the pickup
   * stays primary.
   */
  currents?: LegendCurrents;
}

/** Spellings of {@link PageLegend.currents}. */
export type LegendCurrents = 'primary' | 'secondary' | 'both';

export interface PageAxes extends BaseNode {
  color?: string;
  grid_color?: string;
  label_color?: string;
  label_size_px?: number;
  tick_size_px?: number;
  frame?: boolean;
  /**
   * Repeat the tick labels on the opposite edges -- current along the
   * top as well as the bottom, time down the right as well as the
   * left. On a wide sheet a value in the far corner is a long way from
   * its axis, and mirrored scales are conventional on published TCC
   * sheets for exactly that reason.
   */
  mirror?: boolean;
}

export interface PageCurves extends BaseNode {
  palette?: string | string[];
  line_width_px?: number;
  auto_color?: boolean;
}

export interface PagePoints extends BaseNode {
  color?: string;
  shape?: 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'x';
  size_px?: number;
  outline?: boolean;
}

export interface PageLeaders extends BaseNode {
  show?: boolean;
  style?: 'line' | 'arrow' | 'dot';
  width_px?: number;
  color?: string;
  label_offset_px?: number;
}

export interface PageTitle extends BaseNode {
  text: string;
  font_size_px?: number;
  color?: string;
  subtitle?: string;
  align?: 'left' | 'center' | 'right';
}

export interface PageFooter extends BaseNode {
  left?: string;
  center?: string;
  right?: string;
  font_size_px?: number;
  color?: string;
  border?: boolean;
}

/** Styling for the fault-current markers. */
export interface PageFaults extends BaseNode {
  /** Stroke width in pixels. */
  width_px?: number;
  color?: string;
  /**
   * Line style. When omitted each fault gets its *own* dash pattern so
   * a marker can be traced to its label on a busy sheet; setting it
   * explicitly makes them uniform.
   */
  style?: 'solid' | 'dashed' | 'dotted';
  /** Draw the marker labels below the axis. Defaults to true. */
  labels?: boolean;
}

/** Styling for the horizontal rules a `times` block declares. */
export interface PageTimes extends BaseNode {
  width_px?: number;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  /** Draw the rule labels on the plot. Defaults to true. */
  labels?: boolean;
}

export interface PageBlock extends BaseNode {
  type: 'page';
  size?: string | { width_mm: number; height_mm: number };
  orientation?: 'portrait' | 'landscape';
  margins_mm?: PageMargins;
  scale?: PageScale;
  legend?: PageLegend;
  axes?: PageAxes;
  curves?: PageCurves;
  points?: PagePoints;
  leaders?: PageLeaders;
  faults?: PageFaults;
  times?: PageTimes;
  title?: string | PageTitle;
  footer?: PageFooter;
  theme?: 'light' | 'dark' | 'monochrome' | 'print';
  watermark?: string;
  /**
   * Let the plot take every pixel the furniture below it does not
   * need, instead of a fixed reserve sized for the worst case. Most
   * useful on a portrait sheet, where the unused band is tall.
   */
  stretch?: boolean;
  /**
   * Draw a drawing-office style frame around the sheet, with a title
   * block carrying the title, subtitle, and `meta` fields. Intended
   * for output that gets filed or printed.
   */
  border?: boolean;
}

/**
 * A single marked coordinate on the TCC.
 *
 * The motivating case is transformer *inrush*: a relay curve must pass
 * above and to the right of the inrush point, or the transformer trips
 * its own protection on energisation. The same construct marks motor
 * starting points, damage points, and any other (I, t) the study wants
 * to argue about.
 */
export interface PointBlock extends BaseNode {
  type: 'point';
  id: string;
  /**
   * Phase current in primary amps at `voltage`.
   *
   * `NaN` when the point takes its current from a named condition
   * instead; the two are alternatives, and declaring both is an error
   * rather than a precedence rule to remember.
   *
   * A point declares its current the way a `fault` and a `scenario`
   * level do -- `I_A` for phase, `I2_A` for negative sequence, and so
   * on -- so one vocabulary covers every current in the language. The
   * sheet then takes whichever component its axis is drawn in.
   */
  I_A: number;
  I1_A?: number;
  I2_A?: number;
  I0_A?: number;
  /** Residual `3*I0` declared directly, as an alternative to `I0_A`. */
  earth_A?: number;
  /**
   * Fault type, as on a `fault`: supplies the ratios between the
   * components, so a marker declaring only its phase current can still
   * be placed on a sheet drawn in a component.
   */
  faultType?: FaultTypeKeyword;
  /** Time in seconds. */
  t_s: number;
  /**
   * Conditions supplying the current, as on an `annotate` block.
   *
   * A point marks a time -- a breaker's clearing time, a withstand
   * limit -- and the current it belongs at is often a declared fault or
   * scenario rather than a figure to copy by hand. Naming several draws
   * one marker per condition at the same time.
   */
  conditions?: string[];
  label?: string;
  /** Voltage level this current is measured at. */
  voltage?: string;
  color?: string;
  shape?: 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'x';
  /** Append the `(current, time)` coordinate to the drawn label. */
  coords?: boolean;
  description?: string;
}

export interface NotesBlock extends BaseNode {
  type: 'notes';
  entries: Record<string, ScalarValue>;
}

/* ------------------------------------------------------------------ */
/* Refs                                                               */
/* ------------------------------------------------------------------ */

export interface Ref {
  /** Always present; for `device-ref` the elementId is undefined. */
  deviceId?: string;
  elementId?: string;
  /** Raw text as written, for round-trip stability. */
  text: string;
}

/* ------------------------------------------------------------------ */
/* Top-level container / error                                         */
/* ------------------------------------------------------------------ */

export type TopLevel =
  | MetaBlock
  | SystemBlock
  | FaultsBlock
  | TimesBlock
  | ScenarioBlock
  | RelayBlock
  | ElementBlock        // standalone element block (also inside relay.member)
  | DeviceBlock
  | GradeBlock
  | AnnotateBlock
  | CombineBlock
  | ViewBlock
  | PageBlock
  | PointBlock
  | NotesBlock;

export interface Document extends BaseNode {
  type: 'document';
  items: TopLevel[];
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
  offset: number;
  length: number;
  severity: 'error' | 'warning';
  code: string;
}

export interface ParseResult {
  document?: Document;
  errors: ParseError[];
}
