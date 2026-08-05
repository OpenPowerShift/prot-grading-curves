/**
 * Help data for the language.
 *
 * Maps the *human-readable* keyword name to a short hover-tooltip
 * doc + a small example line. The autocomplete + hover editors
 * import this and use it for hints. Adding a new keyword to the
 * parser also requires updating this file so the editor knows what
 * to suggest and what to tell the user on hover.
 *
 * Keys that appear in multiple contexts (e.g. `voltage` shows up
 * in `system.voltages` AND in `faults` AND in `relay`) get
 * NAME_SCOPE entries to disambiguate hover text.
 */

import { CURVES } from '../constants/curves.js';

export interface HelpEntry {
  /** Where in the .ptc source this construct lives. */
  scope: 'top' | 'meta' | 'system' | 'voltages' | 'faults' | 'times' | 'scenario' | 'relay'
       | 'element' | 'stage' | 'device' | 'grade' | 'solve' | 'annotate' | 'point'
       | 'combine' | 'view' | 'page';
  /** One-line summary for the hover tooltip. */
  summary: string;
  /** Example value or fragment. */
  example: string;
}

const M = (scope: HelpEntry['scope'], summary: string, example: string): HelpEntry =>
  ({ scope, summary, example });

/**
 * The entry for a word, preferring the one scoped to the block it is
 * written in.
 *
 * Several words mean different things in different places: `point` is
 * a top-level marked coordinate and also the field inside `annotate`
 * that names one; `style` is a legend layout, an annotation's drawing
 * mode, and a curve's stroke. A flat table can hold only one of each,
 * so asking about the others explained the wrong thing.
 */
export function helpFor(word: string, block?: string | null): HelpEntry | undefined {
  return (block ? KEYWORD_HELP[`${block}.${word}`] : undefined) ?? KEYWORD_HELP[word];
}

/**
 * Top-level keyword help.
 */
export const KEYWORD_HELP: Record<string, HelpEntry> = {
  // top-level
  meta:        M('top', 'Project metadata block (engineer, date, standard, defaults).', 'meta { engineer = "..."; }'),
  system:      M('top', 'Network-level declarations: named voltage levels, zero-sequence continuity between them, and the per-unit base.', 'system { voltages { ... } zero_sequence { "HV" to "LV" = blocked; } }'),
  faults:      M('top', 'Named fault-current table; each fault has a current and a voltage.', 'faults { "F1" { I = 6.4 kA; type = three_phase; voltage = "LV"; } }'),
  times:       M('top', 'Named required times, drawn as horizontal rules: the other axis\u2019s answer to a fault. An arc-flash limit, a withstand, a grid-code clearance.', 'times { "Arc flash limit" { t = 200 ms; at_I = 3 kA; } }'),
  relay:       M('top', 'A relay instance with its voltage level and current transformer ratio.', 'relay R_FDR { voltage = "LV"; ct_ratio = 600/5; ... }'),
  element:     M('top', 'A protection function on a relay -- IDMT, instantaneous, etc.', 'element 51 { curve = iec.si; ... }'),
  device:      M('top', 'Auxiliary TCC asset: fuse, cable, transformer damage, recloser, motor.', 'device "ferraz_abc_100a" { kind = fuse; ... }'),
  grade:       M('top', 'A grading pair: primary / backup / fault / margin, optionally solved.', 'grade { primary = R_FDR:51; backup = R_INC:51; ... }'),
  combine:     M('top', 'Synthetic curve -- pointwise min/max/sum of source curves.', 'combine { name = "OR"; sources = [R_FDR:51, R_INC:51]; as = envelope_min; }'),
  scenario:    M('top', 'One condition with its currents at every level, so nothing is referred across a transformer. As a field on grade, annotate or point, it names one.', 'scenario "LV earth fault" { type = single_phase_earth; level "LV" { I = 460 A; I0 = 153 A; } }'),
  annotate:    M('top', 'A leader-line annotation on a curve at a specific current, or the margin between two.', 'annotate { on_curve = R_FDR:51; at_I = 8 kA; label = "Trip"; }'),
  point:       M('top', 'A marked (current, time) coordinate. Declares its current as a fault does -- I, I2, I0, residual -- or takes it from a named condition.', 'point "inrush" { I = 2.4 kA; t = 100 ms; label = "Inrush"; }'),
  view:        M('top', 'One sheet: voltage frame, axis quantity, the condition depicted, and its own title. A study may declare several.', 'view "I2 grading" { voltage = "HV"; quantity = I2; condition = "1ph min"; }'),
  page:        M('top', 'Page geometry + theme + title. Output page layout.', 'page { size = "A4"; orientation = "landscape"; title = "..."; }'),
  notes:       M('top', 'Free-form notes attached to the document.', 'notes { revision = "draft"; }'),

  // system
  base_S:    M('system', 'System MVA base for per-unit conversions.', 'base_S = 25 MVA;'),
  I_base:    M('system', 'Per-unit base current for the whole study.', 'I_base = 5 kA;'),
  I_units:     M('system', 'Default current-units for the study ("primary" or "secondary").', 'I_units = "primary";'),

  // system.voltages
  V:          M('voltages', 'Nominal voltage of this level. Write the unit: kV, V or MV.', 'V = 33 kV;'),
  description: M('voltages', 'Free-text description.', 'description = "33 kV side";'),

  // faults
  I:         M('faults', 'Fault current at the named fault, in amperes.', 'I = 6.4 kA;'),
  I_min:       M('faults', 'Minimum fault current for this entry (lower bound of a fault range).', 'I_min = 1.5 kA;'),
  I_max:       M('faults', 'Maximum fault current for this entry.', 'I_max = 6.4 kA;'),
  I0:        M('faults', 'Zero-sequence current component.', 'I0 = 4.5 kA;'),
  I2:        M('faults', 'Negative-sequence current component.', 'I2 = 1.5 kA;'),
  'faults.voltage': M('faults', 'Voltage level name that this fault is declared at (must exist in system.voltages).', 'voltage = "LV";'),

  // relay
  'relay.voltage': M('relay', "A relay's voltage level (must exist in system.voltages).", 'voltage = "LV";'),
  maker:       M('relay', 'Vendor / maker name shown in reports.', 'maker = "ABB";'),
  model:       M('relay', 'Model name shown in reports.', 'model = "REL-615";'),
  ct_ratio:    M('relay', 'Current-transformer ratio (primary/secondary).', 'ct_ratio = 600/5;'),
  direction:   M('relay', 'Direction control: "forward", "reverse", or "none".', 'direction = "forward";'),
  'relay.faults': M('relay', 'List of faults this relay explicitly considers. Optional.', 'faults = ["F1", "F2"];'),
  comment:     M('relay', 'Inline documentation. Free text. Inside page { legend } it is standing text drawn on the sheet under a "Comment" heading -- one string, or a list of lines -- as distinct from "Notes", which the tool writes about what it could not draw.', 'comment = "primary OC element";'),

  // element
  function:    M('element', 'Function of the protection element: phase_oc, earth_fault, neg_seq, thermal, breaker_fail.', 'function = "phase_oc";'),
  curve:       M('element', 'Curve family identifier, e.g. iec.si, ansi.mi, or "definite".', 'curve = iec.si;'),
  formula:     M('element', 'Custom IDMT formula: k [s], c [s], alpha.', 'formula = { k = 0.14 s; c = 0; alpha = 0.02; }'),
  flex_points: M('element', 'Piecewise (I, t) pairs for a flex curve.', 'flex_points = [(100 A, 10 s), (1 kA, 0.1 s)];'),
  I_pickup:        M('element', 'Pickup current. Give the unit: A, kA, A_sec for the settings-sheet figure, or pu / xCT for a multiple.', 'I_pickup = 480 A;'),
  'element.I_units': M('element', "Element's per-element current-units override.", 'I_units = "secondary";'),
  tms:         M('element', 'Time Multiplier Setting -- scales an IDMT curve uniformly.', 'tms = 0.30;'),
  t_delay:     M('element', 'Definite-time delay in seconds.', 't_delay = 0.10 s;'),
  char_angle:  M('element', 'Characteristic angle in degrees.', 'char_angle = 60 deg;'),
  reset:       M('element', 'Reset mode: "instant", "dependent" (inverse time), or "disk_emulation".', 'reset = "instant";'),
  directional: M('element', 'Boolean: enables direction-controlled behavior on a stage.', 'directional = true;'),
  stages:      M('element', 'Sub-block listing named stages for a multi-stage element.', 'stages { stage main { ... } stage inst { ... } }'),

  // stage
  'stage.curve': M('stage', 'Stage delimiter keyword.', ''),

  // device
  kind:        M('device', 'Device kind: fuse, recloser, cable, transformer_damage, motor_startup, breaker.', 'kind = "fuse";'),
  rating_I:    M('device', 'Device rated current (fuse/breaker/motor).', 'rating_I = 100 A;'),
  rating_V:   M('device', 'Device rated voltage in kilovolts.', 'rating_V = 11 kV;'),
  rating_S:  M('device', 'Device rated power (transformer/recloser).', 'rating_S = 25 MVA;'),
  min_melt:    M('device', 'Fuse band: minimum-melt time vs current points.', 'min_melt = [(130 A, 1000 s), ...];'),
  total_clear: M('device', 'Fuse band: total-clear time vs current points.', 'total_clear = [(130 A, 60 s), ...];'),

  // grade
  primary:     M('grade', 'Primary side of the grading pair (relay-ref or device-ref).', 'primary = R_FDR:51;'),
  backup:      M('grade', 'Backup side of the grading pair.', 'backup = R_INC:51;'),
  fault:       M('grade', 'Named condition supplying the current. On annotate and point it takes one name or a list, and `faults` / `scenario` / `scenarios` are the same key.', 'fault = "F1";'),
  /* `scenario` as a *field* shares the word with the block it names,
   * and hover is keyed on the bare word, so one entry covers both. */
  scenarios:   M('annotate', 'Several conditions at once: drawn once per condition, each at its own current.', 'scenarios = ["system normal", "one tx out"];'),
  margin:   M('grade', 'The coordination margin this pair must achieve, as a floor. Was CTI_min_s; the unit is now yours to write.', 'margin = 0.30 s;'),
  margin_target:    M('grade', 'A margin to *hit*, for the solver, as opposed to `margin` which is a floor to satisfy.', 'margin_target = 0.30 s;'),
  tolerance_pct: M('grade', 'Allowed slippage on margin_target for solve (default 0).', 'tolerance_pct = 5;'),
  solve:       M('grade', 'Sub-block: directive to compute tms that hits the target.', 'solve { strategy = "tight"; tolerance_pct = 5; }'),

  // grade -- the sweep
  upstream:    M('grade', 'Sweep the margin *above* the declared fault as well. Grading that holds at the fault can still fail further up, where the two characteristics converge.', 'upstream = true;'),
  upstream_to: M('grade', 'Ceiling for the upstream sweep, in primary amps at the fault\u2019s level.', 'upstream_to = 20 kA;'),

  // element -- what it measures
  measures:    M('element', 'Which current the pickup is expressed in: phase, I1, I2, 3I2, I0, 3I0. Required for neg_seq, where IEDs differ over the factor of three.', 'measures = "I2";'),
  t_reset:     M('element', 'Reset time for a dependent or disk-emulation reset.', 't_reset = 0.5 s;'),

  // conditions
  type:        M('faults', 'What kind of fault this is. Fixes the ratios between phase current and the components, so a component the study does not declare can be derived.', 'type = two_phase;'),
  level:       M('scenario', 'One voltage level\u2019s currents under this condition. A scenario declares a figure per level so nothing is referred across a transformer.', 'level "HV" { I = 3.86 A; I2 = 2.23 A; I0 = 0 A; }'),
  residual:    M('faults', 'Residual current, 3*I0, stated directly as an alternative to I0.', 'residual = 2.4 kA;'),
  zero_sequence: M('system', 'Whether zero sequence crosses between two levels. A delta blocks it; a star-star with both neutrals earthed passes it. The tool cannot know, so the study says.', 'zero_sequence { "HV" to "LV" = blocked; }'),
  voltages:    M('system', 'The named voltage levels of the study. Turns ratios are derived from them; there is deliberately no transformer block.', 'voltages { "HV" { V = 33 kV; } }'),
  share:       M('element', 'Share of the condition\u2019s current this element sees, in percent \u2014 parallel feeders or transformers.', 'share = 50 %;'),

  // view -- the sheet
  quantity:    M('view', 'Which current the abscissa is: any (the default), phase, I1, I2, 3I2, I0, 3I0. Naming one opts into a strict sheet.', 'quantity = I2;'),
  condition:   M('view', 'The fault or scenario this sheet depicts. Gives the ratios that convert curves onto the axis and suppress what the condition cannot operate.', 'condition = "1ph min";'),
  subtitle:    M('view', 'Second line of the sheet\u2019s heading; overrides page { title { subtitle } }.', 'subtitle = "480 V earth fault at 33 kV";'),
  currents:    M('page', 'Which amps the legend quotes a pickup in: primary, secondary, or both. Independent of view { axis }.', 'currents = "both";'),

  // annotate -- where it goes
  on_curve:    M('annotate', 'The characteristic being marked.', 'on_curve = R_FDR:51;'),
  at_I:        M('annotate', 'Current to place the mark at, read off the sheet\u2019s own axis. On an annotate, use at_I2 / at_I0 / at_residual to name a component instead, or `type` to derive it. On a time, it is where along the rule the caption sits -- the rule spans the plot, so its name has no natural anchor and defaults to the left-hand end.', 'at_I = 6.4 kA;'),
  at_t:        M('annotate', 'Time at which to measure a *current* margin \u2014 the horizontal counterpart of the vertical arrow, reported as a percentage.', 'at_t = 20 ms;'),
  coords:      M('annotate', 'Append the (current, time) coordinate to the drawn label.', 'coords = true;'),

  // solve
  strategy:    M('solve', 'Solver strategy: "tight", "loose", or "safety_factor".', 'strategy = "tight";'),
  free:        M('solve', 'List of free variables for the solver: tms, t_delay, I_pickup.', 'free = ["tms", "I_pickup"];'),

  // view
  'view.voltage': M('view', 'Voltage frame for the rendered plot. Named level or "<n> kV" or "pickup".', 'voltage = "HV";'),
  axis:        M('view', 'Axis mode: primary, secondary, or multiples.', 'axis = "primary";'),
  two_axes:    M('view', 'Toggle a secondary axis below the primary.', 'two_axes = true;'),
  reference_ct:M('view', 'Curve whose CT anchors the secondary axis.', 'reference_ct = R_FDR:51;'),
  'view.stages': M('view', 'Composite (default) renders the pointwise-min of all stages; individual draws each.', 'stages = "composite";'),
  current_min: M('view', 'Minimum displayed current on the X-axis.', 'current_min = 100 A;'),
  views:       M('faults', 'Sheets this belongs to, as a list -- the same key as `view`, spelled for more than one.', 'views = ["Phase", "Earth"];'),
  current_pad: M('view', 'Extra room beyond the fitted current range, as a factor: 1.5 leaves half a decade of air on both ends. Use current_pad_low / current_pad_high for one end only.', 'current_pad = 1.5;'),
  current_pad_low: M('view', 'Extra room below the fitted current range, as a factor.', 'current_pad_low = 2;'),
  current_pad_high: M('view', 'Extra room above the fitted current range, as a factor.', 'current_pad_high = 1.2;'),
  time_pad:    M('view', 'Extra room beyond the fitted time range, as a factor. time_pad_low / time_pad_high pad one end.', 'time_pad = 1.5;'),
  time_pad_low: M('view', 'Extra room below the fitted time range, as a factor.', 'time_pad_low = 2;'),
  time_pad_high: M('view', 'Extra room above the fitted time range, as a factor.', 'time_pad_high = 2;'),
  sees:        M('scenario', 'What share of this condition a named relay carries, in percent -- for parallel circuits, where each end feeds part of the fault.', 'sees R_FDR_A { share = 50; }'),
  current_max: M('view', 'Largest current drawn. On a view it is the right-hand end of the X-axis; on an element or a stage it is where that curve stops -- past the maximum fault the bus can deliver the curve describes a current that cannot flow, and drawing it invites a margin to be read at a fault that does not exist. A stage falls back to its element’s.', 'current_max = 50 kA;'),

  /* ------------------------------------------------------------------ */
  /* `page` sub-blocks, and the keys inside them.                        */
  /*                                                                     */
  /* All of these were offered by completions and listed in the spec     */
  /* while having no hover entry at all, so putting the caret on         */
  /* `legend` or `footer` -- the two most-reached-for blocks on the      */
  /* page -- explained nothing.                                          */
  /* ------------------------------------------------------------------ */
  legend:      M('page', 'The identification panel: which curves are drawn, their settings, the conditions marked, and the tool\u2019s notes. `style` decides whether it is a gutter, floated over the plot, direct labels, or absent.', 'legend = { style = "column"; currents = "both"; };'),
  footer:      M('page', 'Three text slots along the foot of the sheet -- left, center, right. Each expands [meta.*] macros, so a drawing number written once in `meta` appears here.', 'footer = { left = "[meta.reference]"; right = "Rev [meta.revision]"; };'),
  axes:        M('page', 'Ink and weight for the axis furniture: frame, gridlines, tick labels. Kept recessive so the curves carry the eye.', 'axes = { color = "#8a8983"; grid_color = "#cfcec8"; };'),
  curves:      M('page', 'How the characteristics are drawn as a set: which palette, and the default line weight. An individual curve overrides both.', 'curves = { palette = "okabe_ito"; line_width_px = 2.0; };'),
  points:      M('page', 'Default marker style for every `point` on the sheet. A point may override any of it.', 'points = { shape = "circle"; size_px = 9; outline = true; };'),
  leaders:     M('page', 'Leader lines from a legend swatch or an annotation to the curve it names.', 'leaders = { show = true; style = "arrow"; };'),
  scale:       M('page', 'An explicit axis window, replacing the automatic fit. `auto = false` is what makes the bounds binding.', 'scale = { auto = false; x_min = 100; x_max = 40000; };'),
  title:       M('page', 'Sheet heading. A bare string, or a block carrying a subtitle, colour, alignment and size.', 'title = { text = "Northgate 33/11 kV"; subtitle = "Feeder grading"; };'),

  /* Keys inside those blocks. */
  show:        M('page', 'Draw this element of the furniture at all.', 'show = true;'),
  position:    M('page', 'Where a floated legend sits: a corner for style = "inside", or a side for a column.', 'position = "top_right";'),
  swatch:      M('page', 'Shape of the colour sample beside each legend entry.', 'swatch = "line";'),
  palette:     M('page', 'Named colour scheme for the curves. `okabe_ito` is colour-blind safe; `grayscale` and `monochrome` are for print.', 'palette = "okabe_ito";'),
  line_width_px: M('page', 'Default stroke weight for every characteristic. One curve\u2019s own `width_px` overrides it.', 'line_width_px = 2.0;'),
  auto_color:  M('page', 'Assign palette hues in the order the elements are declared, so a curve keeps its colour as the study grows.', 'auto_color = true;'),
  frame:       M('page', 'Draw the box around the plot area.', 'frame = true;'),
  mirror:      M('page', 'Repeat the tick labels on the opposite axes, so a value can be read from either edge.', 'mirror = true;'),
  grid_color:  M('page', 'Ink for the gridlines.', 'grid_color = "#cfcec8";'),
  label_color: M('page', 'Ink for the axis tick labels.', 'label_color = "#52514e";'),
  label_size_px: M('page', 'Type size for the axis tick labels.', 'label_size_px = 11;'),
  tick_size_px: M('page', 'Length of the tick marks, in pixels.', 'tick_size_px = 4;'),
  shape:       M('point', 'Marker drawn at the coordinate: circle, square, diamond, triangle, cross or x.', 'shape = "cross";'),
  size_px:     M('page', 'Marker size, in pixels.', 'size_px = 9;'),
  outline:     M('page', 'Draw the marker outlined in the curve\u2019s colour rather than filled.', 'outline = true;'),
  label_offset_px: M('page', 'How far a leader line holds its label off the curve.', 'label_offset_px = 14;'),
  text:        M('page', 'The heading itself, inside a structured `title` block.', 'text = "Northgate 33/11 kV";'),
  align:       M('page', 'Horizontal placement of the heading: left, center or right.', 'align = "center";'),
  font_size_px: M('page', 'Type size for this block\u2019s text. The title block grows to fit, so a larger footer moves the subtitle up rather than colliding with it.', 'font_size_px = 10;'),
  border:      M('page', 'Draw a drawing-office frame with a title block along the foot, filled from `meta`.', 'border = true;'),
  size:        M('page', 'Paper size: A0..A5, Letter, Legal, Tabloid, or a { width_mm, height_mm } clause.', 'size = "A4";'),
  left:        M('page', 'Left-hand footer slot, or the left page margin in millimetres.', 'left = "Drawing NG-TCC-0021";'),
  top:         M('page', 'Top page margin, in millimetres. 0 fills the sheet to its edge.', 'top = 12;'),
  bottom:      M('page', 'Bottom page margin, in millimetres.', 'bottom = 12;'),
  right:       M('page', 'Right-hand footer slot, or the right page margin in millimetres.', 'right = "Rev B";'),
  center:      M('page', 'Centre slot of the footer.', 'center = "[meta.project]";'),

  /* Elsewhere. */
  name:        M('relay', 'Display name. Free text shown on the drawing; the id stays what references resolve against, so renaming for a reader never breaks a `grade`.', 'name = "Feeder 4 (Mill Road)";'),
  voltage:     M('relay', 'Named level from `system.voltages`. On a `fault` it is the level the current was *measured* at, not where the fault is.', 'voltage = "HV";'),
  label:       M('point', 'Text drawn beside the mark. A \\n breaks the line.', 'label = "Transformer inrush";'),
  t:           M('point', 'Time coordinate. On a `times` entry, the required clearance.', 't = 100 ms;'),
  I1:          M('faults', 'Positive-sequence component.', 'I1 = 1.2 kA;'),
  at_I1:       M('annotate', 'Position the mark at a positive-sequence current.', 'at_I1 = 800 A;'),
  at_I2:       M('annotate', 'Position the mark at a negative-sequence current.', 'at_I2 = 225 A;'),
  at_I0:       M('annotate', 'Position the mark at a zero-sequence component.', 'at_I0 = 150 A;'),
  at_residual: M('annotate', 'Position the mark at the residual 3*I0.', 'at_residual = 2.4 kA;'),
  as:          M('combine', 'How the source curves are combined: envelope_min, envelope_max, sum or select_first.', 'as = envelope_min;'),
  sources:     M('combine', 'The curves being combined, by reference.', 'sources = [R_FDR:51, R_INC:51];'),
  default:     M('view', 'Draw this sheet when nothing else names one.', 'default = true;'),
  reference:   M('relay', 'Free text: a panel reference, a drawing number, a cubicle.', 'reference = "Panel 3B, relay 2";'),
  project:     M('meta', 'Project name, shown in the title block.', 'project = "Northgate 11 kV";'),
  study:       M('meta', 'What this particular sheet is of.', 'study = "Feeder grading";'),
  engineer:    M('meta', 'Who prepared it.', 'engineer = "A. Cooper";'),
  date:        M('meta', 'Date of issue.', 'date = "2026-07-30";'),
  revision:    M('meta', 'Revision letter or number.', 'revision = "B";'),
  standard:    M('meta', 'The standard the study is worked to.', 'standard = "IEC 60255-151";'),
  stage:       M('stage', 'One stage of a multi-stage element: its own curve, pickup and delay. The element trips at whichever stage is fastest at the current in question.', 'stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }'),
  /*
   * Scoped entries, addressed `block.field`.
   *
   * `point` means two different things -- a top-level marked
   * coordinate, and the field inside an `annotate` that names one --
   * and the flat table could hold only the first, so asking about the
   * second explained the wrong thing. Same for `style`, `label` and
   * `voltage`, each of which reads differently depending on where the
   * caret is.
   *
   * These were once written `page_size`, `view_voltage` and so on.
   * Nothing ever read them: the lookup is by the word under the caret,
   * and nobody types `page_size`. Dotted, they are reachable.
   */
  'annotate.point': M('annotate', 'Names a marked `point` to measure to. With `at_t` it is the far end of a current margin; without, a time margin at the point\u2019s own current. Referenced by the id in the point\u2019s header, not by its label.', 'point = "TX inrush";'),
  'annotate.style': M('annotate', 'How the mark is drawn: `leader` (elbowed line to the text), `tag` (text alone), `pin` (marker only, and so no label).', 'style = leader;'),
  'annotate.label': M('annotate', 'Text drawn beside the mark. The computed figure -- a margin, a percentage -- is appended to it.', 'label = "CTI";'),
  'annotate.voltage': M('annotate', 'The level a bare `at_I` was read at. Defaults to the view\u2019s, which is the axis in front of you.', 'voltage = "HV";'),
  'point.label': M('point', 'Text drawn beside the marker. A \\n breaks the line.', 'label = "Transformer inrush";'),
  'legend.style': M('page', 'How the panel is laid out: `column` (a gutter), `inside` (floated over the plot), `direct` (no panel, each curve labelled in place), `none`.', 'style = "column";'),
  'legend.comment': M('page', 'Your own standing text at the foot of the panel, under a `Comment` heading -- distinct from `Notes`, which the tool writes about what it could not draw. One string, or a list of lines.', 'comment = ["Checked against issue D."];'),
  'faults.currents': M('page', 'Print each fault\u2019s current beside its name under the axis. Defaults to true -- the figure is the reason the rule is drawn. Turn it off where a dozen conditions at similar currents make a band of numbers and the legend already quotes them.', 'currents = false;'),
  labels:      M('page', 'Draw the names under the axis at all. Off leaves the rules unlabelled, for a sheet whose legend carries the identification.', 'labels = true;'),
  'faults.type': M('faults', 'What kind of fault, which fixes the ratios between phase current and the sequence components -- so a component you did not declare can be derived.', 'type = single_phase_earth;'),
  'element.view': M('element', 'Sheets this curve belongs on, by `view` name. Absent means every sheet.', 'views = ["Phase", "Negative sequence"];'),
  from:        M('annotate', 'One end of a span: a dimension between two figures the study names, with no curve at either end. The unit decides the orientation -- two times draw a vertical span (anchored by at_I or a condition), two currents a horizontal one (anchored by at_t).', 'from = 300 ms; to = 800 ms; at_I = 2 kA;'),
  to:          M('annotate', 'The far end of a from/to span. Must be the same quantity as `from` -- there is no distance between a current and a time.', 'to = 800 ms;'),
  color:       M('element', 'Ink for this one curve, overriding the palette -- for a house standard, or a figure whose colours are fixed by the report around it. The palette slot is still consumed, so the other curves keep their hues.', 'color = "#884400";'),
  style:       M('element', 'How this curve is stroked: solid, dashed or dotted. On an annotate block it means the label style instead.', 'style = dashed;'),
  width_px:    M('element', 'Stroke weight for this curve, overriding page { curves { line_width_px } } -- for drawing the subject heavier than its context.', 'width_px = 3;'),
  time_min:    M('view', 'Minimum displayed time on the Y-axis.', 'time_min = 0.01 s;'),
  time_max:    M('view', 'Maximum displayed time on the Y-axis.', 'time_max = 1000 s;'),

  // page
  'page.size':        M('page', 'Paper size keyword or custom { width_mm, height_mm } clause.', 'size = "A4";'),
  orientation: M('page', 'Portrait or landscape.', 'orientation = "landscape";'),
  theme:       M('page', 'Theme preset: light, dark, monochrome, print.', 'theme = "light";'),
  watermark:   M('page', 'Diagonal watermark text drawn across the page.', 'watermark = "DRAFT";'),
  'page.title':        M('page', 'Chart title (printed at the top).', 'title = "Riverside 33/11";'),
  'page.footer': M('page', 'Footer bar text.', 'footer = "<date> -- <engineer>";'),
  margins_mm:  M('page', 'Sub-block of page margins in millimetres.', 'margins_mm = { top = 12; right = 12; ... };'),

  // common (already declared above in scope-specific entries)
};

/**
 * Help for known curve ids (e.g. "iec.si", "ansi.mi"). The renderer
 * uses the same table for the curve-family long name; the editor
 * surfaces it on hover.
 */
export const CURVE_HELP: Record<string, string> = (() => {
  const out: Record<string, string> = {
    definite: 'Definite-time curve: t = t_delay above pickup.',
  };
  for (const [ns, table] of Object.entries(CURVES)) {
    for (const [family, c] of Object.entries(table)) {
      const constants =
        c.form === 'ri' ? `t = tms / (${c.a} - ${c.b} / M)`
        : c.form === 'log'  ? `t = ${c.a} - ${c.b} * ln(M)`
        : `k=${c.k}, c=${c.c}, alpha=${c.alpha}`;
      out[`${ns}.${family}`] = `${c.name} (${constants}).`;
    }
  }
  return out;
})();

/**
 * List of complete top-level block keywords (the user typed at the
 * left margin of a .ptc file).
 */
export const TOP_BLOCK_KEYWORDS = [
  'meta', 'system', 'faults', 'times', 'scenario', 'relay', 'element', 'device',
  'grade', 'combine', 'annotate', 'point', 'view', 'page', 'notes',
] as const;

/**
 * List of fields that the user most commonly types *inside* a
 * particular block. The autocomplete uses these to suggest entries
 * from the right map.
 *
 * Note: each field name here is the *raw* keyword (no scope
 * suffix). For the autocomplete we don't disambiguate by scope.
 */
export const BLOCK_FIELDS: Record<string, string[]> = {
  meta:        ['project', 'study', 'engineer', 'date', 'standard', 'margin'],
  system:      ['voltages', 'zero_sequence', 'base_S', 'I_base', 'I_units'],
  'system.voltages': ['V', 'description'],
  faults:      ['I', 'I_min', 'I_max', 'I1', 'I2', 'I0', 'residual', 'type',
               'voltage', 'view', 'views', 'description'],
  times:       ['t', 'at_I', 'at_I1', 'at_I2', 'at_I0', 'at_residual', 'type',
               'view', 'views', 'description'],
  scenario:    ['type', 'description', 'level', 'sees'],
  'scenario.level': ['I', 'I1', 'I2', 'I0', 'residual', 'share'],
  relay:       ['name', 'voltage', 'maker', 'model', 'ct_ratio', 'direction', 'faults',
               'comment', 'description', 'reference'],
  element:     ['name', 'function', 'measures', 'curve', 'formula', 'flex_points',
               'I_pickup', 'I_units', 'share', 'tms', 't_delay', 't_reset',
               'char_angle', 'reset', 'directional', 'stages', 'current_max',
               'color', 'style', 'width_px', 'view', 'views',
               'comment'],
  stage:       ['function', 'measures', 'curve', 'formula', 'flex_points', 'I_pickup',
               'I_units', 'share', 'tms', 't_delay', 'char_angle', 'reset',
               'directional', 'current_max', 'color', 'style', 'width_px', 'comment'],
  device:      ['kind', 'voltage', 'maker', 'model', 'rating_I', 'rating_V', 'rating_S',
               'flex_points', 'min_melt', 'total_clear', 't_delay',
               'comment', 'description', 'reference'],
  grade:       ['primary', 'backup', 'fault', 'scenario', 'margin', 'margin_target',
               'tolerance_pct', 'upstream', 'upstream_to', 'solve', 'comment'],
  solve:       ['strategy', 'tolerance_pct', 'free', 'comment'],
  view:        ['name', 'default', 'voltage', 'axis', 'quantity', 'condition',
               'title', 'subtitle',
               'two_axes', 'reference_ct', 'stages',
               'current_min', 'current_max', 'time_min', 'time_max',
               'current_pad', 'current_pad_low', 'current_pad_high',
               'time_pad', 'time_pad_low', 'time_pad_high'],
  page:        ['size', 'orientation', 'theme', 'watermark', 'border', 'title', 'footer',
               'margins_mm', 'scale', 'legend', 'axes', 'curves', 'points', 'leaders',
               'faults', 'times'],
  /* `page` sub-blocks, so asking inside one lists what it accepts
   * rather than repeating the page's own fields. */
  legend:      ['show', 'style', 'position', 'title', 'color', 'swatch', 'currents', 'comment',
               'notes'],
  axes:        ['color', 'grid_color', 'label_color', 'label_size_px', 'tick_size_px',
               'frame', 'mirror'],
  curves:      ['palette', 'line_width_px', 'auto_color'],
  points:      ['color', 'shape', 'size_px', 'outline'],
  leaders:     ['show', 'style', 'width_px', 'color', 'label_offset_px'],
  title:       ['text', 'subtitle', 'font_size_px', 'color', 'align'],
  footer:      ['left', 'center', 'right', 'font_size_px', 'color', 'border'],
  /* The four sides of the page margin. Absent from this table, `top`
   * and `bottom` were not field names anywhere in the language, so the
   * highlighter drew them as values while `left` and `right` -- which
   * the footer also uses -- came out as fields. */
  margins_mm:  ['top', 'right', 'bottom', 'left'],
  combined:    ['name', 'sources', 'as', 'color', 'style', 'label'],
  /* `fault`/`scenario` (and their plurals) all name conditions: the
   * current comes from the study rather than being typed in. */
  annotate:    ['view', 'views', 'on_curve', 'at_I', 'at_I1', 'at_I2', 'at_I0', 'at_residual',
               'type', 'at_t', 'from', 'to', 'voltage', 'primary', 'backup', 'point',
               'fault', 'faults', 'scenario', 'scenarios',
               'label', 'style', 'color', 'coords'],
  point:       ['view', 'views', 'I', 'I1', 'I2', 'I0', 'residual', 'type', 't',
               'fault', 'faults', 'scenario', 'scenarios', 'voltage',
               'label', 'shape', 'color', 'coords', 'description'],
  notes:       ['engineer', 'date', 'revision'],
};


/* ------------------------------------------------------------------ */
/* Value catalogues                                                    */
/* ------------------------------------------------------------------ */

/**
 * A value a field accepts, with a line explaining what it does.
 *
 * These drive "what are my options here?" in the editor: at a value
 * position the completion list becomes the enumeration itself rather
 * than a list of field names, so the answer is in the same place as
 * the question.
 */
export interface ValueChoice {
  value: string;
  detail: string;
}

const V = (value: string, detail: string): ValueChoice => ({ value, detail });

/**
 * Keyword-valued fields, keyed by the field name as written.
 *
 * Where one name means different things in different blocks the
 * union is offered; the parser rejects a wrong one, and offering both
 * beats offering neither.
 */
export const FIELD_VALUES: Record<string, ValueChoice[]> = {
  I_units: [
    V('"primary"', 'Pickups are primary amps (the default)'),
    V('"secondary"', 'Pickups are settings-sheet amps; multiplied by ct_ratio'),
  ],
  function: [
    V('"phase_oc"', 'Phase overcurrent (50/51)'),
    V('"earth_fault"', 'Earth fault (50N/51N), driven by residual current'),
    V('"neg_seq"', 'Negative sequence (46), driven by I2'),
    V('"thermal"', 'Thermal overload (49)'),
    V('"breaker_fail"', 'Breaker failure (50BF)'),
  ],
  reset: [
    V('instant', 'Reset the instant current falls below pickup'),
    V('dependent', 'Reset time depends on how far the disc travelled'),
    V('disk_emulation', 'Emulate an induction disc running back'),
  ],
  direction: [
    V('forward', 'Operates for current away from the busbar'),
    V('reverse', 'Operates for current towards the busbar'),
    V('none', 'Non-directional'),
  ],
  directional: [V('true', 'Directional element'), V('false', 'Non-directional')],
  kind: [
    V('fuse', 'Fuse: draws a min-melt / total-clear band'),
    V('recloser', 'Recloser characteristic'),
    V('cable', 'Cable damage curve'),
    V('transformer_damage', 'Transformer through-fault withstand'),
    V('motor_startup', 'Motor starting characteristic'),
    V('breaker', 'Breaker operating time'),
  ],
  as: [
    V('envelope_min', 'Fastest of the sources at each current'),
    V('envelope_max', 'Slowest of the sources at each current'),
    V('sum', 'Sum of the source times'),
    V('select_first', 'First source that operates'),
  ],
  strategy: [
    V('tight', 'Smallest tms that still meets the margin'),
    V('loose', 'Round the solved tms up to the next standard step'),
    V('safety_factor', 'Multiply the solved tms by a factor'),
  ],
  axis: [
    V('"primary"', 'Current axis in primary amps'),
    V('"secondary"', 'Current axis in secondary amps'),
    V('"multiples"', 'Current axis in multiples of pickup'),
  ],
  /* view.quantity -- which current the abscissa is. */
  quantity: [
    V('any', 'Every curve on one current axis, whatever it measures (default)'),
    V('phase', 'Phase current'),
    V('I2', 'Negative-sequence component'),
    V('3I2', 'Three times the negative-sequence component'),
    V('I0', 'Zero-sequence component'),
    V('3I0', 'Residual current, as a residual CT connection presents it'),
    V('I1', 'Positive-sequence component'),
  ],
  /* element.measures -- which current a pickup is expressed in. */
  measures: [
    V('phase', 'Phase current'),
    V('I2', 'Negative sequence, as the IED is scaled'),
    V('3I2', 'Three times negative sequence'),
    V('I0', 'Zero-sequence component'),
    V('3I0', 'Residual 3*I0 (the earth-fault default)'),
    V('I1', 'Positive-sequence component'),
  ],
  /* fault / scenario type -- fixes the ratios between the quantities. */
  type: [
    V('three_phase', 'Balanced: positive sequence only'),
    V('two_phase', 'Phase to phase: I1 = I2 = I_A/sqrt(3), no earth path'),
    V('single_phase_earth', 'Phase to earth: I1 = I2 = I0 = I_A/3'),
    V('two_phase_earth', 'Two phases to earth: depends on Z0, so declare the components'),
  ],
  orientation: [V('"portrait"', 'Tall sheet'), V('"landscape"', 'Wide sheet (default)')],
  theme: [
    V('"light"', 'Light background, for print and filing'),
    V('"dark"', 'Dark background, for screen'),
    V('"monochrome"', 'Black on white'),
    V('"print"', 'ICC-aware print'),
  ],
  size: [
    V('"A4"', '210 x 297 mm'), V('"A3"', '297 x 420 mm'), V('"A5"', '148 x 210 mm'),
    V('"Letter"', '215.9 x 279.4 mm'), V('"Legal"', '215.9 x 355.6 mm'),
    V('"Tabloid"', '279.4 x 431.8 mm'),
  ],
  /*
   * `style` means four unrelated things. Offered as one merged list, a
   * `?` inside an annotate block suggested the legend's four spellings
   * -- every one of them a hard ANNOTATE_STYLE_UNKNOWN -- and the two
   * rule sub-blocks were offered none of their own. Keyed by block, so
   * each context offers only what it accepts; `valuesFor` falls back to
   * the bare name for fields that mean one thing everywhere.
   */
  'legend.style': [
    V('"column"', 'a gutter down the right-hand side (default)'),
    V('"inside"', 'the same panel floated over the plot'),
    V('"direct"', 'no panel; each curve labelled in place'),
    V('"none"', 'no identification at all'),
  ],
  'annotate.style': [
    V('leader', 'elbowed leader line to the label'),
    V('pin', 'a dot on the curve'),
    V('tag', 'bare text beside the point'),
  ],
  'faults.style': [
    V('"solid"', 'unbroken rule'),
    V('"dashed"', 'dashed rule (default)'),
    V('"dotted"', 'dotted rule'),
  ],
  'times.style': [
    V('"solid"', 'unbroken rule'),
    V('"dashed"', 'dashed rule'),
    V('"dotted"', 'dotted rule (default)'),
  ],
  'leaders.style': [
    V('"line"', 'a plain line to the label'),
    V('"arrow"', 'an arrowhead at the mark'),
    V('"dot"', 'a dot at the mark'),
  ],
  'element.style': [
    V('solid', 'unbroken curve'),
    V('dashed', 'dashed curve'),
    V('dotted', 'dotted curve'),
  ],
  'stage.style': [
    V('solid', 'unbroken curve'),
    V('dashed', 'dashed curve'),
    V('dotted', 'dotted curve'),
  ],
  position: [
    V('"top_right"', 'Inside legend pinned to the top right (default)'),
    V('"top_left"', 'Inside legend pinned to the top left'),
    V('"bottom_right"', 'Inside legend pinned to the bottom right'),
    V('"bottom_left"', 'Inside legend pinned to the bottom left'),
    V('"right"', 'Column legend on the right'),
    V('"left"', 'Column legend on the left'),
  ],
  swatch: [V('line', 'A line segment'), V('box', 'A filled box'), V('circle', 'A dot')],
  shape: [
    V('"circle"', 'Round marker'), V('"square"', 'Square marker'),
    V('"diamond"', 'Diamond marker'), V('"triangle"', 'Triangle marker'),
    V('"cross"', 'Plus-shaped marker'), V('"x"', 'X-shaped marker'),
  ],
  /* page.legend.currents -- which amps the legend quotes a pickup in. */
  currents: [
    V('"primary"', 'Primary amps, as declared (default)'),
    V('"secondary"', 'Secondary amps: the figure set in the relay. Needs ct_ratio'),
    V('"both"', 'Primary with the secondary in brackets'),
  ],
  palette: [
    V('"default"', 'Validated categorical palette'),
    V('"okabe_ito"', 'Okabe-Ito colourblind-safe set'),
    V('"high_contrast"', 'Maximum separation'),
    V('"grayscale"', 'Greys only'),
    V('"ieee"', 'IEEE house colours'),
    V('"monochrome"', 'Single ink'),
  ],
  tick_density: [V('sparse', 'Fewer gridlines'), V('normal', 'Default'), V('dense', 'More gridlines')],
  stages: [
    V('composite', 'Draw the stages as one effective curve'),
    V('individual', 'Draw each stage separately'),
  ],
};

/** Fields that take `true` / `false`. */
export const BOOLEAN_FIELDS = new Set([
  'border', 'stretch', 'mirror', 'coords', 'show', 'labels', 'frame',
  'auto', 'auto_color', 'outline', 'two_axes', 'solve', 'directional',
]);

/**
 * Unit suffixes offered after a number, by the field being assigned.
 *
 * The spec requires the suffix wherever it is not the field's
 * default, so this is the list an engineer would otherwise have to
 * look up mid-line.
 */
export const FIELD_UNITS: Record<string, ValueChoice[]> = {
  /* Currents measured on the primary side. */
  __current: [
    V('A', 'amperes'), V('kA', 'kiloamperes'), V('mA', 'milliamperes'),
  ],
  /* Pickups, which may also be given on the secondary side or as a multiple. */
  __pickup: [
    V('A', 'primary amperes'),
    V('A_sec', 'secondary amperes — multiplied by ct_ratio'),
    V('A_pri', 'primary amperes, explicitly — ignores I_units = "secondary"'),
    V('kA', 'kiloamperes'), V('mA', 'milliamperes'),
    V('pu', 'multiple of the base current'),
    V('xCT', 'multiple of the CT secondary rating'),
    V('xIn', 'multiple of the relay nominal current'),
  ],
  __time: [V('s', 'seconds'), V('ms', 'milliseconds'), V('min', 'minutes')],
  /*
   * `kV` was written as `V` and labelled "kilovolts", beside a second
   * `V` labelled "volts". So the list offered the same suffix twice,
   * one of them describing a unit a thousand times larger, and never
   * offered `kV` at all -- on a field that is nearly always in kV.
   */
  __voltage: [V('kV', 'kilovolts'), V('V', 'volts'), V('MV', 'megavolts')],
  __power: [V('MVA', 'megavolt-amperes'), V('kVA', 'kilovolt-amperes'), V('MW', 'megawatts')],
  __angle: [V('deg', 'degrees')],
};

/** Which unit family a field belongs to. */
/**
 * Which unit family a field belongs to.
 *
 * Held to `FIELD_QUANTITY` -- the parser's own table -- by
 * `tests/unit/help-currency.spec.ts`. Three entries here were keyed on
 * spellings the parser had already renamed (`I_base_A`, `at_I_A`,
 * `base_MVA`), so pressing `?` after `I_base = 5 ` offered nothing at
 * all: the lookup missed, and a silent miss looks exactly like a field
 * that takes no unit.
 */
export const UNIT_FAMILY: Record<string, keyof typeof FIELD_UNITS> = {
  I_pickup: '__pickup',
  I: '__current', I1: '__current', I_min: '__current', I_max: '__current',
  residual: '__current', I0: '__current', I2: '__current',
  I_base: '__current', rating_I: '__current',
  at_I: '__current', at_I1: '__current', at_I2: '__current',
  at_I0: '__current', at_residual: '__current',
  current_min: '__current', current_max: '__current', upstream_to: '__current',
  t_delay: '__time', t_reset: '__time', t: '__time', at_t: '__time',
  time_min: '__time', time_max: '__time',
  margin: '__time', margin_target: '__time',
  V: '__voltage', rating_V: '__voltage', voltage: '__voltage',
  rating_S: '__power', base_S: '__power',
  char_angle: '__angle',
};
