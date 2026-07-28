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
  I_base_A?: number;
  I_units?: 'primary' | 'secondary';
  voltages: VoltageLevelDecl[];
}

export interface FaultDecl extends BaseNode {
  name: string;
  I_A: number;
  min_A?: number;
  max_A?: number;
  earth_A?: number;
  I0_A?: number;
  I2_A?: number;
  voltage?: string;
  description?: string;
}

export interface FaultsBlock extends BaseNode {
  type: 'faults';
  faults: FaultDecl[];
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
  /** Margin form: name a declared fault instead of a bare current. */
  fault?: string;
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
  /** View the TCC in a chosen voltage frame. */
  voltage?: string;            // 'pickup', 'HV', '33 kV', '0.48 kV'...
  stages?: 'composite' | 'individual';
  axis?: 'primary' | 'secondary' | 'multiples';
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

export interface PageLegend extends BaseNode {
  show?: boolean;
  position?: 'right' | 'left' | 'top' | 'bottom';
  color?: string;
  swatch?: 'line' | 'box' | 'circle';
  title?: string;
}

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
  title?: string | PageTitle;
  footer?: PageFooter;
  theme?: 'light' | 'dark' | 'monochrome' | 'print';
  watermark?: string;
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
  /** Current in primary amps at `voltage`. */
  I_A: number;
  /** Time in seconds. */
  t_s: number;
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
