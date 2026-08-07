/**
 * AST types for the .ptc (time-current grading) language.
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

/**
 * Where a value was written.
 *
 * Only blocks used to carry a location, so a diagnostic about a value
 * -- a suffix in the wrong place, a number out of range -- had nowhere
 * to point and reported at 1:1. Thirteen codes did that, and 1:1 is a
 * clickable go-to-line that lands the reader at the top of the file.
 *
 * Optional because a value can also be synthesised (a stage lifted out
 * of an element's shorthand), and a synthetic node honestly has no
 * position in the source.
 */
export interface ValueLocation { loc?: SourceLocation }

export type ScalarValue =
  | ({ kind: 'number'; value: number; unit?: string } & ValueLocation)
  | ({ kind: 'string'; value: string } & ValueLocation)
  | ({ kind: 'boolean'; value: boolean } & ValueLocation)
  | ({ kind: 'ratio'; numerator: number; denominator: number } & ValueLocation);

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
  /**
   * Study MVA base, for the pickup-plausibility check.
   *
   * `frequency_Hz` and `grounding` used to sit beside this. Both were
   * parsed, stored and read by nothing; `zero_sequence` declares the
   * one thing `grounding` was reaching for.
   */
  base_S?: number;
  /**
   * Whether zero sequence crosses between two levels.
   *
   * A delta winding blocks it; a star-star with both neutrals earthed
   * passes it. The tool cannot know which, so the study says.
   */
  zero_sequence?: ZeroSequenceDecl[];
  /**
   * The transformers between the levels, by nameplate vector group.
   *
   * The turns ratio alone refers a *balanced* current correctly and
   * nothing else: a delta-star transition redistributes the phase
   * currents, so a phase-phase fault on the star side comes out 2:1:1
   * on the delta lines. Which it is depends on the windings, not the
   * voltages, so the study says.
   *
   * It also settles zero-sequence continuity, which
   * {@link ZeroSequenceDecl} previously had to be told by hand.
   */
  transformers?: TransformerDecl[];
  I_base_A?: number;
  I_units?: 'primary' | 'secondary';
  voltages: VoltageLevelDecl[];
}

/**
 * What a reader sees for a declared thing.
 *
 * The id is a handle and the `name` is prose; where no prose was given
 * the handle stands in, which is what makes `name` optional without
 * leaving anything unlabelled. Written once so that no site has to
 * decide for itself, and so that "which of the two is this?" is
 * answered by which function was called.
 */
export function displayName(x: { id: string; name?: string }): string {
  return x.name ?? x.id;
}

export interface FaultDecl extends BaseNode, ComponentRange {
  /**
   * Sheets this belongs to, by `view` name. Absent means every sheet.
   *
   * A study with a phase sheet and a negative-sequence sheet routinely
   * has marks that mean something on one and nothing on the other, and
   * before this the only way to keep them apart was two files.
   */
  views?: string[];

  /** How the study refers to this fault. A bare identifier. */
  id: string;
  /** What the reader sees. Defaults to the id. */
  name?: string;
  /**
   * What kind of fault this is. Supplies the ratios between phase
   * current and the sequence components, so a component the study does
   * not declare can be derived and a curve can be placed on an axis
   * drawn in another quantity. A declared component always wins.
   */
  type?: FaultTypeKeyword;
  I_A: number;
  I1_A?: number;
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
/**
 * The low and high figures a condition can take, per component.
 *
 * A study's fault levels come as a range, and the range is as much a
 * sequence quantity as the centre is. Declaring it per component means
 * a study that knows its negative-sequence minimum writes it, rather
 * than working backwards through the ratio to a phase figure it never
 * measured -- and rather than the tool deriving one from an assumed
 * fault shape.
 *
 * Every field is optional. An undeclared range is carried across from
 * the phase range by the same factor the component's own value was, so
 * the common case still says it once.
 */
export interface ComponentRange {
  min_A?: number;
  max_A?: number;
  I1_min_A?: number;
  I1_max_A?: number;
  I2_min_A?: number;
  I2_max_A?: number;
  I0_min_A?: number;
  I0_max_A?: number;
  earth_min_A?: number;
  earth_max_A?: number;
}

export interface ScenarioLevelDecl extends BaseNode, ComponentRange {
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
  /**
   * Sheets this condition belongs to. Absent means every sheet.
   *
   * A `fault` could be scoped and a `scenario` could not, so a study
   * with two independent chains drew each chain's conditions on the
   * other chain's sheets -- and listed the ones it could not place in
   * the notes, on a sheet they had no business appearing on.
   */
  views?: string[];
  type: 'scenario';
  /** How the study refers to this condition. A bare identifier. */
  id: string;
  /** What the reader sees. Defaults to the id. */
  name?: string;
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
  /**
   * Sheets this belongs to, by `view` name. Absent means every sheet.
   *
   * A study with a phase sheet and a negative-sequence sheet routinely
   * has marks that mean something on one and nothing on the other, and
   * before this the only way to keep them apart was two files.
   */
  views?: string[];

  /** How the study refers to this required time. A bare identifier. */
  id: string;
  /** What the reader sees. Defaults to the id. */
  name?: string;
  /** The required time, in seconds. */
  t_s: number;
  /**
   * Where along the rule to put its caption, as a current read off the
   * sheet's own axis. The rule spans the whole plot, so its name has no
   * natural anchor; without this it goes at the left-hand end, which is
   * not always where there is room or where the reader is looking.
   */
  at_I_A?: number;
  /**
   * The same component vocabulary a `fault`, a `point` and an
   * `annotate` use, because the abscissa is not always phase current.
   *
   * A caption anchored at a phase figure lands in the wrong place on
   * an `I2` or `3I0` sheet -- not off the rule, which spans the plot,
   * but beside a current that means nothing there.
   */
  at_I1_A?: number;
  at_I2_A?: number;
  at_I0_A?: number;
  at_earth_A?: number;
  faultType?: FaultTypeKeyword;
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

/** `transformer HV to LV { vector_group = "Dyn11"; }` */
export interface TransformerDecl extends BaseNode {
  from: string;
  to: string;
  /** As written on the nameplate; parsed by `constants/vector-groups`. */
  vector_group?: string;
  /** Location of the group string itself, for an anchored diagnostic. */
  groupLoc?: BaseNode['loc'];
}

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
export type SolveFreeKeyword = 'tms' | 't_delay' | 'I_pickup';

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
/**
 * One end of a `from` / `to` span, and which axis it is measured on.
 */
export interface SpanEnd {
  value: number;
  /** Amps for `current`, seconds for `time`. */
  quantity: 'current' | 'time';
}

export interface AnnotateBlock extends BaseNode {
  /**
   * Optional handle. The only drawable block with no way to be named,
   * so nothing could refer to a mark the study had already drawn.
   */
  id?: string;
  /**
   * Sheets this belongs to, by `view` name. Absent means every sheet.
   *
   * A study with a phase sheet and a negative-sequence sheet routinely
   * has marks that mean something on one and nothing on the other, and
   * before this the only way to keep them apart was two files.
   */
  views?: string[];

  type: 'annotate';
  /** Point form: the curve being marked. */
  on_curve?: Ref;
  /**
   * Current at which to place the annotation, in primary amps.
   *
   * Read at `voltage` -- the level named below, or the view's. Without
   * a level a bare figure was taken in *each* referenced element's own
   * frame, so one number meant two different currents across a
   * transformer and the drawn margin contradicted the report.
   */
  at_I_A?: number;
  /**
   * Level `at_I_A` is measured at. Defaults to the view's, which is
   * the axis the number was read off.
   */
  voltage?: string;
  /**
   * The same component vocabulary a `fault`, a `scenario` level and a
   * `point` use, because the abscissa is not always phase current.
   *
   * `at_I_A` named a phase current, which invited one to be written
   * and then land on an `I2` or `3I0` axis. Naming the component
   * removes the guess; `type` derives the rest where only one is
   * given.
   */
  at_I1_A?: number;
  at_I2_A?: number;
  at_I0_A?: number;
  at_earth_A?: number;
  faultType?: FaultTypeKeyword;
  /**
   * Time at which to measure a *current* margin, in seconds.
   *
   * The horizontal counterpart of the vertical margin arrow: with
   * `primary` and `backup`, it spans the gap in current between the two
   * characteristics at one time, and labels it as a percentage of the
   * primary's current. That is how a current-grading margin is quoted
   * -- "the backup picks up 40% above" -- rather than in amps, which
   * means nothing without knowing which end of the axis you are at.
   */
  at_t_s?: number;
  /**
   * The two ends of a *span*: a dimension between two figures the
   * study names, rather than between two characteristics.
   *
   * A grading band an authority requires, the window a setting has to
   * fall inside, the range a supplier quotes for a fuse -- none of
   * these is a curve, so none could be drawn. `from` and `to` put an
   * arbitrary dimension on the sheet and label it.
   *
   * The *unit* decides the orientation: two times draw a vertical
   * span, two currents a horizontal one. Units are mandatory
   * everywhere else precisely so a figure cannot be misread, and
   * taking the orientation from a separate key would let the two
   * disagree.
   */
  from?: SpanEnd;
  to?: SpanEnd;
  /**
   * A marked point the current margin is measured to, by id.
   *
   * The far end of a current margin need not be another characteristic:
   * a pickup is as often quoted against a fault level or against an
   * inrush point ("120% of the inrush peak", "35% below the minimum
   * two-phase fault") as against another relay.
   */
  pointRef?: string;
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

/**
 * A protection chain: the devices in series on one path.
 *
 * Declared as an ordered sequence, upstream first, because the order is
 * what will enumerate grading pairs once topology lands -- and because
 * writing it unordered would imply the order does not matter, which on
 * a radial feeder is the one thing that does.
 *
 * A group holds *devices*. Times, points and annotations name a group
 * rather than being listed by one: they are not part of a chain, they
 * are requirements and observations about it, and allowing both
 * directions would need a precedence rule between two mechanisms that
 * mean the same thing.
 */
export interface GroupBlock extends BaseNode {
  type: 'group';
  id: string;
  name?: string;
  description?: string;
  /** Relay ids, upstream first. */
  members: string[];
}

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
  /**
   * The level the combined curve is stated at, as named in
   * `system.voltages`.
   *
   * A combine folds several curves into one, and a curve is only a
   * curve at some voltage: the sources may sit on either side of a
   * transformer, where one current is not the other. Left out, it is
   * taken from the sources when they agree; where they do not, the
   * study must say which bus the envelope is read at.
   */
  voltage?: string;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  label?: string;
}

export interface ViewBlock extends BaseNode {
  /**
   * Things declared inside this sheet.
   *
   * `times`, `point` and `annotate` may be written in a `view`, where
   * they belong to that sheet and no other. It is exactly equivalent to
   * declaring them at the top level with `views = [this sheet]`, and is
   * hoisted to that during resolution -- but with no name to spell, no
   * name to keep in step, and no way to be scoped somewhere else by
   * mistake.
   *
   * Only things that exist to be drawn may nest. A relay element is a
   * real setting in a real device: it exists whether or not it is
   * drawn, and nesting it would put one relay's settings in three
   * places.
   */
  nested?: TopLevel[];
  /**
   * The protection chain this sheet draws.
   *
   * Selects the relays whose elements belong here, so a study says once
   * which relays are on a path instead of every element listing every
   * sheet it appears on. An element's own `views` still wins, for the
   * exceptions -- an incomer's phase element shown on a sequence sheet
   * as backup is a real one.
   */
  group?: string;
  /**
   * How the study refers to this sheet -- what a `views` list matches.
   *
   * Separate from `name` because they used to be one field: the block
   * id was written into `name` and a `name =` key then overwrote it,
   * so a view with a caption had no handle at all and every `views`
   * entry naming it silently matched nothing.
   */
  id?: string;
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
   * Draw this sheet when nothing else selects one.
   *
   * There is no multi-page output, so a file declaring several sheets
   * has to be able to say which one a plain `render` produces --
   * otherwise the answer is "whichever you wrote first", and choosing
   * means reordering the file. The CLI's `--view` overrides it.
   */
  isDefault?: boolean;
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
  /**
   * The author's own remarks, drawn at the foot of the panel.
   *
   * Distinct from `Notes`, which the tool writes about what it could
   * not do. This is the standing text every drawing office wants on a
   * sheet -- the issue it was checked against, the assumption the
   * study rests on, who to ask -- and there was nowhere for it: `meta`
   * is metadata rather than something drawn, and the title block takes
   * a line, not a paragraph.
   *
   * Written as one string or as a list of lines; a `\n` inside a
   * single string breaks it the same way.
   */
  comment?: string[];
  /**
   * Draw the `Notes` block at the foot of the panel. Defaults to true.
   *
   * The notes are how a sheet accounts for what it left out, so they
   * are on by default -- but a drawing being issued to someone who
   * does not need the workings can turn them off, and get the space
   * back for the curves.
   *
   * `false` is the only thing that removes them silently. Where the
   * panel is merely short of room they are reduced to a count and a
   * pointer to the report, because a sheet that quietly drops
   * something is the failure these notes exist to prevent.
   */
  notes?: boolean;
}

/** Spellings of {@link PageLegend.currents}. */
export type LegendCurrents = 'primary' | 'secondary' | 'both';

/** How a set of gridlines is stroked. */
export type GridStyle = 'solid' | 'dashed' | 'dotted';

export interface PageAxes extends BaseNode {
  color?: string;
  grid_color?: string;
  /**
   * The minor gridlines, separately from the major ones.
   *
   * A log axis draws nine lines per decade and only one of them is a
   * labelled power of ten. Told apart by weight alone the reader has
   * to count to find the decade; a different colour or dash says it at
   * a glance. Unset, the minor lines take the major colour, as they
   * always did.
   */
  grid_minor_color?: string;
  grid_style?: GridStyle;
  grid_minor_style?: GridStyle;
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
  /**
   * Print each fault's current beside its name. Defaults to true.
   *
   * The figure is the reason the rule is drawn, so it belongs on the
   * sheet -- but a study with a dozen conditions at similar currents
   * is a band of numbers, and an office that quotes them in the
   * legend instead wants the band back.
   */
  currents?: boolean;
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
  /**
   * Sheets this belongs to, by `view` name. Absent means every sheet.
   *
   * A study with a phase sheet and a negative-sequence sheet routinely
   * has marks that mean something on one and nothing on the other, and
   * before this the only way to keep them apart was two files.
   */
  views?: string[];

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
  /**
   * One stage of a multi-stage element, as `R_850:46/energ`.
   *
   * Without it a reference means the element as a whole -- the
   * composite, which is what the relay trips at. A study whose stages
   * are alternatives under different conditions (one inrush-blocked,
   * one not) needs to point at the one that is armed, and an
   * annotation about the energisation stage should say so rather than
   * quietly describing the fastest.
   */
  stageId?: string;
  /** Raw text as written, for round-trip stability. */
  text: string;
  /**
   * Where the reference was written.
   *
   * A diagnostic about a reference -- an unresolved element, a stage
   * that does not exist -- has to be able to point at it. Without this
   * they all reported at 1:1, which on a study of any size means the
   * reader is told there is a problem and left to find it.
   */
  loc?: SourceLocation;
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
  | GroupBlock
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
