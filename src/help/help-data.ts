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
  /** Where in the .tc source this construct lives. */
  scope: 'top' | 'meta' | 'system' | 'voltages' | 'faults' | 'relay'
       | 'element' | 'stage' | 'device' | 'grade' | 'solve' | 'view' | 'page';
  /** One-line summary for the hover tooltip. */
  summary: string;
  /** Example value or fragment. */
  example: string;
}

const M = (scope: HelpEntry['scope'], summary: string, example: string): HelpEntry =>
  ({ scope, summary, example });

/**
 * Top-level keyword help.
 */
export const KEYWORD_HELP: Record<string, HelpEntry> = {
  // top-level
  meta:        M('top', 'Project metadata block (engineer, date, standard, defaults).', 'meta { engineer = "..."; }'),
  system:      M('top', 'Network-level declarations: voltages, frequency, grounding.', 'system { voltages { ... } }'),
  faults:      M('top', 'Named fault-current table; each fault has a current and a voltage.', 'faults { "F1" { I_A = 6400 A; voltage = "LV"; } }'),
  relay:       M('top', 'A relay instance with its voltage level and current transformer ratio.', 'relay R_FDR { voltage = "LV"; ct_ratio = 600/5; ... }'),
  element:     M('top', 'A protection function on a relay -- IDMT, instantaneous, etc.', 'element 51 { curve = iec.si; ... }'),
  device:      M('top', 'Auxiliary TCC asset: fuse, cable, transformer damage, recloser, motor.', 'device "ferraz_abc_100a" { kind = fuse; ... }'),
  grade:       M('top', 'A grading pair: primary / backup / fault / margin, optionally solved.', 'grade { primary = R_FDR:51; backup = R_INC:51; ... }'),
  combine:     M('top', 'Synthetic curve -- pointwise min/max/sum of source curves.', 'combine { name = "OR"; sources = [R_FDR:51, R_INC:51]; as = envelope_min; }'),
  annotate:    M('top', 'A leader-line annotation on a curve at a specific current.', 'annotate { on_curve = R_FDR:51; at_I_A = 8 kA; label = "Trip"; }'),
  view:        M('top', 'Display-only directives: voltage frame, axis mode, stages mode.', 'view { voltage = "HV"; current_min = 100 A; }'),
  page:        M('top', 'Page geometry + theme + title. Output page layout.', 'page { size = "A4"; orientation = "landscape"; title = "..."; }'),
  notes:       M('top', 'Free-form notes attached to the document.', 'notes { revision = "draft"; }'),

  // system
  frequency_Hz:M('system', 'System nominal frequency in Hz.', 'frequency_Hz = 50;'),
  base_MVA:    M('system', 'System MVA base for per-unit conversions.', 'base_MVA = 25.0;'),
  grounding:   M('system', 'How the system is grounded.', 'grounding = "low_impedance";'),
  I_base_A:    M('system', 'Per-unit base current for the whole study.', 'I_base_A = 5000;'),
  I_units:     M('system', 'Default current-units for the study ("primary" or "secondary").', 'I_units = "primary";'),

  // system.voltages
  kV:          M('voltages', 'Numerical voltage in kV (single value, no qualifier).', 'kV = 33.0;'),
  description: M('voltages', 'Free-text description.', 'description = "33 kV side";'),

  // faults
  I_A:         M('faults', 'Fault current at the named fault, in amperes.', 'I_A = 6400 A;'),
  min_A:       M('faults', 'Minimum fault current for this entry (lower bound of a fault range).', 'min_A = 1500 A;'),
  max_A:       M('faults', 'Maximum fault current for this entry.', 'max_A = 6400 A;'),
  earth_A:     M('faults', 'Earth-fault current component (residual 3I0).', 'earth_A = 4500 A;'),
  I0_A:        M('faults', 'Zero-sequence current component.', 'I0_A = 4500 A;'),
  I2_A:        M('faults', 'Negative-sequence current component.', 'I2_A = 1500 A;'),
  fault_voltage: M('faults', 'Voltage level name that this fault is declared at (must exist in system.voltages).', 'voltage = "LV";'),

  // relay
  relay_voltage: M('relay', "A relay's voltage level (must exist in system.voltages).", 'voltage = "LV";'),
  maker:       M('relay', 'Vendor / maker name shown in reports.', 'maker = "ABB";'),
  model:       M('relay', 'Model name shown in reports.', 'model = "REL-615";'),
  ct_ratio:    M('relay', 'Current-transformer ratio (primary/secondary).', 'ct_ratio = 600/5;'),
  direction:   M('relay', 'Direction control: "forward", "reverse", or "none".', 'direction = "forward";'),
  relay_faults: M('relay', 'List of faults this relay explicitly considers. Optional.', 'faults = ["F1", "F2"];'),
  comment:     M('relay', 'Inline documentation. Free text.', 'comment = "primary OC element";'),

  // element
  function:    M('element', 'Function of the protection element: phase_oc, earth_fault, neg_seq, thermal, breaker_fail.', 'function = "phase_oc";'),
  curve:       M('element', 'Curve family identifier, e.g. iec.si, ansi.mi, or "definite".', 'curve = iec.si;'),
  formula:     M('element', 'Custom IDMT formula: k [s], c [s], alpha.', 'formula = { k = 0.14 s; c = 0; alpha = 0.02; }'),
  flex_points: M('element', 'Piecewise (I, t) pairs for a flex curve.', 'flex_points = [(100 A, 10 s), (1 kA, 0.1 s)];'),
  I_pu:        M('element', 'Pickup current in amps (default unit) or multiples.', 'I_pu = 480 A;'),
  element_I_units: M('element', "Element's per-element current-units override.", 'I_units = "secondary";'),
  current_pct: M('element', 'Fraction (0..100) of total fault current the relay sees (parallel feeders).', 'current_pct = 50;'),
  tms:         M('element', 'Time Multiplier Setting -- scales an IDMT curve uniformly.', 'tms = 0.30;'),
  t_delay:     M('element', 'Definite-time delay in seconds.', 't_delay = 0.10 s;'),
  char_angle:  M('element', 'Characteristic angle in degrees.', 'char_angle = 60 deg;'),
  reset:       M('element', 'Reset mode: "instant", "dependent" (inverse time), or "disk_emulation".', 'reset = "instant";'),
  directional: M('element', 'Boolean: enables direction-controlled behavior on a stage.', 'directional = true;'),
  stages:      M('element', 'Sub-block listing named stages for a multi-stage element.', 'stages { stage main { ... } stage inst { ... } }'),

  // stage
  stage_curve_id: M('stage', 'Stage delimiter keyword.', ''),

  // device
  kind:        M('device', 'Device kind: fuse, recloser, cable, transformer_damage, motor_startup, breaker.', 'kind = "fuse";'),
  rating_A:    M('device', 'Device rated current (fuse/breaker/motor).', 'rating_A = 100 A;'),
  rating_kV:   M('device', 'Device rated voltage in kilovolts.', 'rating_kV = 11;'),
  rating_MVA:  M('device', 'Device rated power (transformer/recloser).', 'rating_MVA = 25;'),
  min_melt:    M('device', 'Fuse band: minimum-melt time vs current points.', 'min_melt = [(130 A, 1000 s), ...];'),
  total_clear: M('device', 'Fuse band: total-clear time vs current points.', 'total_clear = [(130 A, 60 s), ...];'),

  // grade
  primary:     M('grade', 'Primary side of the grading pair (relay-ref or device-ref).', 'primary = R_FDR:51;'),
  backup:      M('grade', 'Backup side of the grading pair.', 'backup = R_INC:51;'),
  fault:       M('grade', 'Named fault input for margin computation.', 'fault = "F1";'),
  CTI_min_s:   M('grade', 'Minimum Coordination Time Interval (default project CTI).', 'CTI_min_s = 0.30;'),
  margin_s:    M('grade', 'Target margin for the grade block.', 'margin_s = 0.30;'),
  tolerance_pct: M('grade', 'Allowed slippage on margin_s for solve (default 0).', 'tolerance_pct = 5;'),
  solve:       M('grade', 'Sub-block: directive to compute tms that hits the target.', 'solve { strategy = "tight"; tolerance_pct = 5; }'),

  // solve
  strategy:    M('solve', 'Solver strategy: "tight", "loose", or "safety_factor".', 'strategy = "tight";'),
  free:        M('solve', 'List of free variables for the solver: tms, t_delay, I_pu.', 'free = ["tms", "I_pu"];'),

  // view
  view_voltage: M('view', 'Voltage frame for the rendered plot. Named level or "<n> kV" or "pickup".', 'voltage = "HV";'),
  axis:        M('view', 'Axis mode: primary, secondary, or multiples.', 'axis = "primary";'),
  two_axes:    M('view', 'Toggle a secondary axis below the primary.', 'two_axes = true;'),
  reference_ct:M('view', 'Curve whose CT anchors the secondary axis.', 'reference_ct = R_FDR:51;'),
  view_stages: M('view', 'Composite (default) renders the pointwise-min of all stages; individual draws each.', 'stages = "composite";'),
  current_min: M('view', 'Minimum displayed current on the X-axis.', 'current_min = 100 A;'),
  current_max: M('view', 'Maximum displayed current on the X-axis.', 'current_max = 50 kA;'),
  time_min:    M('view', 'Minimum displayed time on the Y-axis.', 'time_min = 0.01 s;'),
  time_max:    M('view', 'Maximum displayed time on the Y-axis.', 'time_max = 1000 s;'),

  // page
  page_size:        M('page', 'Paper size keyword or custom { width_mm, height_mm } clause.', 'size = "A4";'),
  orientation: M('page', 'Portrait or landscape.', 'orientation = "landscape";'),
  theme:       M('page', 'Theme preset: light, dark, monochrome, print.', 'theme = "light";'),
  watermark:   M('page', 'Diagonal watermark text drawn across the page.', 'watermark = "DRAFT";'),
  page_title:        M('page', 'Chart title (printed at the top).', 'title = "Riverside 33/11";'),
  page_footer: M('page', 'Footer bar text.', 'footer = "<date> -- <engineer>";'),
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
        c.form === 'linear' ? `t = ${c.a} - ${c.b} * M`
        : c.form === 'log'  ? `t = ${c.a} - ${c.b} * ln(M)`
        : `k=${c.k}, c=${c.c}, alpha=${c.alpha}`;
      out[`${ns}.${family}`] = `${c.name} (${constants}).`;
    }
  }
  return out;
})();

/**
 * List of complete top-level block keywords (the user typed at the
 * left margin of a .tc file).
 */
export const TOP_BLOCK_KEYWORDS = [
  'meta', 'system', 'faults', 'relay', 'element', 'device',
  'grade', 'combine', 'annotate', 'view', 'page', 'notes',
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
  meta:        ['project', 'study', 'engineer', 'date', 'standard', 'CTI_min_s'],
  system:      ['voltages', 'frequency_Hz', 'base_MVA', 'grounding', 'I_base_A', 'I_units'],
  'system.voltages': ['kV', 'description'],
  faults:      ['I_A', 'min_A', 'max_A', 'earth_A', 'I0_A', 'I2_A', 'voltage', 'description'],
  relay:       ['voltage', 'maker', 'model', 'ct_ratio', 'direction', 'faults',
               'comment', 'description', 'reference'],
  element:     ['function', 'curve', 'formula', 'flex_points', 'I_pu', 'I_units',
               'current_pct', 'tms', 't_delay', 't_reset', 'char_angle', 'reset',
               'directional', 'stages', 'comment'],
  stage:       ['function', 'curve', 'formula', 'flex_points', 'I_pu', 'I_units',
               'current_pct', 'tms', 't_delay', 'char_angle', 'reset',
               'directional', 'comment'],
  device:      ['kind', 'maker', 'model', 'rating_A', 'rating_kV', 'rating_MVA',
               'flex_points', 'min_melt', 'total_clear', 't_delay',
               'comment', 'description', 'reference'],
  grade:       ['primary', 'backup', 'fault', 'CTI_min_s', 'margin_s',
               'tolerance_pct', 'solve', 'comment'],
  solve:       ['strategy', 'tolerance_pct', 'free'],
  view:        ['voltage', 'axis', 'two_axes', 'reference_ct', 'stages',
               'current_min', 'current_max', 'time_min', 'time_max'],
  page:        ['size', 'orientation', 'theme', 'watermark', 'title', 'footer',
               'margins_mm', 'scale', 'legend', 'axes', 'curves', 'points', 'leaders'],
  combined:    ['name', 'sources', 'as', 'color', 'style', 'label'],
  annotate:    ['on_curve', 'at_I_A', 'label', 'style'],
  notes:       ['engineer', 'date', 'revision'],
};

export const SCOPE_OF_TOP_BLOCK: Record<string, keyof typeof BLOCK_FIELDS> = {
  meta: 'meta',
  system: 'system',
  faults: 'faults',
  relay: 'relay',
  element: 'element',
  device: 'device',
  grade: 'grade',
  page: 'page',
  view: 'view',
  combine: 'combined',
  annotate: 'annotate',
  notes: 'notes',
};
