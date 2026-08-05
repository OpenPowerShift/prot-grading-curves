/**
 * SVG composer.
 *
 * Produces a self-contained `<svg>` for a parsed `.ptc` document.
 *
 * v0.1.0 conventions:
 *   - Log-log axes (current vs time), minor ticks at 1..9 / decade
 *   - Curves and faults project into the chosen `view.voltage`
 *     frame -- all currents displayed are normalised to that voltage
 *     so the engineer can compare apples-to-apples across voltage
 *     levels.
 *   - Title block top
 *   - Curves legend at the top-right; faults legend at bottom-right
 *   - Each plotted curve as a `<path>` against the log axes
 *   - Fault-current vertical marker (red dashed line) at the
 *     voltage-adjusted primary current
 *   - Pickup tick marks under the x-axis at each curve's I_pickup
 *     projected into the view voltage
 *   - Per-curve legend shows voltage, curve family, pickup, tms
 *   - Bottom band: optional interactive overlay (live markers + readout)
 *     drawn by the parent <tc-viewer> when the user hovers
 *
 * No D3 -- the renderer is fully hand-rolled.
 */

import type {
  Document,
  FaultsBlock,
  LegendCorner,
  LegendStyle,
  PageBlock,
  PageLegend,
  LegendCurrents,
  Ref,
  SystemBlock,
  ViewBlock,
} from '../parser/ast.js';
import { LogScale } from './scale.js';
import { ticks, formatSi } from './ticks.js';
import { paletteFor, paletteFromList, strokeDashFor, type Palette } from './palette.js';
import { measuredQuantityOf } from '../semantics/quantity.js';
import {
  faultTypeLabel, isFaultType, quantityIsAbsent, type FaultType,
} from '../constants/sequence.js';
import { LabelPlacer, type Placement, type Rect } from './labels.js';
import {
  conversionFactor,
  elementQuantity,
  isMeasuredQuantity,
  resolveCurrent,
  scalingBetween,
  quantityLabel,
  survivesVoltageReferral,
  type MeasuredQuantity,
} from '../semantics/quantity.js';
import { resolveCondition, type ResolvedCondition } from '../semantics/condition.js';
import { theme as loadTheme, type ThemeName } from './theme.js';
import { buildStudy, allElements, levelPairKey, resolveRef, type Annotation, type CurveStyle, type Device, type Element, type Stage, type Study } from '../semantics/model.js';
import { tTripStage } from '../semantics/curves.js';
import { tTripElement } from '../semantics/stages.js';
import { tTripCombine } from '../semantics/combine.js';
import { tTripFlex } from '../semantics/curves.js';

/* ------------------------------------------------------------------ */
/* Type scale                                                          */
/* ------------------------------------------------------------------ */

/*
 * One place for every size in the plot. The previous values (10-12 px
 * against a 1200 px canvas) were too small to read comfortably at
 * print size or on a laptop screen, and the line spacing was tighter
 * than the type, so legend entries ran together.
 *
 * Line heights are ~1.35x their type size, which keeps successive
 * lines distinguishable without wasting the column.
 */
const FONT_TITLE = 18;
const FONT_SUBTITLE = 12;
const FONT_HEADING = 13;
const FONT_LABEL = 12;
const FONT_DETAIL = 11;
const FONT_AXIS = 12;
/**
 * Baseline of the x-axis tick labels, below the plot.
 *
 * Named because the fault band has to clear it, and clearing it by a
 * guessed constant is how the band came to overlap the scale: the
 * labels are at +20 and the band was moved to +22.
 */
const AXIS_LABEL_DY = 20;
/**
 * First row of fault names, below the axis labels.
 *
 * `AXIS_LABEL_DY` puts a 12 px label's baseline at +20 and its
 * descenders reach about +24, so clearing it is only the floor. The
 * band is a different kind of thing from the scale and wants reading
 * as one, which takes a visible gap rather than a technical one --
 * eight pixels between baselines left about five between the ink, and
 * the two rows ran together.
 *
 * Still well short of the fixed 44 this started at.
 */
const FAULT_BAND_DY = AXIS_LABEL_DY + FONT_AXIS + 2;

/**
 * How far a fault's caption sits from its own rule.
 *
 * Close enough to read as belonging to it. At four the name floated
 * between its rule and the next one along on a crowded sheet, which
 * is exactly when knowing which is which matters.
 */
const FAULT_LABEL_DX = 2;
const FONT_AXIS_TITLE = 13;

const LINE_HEADING = 20;
const LINE_LABEL = 16;
const LINE_DETAIL = 15;
const LEGEND_ENTRY_GAP = 10;
/*
 * Clearance between the plot frame and the legend column.
 *
 * 20 px read as crowding: the section headings -- the Faults one
 * especially, being coloured and so drawing the eye -- looked stuck to
 * the frame. The plot gives up 14 px of width, which on a log axis is
 * nothing.
 */
const LEGEND_GUTTER = 34;

/** Mean glyph advance as a fraction of font size, for the mono stack. */
const CHAR_ADVANCE = 0.60;

/**
 * Greedy word wrap to a pixel width.
 *
 * SVG has no text flow, so a long relay model or curve description
 * would simply run past the legend column and off the page. Measuring
 * by average advance is approximate but the stack is monospaced, so
 * it is accurate enough to keep text inside its column.
 */
function wrapText(text: string, maxWidthPx: number, fontSize: number): string[] {
  const maxChars = Math.max(8, Math.floor(maxWidthPx / (fontSize * CHAR_ADVANCE)));
  if (text.length <= maxChars) return [text];

  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';

  /* A single token longer than the column -- a relay id, a fault
   * name, a model number -- has no space to break at, so it is cut
   * hard. Leaving it whole is what pushed text past the frame. */
  const emit = (word: string): void => {
    let rest = word;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    line = rest;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    emit(word);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Wrap author text that may also carry explicit line breaks.
 *
 * `\n` is honoured first, then each of those lines is wrapped to the
 * column -- so a declared name both breaks where the author asked and
 * still cannot run past the frame.
 */
function wrapLabel(text: string, maxWidthPx: number, fontSize: number): string[] {
  return labelLines(text).flatMap((line) => wrapText(line, maxWidthPx, fontSize));
}

export interface RenderOptions {
  page: PageBlock | null;
  system: SystemBlock | null;
  faults: FaultsBlock | null;
  view?: ViewBlock | null;
  width: number;
  height: number;
  /** Optional curve identifier that should be drawn bolder than
   *  the others. Format is the same as `data-curve` on the emitted
   *  path. */
  highlightLabel?: string | null;
  /** Voltages that match pairs of (label, voltage) to disambiguate
   *  when the same curve label appears at multiple voltages. */
  highlightVoltage?: string | null;
  /**
   * Resolved study. Pass the *same* object that `process()` graded so
   * that any `tms` the solver computed is drawn; omitting it makes the
   * renderer resolve the document afresh, which loses solver results.
   */
  study?: Study | null;
  /**
   * Theme to draw with, overriding the source's `page { theme = ... }`.
   *
   * The playground uses this so the plot follows the UI's light/dark
   * setting -- on screen the theme is a *viewing* preference. Exports
   * leave it unset, so a `page` block still governs the document the
   * engineer files.
   */
  theme?: ThemeName | null;
}

/** What a legend detail line describes. */
type DetailRole =
  /** Make and model. */
  | 'identity'
  /** Curve, pickup, TMS or delay -- the line an engineer checks. */
  | 'settings'
  /** Voltage level, band note: useful, but not the setting. */
  | 'context';

interface DetailLine {
  text: string;
  role: DetailRole;
}

interface CurveEntry {
  label: string;
  /**
   * The identifier `grade`, `annotate` and `combine` resolve against
   * -- `R_FDR:51` -- as opposed to `label`, which is what the drawing
   * calls the curve.
   *
   * The two differ whenever a relay or element declares a `name`,
   * which is most studies worth reading. Carried onto the sheet so the
   * playground can tell an author what to type: hovering a curve and
   * being shown "Feeder 4 (Mill Road) 51" is no help at all when the
   * reference you need is `R_FDR:51`.
   */
  ref?: string;
  color: string;
  pathD: string;
  pickupPx: number;       // in the view frame
  /** Legend body, one entry per rendered line. */
  /**
   * Legend body, one entry per rendered line.
   *
   * Each carries what it *is*, not just where it sits. A compact
   * legend has to keep the settings and drop the rest, and picking by
   * position got that backwards: the settings line is the middle one,
   * so taking the last kept the voltage and threw the settings away --
   * which is what made a crowded sheet, and every PDF of one, show no
   * settings at all.
   */
  detailLines: DetailLine[];
  voltage?: string;
  voltage_kV?: number;    // <<< the relay's own nominal voltage -- useful for the hover overlay
  opAt?: { I_A: number; t_s: number };
  /** Explicit stroke-dasharray, for combines and repeated hues. */
  dashArray?: string;
  /**
   * Stroke weight this curve asked for, overriding
   * `page { curves { line_width_px } }`.
   */
  widthPx?: number;
  /** Synthetic `combine` curves may ask for a dashed stroke. */
  dashed?: boolean;
  /** True for a fuse band, whose legend swatch is a hatched block. */
  band?: boolean;
}

/**
 * One condition marked on the plot: a `fault` or a `scenario`.
 *
 * Both draw the same furniture -- a vertical rule, a name below the
 * axis, a legend entry -- because to a reader they are the same thing:
 * a current the study says something happens at. They differ in where
 * the figure came from, which the entry records so the legend can be
 * honest about it.
 */
interface FaultEntry {
  name: string;
  /** Which form declared it. */
  kind: 'fault' | 'scenario';
  /** Author's note on what the fault is; shown under the legend entry. */
  description?: string;
  I_A: number;            // original current, at the level it was declared on
  voltage?: string;
  voltage_kV?: number;
  voltageLabel?: string;
  /** Current at the chosen view-voltage frame. */
  I_view?: number;
}

export function renderSvg(doc: Document | undefined, opts: RenderOptions): string {
  if (!doc) return placeholderSvg('No document parsed yet.');
  const W = opts.width;
  const H = opts.height;
  const themeName: ThemeName = opts.theme ?? opts.page?.theme ?? 'light';
  /*
   * `page { axes { ... } }` overrides the theme's ink per element.
   * Applied here so every downstream use reads one resolved theme
   * rather than re-checking the page block.
   */
  const pageAxes = opts.page?.axes;
  const th = {
    ...loadTheme(themeName),
    ...(pageAxes?.color ? { axis: pageAxes.color } : {}),
    ...(pageAxes?.grid_color ? { grid: pageAxes.grid_color } : {}),
    ...(pageAxes?.label_color ? { label: pageAxes.label_color } : {}),
  };
  const palName =
    typeof opts.page?.curves?.palette === 'string'
      ? (opts.page!.curves!.palette as any)
      : 'default';
  /* Dark mode gets its own steps, not a flip of the light ones. */
  const pal: Palette =
    Array.isArray(opts.page?.curves?.palette)
      ? paletteFromList(opts.page!.curves!.palette as string[])
      : paletteFor(palName, themeName === 'dark');

  /*
   * The resolved study is the single source of curve data. Building it
   * here as a fallback keeps `renderSvg(doc, ...)` working standalone,
   * but callers that ran the solver must pass their own study or the
   * auto-computed settings will not be drawn.
   */
  const study: Study = opts.study ?? buildStudy(doc);

  /* Voltage-level registry (name -> kV) */
  const voltageKvs = new Map<string, number>();
  for (const lvl of study.voltages.values()) voltageKvs.set(lvl.name, lvl.kV);
  if (opts.system) {
    for (const lvl of opts.system.voltages) voltageKvs.set(lvl.name, lvl.kV);
  }

  /* Decide the view voltage (kV) */
  const view = opts.view ?? study.view ?? null;
  let V_view_kV: number | undefined;
  let viewLabel = '';
  if (view?.voltage) {
    const tag = view.voltage.trim();
    if (tag === 'pickup') {
      viewLabel = 'pickup';
    } else {
      // try named level first
      const named = voltageKvs.get(tag.replace(/^"|"$/g, ''));
      if (named != null) {
        V_view_kV = named;
        viewLabel = `${tag.replace(/^"|"$/g, '')} · ${named} kV`;
      } else {
        // try numeric "<n> kV" or "<n> V"
        const m = tag.match(/^(-?\d+(?:\.\d+)?)\s*(k?v)$/i);
        if (m) {
          const n = Number(m[1]);
          const u = m[2].toLowerCase();
          if (u === 'kv') {
            V_view_kV = n;
            viewLabel = `${n} kV`;
          } else if (u === 'v') {
            V_view_kV = n / 1000;
            viewLabel = `${n} V`;
          } else {
            viewLabel = 'pickup';   // fallback
          }
        }
      }
    }
  }
  /*
   * With no `view { voltage }` the axis still needs an honest label.
   *
   * A single-voltage study has an unambiguous frame, so name it. With
   * several levels and no chosen frame there is no single voltage the
   * axis is in -- each curve is drawn in its own -- so say "primary"
   * rather than inventing one. "pickup" (the old fallback) told the
   * reader nothing.
   */
  if (!viewLabel) {
    if (V_view_kV == null && study.voltages.size === 1) {
      const only = [...study.voltages.values()][0];
      V_view_kV = only.kV;
      viewLabel = `${only.name} · ${only.kV} kV`;
    } else if (V_view_kV == null && study.voltages.size > 1) {
      viewLabel = 'primary, per relay';
    } else {
      viewLabel = 'primary';
    }
  }

  /*
   * Axis mode (spec: _Display axis modes_). `primary` labels the axis
   * in primary amps; `secondary` divides by a reference CT so the
   * numbers match what a relay's own settings sheet shows.
   */
  const axisMode: 'primary' | 'secondary' | 'multiples' = view?.axis ?? 'primary';

  /**
   * CT ratio anchoring the secondary axis.
   *
   * Spec _Two-axes display_: the reference is the explicitly named
   * curve's CT, or failing that the highest ratio in the plot. Each
   * curve still computes against its *own* CT; only the axis labelling
   * uses this one.
   */
  const referenceCt = ((): number | undefined => {
    if (axisMode !== 'secondary') return undefined;
    const named = view?.reference_ct?.deviceId
      ? study.relays.get(view.reference_ct.deviceId)?.ct_ratio
      : undefined;
    if (named) return named;
    const ratios = [...study.relays.values()]
      .map((r) => r.ct_ratio)
      .filter((r): r is number => r != null && r > 0);
    return ratios.length > 0 ? Math.max(...ratios) : undefined;
  })();

  /** Tick label for a current, honouring the axis mode. */
  const axisTickLabel = (I_primary: number): string =>
    axisMode === 'secondary' && referenceCt
      ? formatSi(I_primary / referenceCt, 'A')
      : formatSi(I_primary, 'A');

  /*
   * Which current the abscissa is.
   *
   * `any` -- the default -- means the axis is simply current, and every
   * curve is drawn against it whatever it measures. That is the case
   * where an engineer wants several characteristics on one sheet
   * without arguing about components; the legend states each curve's
   * quantity, which is what keeps it readable.
   *
   * Naming a quantity opts into strictness: the sheet becomes an
   * earth-fault or negative-sequence sheet, curves measuring something
   * else are converted onto it where the condition allows and
   * suppressed where it does not.
   */
  const axisQuantity: MeasuredQuantity | 'any' =
    isMeasuredQuantity(opts.view?.quantity) ? opts.view.quantity : 'any';

  /* Only meaningful for the strict modes; `phase` where the axis is
   * unconstrained, so faults keep standing at their phase current. */
  const viewQuantity: MeasuredQuantity = axisQuantity === 'any' ? 'phase' : axisQuantity;

  const quantityNote = axisQuantity === 'any' || axisQuantity === 'phase'
    ? ''
    : `${quantityLabel(axisQuantity)} · `;
  const currentAxisTitle =
    axisMode === 'secondary' && referenceCt
      ? `Current (A secondary, ${quantityNote}CT ${trimZeros(referenceCt)}:1 · ${viewLabel})`
      : `Current (A primary · ${quantityNote}${viewLabel})`;

  /*
   * The condition this sheet depicts, if it names one.
   *
   * A fault type fixes the ratios between phase current and the
   * sequence components, which is what lets a curve measured in one
   * quantity be placed on an axis drawn in another -- and what says
   * which components a condition carries none of, so an element that
   * cannot operate is suppressed rather than drawn somewhere
   * meaningless.
   */
  /** Named level the sheet is drawn in, for the zero-sequence lookup. */
  const viewLevelName = view?.voltage?.trim().replace(/^"|"$/g, '');

  /*
   * A scenario holds one set of figures per level and the sheet is drawn
   * in one frame, so the ratios come from that frame's set -- never from
   * another level's, which would mix two turns ratios into one number.
   */
  const conditionName = opts.view?.condition;
  const condition: ResolvedCondition | null =
    conditionName ? resolveCondition(study, conditionName, viewLevelName) : null;

  /* Per-relay metadata cache (relay id -> voltage kV) */
  const relayVoltages = new Map<string, number>();
  for (const item of doc.items) {
    if (item.type !== 'relay') continue;
    const r: any = item;
    const vm = r.members.find((mm: any) => mm.kind === 'scalar' && mm.key === 'voltage');
    if (vm) {
      const v = vm.value as any;
      const nm = typeof v === 'object' ? v.value : v;
      if (typeof nm === 'string') {
        const kv = voltageKvs.get(nm);
        if (kv) relayVoltages.set(item.id, kv);
      }
    }
  }

  /* First pass: collect I_pu-driven range; also collect all curves'
   * data so we can project into the view-voltage. */
  let I_lo = 10, I_hi = 50_000;
  let t_lo = 0.01, t_hi = 1000;

  /**
   * Conditions the sheet cannot mark, and why.
   *
   * Stated in the legend rather than dropped, for faults and scenarios
   * alike. A condition used only for grading and never drawn was the
   * state before this: the margin report cited something that appeared
   * nowhere on the sheet, so a reader had no way to see where it stood.
   */
  /**
   * Anything this sheet places by the turns ratio where that ratio is
   * known not to hold.
   *
   * `survivesVoltageReferral` answers `true` for phase current
   * unconditionally, and for a balanced fault that is right. It is not
   * right behind a winding that blocks zero sequence: phase current is
   * `I1 + I2 + I0`, and with the zero-sequence third trapped in the
   * delta the remaining two do not sum to the ratio's answer.
   *
   * The study has already said which windings block it, so the sheet
   * can say when it is relying on a ratio that does not apply. Six
   * places refer by that ratio -- fault rules, scenario rules, marked
   * points, annotations, condition currents and (as a fallback) curves
   * -- and all of them come through here, so the advice is worded once
   * and cannot drift between them.
   *
   * Advisory, not suppressing: the sheet is still worth reading, and
   * the fix is one line of source.
   */
  const referralCaveats = new Map<string, string>();

  const noteReferralCaveat = (
    subject: string,
    quantity: MeasuredQuantity,
    fromLevel: string | undefined,
    toLevel: string | undefined,
    type: FaultType | undefined,
  ): void => {
    if (quantity !== 'phase') return;
    if (!fromLevel || !toLevel || fromLevel === toLevel) return;
    /* A balanced fault carries no zero sequence to be blocked, so the
     * ratio holds and there is nothing to warn about. */
    if (type === 'three_phase') return;
    if (study.zeroSequence.get(levelPairKey(fromLevel, toLevel)) !== 'blocked') return;
    referralCaveats.set(subject,
      `${subject} placed by the ${fromLevel}-${toLevel} turns ratio. Zero sequence is `
      + 'blocked between them, so phase current does not follow that ratio under an '
      + 'unbalanced fault; declare the condition as a scenario with figures at both '
      + 'levels and it is placed from the study\'s own numbers instead');
  };

  const unmarkedScenarios: string[] = [];

  /*
   * Times, drawn as horizontal rules.
   *
   * The other axis's answer to a fault: a limit the curves are judged
   * against rather than a current they are evaluated at. They widen the
   * time domain the way a fault widens the current domain, so a
   * requirement can never be off the sheet that is supposed to show it
   * being met.
   */
  /*
   * Longest first, so the legend reads down the sheet the way the rules
   * stand on it: the 4 s withstand at the top, the 200 ms arc-flash
   * boundary at the bottom. Declaration order made the reader match
   * each entry to a rule by its figure.
   */
  /**
   * Whether something scoped to particular sheets belongs on this one.
   *
   * A study with a phase sheet and a negative-sequence sheet routinely
   * carries marks that mean something on one and nothing on the other
   * -- an inrush point in phase amps, a clearance that applies only to
   * the earth-fault story. Without a way to say so the only options
   * were to draw them everywhere or split the study into two files,
   * and two files drift.
   *
   * Absent `view` means every sheet, so nothing written before this
   * changes.
   */
  const onThisSheet = (scoped: { views?: string[] }): boolean => {
    if (!scoped.views || scoped.views.length === 0) return true;
    const here = view?.name;
    return here != null && scoped.views.includes(here);
  };

  const times = [...study.times.values()]
    .filter((t) => Number.isFinite(t.t_s) && t.t_s > 0 && onThisSheet(t))
    .sort((a, b) => b.t_s - a.t_s);
  for (const t of times) {
    if (t.t_s * 0.7 < t_lo) t_lo = t.t_s * 0.7;
    if (t.t_s * 1.4 > t_hi) t_hi = t.t_s * 1.4;
  }

  /*
   * Faults are listed in the order the axis puts them, not the order
   * they were declared. A legend that runs 6.4 kA, 950 A, 3.1 kA
   * against rules standing left to right makes the reader match them up
   * by eye, every time.
   */
  const faults: FaultEntry[] = [];
  for (const item of doc.items) {
    if (item.type === 'faults') {
      const fb = item as FaultsBlock;
      for (const f of fb.faults) {
        if (!Number.isFinite(f.I_A)) continue;
        if (!onThisSheet(f)) continue;
        const V_fault = f.voltage ? voltageKvs.get(f.voltage) : undefined;

        /*
         * The fault's value of *the axis quantity* -- declared where the
         * study gives it, otherwise derived from the fault's type, which
         * fixes the ratios between phase current and the components.
         * Declared always wins, so writing `I2_A` overrides the table.
         */
        const resolved = resolveCurrent(
          viewQuantity,
          { phase: f.I_A, I2: f.I2_A, I0: f.I0_A, residual: f.earth_A },
          isFaultType(f.type) ? f.type : undefined,
        );
        if (resolved == null) {
          /* Said, as the equivalent scenario case is. A fault silently
           * absent from a sheet reads as one that was not relevant. */
          unmarkedScenarios.push(
            `${f.name} declares no ${quantityLabel(viewQuantity)}`
            + (f.type ? '' : '; give it a type, or the component itself'),
          );
          continue;
        }
        const declared = resolved.value;

        /*
         * Whether zero sequence reaches this level is a property of the
         * windings between them, which the study declares.
         */
        const differentLevel = V_fault != null && V_view_kV != null && V_fault !== V_view_kV;
        if (differentLevel
            && !survivesVoltageReferral(viewQuantity, study, f.voltage, viewLevelName)) {
          continue;
        }
        if (differentLevel) {
          noteReferralCaveat(`fault ${oneLine(f.name)}`, viewQuantity,
            f.voltage, viewLevelName, f.type);
        }

        const I_view = V_fault && V_view_kV ? declared * (V_fault / V_view_kV) : declared;
        if (I_view * 0.8 < I_lo) I_lo = I_view * 0.8;
        if (I_view * 1.5 > I_hi) I_hi = I_view * 1.5;
        faults.push({
          name: f.name,
          kind: 'fault',
          description: f.description,
          I_A: declared,
          voltage: f.voltage,
          voltage_kV: V_fault,
          voltageLabel: f.voltage ? `${f.voltage} · ${voltageKvs.get(f.voltage) ?? '?'} kV` : undefined,
          I_view,
        });
      }
    }
  }

  /* Left to right, as the rules stand on the sheet. */
  faults.sort((a, b) => (a.I_view ?? a.I_A) - (b.I_view ?? b.I_A));

  /**
   * Marked points the sheet's own quantity cannot carry to this level.
   *
   * A point is a current on a level, and reaching the level the sheet is
   * drawn in means crossing whatever is between them. Phase current
   * crosses by ampere-turns; residual current may not cross at all. Left
   * unchecked, a residual point declared on the star side appeared on a
   * delta-side residual sheet at the turns ratio -- a marker standing at
   * a current that cannot exist there.
   */
  const unreferrablePoints: string[] = [];

  /**
   * Markers declared in a component this sheet is not drawn in.
   *
   * Expected in a study with a sheet per quantity, so they are summed
   * into one note rather than given a bullet each -- but still named,
   * since a marker the author wrote and cannot see is worth a line.
   */
  const otherQuantityPoints: string[] = [];

  /*
   * Scenario rules.
   *
   * A scenario declares its own figure for each level, so the rule
   * stands at *this level's* declared current with nothing referred
   * across a transformer -- which is the reason to write one instead of
   * a fault. A scenario silent about this level therefore has no
   * position here at all, and saying so is the only honest answer;
   * borrowing another level's number would put the rule out by the
   * turns ratio.
   */
  for (const scenario of study.scenarios.values()) {
    const c = resolveCondition(study, scenario.name, viewLevelName);
    if (!c) continue;

    if (c.voltage == null) {
      unmarkedScenarios.push(
        `${scenario.name} declares no currents at ${viewLevelName ?? 'this level'}`
        + (c.levels.length > 0 ? ` (has ${c.levels.join(', ')})` : ''),
      );
      continue;
    }

    const resolved = resolveCurrent(viewQuantity, c.currents, c.type);
    if (resolved == null) {
      unmarkedScenarios.push(
        `${scenario.name} declares no ${quantityLabel(viewQuantity)} at ${c.voltage}`,
      );
      continue;
    }

    const declared = resolved.value;
    if (!(declared > 0) || !Number.isFinite(declared)) {
      /* Zero is a real answer -- a residual blocked by a delta -- and it
       * has no place on a log axis, so it is reported, not plotted. */
      unmarkedScenarios.push(
        `${scenario.name} carries no ${quantityLabel(viewQuantity)} at ${c.voltage}`,
      );
      continue;
    }

    const V_level = c.voltage_kV ?? voltageKvs.get(c.voltage);
    /*
     * Referred only when the sheet is drawn in a frame the scenario did
     * not declare -- which `resolveCondition` allows for a single-level
     * scenario, where there is nothing to be ambiguous about.
     */
    const I_view = V_level && V_view_kV && V_level !== V_view_kV
      ? declared * (V_level / V_view_kV)
      : declared;
    if (V_level && V_view_kV && V_level !== V_view_kV) {
      noteReferralCaveat(oneLine(scenario.name), viewQuantity,
        c.voltage, viewLevelName, c.type);
    }
    if (V_level && V_view_kV && V_level !== V_view_kV
        && !survivesVoltageReferral(viewQuantity, study, c.voltage, viewLevelName)) {
      unmarkedScenarios.push(
        `${scenario.name} is declared at ${c.voltage}, and ${quantityLabel(viewQuantity)} `
        + 'does not cross to this level',
      );
      continue;
    }

    if (I_view * 0.8 < I_lo) I_lo = I_view * 0.8;
    if (I_view * 1.5 > I_hi) I_hi = I_view * 1.5;
    faults.push({
      name: scenario.name,
      kind: 'scenario',
      description: scenario.description,
      I_A: declared,
      voltage: c.voltage,
      voltage_kV: V_level,
      voltageLabel: `${c.voltage} · ${V_level ?? '?'} kV`,
      I_view,
    });
  }

  /*
   * Project a current from the frame it was declared in onto the view
   * frame. Across a transformer the ampere-turns balance, so a current
   * referred from V_source to V_view scales by V_source / V_view: an
   * 11 kV pickup of 480 A is 160 A seen from 33 kV, not 1440 A. This
   * is the same direction the fault projection above uses.
   */
  const project = (I: number, V_source: number | undefined): number => {
    if (V_view_kV == null || V_source == null || !(V_source > 0) || !(V_view_kV > 0)) return I;
    return I * (V_source / V_view_kV);
  };

  /* Widen the domain to hold every pickup in the study. */
  for (const element of allElements(study)) {
    /* A curve kept off this sheet must not stretch its axes either. */
    if (!onThisSheet(element)) continue;
    for (const stage of element.stages) {
      if (stage.I_pu_A == null || !Number.isFinite(stage.I_pu_A)) continue;
      const pu = project(stage.I_pu_A, element.voltage_kV);
      if (pu * 0.5 < I_lo) I_lo = pu * 0.5;
      if (pu * 20 > I_hi) I_hi = pu * 20;
    }
  }

  /*
   * Explicit `view` bounds are *authoritative*, not merely widening.
   * The auto-fit above grows the domain to hold every pickup and
   * fault; a declared bound -- or an interactive zoom, which the
   * playground expresses as the same bound -- replaces it outright,
   * otherwise it would be impossible to look at less than everything.
   *
   * Declared bounds also bypass the decade rounding below: rounding a
   * zoom out to whole decades would quantise the gesture away.
   */
  const xMinFixed = view?.current_min != null && Number.isFinite(view.current_min);
  const xMaxFixed = view?.current_max != null && Number.isFinite(view.current_max);
  const yMinFixed = view?.time_min != null && Number.isFinite(view.time_min);
  const yMaxFixed = view?.time_max != null && Number.isFinite(view.time_max);

  if (xMinFixed) I_lo = view!.current_min!;
  if (xMaxFixed) I_hi = view!.current_max!;
  if (yMinFixed) t_lo = view!.time_min!;
  if (yMaxFixed) t_hi = view!.time_max!;

  /* Guard against an inverted or degenerate domain. */
  if (!(I_hi > I_lo)) I_hi = I_lo * 10;
  if (!(t_hi > t_lo)) t_hi = t_lo * 10;

  const nice = LogScale.niceDomain(I_lo, I_hi);
  let I_min = xMinFixed ? I_lo : nice.min;
  let I_max = xMaxFixed ? I_hi : nice.max;
  let t_min = yMinFixed ? t_lo : Math.pow(10, Math.floor(Math.log10(t_lo)));
  let t_max = yMaxFixed ? t_hi : Math.pow(10, Math.ceil(Math.log10(t_hi)));

  /*
   * Axis padding, in decades, around the auto-fitted domain. An end
   * with an explicitly declared bound is left alone: the author has
   * already said where they want it.
   */
  const pad = (base: number | undefined, specific: number | undefined): number =>
    Number.isFinite(specific) ? specific! : Number.isFinite(base) ? base! : 0;

  const padILow = pad(view?.current_pad, view?.current_pad_low);
  const padIHigh = pad(view?.current_pad, view?.current_pad_high);
  const padTLow = pad(view?.time_pad, view?.time_pad_low);
  const padTHigh = pad(view?.time_pad, view?.time_pad_high);

  if (!xMinFixed && padILow) I_min = Math.pow(10, Math.log10(I_min) - padILow);
  if (!xMaxFixed && padIHigh) I_max = Math.pow(10, Math.log10(I_max) + padIHigh);
  if (!yMinFixed && padTLow) t_min = Math.pow(10, Math.log10(t_min) - padTLow);
  if (!yMaxFixed && padTHigh) t_max = Math.pow(10, Math.log10(t_max) + padTHigh);

  /* margins */
  /*
   * Sheet frame and title block (spec: `page { border = true; }`).
   *
   * When enabled the plot sits inside a drawing-office style frame
   * with a title block along the bottom, so the export can be filed or
   * printed as a standalone document. Everything below is laid out
   * relative to the frame's inner edge.
   */
  const bordered = opts.page?.border === true;
  const sheetInset = bordered ? 14 : 0;
  /*
   * The title block holds a stack: heading, optional subtitle, and an
   * optional author's footer along its foot.
   *
   * It was a flat 54 px whatever was in it, with the footer pinned 6 px
   * above the bottom edge. A block carrying both a subtitle and a
   * footer put their baselines 8 px apart -- overlapping at the default
   * size and plainly colliding at any larger `font_size_px`, which is
   * why setting one looked like it did nothing: the text grew into the
   * line above it rather than into space of its own.
   *
   * Measured from what is actually there, so the strip is as tall as it
   * needs to be and no taller.
   */
  const tbFooterSize = opts.page?.footer
    ? Math.max(1, opts.page.footer.font_size_px ?? FONT_DETAIL - 1)
    : 0;
  const tbHasSubtitle = ((): boolean => {
    const title = opts.page?.title;
    return typeof title === 'object' && title != null && !!title.subtitle;
  })();
  const titleBlockH = bordered
    ? 22                                        /* top pad to the first baseline */
      + FONT_LABEL + 4                          /* the heading */
      + (tbHasSubtitle ? 2 + FONT_SUBTITLE + 3 : 0)
      + (tbFooterSize > 0 ? tbFooterSize + 8 : 0)
      + 6                                       /* bottom pad */
    : 0;

  /*
   * Plot margins. The legend column is sized to hold a relay
   * identity line ("Schneider MiCOM_P122") without wrapping, and the
   * top margin to clear a title set at FONT_TITLE.
   */
  /*
   * How the curves are identified, which decides whether a gutter is
   * reserved at all.
   *
   * Only `column` costs width. The other modes give that 330 px back
   * to the plot, leaving just enough room for the last tick label --
   * and for the right-hand scale, when the axes are mirrored.
   */
  const mirrorAxes = pageAxes?.mirror === true;
  const legendMode = resolveLegendMode(opts.page?.legend);

  /** Which amps the legend quotes pickups in; see `pickupLabel`. */
  const declaredCurrents = opts.page?.legend?.currents;
  const legendCurrents: LegendCurrents | undefined =
    declaredCurrents === 'primary' || declaredCurrents === 'secondary'
      || declaredCurrents === 'both'
      ? declaredCurrents
      : undefined;

  /**
   * Elements asked for in secondary amps that carry no CT ratio.
   *
   * Named in the legend rather than silently left in primary: a sheet
   * that says it is in secondary amps and shows a primary figure is
   * off by the ratio, which is the sort of error that reaches a relay.
   */
  const missingCtRatio = new Set<string>();

  /*
   * The sheet's own heading wins over the page's.
   *
   * `page` is paper and decoration and is shared by every sheet of a
   * study; what a sheet is *of* changes with it. A negative-sequence
   * sheet headed "Phase grading" because the page said so is worse
   * than no title at all, so `view { title }` overrides -- the
   * ordinary more-specific-wins, entirely inside the presentation
   * layer.
   */
  const pageTitle = opts.page?.title;
  /*
   * `[meta.*]`, `[date]`, `[page]` and `[of]` are substituted here as
   * they are in the footer. The footer expanded them and the title did
   * not, so a heading written to the documented convention printed the
   * macro rather than the project it names -- and the one place the
   * reader is most likely to look.
   */
  const titleText = expandMacros(
    opts.view?.title ?? (typeof pageTitle === 'string' ? pageTitle : pageTitle?.text) ?? '',
    study,
  ) || undefined;
  const subtitleText = expandMacros(
    opts.view?.subtitle
      ?? (typeof pageTitle === 'string' ? undefined : pageTitle?.subtitle) ?? '',
    study,
  ) || undefined;

  const leftMargin = 92 + sheetInset;
  const rightMargin = (legendMode === 'column' ? 330 : (mirrorAxes ? 104 : 58)) + sheetInset;

  /*
   * Top margin: enough for the heading, plus clearance for whatever
   * sits at the top of the plot.
   *
   * Mirrored axes print a second current scale *above* the frame, at
   * `topMargin - 8` -- which is exactly where the subtitle's baseline
   * falls, so the two overprinted. The scale needs its own band. A
   * wrapped title or subtitle needs its extra lines counted too, or it
   * grows down into the same place.
   */
  const headingExtra = titleText
    ? labelExtraHeightPx(titleText, FONT_TITLE)
      + (subtitleText ? labelExtraHeightPx(subtitleText, FONT_SUBTITLE) : 0)
    : 0;
  const topMargin =
    (titleText ? 52 : 32) + (mirrorAxes ? 22 : 0) + headingExtra + sheetInset;
  const plotW = W - leftMargin - rightMargin;

  /*
   * The current scale is fixed by the horizontal margins alone, so it
   * can be built before the vertical ones are settled -- which is what
   * lets the fault labels be packed into rows *first*, and the band
   * below the axis then be sized to the rows it actually needs.
   */
  const xScale = new LogScale(I_min, I_max, leftMargin, leftMargin + plotW);

  /*
   * `page { stretch = true; }` gives the plot every pixel the
   * furniture below it does not need.
   *
   * The default reserve is a fixed 140 px, sized for the worst case:
   * several fault names stacked into rows. A study with one row of
   * labels leaves most of that unused, which on a tall portrait sheet
   * is a visible band of nothing between the axis title and the plot.
   * Stretching measures the band instead of reserving for it.
   */
  const stretch = opts.page?.stretch === true;
  const faultLayout = packFaultLabels(
    faults, xScale, I_min, I_max, opts.page?.faults?.labels !== false, leftMargin + plotW,
    opts.page?.faults?.currents !== false,
  );
  const faultRows = faultLayout.reduce((n, f) => Math.max(n, f.row + 1), 0);

  const faultBandH = faultRows > 0
    ? FAULT_BAND_DY + (faultRows - 1) * (LINE_DETAIL - 1) + 6
    : 26;
  const bottomMargin = (stretch ? faultBandH + 34 : 140) + sheetInset + titleBlockH;
  const plotH = H - topMargin - bottomMargin;

  const yScale = new LogScale(t_min, t_max, topMargin + plotH, topMargin);

  /* Curves -- driven entirely by the resolved study model. */
  const curves: CurveEntry[] = [];
  /*
   * Hues are assigned in fixed slot order. Past the end of the palette
   * the hue repeats but the stroke changes to dashed, then dotted, so
   * two curves never share both -- identity survives without inventing
   * colours.
   */
  let colorIdx = 0;
  const pickStyle = (): { color: string; dash?: string } => {
    const index = colorIdx++;
    return {
      color: pal[index % pal.length],
      dash: strokeDashFor(index, pal.length),
    };
  };

  /** Dash pattern for a style word, or undefined for a solid line. */
  const dashForStyle = (style: CurveStyle | undefined): string | undefined => {
    switch (style) {
      case 'dashed': return '6 4';
      case 'dotted': return '1 3';
      /* `solid` is an explicit request for no dashes, and must beat the
       * automatic pattern the palette would otherwise assign. */
      case 'solid': return '';
      default: return undefined;
    }
  };

  /**
   * The ink one curve is drawn in, after any declared override.
   *
   * A slot is consumed from the palette either way, so declaring a
   * colour on one element does not shift the hues of the others. The
   * sheet is read against the legend, and a study that recolours as
   * curves are added and removed makes two revisions incomparable.
   */
  const styleFor = (
    over: { color?: string; style?: CurveStyle; width_px?: number },
    auto: { color: string; dash?: string },
  ): { color: string; dash?: string; widthPx?: number } => {
    const dash = dashForStyle(over.style);
    return {
      color: over.color ?? auto.color,
      dash: dash === undefined ? auto.dash : (dash === '' ? undefined : dash),
      widthPx: over.width_px,
    };
  };

  const samples = sampleLog(I_min, I_max, 200);

  /**
   * Trace one time-current characteristic across the plotted domain.
   *
   * `tAt` is given the current in the *source's own* voltage frame,
   * while the path is drawn against the view frame -- so a study
   * spanning a transformer compares curves on one axis without any
   * caller having to pre-convert.
   *
   * `axisFactor` is element units per unit of the axis quantity, for a
   * sheet drawn in a quantity the element does not itself measure. On a
   * log axis it is a constant pixel shift, so a curve keeps its shape
   * and its operate times exactly -- only its abscissa moves.
   */
  const trace = (
    V_source: number | undefined,
    tAt: (I_source: number) => number,
    /**
     * Currents at which the characteristic steps discontinuously --
     * every stage pickup. A log-spaced sweep alone would join the two
     * sides of a step with a sloped segment, drawing a diagonal where
     * a protection curve has a vertical edge, so each breakpoint is
     * sampled twice: just below it and exactly on it.
     */
    breakpoints: number[] = [],
    axisFactor = 1,
    /**
     * Highest current the characteristic is drawn to, in the element's
     * own amps. Past it the curve is describing a fault the network
     * cannot deliver, so it stops rather than running to the frame.
     */
    maxSource: number | undefined = undefined,
  ): string => {
    const xs = [...samples];
    if (maxSource != null) {
      /* Sample the ceiling itself, or the last sample below it decides
       * where the curve appears to end -- up to half a decade short. */
      const onAxis = maxSource / axisFactor;
      if (onAxis > I_min && onAxis < I_max) xs.push(onAxis);
    }
    for (const bp of breakpoints) {
      /* Breakpoints arrive in the element's own quantity, so they need
       * the same factor as the samples or a vertical riser lands at the
       * wrong x. */
      const onAxis = bp / axisFactor;
      if (!(onAxis > 0) || onAxis < I_min || onAxis > I_max) continue;
      xs.push(onAxis * (1 - 1e-9), onAxis);
    }
    xs.sort((a, b) => a - b);

    const parts: string[] = [];
    let started = false;
    let previousOperated = false;

    for (const I_view of xs) {
      /*
       * From the axis reading to the current the characteristic is
       * defined in: first the quantity, then the voltage frame.
       */
      const I_measured = I_view * axisFactor;
      const I_source =
        V_view_kV != null && V_source != null && V_source > 0 && V_view_kV > 0
          ? I_measured * (V_view_kV / V_source)
          : I_measured;
      if (maxSource != null && I_source > maxSource) {
        started = false;
        previousOperated = false;
        continue;
      }
      const t = tAt(I_source);

      if (!Number.isFinite(t) || t <= 0) {
        started = false;
        previousOperated = false;
        continue;
      }

      const px = xScale.toPx(I_view);
      const py = yScale.toPx(t);
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        started = false;
        previousOperated = false;
        continue;
      }

      /*
       * Entering the operating region: carry the curve up to the top
       * of the plot first. That vertical riser at pickup is how a TCC
       * is conventionally drawn -- a definite-time stage in particular
       * is a vertical edge followed by a horizontal shelf, and without
       * this it would appear to begin in mid-air.
       */
      if (!previousOperated) {
        const topPy = yScale.toPx(t_max);
        if (Number.isFinite(topPy) && Math.abs(topPy - py) > 0.5) {
          parts.push(`M${px.toFixed(1)} ${topPy.toFixed(1)}`);
          started = true;
        }
      }

      parts.push(`${started ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`);
      started = true;
      previousOperated = true;
    }
    return parts.join(' ');
  };

  /**
   * A flex table as an SVG path in the current projection.
   *
   * Returns the forward path and the reversed point list, so a band
   * can be closed by walking its upper bound back to the start.
   */
  const flexPath = (
    points: Array<{ I_A: number; t_s: number }>,
    /**
     * The device's own level. A published characteristic is in the amps
     * of the winding it sits on, so it needs referring to the view
     * frame exactly as a relay curve does -- without this a fuse on the
     * low side of a transformer was drawn at its own amps on a
     * high-side sheet, out by the turns ratio.
     */
    V_source?: number,
  ): { d: string; reversed: string[] } | null => {
    const pts: string[] = [];
    for (const point of points) {
      const px = xScale.toPx(project(point.I_A, V_source));
      const py = yScale.toPx(point.t_s);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      pts.push(`${px.toFixed(1)} ${py.toFixed(1)}`);
    }
    if (pts.length < 2) return null;
    return { d: `M${pts.join(' L')}`, reversed: [...pts].reverse() };
  };

  /** Legend body for a device. */
  const deviceDetailLines = (device: Device): DetailLine[] => {
    const lines: DetailLine[] = [];
    const identity = [device.maker, device.model].filter(Boolean).join(' ');
    if (identity) lines.push({ text: identity, role: 'identity' });

    const bits: string[] = [];
    if (device.kind) bits.push(DEVICE_KIND_LABEL[device.kind] ?? device.kind);
    if (device.rating_A != null) bits.push(formatSi(device.rating_A, 'A'));
    if (device.t_delay_s != null) bits.push(`clearing ${formatSi(device.t_delay_s, 's')}`);
    if (bits.length) lines.push({ text: bits.join(' \u00b7 '), role: 'settings' });

    if (device.min_melt && device.total_clear) {
      /*
       * ASCII arrow deliberately: U+2192 is outside the PDF core
       * fonts' WinAnsi encoding and comes out as mojibake on the
       * printed sheet.
       */
      lines.push({ text: 'min melt -> total clear', role: 'context' });
    }
    return lines.filter((l) => l.text);
  };

  /**
   * Current a named condition gives, in one level's own frame.
   *
   * A fault is one figure at one level, so reaching another level means
   * referring it by ampere-turns -- and only where the quantity survives
   * the windings between them. A scenario needs none of that when it
   * declares the level asked for, which is the whole reason to write
   * one: the lookup returns that level's own figures and the referral
   * below is a no-op.
   */
  const conditionCurrentAt = (
    name: string,
    voltage: string | undefined,
    quantity: MeasuredQuantity,
  ): number | null => {
    const c = resolveCondition(study, name, voltage);
    if (!c) return null;

    const resolved = resolveCurrent(quantity, c.currents, c.type);
    if (resolved == null) return null;

    const fromKv = c.voltage_kV;
    const levelKv = voltage ? study.voltages.get(voltage)?.kV : undefined;
    if (fromKv == null || levelKv == null || fromKv === levelKv) return resolved.value;
    if (!survivesVoltageReferral(quantity, study, c.voltage, voltage)) return null;
    noteReferralCaveat(oneLine(name), quantity, c.voltage, voltage, c.type);
    return resolved.value * (fromKv / levelKv);
  };

  /**
   * Current an annotation refers to, in the referenced device's own
   * frame. A named condition is projected onto that level; a bare
   * `at_I_A` is taken as already being in it.
   */
  const annotationCurrent = (
    _study: Study,
    annotation: Annotation,
    voltage: string | undefined,
    /**
     * What the annotated element measures. A named condition is resolved
     * to *that* quantity, so an earth-fault element is annotated at the
     * residual and a negative-sequence element at `I2`.
     *
     * This used to take `fault.I_A` unconditionally, which put every
     * annotation at the fault's phase current whatever the element it
     * pointed at -- the wrong time on the report and the wrong x on a
     * sheet drawn in a component.
     */
    quantity: MeasuredQuantity = 'phase',
  ): number | null => {
    if (annotation.condition) {
      return conditionCurrentAt(annotation.condition, voltage, quantity);
    }
    /*
     * Resolved for the quantity the *side* measures, exactly as a
     * condition is. `at_I_A` still means phase current, so nothing
     * written before this changes; naming the component is what makes
     * an annotation placeable on a sheet whose abscissa is not phase.
     */
    const declared = resolveCurrent(
      quantity,
      {
        phase: annotation.at_I_A, I1: annotation.at_I1_A, I2: annotation.at_I2_A,
        I0: annotation.at_I0_A, residual: annotation.at_earth_A,
      },
      annotation.type,
    );
    if (declared == null) return null;

    /*
     * A bare current needs a level, exactly as a fault's does.
     *
     * It used to be handed to each side unchanged, so on a margin
     * spanning a transformer the same number was read once at 11 kV and
     * once at 33 kV -- two different currents -- and the annotation
     * reported 667 ms against a true margin of 1.639 s. That is the
     * very contradiction this code was fixed for once already, for the
     * `fault` form; the bare figure kept it.
     *
     * The default is the view's level: `at_I_A` is a number read off
     * the axis in front of you.
     */
    const fromLevel = annotation.voltage ?? viewLevelName;
    const fromKv = fromLevel ? voltageKvs.get(fromLevel) : V_view_kV;
    const toKv = voltage ? study.voltages.get(voltage)?.kV : undefined;
    if (fromKv == null || toKv == null || fromKv === toKv) return declared.value;
    if (!survivesVoltageReferral(quantity, study, fromLevel, voltage)) return null;
    noteReferralCaveat('an annotation\'s declared current', quantity,
      fromLevel, voltage, condition?.type);
    return declared.value * (fromKv / toKv);
  };

  /** Operate time of a device at a current, by role. */
  const deviceTime = (device: Device, I: number): number => {
    const points = device.total_clear ?? device.flex_points ?? device.min_melt;
    if (points) return tTripFlex(I, points);
    return device.t_delay_s ?? Infinity;
  };

  /**
   * Operate time of one side of a margin annotation. A fuse is judged
   * on total clear as a primary and minimum melt as a backup, matching
   * how `grades.ts` reasons about it.
   */
  /**
   * Narrow a resolved side to the single stage its reference named.
   *
   * `R_850:46/energ` means that stage, not the element. Without it a
   * reference is the composite -- what the relay trips at -- which is
   * right for grading and wrong for an annotation about the stage that
   * is armed under the condition being drawn.
   */
  const atStage = (
    side: { element?: Element; device?: Device },
    ref: Ref | undefined,
  ): { element?: Element; device?: Device } => {
    if (!ref?.stageId || !side.element) return side;
    const stage = side.element.stages.find((st) => st.id === ref.stageId);
    if (!stage) return side;
    return { ...side, element: { ...side.element, stages: [stage] } };
  };

  const sideTime = (
    side: { element?: Element; device?: Device },
    I: number,
    role: 'primary' | 'backup',
  ): number => {
    if (side.element) return tTripElement(side.element, I);
    if (!side.device) return Infinity;
    const points = role === 'primary'
      ? side.device.total_clear ?? side.device.flex_points ?? side.device.min_melt
      : side.device.min_melt ?? side.device.flex_points ?? side.device.total_clear;
    if (points) return tTripFlex(I, points);
    return side.device.t_delay_s ?? Infinity;
  };

  /** Every pickup an element steps at, in the view frame. */
  const breakpointsOf = (element: Element, V_source: number | undefined): number[] =>
    element.stages
      .filter((s) => s.I_pu_A != null && Number.isFinite(s.I_pu_A))
      .map((s) => project(s.I_pu_A!, V_source));

  /**
   * Pickup as the legend should show it.
   *
   * `view { axis = "secondary" }` means the engineer is working in the
   * relay's own frame, so the legend quotes secondary amps alongside
   * the primary value rather than making them do the CT arithmetic.
   */
  const pickupLabel = (stage: Stage, element: Element): string => {
    if (stage.I_pu_A == null || !Number.isFinite(stage.I_pu_A)) return '';
    const primaryA = formatSi(stage.I_pu_A, 'A');

    /*
     * A study is written in primary amps because that is what the fault
     * study gives, but the number an engineer types into the relay is
     * the secondary one. `page { legend { currents } }` asks for that
     * figure whatever the abscissa is doing -- the two are separate
     * questions, and a sheet taken to site wants the settings in the
     * units of the settings sheet.
     *
     * Defaults to today's rule: primary, with the secondary in brackets
     * only when the axis itself is in secondary amps.
     */
    const want = legendCurrents ?? (axisMode === 'secondary' ? 'both' : 'primary');
    if (want === 'primary') return primaryA;

    if (!element.ct_ratio) {
      /* Nothing to convert with. Named once in the legend rather than
       * quietly showing primary amps under a "secondary" heading. */
      missingCtRatio.add(element.label);
      return primaryA;
    }

    const secondary = `${trimZeros(stage.I_pu_A / element.ct_ratio)} A sec`;
    return want === 'secondary' ? secondary : `${primaryA} (${secondary})`;
  };

  /** Legend detail for one stage, as discrete fields. */
  const stageDetail = (stage: Stage, element: Element): string => {
    const bits: string[] = [];
    const producer = stage.producer;
    if (producer?.kind === 'standard') bits.push(curveDisplayName(producer.id));
    else if (producer?.kind === 'formula') bits.push('Formula');
    else if (producer?.kind === 'flex') bits.push(`FlexCurve (${producer.points.length} pts)`);
    else if (producer?.kind === 'definite') bits.push('Definite time');

    const pu = pickupLabel(stage, element);
    if (pu) bits.push(pu);

    if (producer?.kind === 'definite') {
      if (stage.t_delay_s != null) bits.push(`delay ${formatSi(stage.t_delay_s, 's')}`);
    } else if (stage.tms != null) {
      /* Spec _On-graph annotation_: a solver-set value is labelled. */
      /* A solved dial names the one it replaced: the drawing is what
       * gets set, and the file still says something else. */
      const wasDeclared = stage.tms_declared != null
        ? `, was ${trimZeros(stage.tms_declared)}` : '';
      bits.push(`TMS ${trimZeros(stage.tms)}`
        + (stage.tms_auto ? ` (auto${wasDeclared})` : ''));
    }
    /*
     * What the curve is plotted against.
     *
     * A sheet carrying phase, earth-fault and negative-sequence
     * elements draws them all on one current axis, which is standard
     * practice but only readable if each curve says which current its
     * abscissa is. Phase is the unmarked default, so only the others
     * are called out.
     */
    const quantity = measuredQuantityOf(stage);
    if (quantity != null && quantity !== 'phase') bits.push(`vs ${quantityLabel(quantity)}`);

    /*
     * A curve that stops short of the frame looks like one the renderer
     * failed to finish, unless the sheet says the stop was asked for.
     */
    if (element.current_max_A != null) {
      bits.push(`to ${formatSi(element.current_max_A, 'A')}`);
    }

    return bits.join(' \u00b7 ');
  };

  /**
   * Legend body for an element, as *separate lines*.
   *
   * A multi-stage element used to be flattened onto one line joined by
   * pipes, which ran together and overflowed the legend column. One
   * line per stage is both readable and naturally width-bounded.
   */
  const elementDetailLines = (element: Element): DetailLine[] => {
    const lines: DetailLine[] = [];

    const identity = [element.maker, element.model].filter(Boolean).join(' ');
    if (identity) lines.push({ text: identity, role: 'identity' });

    if (element.stages.length === 1) {
      lines.push({ text: stageDetail(element.stages[0], element), role: 'settings' });
    } else {
      for (const stage of element.stages) {
        lines.push({ text: `${stage.id}: ${stageDetail(stage, element)}`, role: 'settings' });
      }
    }

    if (element.voltage) {
      lines.push({
        text: element.voltage_kV != null
          ? `${element.voltage} \u00b7 ${trimZeros(element.voltage_kV)} kV`
          : element.voltage,
        role: 'context',
      });
    }
    return lines.filter((l) => l.text);
  };

  const pickupPxOf = (
    element: Element,
    axisFactor = 1,
    V_source: number | undefined = element.voltage_kV,
  ): number => {
    /* The lowest pickup is where the composite curve starts. */
    let lowest = Infinity;
    for (const stage of element.stages) {
      if (stage.I_pu_A != null && Number.isFinite(stage.I_pu_A) && stage.I_pu_A < lowest) {
        lowest = stage.I_pu_A;
      }
    }
    if (!Number.isFinite(lowest)) return NaN;
    /* The pickup is in the element's own quantity, so it comes back onto
     * the axis by the same factor the curve did. */
    return xScale.toPx(project(lowest, V_source) / axisFactor);
  };

  /*
   * Spec _Stages and composite curves_: one curve per element by
   * default; `view { stages = "individual"; }` splits them apart.
   */
  const individual = view?.stages === 'individual';

  /** Elements the axis leaves off the sheet, and why. */
  const offAxisElements: string[] = [];
  /** Elements drawn against a quantity other than the one they measure. */
  const convertedElements = new Map<string, {
    measures: MeasuredQuantity;
    factor: number;
    /** Level the element sits on, when the factor also carries the
     * change of level. `undefined` for a same-frame conversion. */
    fromLevel?: string;
  }>();
  /**
   * Elements whose own current cannot reach this sheet, named one by
   * one with the reason.
   *
   * Distinct from `offAxisElements`, which is about the abscissa. These
   * are about the *network*: a residual element behind a delta measures
   * a current the sheet's level does not carry, so the objection is not
   * that the axis is inconvenient but that the element cannot operate.
   * Counted rather than named, a reader would have no way to tell which
   * relay had gone missing from a study that grades against it.
   *
   * Keyed on the label, because `axisFactorFor` is asked again for every
   * annotation that points at the element and each answer would
   * otherwise add the same sentence to the legend.
   */
  const blockedElements = new Map<string, string>();

  /**
   * Where an element sits, taken *wholly* from the depicted condition.
   *
   * A curve on another level used to be placed in two independent
   * steps: the turns ratio for the voltage, then the condition's ratios
   * for the quantity. The two disagree, because a scenario's per-level
   * figures need not follow the turns ratio -- and behind a delta they
   * must not. Phase current is `I1 + I2 + I0`, and the zero-sequence
   * part does not cross, so an unbalanced fault's phase current is not
   * the other level's divided by the ratio.
   *
   * On example 12 that put the LV breaker's curve a factor of sqrt(3)
   * to the right: its pickup landed at 2.56 A on an axis whose fault
   * rule stands at 2.23 A, so the sheet showed a breaker that never
   * picks up while the report had it clearing in 1.631 s and passing.
   * One drawing, two answers.
   *
   * When the condition declares figures at both levels there is no need
   * to refer anything. The element measures a stated current at its own
   * bus; the axis reads a stated current at the sheet's. Their ratio is
   * the whole mapping, voltage included, and it makes the plot agree
   * with the report by construction rather than by coincidence.
   *
   * `null` where the condition is silent about either level -- notably
   * for a `fault`, which is one current at one level and is properly
   * referred by the turns ratio. Those keep the old path.
   */
  const conditionPlacement = (
    element: Element,
    measures: MeasuredQuantity,
    onAxis: MeasuredQuantity,
  ): number | null => {
    if (!conditionName || !element.voltage || viewLevelName == null) return null;
    if (element.voltage === viewLevelName) return null;

    const own = resolveCondition(study, conditionName, element.voltage);
    const sheet = resolveCondition(study, conditionName, viewLevelName);
    /* `voltage` comes back undefined when the condition says nothing at
     * the level asked for, which is the case this must not guess at. */
    if (own?.voltage !== element.voltage || sheet?.voltage !== viewLevelName) return null;

    const there = resolveCurrent(measures, own.currents, own.type);
    const here = resolveCurrent(onAxis, sheet.currents, sheet.type);
    if (there == null || here == null) return null;
    if (!(there.value > 0) || !(here.value > 0)) return null;

    return there.value / here.value;
  };

  /**
   * Element units per unit of the axis quantity, and the level the
   * curve is referred from.
   *
   * `V_source` is `undefined` when `factor` already carries the change
   * of level -- the condition-placed case, where referring by the turns
   * ratio on top of it would apply the step twice.
   */
  interface CurvePlacement { factor: number; V_source: number | undefined }

  const placementFor = (element: Element): CurvePlacement | null => {
    const measures = elementQuantity(element.stages);

    if (axisQuantity === 'any') {
      /*
       * A mixed axis has no quantity to convert onto, but it still has
       * a level, and the condition still knows what this element
       * measures at each. Referring by the condition beats the turns
       * ratio here for the same reason it does anywhere else.
       */
      if (measures != null && measures !== 'mixed') {
        const placed = conditionPlacement(element, measures, measures);
        if (placed != null) return { factor: placed, V_source: undefined };
        noteReferralCaveat(element.label, measures, element.voltage, viewLevelName, condition?.type);
      }
      return { factor: 1, V_source: element.voltage_kV };
    }
    if (measures == null || measures === 'mixed') return null;

    /*
     * Can what this element measures reach this sheet at all?
     *
     * Asked before anything about the axis, and before the shortcut for
     * an element already measuring the axis quantity, because it is a
     * question about the network rather than about the drawing. Zero
     * sequence does not cross a delta, so an HV residual element has no
     * position on an LV sheet whatever quantity that sheet is drawn
     * against -- and the turns ratio would happily give it one.
     *
     * The same rule the fault rules and the marked points obey. Curves
     * were the one thing still exempt from it: on a phase sheet in the
     * star-side frame, an HV `51G` was drawn from the *sheet's* level's
     * residual-to-phase ratio, a level the element is not on, and
     * appeared as a working backup while the grading report for the same
     * condition said NO_OPERATION.
     */
    const sameFrame = element.voltage_kV == null || V_view_kV == null
      || element.voltage_kV === V_view_kV;
    if (!sameFrame
        && !survivesVoltageReferral(measures, study, element.voltage, viewLevelName)) {
      blockedElements.set(element.label,
        `${element.label} measures ${quantityLabel(measures)}, which does not cross `
        + `${element.voltage} to ${viewLevelName ?? 'this level'}`);
      return null;
    }

    /*
     * And does it carry any of that current at *its own* bus under this
     * condition? The ratios below come from the level the sheet is drawn
     * in, which for an element on another level answers a question
     * about the wrong bus.
     */
    if (condition && conditionName && element.voltage && element.voltage !== condition.voltage) {
      const atOwnLevel = resolveCondition(study, conditionName, element.voltage);
      const own = atOwnLevel
        ? resolveCurrent(measures, atOwnLevel.currents, atOwnLevel.type)
        : null;
      if (own != null && !(Math.abs(own.value) > 0)) {
        blockedElements.set(element.label,
          `${element.label} carries no ${quantityLabel(measures)} at ${element.voltage} `
          + `under ${conditionName}`);
        return null;
      }
    }

    /*
     * Placed from the condition where it can be: one factor for the
     * quantity *and* the level together, so no turns ratio is involved
     * and the plot cannot disagree with the report.
     */
    const placed = conditionPlacement(element, measures, axisQuantity);
    if (placed != null) return { factor: placed, V_source: undefined };
    noteReferralCaveat(element.label, measures, element.voltage, viewLevelName, condition?.type);

    if (measures === axisQuantity) return { factor: 1, V_source: element.voltage_kV };

    /*
     * The same component in another scaling is a fixed factor of three
     * and needs no condition: an element set in `I2` belongs on a `3I2`
     * sheet at a third of its own current whatever the fault is. Asked
     * before the condition, since requiring one made those elements
     * vanish from a sheet the tool could perfectly well place them on.
     */
    const scaled = scalingBetween(measures, axisQuantity);
    if (scaled != null) return { factor: scaled, V_source: element.voltage_kV };

    /*
     * Different components, and no condition to relate them by. Said
     * rather than left as a bare count: the reader has done nothing
     * wrong, they have simply not told the sheet which condition it
     * depicts, and that is a one-line fix.
     */
    if (!condition) {
      blockedElements.set(element.label,
        `${element.label} measures ${quantityLabel(measures)}; name a condition `
        + `to convert it onto ${quantityLabel(axisQuantity)}`);
      return null;
    }

    /*
     * A condition carrying none of what the element measures means the
     * element cannot operate under it -- a residual element on a
     * balanced three-phase fault. Drawing it would imply an operation
     * that cannot happen.
     */
    if (quantityIsAbsent(condition.type, measures)) {
      blockedElements.set(element.label,
        `${element.label} carries no ${quantityLabel(measures)} under ${conditionName}`);
      return null;
    }

    const factor = conversionFactor(measures, axisQuantity, condition.currents, condition.type);

    /*
     * A zero or negative factor is the same answer as an absent one:
     * the element has nothing to measure here. It arrives when the
     * *declared* figure is zero where the type says otherwise -- an HV
     * residual element behind a delta, whose condition states
     * `I0_A = 0`. Left as a number it became a divisor of zero, and the
     * curve was counted as converted and then quietly not drawn.
     *
     * Reported as what it is. "Not on this axis" is true but weak: the
     * element is not missing because the abscissa is inconvenient, it is
     * missing because there is none of its current to measure.
     */
    if (factor === 0) {
      blockedElements.set(element.label,
        `${element.label} carries no ${quantityLabel(measures)}`
        + `${condition.voltage ? ` at ${condition.voltage}` : ''}`
        + `${conditionName ? ` under ${conditionName}` : ''}`);
      return null;
    }
    if (factor == null || !(factor > 0) || !Number.isFinite(factor)) return null;

    return { factor, V_source: element.voltage_kV };
  };


  /**
   * An element's own current, read onto this sheet's axis.
   *
   * Everything that positions something against a curve -- margin
   * arrows, marked points, annotations -- has to land on the same axis
   * the curve was drawn on, so it goes through the same placement.
   * Doing the arithmetic inline was how the two got out of step in the
   * first place. `null` when the element has no position on this sheet.
   */
  const onAxisCurrent = (
    element: Element | undefined,
    I: number,
    fallbackV?: number,
  ): number | null => {
    if (!element) return project(I, fallbackV);
    const placed = placementFor(element);
    if (placed == null) return null;
    return project(I, placed.V_source) / placed.factor;
  };

  for (const element of allElements(study)) {
    /*
     * Scoped out of this sheet entirely: not drawn, and not counted
     * among the elements the sheet could not place. Being on another
     * sheet is a choice the study made, not a failure to report.
     */
    if (!onThisSheet(element)) continue;
    const blockedBefore = blockedElements.size;
    const placement = placementFor(element);
    if (placement == null) {
      /* One reason each: an element the network keeps off the sheet has
       * already been named, and counting it again as merely off-axis
       * would state a second, weaker reason for the same absence. */
      if (blockedElements.size === blockedBefore) offAxisElements.push(element.label);
      continue;
    }
    const { factor } = placement;
    if (factor !== 1) {
      const measures = elementQuantity(element.stages);
      if (measures != null && measures !== 'mixed') {
        convertedElements.set(element.label, {
          measures,
          factor,
          fromLevel: placement.V_source === undefined && element.voltage !== viewLevelName
            ? element.voltage
            : undefined,
        });
      }
    }

    const auto = pickStyle();
    const V_source = placement.V_source;

    if (individual && element.stages.length > 1) {
      for (const stage of element.stages) {
        /*
         * Each stage takes its own ink where it declared any, and the
         * element's otherwise -- `pick` in the model has already done
         * that fallback, so a stage that says nothing carries the
         * element's values here.
         */
        const drawn = styleFor(stage, auto);
        const pathD = trace(
          V_source,
          (I) => tTripStage(stage, I),
          stage.I_pu_A != null ? [project(stage.I_pu_A, V_source)] : [],
          factor,
          /* A stage may stop earlier than the element that owns it. */
          stage.current_max_A ?? element.current_max_A,
        );
        if (!pathD) continue;
        curves.push({
          label: `${element.label}/${stage.id}`,
          ref: `${element.ref}/${stage.id}`,
          color: drawn.color,
          pathD,
          pickupPx: stage.I_pu_A != null
            ? xScale.toPx(project(stage.I_pu_A, V_source) / factor)
            : NaN,
          detailLines: ([
            { text: [element.maker, element.model].filter(Boolean).join(' '), role: 'identity' },
            { text: stageDetail(stage, element), role: 'settings' },
          ] as DetailLine[]).filter((l) => l.text),
          dashArray: drawn.dash,
          widthPx: drawn.widthPx,
          voltage: element.voltage,
          voltage_kV: V_source,
        });
      }
      continue;
    }

    const drawn = styleFor(element, auto);
    const pathD = trace(
      V_source, (I) => tTripElement(element, I), breakpointsOf(element, V_source), factor,
      element.current_max_A,
    );
    if (!pathD) continue;
    curves.push({
      label: element.label,
      ref: element.ref,
      color: drawn.color,
      pathD,
      pickupPx: pickupPxOf(element, factor, V_source),
      detailLines: elementDetailLines(element),
      voltage: element.voltage,
      voltage_kV: V_source,
      dashArray: drawn.dash,
      widthPx: drawn.widthPx,
    });
  }

  /*
   * Devices -- fuses, cables, transformer damage curves, breakers.
   *
   * A fuse is not one curve but a *band*: it may open any time between
   * its minimum-melt and total-clear characteristics, and a grading
   * study has to respect the whole band. Drawing it as a filled,
   * hatched region says that directly, where two bare lines would
   * invite reading the gap as a margin.
   */
  const deviceBands: DeviceBand[] = [];

  for (const device of study.devices.values()) {
    const { color } = pickStyle();

    /* Fuse band: min-melt and total-clear bound a hatched region. */
    if (device.min_melt && device.total_clear) {
      const lower = flexPath(device.min_melt, device.voltage_kV);
      const upper = flexPath(device.total_clear, device.voltage_kV);
      if (lower && upper) {
        deviceBands.push({
          id: device.id,
          color,
          lowerD: lower.d,
          upperD: upper.d,
          areaD: `${lower.d} L${upper.reversed.join(' L')} Z`,
        });
      }

      curves.push({
        label: device.id,
        color,
        pathD: upper?.d ?? '',
        pickupPx: NaN,
        detailLines: deviceDetailLines(device),
        band: true,
      });
      continue;
    }

    /* Everything else is a single characteristic. */
    const points = device.flex_points ?? device.min_melt ?? device.total_clear;
    let pathD = '';
    if (points) {
      pathD = flexPath(points, device.voltage_kV)?.d ?? '';
    } else if (device.t_delay_s != null) {
      /* A breaker is a flat clearing time across the whole domain. */
      const py = yScale.toPx(device.t_delay_s);
      if (Number.isFinite(py)) {
        pathD = `M${xScale.toPx(I_min).toFixed(1)} ${py.toFixed(1)} ` +
                `L${xScale.toPx(I_max).toFixed(1)} ${py.toFixed(1)}`;
      }
    }
    if (!pathD) continue;

    curves.push({
      label: device.id,
      color,
      pathD,
      pickupPx: NaN,
      detailLines: deviceDetailLines(device),
      /* Damage and withstand limits are boundaries, not operating
       * curves; dashing keeps that distinction visible. */
      dashArray: device.kind === 'cable' || device.kind === 'transformer_damage'
        ? '9 5'
        : undefined,
    });
  }

  /* Synthetic `combine` curves, drawn in their declared style. */
  for (const combine of study.combines) {
    const color = combine.color ?? pickStyle().color;
    const pathD = trace(undefined, (I) => tTripCombine(study, combine, I));
    if (!pathD) continue;
    curves.push({
      label: combine.label ?? combine.name,
      color,
      pathD,
      pickupPx: NaN,
      detailLines: [{ text: `Combine · ${combine.as}`, role: 'settings' }],
      dashed: combine.style === 'dashed' || combine.style === 'dotted',
    });
  }

  /* -------------------- compose SVG -------------------- */
  const out: string[] = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" style="background:${th.background};color:${th.foreground}">`);

  out.push(`<style>.tc-axis { stroke:${th.axis}; fill:none; } .tc-grid-major { stroke:${th.grid}; stroke-width:0.8; opacity:0.9; } .tc-grid-minor { stroke:${th.grid}; stroke-width:0.5; opacity:0.5; } .tc-label { fill:${th.label}; } .tc-legend { fill:${th.foreground}; } .tc-legend-muted { fill:${th.label}; opacity:0.6; } .tc-fault { stroke:${th.fault}; opacity:0.55; } .tc-fault-label { fill:${th.fault}; } .tc-pickup { stroke:${th.foreground}; stroke-width:1.5; } .tc-current-axis { fill:${th.label}; font-weight:600; } .tc-curve { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round; } .tc-overlay { fill:${th.background}; stroke:${th.axis}; stroke-width:0.8; }</style>`);

  /* embedded data for the live overlay -- curves and faults projected
   * into the view frame */
  out.push(`<desc class="tc-data" data-domain-i="${I_min},${I_max}" data-domain-t="${t_min},${t_max}" data-plot="${leftMargin},${topMargin},${plotW},${plotH}"/>`);

  /*
   * Clip region for everything that lives *inside* the axes.
   *
   * A curve is sampled across the whole current domain, and near
   * pickup an inverse-time characteristic runs to very large times --
   * far above `t_max`. Zooming narrows the domain without changing
   * that, so without a clip those tails paint over the title and the
   * legend. Axis furniture (tick labels, fault names) is deliberately
   * left unclipped, since it belongs in the margins.
   */
  const clipId = 'tc-plot-clip';
  out.push(
    `<defs><clipPath id="${clipId}">` +
    `<rect x="${leftMargin}" y="${topMargin}" width="${plotW}" height="${plotH}"/>` +
    `</clipPath></defs>`,
  );

  /* Sheet frame and title block. */
  if (bordered) {
    const fx = sheetInset / 2;
    const fy = sheetInset / 2;
    const fw = W - sheetInset;
    const fh = H - sheetInset;
    out.push(
      `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" ` +
      `stroke="${th.axis}" stroke-width="1.2"/>`,
    );

    /* Title block strip along the bottom of the sheet. */
    const tbY = fy + fh - titleBlockH;
    out.push(
      `<line x1="${fx}" y1="${tbY}" x2="${fx + fw}" y2="${tbY}" stroke="${th.axis}" stroke-width="1.2"/>`,
    );

    const padX = 14;
    const tbTitle = titleText ?? 'Time-current grading study';

    /*
     * The title block shares its strip with the meta fields on the
     * right, so the heading gets the left half and wraps inside it
     * rather than running under them.
     */
    const tbTextWidth = fw * 0.5 - padX * 2;
    let tbY2 = tbY + 22;
    for (const wrapped of wrapLabel(tbTitle, tbTextWidth, FONT_LABEL)) {
      out.push(
        `<text x="${fx + padX}" y="${tbY2}" font-size="${FONT_LABEL}" font-weight="600" ` +
        `fill="${th.foreground}">${escapeXml(wrapped)}</text>`,
      );
      tbY2 += FONT_LABEL + 4;
    }
    if (subtitleText) {
      tbY2 += 2;
      for (const wrapped of wrapLabel(subtitleText, tbTextWidth, FONT_SUBTITLE)) {
        out.push(
          `<text x="${fx + padX}" y="${tbY2}" font-size="${FONT_SUBTITLE}" ` +
          `fill="${th.label}" opacity="0.85">${escapeXml(wrapped)}</text>`,
        );
        tbY2 += FONT_SUBTITLE + 3;
      }
    }

    /*
     * Right-hand fields, drawn from `meta`. These are the details an
     * engineer looks for on a filed drawing: who, what, when.
     */
    const fields: Array<[string, string]> = [];
    const meta = study.meta;
    if (meta.project) fields.push(['Project', String(meta.project)]);
    if (meta.engineer) fields.push(['Engineer', String(meta.engineer)]);
    if (meta.date) fields.push(['Date', String(meta.date)]);
    if (meta.revision) fields.push(['Rev', String(meta.revision)]);

    let fieldX = fx + fw - padX;
    for (const [label, value] of fields.slice().reverse()) {
      const width = Math.max(
        (label.length + 1) * FONT_DETAIL * CHAR_ADVANCE,
        value.length * FONT_DETAIL * CHAR_ADVANCE,
      );
      fieldX -= width + 22;
      out.push(
        `<text x="${fieldX}" y="${tbY + 20}" font-size="${FONT_DETAIL - 1}" ` +
        `fill="${th.label}" opacity="0.7">${escapeXml(label.toUpperCase())}</text>`,
      );
      out.push(
        `<text x="${fieldX}" y="${tbY + 38}" font-size="${FONT_DETAIL}" ` +
        `fill="${th.foreground}">${escapeXml(value)}</text>`,
      );
    }

    /*
     * A declared footer, drawn along the foot of the title block.
     *
     * The unbordered layout puts it under the plot; bordered, that
     * space is the title block, and the footer used to be dropped
     * without a word -- an author who wrote three slots got the
     * conventional meta fields and no indication their instruction had
     * been ignored. Drawn here, both fit: the strip's own fields name
     * the drawing, the author's line says whatever they wanted said.
     */
    const tbFooter = opts.page?.footer;
    if (tbFooter) {
      const footY = tbY + titleBlockH - 6;
      const slots: Array<[string | undefined, number, string]> = [
        [tbFooter.left, fx + padX, 'start'],
        [tbFooter.center, fx + fw / 2, 'middle'],
        [tbFooter.right, fx + fw - padX, 'end'],
      ];
      for (const [raw, x, anchor] of slots) {
        if (!raw) continue;
        out.push(
          `<text x="${x}" y="${footY}" text-anchor="${anchor}" ` +
          `font-size="${tbFooter.font_size_px ?? FONT_DETAIL - 1}" ` +
          `fill="${tbFooter.color ?? th.label}">${escapeXml(expandMacros(raw, study))}</text>`,
        );
      }
    }
  } else if (titleText) {
    /* Bounded by the sheet, so a long heading wraps instead of
     * running off the right-hand edge. */
    const headWidth = W - leftMargin - 16;
    let headY = 26;
    for (const wrapped of wrapLabel(titleText, headWidth, FONT_TITLE)) {
      out.push(
        `<text x="${leftMargin}" y="${headY}" font-size="${FONT_TITLE}" font-weight="600" ` +
        `fill="${th.foreground}">${escapeXml(wrapped)}</text>`,
      );
      headY += FONT_TITLE + 4;
    }
    if (subtitleText) {
      for (const wrapped of wrapLabel(subtitleText, headWidth, FONT_SUBTITLE)) {
        out.push(
          `<text x="${leftMargin}" y="${headY}" font-size="${FONT_SUBTITLE}" ` +
          `fill="${th.label}" opacity="0.85">${escapeXml(wrapped)}</text>`,
        );
        headY += FONT_SUBTITLE + 3;
      }
    }
  }

  /* plot frame */
    const showFrame = pageAxes?.frame !== false;
  out.push(
    `<rect x="${leftMargin}" y="${topMargin}" width="${plotW}" height="${plotH}" ` +
    `fill="${th.background}" stroke="${showFrame ? th.axis : 'none'}" ` +
    `stroke-width="1" shape-rendering="crispEdges"/>`,
  );

  /* ticks */
  /* `page { scale { tick_density } }`: sparse | normal | dense. */
  const tickDensity = opts.page?.scale?.tick_density ?? 'normal';
  const xTicks = ticks(I_min, I_max, tickDensity);
  const yTicks = ticks(t_min, t_max, tickDensity);
  for (const t of xTicks) {
    const px = xScale.toPx(t.value);
    if (!Number.isFinite(px)) continue;
    out.push(`<line x1="${px}" y1="${topMargin}" x2="${px}" y2="${topMargin + plotH}" class="${t.major ? 'tc-grid-major' : 'tc-grid-minor'}" stroke="${th.grid}" stroke-width="${t.major ? 0.9 : 0.6}" stroke-opacity="${t.major ? 1 : 0.7}"/>`);
    if (t.major) {
      out.push(`<text x="${px}" y="${topMargin + plotH + AXIS_LABEL_DY}" text-anchor="middle" class="tc-current-axis" fill="${th.label}" font-weight="600" font-size="${FONT_AXIS}">${escapeXml(axisTickLabel(t.value))}</text>`);
    } else if (isLabelledInterval(t.value)) {
      /* 2x and 5x of each decade: enough to read an intermediate
       * value off the chart without crowding the axis. */
      out.push(`<text x="${px}" y="${topMargin + plotH + AXIS_LABEL_DY}" text-anchor="middle" fill="${th.label}" fill-opacity="0.7" font-size="${FONT_AXIS - 2}">${escapeXml(axisTickLabel(t.value))}</text>`);
    }
    /* `page { axes { mirror = true; } }` repeats the scale on top. */
    if (mirrorAxes && (t.major || isLabelledInterval(t.value))) {
      out.push(
        `<text x="${px}" y="${topMargin - 8}" text-anchor="middle" fill="${th.label}" ` +
        `${t.major ? `font-weight="600" font-size="${FONT_AXIS}"` : `fill-opacity="0.7" font-size="${FONT_AXIS - 2}"`}>` +
        `${escapeXml(axisTickLabel(t.value))}</text>`,
      );
    }
  }
  for (const t of yTicks) {
    const py = yScale.toPx(t.value);
    if (!Number.isFinite(py)) continue;
    out.push(`<line x1="${leftMargin}" y1="${py}" x2="${leftMargin + plotW}" y2="${py}" class="${t.major ? 'tc-grid-major' : 'tc-grid-minor'}" stroke="${th.grid}" stroke-width="${t.major ? 0.9 : 0.6}" stroke-opacity="${t.major ? 1 : 0.7}"/>`);
    if (t.major) {
      out.push(`<text x="${leftMargin - 10}" y="${py + 4}" text-anchor="end" class="tc-current-axis" fill="${th.label}" font-weight="600" font-size="${FONT_AXIS}">${formatSi(t.value, 's')}</text>`);
    } else if (isLabelledInterval(t.value)) {
      out.push(`<text x="${leftMargin - 10}" y="${py + 3}" text-anchor="end" fill="${th.label}" fill-opacity="0.7" font-size="${FONT_AXIS - 2}">${formatSi(t.value, 's')}</text>`);
    }
    /* ...and down the right-hand edge. */
    if (mirrorAxes && (t.major || isLabelledInterval(t.value))) {
      out.push(
        `<text x="${leftMargin + plotW + 8}" y="${py + 4}" text-anchor="start" fill="${th.label}" ` +
        `${t.major ? `font-weight="600" font-size="${FONT_AXIS}"` : `fill-opacity="0.7" font-size="${FONT_AXIS - 2}"`}>` +
        `${escapeXml(formatSi(t.value, 's'))}</text>`,
      );
    }
  }

  /* axis titles -- rotated Time label, "Current (A @ <voltage>)" label */
    /*
   * Y-axis title, set in from the sheet edge and close to the scale it
   * names. Sitting hard against the border reads as page furniture
   * rather than as part of the chart; the offset clears the widest
   * tick label ("1000 s") and no more.
   */
  const yTitleX = Math.max(sheetInset + 16, leftMargin - 62);
  out.push(
    `<text transform="rotate(-90 ${yTitleX} ${topMargin + plotH / 2})" ` +
    `x="${yTitleX}" y="${topMargin + plotH / 2}" text-anchor="middle" font-weight="600" ` +
    `font-size="${FONT_AXIS_TITLE}" fill="${th.label}">Operating time (s)</text>`,
  );
  /* Sits above the title block when the sheet is framed. */
  const axisTitleY = H - 20 - sheetInset - titleBlockH;
  out.push(`<text x="${leftMargin + plotW / 2}" y="${axisTitleY}" text-anchor="middle" font-weight="600" font-size="${FONT_AXIS_TITLE}" fill="${th.label}">${escapeXml(currentAxisTitle)}</text>`);

  /*
   * Fault-marker styling (`page { faults { ... } }`).
   *
   * Each fault gets its own dash pattern by default. On a cascade with
   * five markers a few hundred amps apart, identical dashes make it
   * impossible to tell which vertical belongs to which label; a
   * distinct pattern lets the eye trace one line down to its name. An
   * explicit `style` overrides that and makes them uniform.
   */
  /*
   * Required-time styling (`page { times { ... } }`), mirroring the
   * fault rules' but with its own ink so the two kinds of rule are
   * told apart at a glance.
   */
  const timeStyle = opts.page?.times;
  const timeWidth = timeStyle?.width_px ?? 1.4;
  const timeColour = timeStyle?.color ?? th.label;
  const timeDash =
    timeStyle?.style === 'solid' ? ''
      : timeStyle?.style === 'dashed' ? '6 4'
        : '2 4';

  const faultStyle = opts.page?.faults;
  const FAULT_DASHES = ['5 4', '10 4', '2 3', '10 3 2 3', '16 4', '6 3 2 3 2 3'];
  const faultWidth = faultStyle?.width_px ?? 1.4;
  const faultColour = faultStyle?.color ?? th.fault;
  const faultDash = (index: number): string => {
    if (faultStyle?.style === 'solid') return '';
    if (faultStyle?.style === 'dotted') return '2 3';
    if (faultStyle?.style === 'dashed') return '5 4';
    return FAULT_DASHES[index % FAULT_DASHES.length];
  };

  /**
   * Is a current inside the plotted domain? Used to drop faults and
   * pick-up marks that a zoom has moved off-screen -- their vertical
   * rules would otherwise be drawn beyond the axes.
   */
  const inDomain = (I: number): boolean =>
    Number.isFinite(I) && I >= I_min && I <= I_max;

  /**
   * Whether a coordinate falls inside the plotted window.
   *
   * `toPx` is affine in `log10` and extrapolates past the frame quite
   * happily, so anything anchored outside the window was still drawn --
   * at a position off the plot, over the legend, with a leader running
   * to it. Zooming in is exactly when that happens, and it is exactly
   * when the reader is least able to tell a marker that belongs here
   * from one that does not.
   *
   * Suppressed rather than clamped: a marker pinned to the frame edge
   * claims a current it does not have, which is worse than an absent
   * marker the legend still lists.
   */
  const anchorOnPlot = (I: number, t: number): boolean =>
    inDomain(I) && Number.isFinite(t) && t >= t_min && t <= t_max;

  /** Annotations dropped because their anchor is off the window. */
  const offPlotAnnotations: string[] = [];

  /**
   * Annotations that have no position at all on this sheet.
   *
   * Distinct from `offPlotAnnotations`, which is a consequence of the
   * viewport and changes as you zoom. These are marks the study asked
   * for that could not be placed for any window: a curve that never
   * reaches the time asked for, a component the annotated element does
   * not measure, a condition that declares nothing at that level.
   *
   * They are *named* rather than counted, because unlike an off-plot
   * mark the answer is not "zoom out" -- it is a line of source to fix,
   * and the author needs to know which one.
   */
  const unplaceableAnnotations: string[] = [];

  /**
   * Times whose caption anchor named a component this sheet is not
   * drawn in, so the caption fell back to the left-hand end.
   *
   * The fallback is right -- the rule still spans the plot and still
   * carries its name -- but it is indistinguishable from having asked
   * for no anchor, so the author would never learn the figure they
   * wrote was being ignored.
   */
  const unanchoredTimes: string[] = [];


  /*
   * House style for leader lines. The `page { leaders }` block was
   * parsed, validated and offered in completions while being read by
   * nothing, so a drawing office that set its leader ink and weight got
   * the defaults and no indication otherwise.
   */
  const leaderStyle = opts.page?.leaders;
  const leaderColour = (fallback: string): string => leaderStyle?.color ?? fallback;
  const leaderWidth = (fallback: number): number => leaderStyle?.width_px ?? fallback;
  const leaderGap = (fallback: number): number => leaderStyle?.label_offset_px ?? fallback;

  /* pickup ticks, just below the axis */
  for (const c of curves) {
    if (!Number.isFinite(c.pickupPx)) continue;
    if (c.pickupPx < leftMargin || c.pickupPx > leftMargin + plotW) continue;
    out.push(`<line x1="${c.pickupPx}" y1="${topMargin + plotH}" x2="${c.pickupPx}" y2="${topMargin + plotH + 4}" stroke="${c.color}" stroke-width="1.5"/>`);
  }

  /* ---- clipped group: everything inside the axes ---- */
  out.push(`<g clip-path="url(#${clipId})">`);

  /* fault-current vertical markers */
  for (const [i, f] of faults.entries()) {
    const I = f.I_view ?? f.I_A;
    if (!inDomain(I)) continue;
    const px = xScale.toPx(I);
    if (!Number.isFinite(px)) continue;
    const dash = faultDash(i);
    out.push(
      `<line x1="${px}" y1="${topMargin}" x2="${px}" y2="${topMargin + plotH}" class="tc-fault" ` +
      /* `data-fault` and `data-current` stay adjacent: they are scraped
       * as a pair, and a new attribute between them breaks that. */
      `data-fault="${escapeXml(f.name)}" data-current="${I}" data-kind="${f.kind}" ` +
      /* Full strength, matching the legend swatch. At 0.7 the rule read
       * as a fainter colour than the entry naming it, so the two did not
       * obviously belong together. */
      `stroke="${faultColour}" stroke-width="${faultWidth}"` +
      `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
    );
  }

  /*
   * Required-time rules, drawn with the fault rules and under the
   * curves: a requirement is context for the characteristic that has to
   * meet it, so it must not obscure the thing being judged.
   *
   * Styled apart from the fault rules on purpose. They are the same
   * kind of furniture but they answer a different question -- "is the
   * curve under this?" rather than "what happens at this current?" --
   * and a reader should not have to work out which axis a dashed red
   * line belongs to.
   */
  const timesOnPlot = times.filter((t) => t.t_s >= t_min && t.t_s <= t_max);

  /*
   * Held back and drawn after the curves.
   *
   * A required time is a limit the characteristics are being judged
   * against, so it has to be legible where it crosses them -- under a
   * 2 px curve it disappears at exactly the current the reader is
   * checking.
   */
  const timeRules: string[] = [];
  for (const t of timesOnPlot) {
    const py = yScale.toPx(t.t_s);
    if (!Number.isFinite(py)) continue;
    timeRules.push(
      `<line x1="${leftMargin}" y1="${py.toFixed(1)}" ` +
      `x2="${leftMargin + plotW}" y2="${py.toFixed(1)}" class="tc-time" ` +
      `data-time-name="${escapeXml(t.name)}" data-time="${t.t_s}" ` +
      `stroke="${timeColour}" stroke-opacity="0.75" stroke-width="${timeWidth}"` +
      `${timeDash ? ` stroke-dasharray="${timeDash}"` : ''}/>`,
    );
  }

  /*
   * Fuse bands, under the curves: the band is context for the relay
   * characteristics being graded against it, so it must not obscure
   * them.
   */
  for (const [i, band] of deviceBands.entries()) {
    const clipId = `tc-band-${i}`;
    out.push(
      `<defs><clipPath id="${clipId}"><path d="${band.areaD}"/></clipPath></defs>`,
    );
    /* A wash of the device colour, then the hatch over it. */
    out.push(`<path d="${band.areaD}" fill="${band.color}" fill-opacity="0.10" stroke="none"/>`);
    out.push(hatchLines(clipId, leftMargin, topMargin, leftMargin + plotW, topMargin + plotH, band.color, 9));

    /* Minimum melt dashed, total clear solid: the fuse may start to
     * melt at the first and is guaranteed clear by the second. */
    out.push(
      `<path d="${band.lowerD}" fill="none" stroke="${band.color}" stroke-width="1.6" ` +
      `stroke-dasharray="6 3" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    out.push(
      `<path d="${band.upperD}" fill="none" stroke="${band.color}" stroke-width="2" ` +
      `stroke-linejoin="round" stroke-linecap="round" data-curve="${escapeXml(band.id)}"/>`,
    );
  }

  /* curves */
  const hlLabel = (opts.highlightLabel ?? '').trim();
  const hlVolt  = (opts.highlightVoltage ?? '').trim();
  for (const c of curves) {
    if (c.band) continue; // already drawn as a filled band
    const isHl = hlLabel && c.label.trim() === hlLabel
      && (!hlVolt || (c.voltage ?? '').trim() === hlVolt);
    const cls = isHl ? 'tc-curve tc-curve-snap' : 'tc-curve';
    /*
     * `page { curves { line_width_px } }` sets the data-line weight for
     * the sheet; a curve that declared its own `width_px` overrides it,
     * which is what lets one characteristic be drawn heavier as the
     * subject and the rest left as context.
     */
    const baseWidth = c.widthPx ?? opts.page?.curves?.line_width_px ?? 2;
    const sw = isHl ? String(baseWidth * 1.6) : String(baseWidth);
    const dashValue = c.dashArray ?? (c.dashed ? '6 4' : undefined);
    const dash = dashValue ? ` stroke-dasharray="${dashValue}"` : '';
    out.push(`<path d="${c.pathD}" class="${cls}" fill="none" stroke-linejoin="round" stroke-linecap="round" stroke="${c.color}" stroke-width="${sw}"${dash} data-curve="${escapeXml(c.label)}" data-ref="${escapeXml(c.ref ?? '')}" data-voltage="${escapeXml(c.voltage ?? '')}"/>`);
  }

  /* The limits, over the characteristics they judge. */
  out.push(...timeRules);

  /*
   * Direct labels, drawn here rather than with the legend so that the
   * marked points and margin annotations that follow paint *over*
   * them. A boxed name covering a CTI figure hides the study's
   * conclusion; the reverse costs only part of a name that is still
   * traceable by colour.
   */
  /*
   * Every label on the plot goes through one placer, so a point's
   * caption, an annotation and a margin figure all avoid each other
   * rather than each avoiding only the frame.
   */
  const placer = new LabelPlacer({ x: leftMargin, y: topMargin, w: plotW, h: plotH });

  /*
   * The drawn characteristics, so captions can keep off them.
   *
   * A label printed along a curve is hard to read and hides the line
   * the sheet exists to show -- worst on a definite-time shelf, where
   * the text sits exactly on a long horizontal run. The placer treats
   * these as a preference rather than an obstruction: see `avoidLine`.
   */
  for (const c of curves) {
    for (const run of polylineRuns(c.pathD)) placer.avoidLine(run);
  }
  for (const band of deviceBands) {
    for (const d of [band.lowerD, band.upperD]) {
      for (const run of polylineRuns(d)) placer.avoidLine(run);
    }
  }
  /*
   * The rules are drawn lines too. A required-time label printed along
   * its own rule is the worst case of all -- the line runs through the
   * text it belongs to -- and a caption lying on a fault's vertical is
   * no better.
   */
  for (const t of timesOnPlot) {
    const py = yScale.toPx(t.t_s);
    if (Number.isFinite(py)) {
      placer.avoidLine([{ x: leftMargin, y: py }, { x: leftMargin + plotW, y: py }]);
    }
  }
  for (const f of faults) {
    const I = f.I_view ?? f.I_A;
    if (!inDomain(I)) continue;
    const fx = xScale.toPx(I);
    if (Number.isFinite(fx)) {
      placer.avoidLine([{ x: fx, y: topMargin }, { x: fx, y: topMargin + plotH }]);
    }
  }

  if (legendMode === 'direct') {
    const direct = directLabels(curves, {
      leftMargin, topMargin, plotW, plotH, background: th.background, ink: th.foreground,
    });
    out.push(...direct.markup);
    /* The direct-label column is drawn first and must not be written
     * over by a point caption or a margin figure. */
    for (const box of direct.boxes) placer.reserve(box);
  }

  /*
   * Marked points -- transformer inrush, motor starting, damage
   * points. Drawn inside the clip with the curves, since a point that
   * has been zoomed off the chart should disappear like everything
   * else. The label sits to the right so it does not obscure the
   * curve the point is being compared against.
   */
  /*
   * Points drawn on the plot need no legend entry: the marker carries
   * its own label, so listing it again says the same thing twice and
   * costs the legend room it needs for the curves. Only a point that
   * fell outside the view -- and so is not on the drawing at all --
   * earns a line in the panel.
   */
  const pointsOnPlot = new Set<string>();
  /**
   * Markers the sheet declined, for a reason it has already given.
   *
   * The legend lists points that fell outside the view, on the grounds
   * that a marker nowhere on the drawing still deserves a line. One
   * withheld because it measures another quantity is already named in
   * the notes, so listing it again says the same thing twice -- and in
   * a two-sheet study that is every marker belonging to the other
   * sheet.
   */
  const pointsAccountedFor = new Set<string>();


  /** Emit a label, moved clear of the ones already placed. */
  const placeLabel = (
    text: string,
    anchor: { x: number; y: number },
    colour: string,
    options: { prefer?: Parameters<typeof placer.place>[0]['prefer']; gap?: number; weight?: number } = {},
  ): string[] => {
    const lines = labelLines(text);
    const placement: Placement = placer.place({
      anchor,
      size: {
        w: labelWidthPx(text, FONT_DETAIL),
        h: Math.max(FONT_DETAIL + 2, lines.length * FONT_DETAIL * LINE_SPACING),
      },
      prefer: options.prefer,
      gap: options.gap,
    });

    const emitted: string[] = [];
    /*
     * A label that had to be moved is no longer obviously attached to
     * its anchor, so it gets a leader. One that landed where it was
     * asked to does not need the extra ink.
     */
    if (placement.displaced) {
      const from = placement.anchorText === 'end'
        ? placement.rect.x + placement.rect.w
        : placement.rect.x;
      emitted.push(
        `<path d="M${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)} ` +
        `L${from.toFixed(1)} ${(placement.rect.y + placement.rect.h / 2).toFixed(1)}" ` +
        `fill="none" stroke="${leaderColour(colour)}" ` +
        `stroke-width="${leaderWidth(0.8)}" stroke-opacity="0.6"/>`,
      );
    }
    emitted.push(
      `<text x="${placement.x.toFixed(1)}" y="${placement.y.toFixed(1)}" ` +
      `text-anchor="${placement.anchorText}" font-size="${FONT_DETAIL}"` +
      `${options.weight ? ` font-weight="${options.weight}"` : ''} fill="${colour}">` +
      `${labelBody(text, placement.x, FONT_DETAIL)}</text>`,
    );
    return emitted;
  };

  /*
   * Required-time labels, placed like every other label on the sheet.
   *
   * The rule spans the whole plot, so its name has no natural anchor --
   * it is put at the left-hand end, where the eye starts, and the
   * placer moves it clear of the curves and of anything already there.
   */
  if (opts.page?.times?.labels !== false) {
    for (const t of timesOnPlot) {
      const py = yScale.toPx(t.t_s);
      if (!Number.isFinite(py)) continue;
      const caption = `${t.name} · ${formatSi(t.t_s, 's')}`;
      /*
       * `at_I` puts the caption where the reader is looking -- beside
       * the curve the clearance applies to, say -- instead of at the
       * left-hand end, which is only ever a default. A figure outside
       * the plotted currents would put the text off the sheet, so it
       * falls back rather than drawing into the margin.
       */
      /*
       * The anchor is read in the quantity the sheet is drawn in.
       *
       * `at_I` alone means phase current, and on an `I2` or `3I0`
       * abscissa that is a figure from a different axis -- so the
       * caption sat beside a current that means nothing there.
       * Naming the component (`at_I2`, `at_residual`) says which, on
       * the same vocabulary a fault, a point and an annotate use.
       */
      const anchorI = resolveCurrent(viewQuantity, {
        phase: t.at_I_A, I1: t.at_I1_A, I2: t.at_I2_A,
        I0: t.at_I0_A, residual: t.at_earth_A,
      }, t.type)?.value ?? null;

      /*
       * No anchor at all means the left-hand end, which is the
       * documented default. An anchor that *was* given and could not
       * be resolved onto this axis is a different thing: the caption
       * lands at the default and looks deliberate, so it is said.
       */
      const anchorDeclared = t.at_I_A != null || t.at_I1_A != null || t.at_I2_A != null
        || t.at_I0_A != null || t.at_earth_A != null;
      if (anchorDeclared && anchorI == null) {
        unanchoredTimes.push(t.name);
      }

      const anchorX = anchorI != null && anchorI >= I_min && anchorI <= I_max
        ? xScale.toPx(anchorI)
        : leftMargin + 6;
      out.push(...placeLabel(caption, { x: anchorX, y: py }, timeColour, {
        prefer: ['above', 'below', 'right'],
        gap: 6,
      }));
    }
  }

  for (const point of study.points) {
    if (!(point.t_s > 0)) continue;
    if (!onThisSheet(point)) continue;

    /*
     * A point either states its current or names a condition that
     * supplies it. Where a condition supplies it, the figure is already
     * in the frame of the point's own level -- `conditionCurrentAt`
     * refers a fault onto that level and takes a scenario's own entry
     * for it -- so the projection below is the one every other point
     * gets, and a scenario's number is never referred twice.
     */
    /*
     * The marker's value of *the axis quantity*, resolved exactly as a
     * fault rule's is: declared where the point gives it, otherwise
     * derived from its `type`.
     *
     * A point used to carry one `I_A` that was plotted against whatever
     * the axis happened to be, so the same number meant phase current
     * on one sheet and negative sequence on the next. Studies worked
     * around it with a comment -- "49 A, which is |I2| on this sheet"
     * -- which is the tool asking the reader to keep its books.
     */
    const I_declared = point.condition
      ? conditionCurrentAt(point.condition, point.voltage ?? viewLevelName, viewQuantity)
      : resolveCurrent(
        viewQuantity,
        {
          phase: point.I_A, I1: point.I1_A, I2: point.I2_A,
          I0: point.I0_A, residual: point.earth_A,
        },
        point.type,
      )?.value ?? null;

    if (I_declared == null || !(I_declared > 0)) {
      /*
       * Named rather than dropped, for the same reason a suppressed
       * curve is: the reader declared a marker and it is not on the
       * sheet, and a count would not tell them which or why.
       */
      const declaresSomething = [point.I_A, point.I1_A, point.I2_A, point.I0_A, point.earth_A]
        .some((v) => v != null && Number.isFinite(v));
      if (!point.condition && declaresSomething) {
        /*
         * Collected rather than one note apiece. A study with a sheet
         * per quantity has, by design, markers belonging to the other
         * sheet, and a bullet for each turned the panel into a list of
         * things that are fine. `oneLine` because a label may carry
         * newlines for the drawing, which broke the sentence in two.
         */
        otherQuantityPoints.push(oneLine(point.label ?? point.id));
      }
      pointsAccountedFor.add(point.id);
      continue;
    }
    /*
     * Whether the marker's current reaches this sheet at all. `project`
     * below scales by the turns ratio unconditionally, which is right
     * for phase current and wrong for a residual behind a delta -- so
     * the same rule the fault rules obey is applied here, and a point
     * that cannot be referred is named in the legend rather than drawn
     * at a current that does not exist on this side.
     */
    if (point.voltage_kV != null && V_view_kV != null && point.voltage_kV !== V_view_kV
        && !survivesVoltageReferral(viewQuantity, study, point.voltage, viewLevelName)) {
      unreferrablePoints.push(
        `point ${oneLine(point.label ?? point.id)} is on ${point.voltage}, and `
        + `${quantityLabel(viewQuantity)} does not cross to this level`,
      );
      pointsAccountedFor.add(point.id);
      continue;
    }
    /* Past the gate, so this describes a marker that is drawn. */
    if (point.voltage_kV != null && V_view_kV != null && point.voltage_kV !== V_view_kV) {
      noteReferralCaveat(`point ${oneLine(point.label ?? point.id)}`, viewQuantity,
        point.voltage, viewLevelName, condition?.type);
    }

    const I_view = project(I_declared, point.voltage_kV);
    const px = xScale.toPx(I_view);
    const py = yScale.toPx(point.t_s);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

    const onPlot = anchorOnPlot(I_view, point.t_s);
    if (onPlot) pointsOnPlot.add(point.id);
    /* Off the window it gets a legend entry instead -- `legendPoints`
     * picks up exactly the points this set does not hold. */
    if (!onPlot) continue;

    /*
     * A marked point is not a fault current; it gets its own ink. The
     * point's own declaration wins, then the page's house style, then
     * the theme -- the `page { points }` block was parsed, validated
     * and offered in completions while being read by nothing, so a
     * declared house style for markers did nothing at all.
     */
    const pagePoints = opts.page?.points;
    const colour = point.color ?? pagePoints?.color ?? th.point;
    out.push(
      `<g class="tc-point" data-point="${escapeXml(oneLine(point.label ?? point.id))}" ` +
      `data-current="${I_view}" data-time="${point.t_s}" ` +
      `data-px="${px.toFixed(1)}" data-py="${py.toFixed(1)}">`,
    );
    /* Drawn after the curves, and haloed in the page colour, so a point
     * marking a spot *on* a characteristic reads as being in front of
     * it rather than merging with it. */
    out.push(pointMarker(
      point.shape ?? pagePoints?.shape ?? 'cross',
      px, py, colour,
      pagePoints?.outline === false ? undefined : th.background,
      pagePoints?.size_px,
    ));
    /*
     * The marker is an obstacle too. A caption printed across the very
     * mark it names is the same fault as one printed along a curve, and
     * markers are drawn before most labels are placed.
     */
    placer.reserve({ x: px - 7, y: py - 7, w: 14, h: 14 });

    const base = point.label ?? point.id;
    const text = point.coords ? `${base} (${coordText(I_view, point.t_s)})` : base;
    if (text) {
      /* Right of the marker by preference, then left -- a portrait
       * sheet has little width to spare -- then above or below. */
      out.push(...placeLabel(text, { x: px, y: py }, colour, { gap: 10 }));
    }
    out.push('</g>');
  }

  /*
   * Annotations.
   *
   * The margin form is the one a coordination study exists to produce:
   * it draws the vertical separation between two curves at a fault
   * current and labels it with the time. Without it the reader has to
   * eyeball a gap on a log axis, where equal pixel distances are not
   * equal times -- which is exactly the judgement the chart should be
   * making for them.
   */
  /**
   * The current at which a side reaches a given operating time.
   *
   * A binary search for the *smallest* current whose operate time is at
   * or below `t`, rather than a root-find on `t(I) = t`. The two agree
   * on an inverse curve, but a definite-time stage is flat: every
   * current above pickup gives the same time, so an equality solve
   * converges wherever it happens to start, while "the smallest current
   * that achieves it" is the pickup -- which is the answer a reader
   * means. Monotone because `t` falls as `I` rises, composite stages
   * included.
   */
  const currentAtTime = (
    side: { element?: Element; device?: Device },
    t: number,
    role: 'primary' | 'backup',
  ): number | null => {
    if (!(t > 0)) return null;
    const reaches = (I: number): boolean => {
      const at = sideTime(side, I, role);
      return Number.isFinite(at) && at <= t;
    };

    let lo = I_min;
    let hi = I_max;
    if (!reaches(hi)) return null;      /* never that fast in the domain */
    if (reaches(lo)) return lo;         /* already there at the left edge */

    for (let i = 0; i < 60; i++) {
      const mid = Math.sqrt(lo * hi);   /* bisect in log space, as the axis is */
      if (reaches(mid)) hi = mid; else lo = mid;
    }
    return hi;
  };

  for (const annotation of study.annotations) {
    if (!onThisSheet(annotation)) continue;
    const colour = annotation.color ?? th.foreground;

    /*
     * A span: a dimension between two figures the study simply names.
     *
     * Both margin forms measure between two *characteristics*, which
     * is the common case and not the only one. A grading band an
     * authority requires, the window a setting has to fall inside, the
     * range a supplier quotes -- none of those is a curve, so none of
     * them could be drawn at all. Here the two ends are given, and
     * only the other coordinate has to be worked out.
     */
    if (annotation.kind === 'span') {
      const span = annotation.span!;
      const lo = Math.min(span.from, span.to);
      const hi = Math.max(span.from, span.to);

      if (span.quantity === 'time') {
        /* A vertical dimension needs a current to stand at. */
        const I = annotation.condition
          ? (faults.find((f) => f.name === annotation.condition)?.I_view
            ?? faults.find((f) => f.name === annotation.condition)?.I_A ?? null)
          : annotation.at_I_A ?? null;
        if (I == null || !(I > 0)) {
          unplaceableAnnotations.push(annotation.label ?? 'a span');
          continue;
        }
        const px = xScale.toPx(I);
        const pyLo = yScale.toPx(lo);
        const pyHi = yScale.toPx(hi);
        if (![px, pyLo, pyHi].every(Number.isFinite)) {
          unplaceableAnnotations.push(annotation.label ?? 'a span');
          continue;
        }

        out.push(
          `<line x1="${px.toFixed(1)}" y1="${pyLo.toFixed(1)}" x2="${px.toFixed(1)}" y2="${pyHi.toFixed(1)}" ` +
          `stroke="${colour}" stroke-width="1.4"/>`,
        );
        out.push(arrowHead(px, pyLo, pyLo < pyHi ? 1 : -1, colour));
        out.push(arrowHead(px, pyHi, pyHi < pyLo ? 1 : -1, colour));
        /* Short cross-bars, so the two ends read as limits. */
        for (const py of [pyLo, pyHi]) {
          out.push(
            `<line x1="${(px - 6).toFixed(1)}" y1="${py.toFixed(1)}" x2="${(px + 6).toFixed(1)}" y2="${py.toFixed(1)}" ` +
            `stroke="${colour}" stroke-width="1.4"/>`,
          );
        }

        const figure = formatSi(hi - lo, 's');
        const text = annotation.label ? `${annotation.label} ${figure}` : figure;
        placer.avoidLine([{ x: px, y: Math.min(pyLo, pyHi) }, { x: px, y: Math.max(pyLo, pyHi) }]);
        out.push(...placeLabel(text, { x: px, y: (pyLo + pyHi) / 2 }, colour,
          { gap: 10, weight: 600 }));
        continue;
      }

      /* A horizontal dimension needs a time to sit at. */
      const t = annotation.at_t_s ?? null;
      if (t == null || !(t > 0)) {
        unplaceableAnnotations.push(annotation.label ?? 'a span');
        continue;
      }
      const py = yScale.toPx(t);
      const pxLo = xScale.toPx(lo);
      const pxHi = xScale.toPx(hi);
      if (![py, pxLo, pxHi].every(Number.isFinite)) {
        unplaceableAnnotations.push(annotation.label ?? 'a span');
        continue;
      }

      out.push(
        `<line x1="${pxLo.toFixed(1)}" y1="${py.toFixed(1)}" x2="${pxHi.toFixed(1)}" y2="${py.toFixed(1)}" ` +
        `stroke="${colour}" stroke-width="1.4"/>`,
      );
      out.push(arrowHeadH(pxLo, py, pxLo < pxHi ? 1 : -1, colour));
      out.push(arrowHeadH(pxHi, py, pxHi < pxLo ? 1 : -1, colour));
      for (const px of [pxLo, pxHi]) {
        out.push(
          `<line x1="${px.toFixed(1)}" y1="${(py - 6).toFixed(1)}" x2="${px.toFixed(1)}" y2="${(py + 6).toFixed(1)}" ` +
          `stroke="${colour}" stroke-width="1.4"/>`,
        );
      }

      /*
       * Quoted as the larger over the smaller, the same convention the
       * current margin uses -- one gap, one figure, whichever order it
       * was written in.
       */
      const figure = lo > 0
        ? `${trimZeros(Number(((hi / lo) * 100).toFixed(1)))}%`
        : formatSi(hi - lo, 'A');
      const text = annotation.label ? `${annotation.label} ${figure}` : figure;
      placer.avoidLine([{ x: Math.min(pxLo, pxHi), y: py }, { x: Math.max(pxLo, pxHi), y: py }]);
      out.push(...placeLabel(text, { x: (pxLo + pxHi) / 2, y: py }, colour,
        { prefer: ['above', 'below', 'right'], gap: 8, weight: 600 }));
      continue;
    }

    /*
     * Current margin: the horizontal counterpart of the vertical
     * arrow. Spans the gap in current between two characteristics at
     * one time, and reports it as a percentage of the primary's
     * current -- which is how a current-grading margin is quoted, amps
     * meaning little without knowing where on the axis you are.
     */
    if (annotation.kind === 'current_margin') {
      const primary = atStage(resolveRef(study, annotation.primary), annotation.primary);
      const backup = atStage(resolveRef(study, annotation.backup), annotation.backup);
      const t = annotation.at_t_s!;
      /* As for the time margin: every failure here was silent. */
      const spanName = annotation.label
        ?? `${annotation.primary?.text ?? '?'} current margin`;


      const Ip = currentAtTime(primary, t, 'primary');
      if (Ip == null) {
        /* The primary is never that fast anywhere on the sheet. */
        unplaceableAnnotations.push(spanName);
        continue;
      }

      /*
       * The far end: another characteristic, a declared condition, or a
       * marked point. A pickup is as often quoted against a fault level
       * or an inrush peak -- "120% of the inrush", "35% below the
       * minimum two-phase fault" -- as against another relay, and each
       * of those is a current already on the sheet.
       */
      const farEnd = ((): number | null => {
        if (annotation.backup) {
          const I = currentAtTime(backup, t, 'backup');
          if (I == null) return null;
          return onAxisCurrent(backup.element, I, backup.device?.voltage_kV);
        }
        if (annotation.pointRef) {
          const marker = study.points.find(
            (pt) => pt.id === annotation.pointRef || pt.label === annotation.pointRef,
          );
          if (!marker) return null;
          const declared = marker.condition
            ? conditionCurrentAt(marker.condition, marker.voltage ?? viewLevelName, viewQuantity)
            : resolveCurrent(viewQuantity, {
              phase: marker.I_A, I1: marker.I1_A, I2: marker.I2_A,
              I0: marker.I0_A, residual: marker.earth_A,
            }, marker.type)?.value ?? null;
          return declared == null ? null : project(declared, marker.voltage_kV);
        }
        if (annotation.condition) {
          /* The condition's own rule, at the quantity the axis is in --
           * the same figure the vertical rule stands at. */
          const entry = faults.find((f) => f.name === annotation.condition);
          return entry?.I_view ?? entry?.I_A ?? null;
        }
        return null;
      })();
      if (farEnd == null) {
        unplaceableAnnotations.push(spanName);
        continue;
      }

      /*
       * Both put on the sheet's own axis before they are compared. Two
       * currents on different windings are not comparable as they
       * stand, and the percentage has to be the one the drawn arrow
       * actually spans.
       */
      const viewP = onAxisCurrent(primary.element, Ip, primary.device?.voltage_kV);
      if (viewP == null) {
        unplaceableAnnotations.push(spanName);
        continue;
      }
      const viewB = farEnd;
      if (!(viewP > 0) || !(viewB > 0)) {
        unplaceableAnnotations.push(spanName);
        continue;
      }

      const pxP = xScale.toPx(viewP);
      const pxB = xScale.toPx(viewB);
      const py = yScale.toPx(t);
      if (![pxP, pxB, py].every(Number.isFinite)) {
        unplaceableAnnotations.push(spanName);
        continue;
      }

      /*
       * The larger over the smaller, unsigned, and nothing else.
       *
       * It used to be a signed difference against the primary,
       * `(B - A) / A`. Two things were wrong with that. The magnitude
       * depended on which end happened to be called the primary -- the
       * same gap reads +40% one way and -28.6% the other -- so two
       * annotations over one pair of curves disagreed about how big it
       * was. And the sign carried the direction, which is the part a
       * reader is most likely to take the wrong way round on a sheet
       * where the arrow already shows it.
       *
       * A ratio is symmetric, so a gap has one figure however it is
       * written. The base was named for a while -- "140% of R_FDR:51"
       * -- which is how the figure is quoted aloud, but on the sheet it
       * doubles the length of every margin label to repeat what the
       * legend and the drawn arrow already say. The number alone.
       */
      const larger = Math.max(viewP, viewB);
      const smaller = Math.min(viewP, viewB);
      const pct = (larger / smaller) * 100;

      const figure = `${trimZeros(Number(pct.toFixed(1)))}%`;
      const text = annotation.label ? `${annotation.label} ${figure}` : figure;

      out.push(
        `<line x1="${pxP.toFixed(1)}" y1="${py.toFixed(1)}" x2="${pxB.toFixed(1)}" y2="${py.toFixed(1)}" ` +
        `stroke="${colour}" stroke-width="1.4"/>`,
      );
      out.push(arrowHeadH(pxP, py, pxP < pxB ? 1 : -1, colour));
      out.push(arrowHeadH(pxB, py, pxB < pxP ? 1 : -1, colour));

      /* Short uprights at each end, so the span is unambiguous. */
      for (const px of [pxP, pxB]) {
        out.push(
          `<line x1="${px.toFixed(1)}" y1="${(py - 6).toFixed(1)}" x2="${px.toFixed(1)}" y2="${(py + 6).toFixed(1)}" ` +
          `stroke="${colour}" stroke-width="1.4"/>`,
        );
      }

      placer.avoidLine([{ x: Math.min(pxP, pxB), y: py }, { x: Math.max(pxP, pxB), y: py }]);
      out.push(...placeLabel(text, { x: (pxP + pxB) / 2, y: py }, colour, {
        prefer: ['above', 'below', 'right'], gap: 8, weight: 600,
      }));
      continue;
    }

    if (annotation.kind === 'margin') {
      const primary = atStage(resolveRef(study, annotation.primary), annotation.primary);
      const backup = atStage(resolveRef(study, annotation.backup), annotation.backup);
      /*
       * Every way out of this block used to be a bare `continue`, so a
       * margin that could not be computed drew nothing and said
       * nothing -- a pair that never operates at the current asked
       * for, a reference the study does not declare, a fault that
       * resolves to no figure at this level. The study looked
       * complete and the argument it was written to make was simply
       * absent.
       */
      const marginName = annotation.label
        ?? `${annotation.primary?.text ?? '?'} to `
          + `${annotation.backup?.text ?? annotation.pointRef ?? '?'} margin`;

      /*
       * The far end may be a marked point rather than a curve.
       *
       * A point asserts a coordinate the study is sure of -- an inrush
       * peak, a withstand corner, a figure from a data sheet -- and the
       * gap between a characteristic and one of those is as much a
       * margin as the gap between two relays. Its current is where the
       * arrow stands and its time is one end of the span, so nothing
       * has to be solved for it.
       */
      const marker = annotation.pointRef == null ? undefined
        : study.points.find(
          (pt) => pt.id === annotation.pointRef || pt.label === annotation.pointRef);
      if (annotation.pointRef != null && marker == null) {
        unplaceableAnnotations.push(marginName);
        continue;
      }

      /*
       * Each side is evaluated at the current *it* measures, exactly as
       * `grades.ts` does. Projecting the fault onto the primary's level
       * and evaluating both sides there would divide an LV current by
       * an HV pick-up and report a margin that does not exist -- the
       * annotation would then contradict the margin report for the
       * same pair and fault.
       */
      const primaryQ = primary.element ? elementQuantity(primary.element.stages) : 'phase';
      const backupQ = backup.element ? elementQuantity(backup.element.stages) : 'phase';
      const qOf = (q: ReturnType<typeof elementQuantity>): MeasuredQuantity =>
        q == null || q === 'mixed' ? 'phase' : q;

      /*
       * A marked point supplies the current as well as the far time,
       * so an annotation naming one needs no `at_I` and no condition.
       */
      const markerI = marker == null ? null
        : marker.condition
          ? conditionCurrentAt(marker.condition, marker.voltage ?? viewLevelName, qOf(primaryQ))
          : resolveCurrent(qOf(primaryQ), {
            phase: marker.I_A, I1: marker.I1_A, I2: marker.I2_A,
            I0: marker.I0_A, residual: marker.earth_A,
          }, marker.type)?.value ?? null;

      const I = marker != null
        ? markerI
        : annotationCurrent(study, annotation, primary.element?.voltage, qOf(primaryQ));
      const I_backup = marker != null
        ? markerI
        : annotationCurrent(study, annotation, backup.element?.voltage, qOf(backupQ));
      if (I == null || I_backup == null) {
        unplaceableAnnotations.push(marginName);
        continue;
      }

      /*
       * The *smallest* separation, across every pair of stages.
       *
       * `sideTime` gives the composite -- the fastest stage at that
       * current -- which is what the element trips at and so what the
       * margin report uses. Drawn between two multi-stage elements it
       * spans the widest gap on the sheet and calls it the margin,
       * while a slower stage of the same element sits far closer to the
       * backup. On a study whose stages are alternatives under
       * different conditions -- one inrush-blocked, one not -- that
       * overstates the coordination by the whole difference between
       * them: 0.35 s drawn where the binding gap is 0.10 s.
       *
       * The closest pair is the honest one to put on a drawing, and it
       * is the one an engineer is checking. `stages = "individual"`
       * draws those stages, so the arrow now lands between two curves
       * the reader can see.
       */
      const stageTimes = (
        side: { element?: Element; device?: Device },
        current: number,
        role: 'primary' | 'backup',
      ): number[] => {
        const stages = side.element?.stages;
        /*
         * Only where the stages are drawn separately.
         *
         * The closest pair is the honest margin when the reader can see
         * both stages, but a sheet drawing the composite has only one
         * line per element -- the pointwise minimum -- and an arrow
         * ending at a slower stage then stops in mid-air, a hundred
         * pixels short of the curve it is supposed to touch. On a
         * composite sheet the composite is what the arrow must land on;
         * `R_850:46/energ` is how a particular stage is named, and that
         * narrows the side before it gets here.
         */
        if (!individual || !stages || stages.length < 2) {
          const t = sideTime(side, current, role);
          return Number.isFinite(t) ? [t] : [];
        }
        return stages
          .map((stage) => tTripStage(stage, current))
          .filter((t) => Number.isFinite(t) && t > 0);
      };

      const primaryTimes = stageTimes(primary, I, 'primary');
      /* A point's own declared time is the far end; there is no curve
       * there to evaluate. */
      const backupTimes = marker != null
        ? (marker.t_s > 0 ? [marker.t_s] : [])
        : stageTimes(backup, I_backup, 'backup');
      if (primaryTimes.length === 0 || backupTimes.length === 0) {
        /* One side never operates at this current, so there is no gap
         * between them to draw. */
        unplaceableAnnotations.push(marginName);
        continue;
      }

      let tP = primaryTimes[0];
      let tB = backupTimes[0];
      let closest = Infinity;
      for (const p of primaryTimes) {
        for (const b of backupTimes) {
          /* Signed, so a stage that has crossed its backup reports the
           * violation rather than an absolute value that hides it. */
          const gap = b - p;
          if (gap < closest) { closest = gap; tP = p; tB = b; }
        }
      }
      if (!Number.isFinite(tP) || !Number.isFinite(tB)) {
        unplaceableAnnotations.push(marginName);
        continue;
      }

      /* The arrow stands where the primary's current falls on *this*
       * axis, so it lines up with the curves it spans. */
      const I_view = onAxisCurrent(primary.element, I);
      if (I_view == null) {
        unplaceableAnnotations.push(marginName);
        continue;
      }
      /* Both ends of the arrow have to be somewhere the reader can see,
       * or it measures a gap between two curves that are not on the
       * sheet. */
      if (!anchorOnPlot(I_view, tP) || !anchorOnPlot(I_view, tB)) {
        offPlotAnnotations.push(annotation.label ?? `${annotation.primary?.text ?? ''} margin`);
        continue;
      }
      const px = xScale.toPx(I_view);
      const pyP = yScale.toPx(tP);
      const pyB = yScale.toPx(tB);
      if (![px, pyP, pyB].every(Number.isFinite)) {
        unplaceableAnnotations.push(marginName);
        continue;
      }

      const margin = tB - tP;
      const text = annotation.label
        ? `${annotation.label} ${formatSi(Math.abs(margin), 's')}`
        : formatSi(Math.abs(margin), 's');

      /* Double-headed arrow spanning the gap. */
      out.push(
        `<line x1="${px.toFixed(1)}" y1="${pyP.toFixed(1)}" x2="${px.toFixed(1)}" y2="${pyB.toFixed(1)}" ` +
        `stroke="${colour}" stroke-width="1.4"/>`,
      );
      out.push(arrowHead(px, pyP, pyP < pyB ? 1 : -1, colour));
      out.push(arrowHead(px, pyB, pyB < pyP ? 1 : -1, colour));

      /* Short ticks on each curve, so the ends are unambiguous. */
      for (const py of [pyP, pyB]) {
        out.push(
          `<line x1="${(px - 6).toFixed(1)}" y1="${py.toFixed(1)}" x2="${(px + 6).toFixed(1)}" y2="${py.toFixed(1)}" ` +
          `stroke="${colour}" stroke-width="1.4"/>`,
        );
      }

      /*
       * The figure sits beside the middle of the arrow. It is the whole
       * point of the annotation, so it is placed like any other label
       * and moved clear if something is already there.
       */
      const midY = (pyP + pyB) / 2;
      placer.avoidLine([{ x: px, y: Math.min(pyP, pyB) }, { x: px, y: Math.max(pyP, pyB) }]);
      out.push(...placeLabel(text, { x: px, y: midY }, colour, { gap: 10, weight: 600 }));
      continue;
    }

    /* Point form: mark one curve at one current. */
    const { element, device } = atStage(
      resolveRef(study, annotation.on_curve), annotation.on_curve);
    const annotatedQ = element ? elementQuantity(element.stages) : 'phase';

    /*
     * `at_t` reads the curve the other way round: not "how long at this
     * current" but "at what current is this curve this fast". Both are
     * ordinary questions to ask of a characteristic, and a clearance
     * time is far more often the figure an engineer has in hand.
     *
     * It used to be accepted by the parser, carried through the model,
     * and then read by nothing on this path -- so the mark was not
     * drawn and nothing said why. The inversion is the same bisection
     * the current-margin arrow already uses, which is exact enough on
     * a log axis and works for a flex table and a definite stage alike.
     */
    const byTime = annotation.at_t_s != null && annotation.at_I_A == null
      && annotation.at_I1_A == null && annotation.at_I2_A == null
      && annotation.at_I0_A == null && annotation.at_earth_A == null
      && annotation.condition == null;

    const I = byTime
      ? currentAtTime({ element, device }, annotation.at_t_s!, 'primary')
      : annotationCurrent(
        study, annotation, element?.voltage ?? device?.voltage,
        annotatedQ == null || annotatedQ === 'mixed' ? 'phase' : annotatedQ,
      );
    if (I == null) {
      unplaceableAnnotations.push(annotation.label ?? annotation.on_curve?.text ?? 'an annotation');
      continue;
    }
    /*
     * Placed at the time asked for rather than at the time the curve
     * gives for the current just solved: the two agree to the accuracy
     * of the bisection, and taking the declared figure keeps the mark
     * exactly on the horizontal an author drew it to sit on.
     */
    const t = byTime
      ? annotation.at_t_s!
      : element
        ? tTripElement(element, I)
        : device
          ? deviceTime(device, I)
          : Infinity;
    if (!Number.isFinite(t)) {
      unplaceableAnnotations.push(annotation.label ?? annotation.on_curve?.text ?? 'an annotation');
      continue;
    }

    /*
     * Past the end of the curve it marks.
     *
     * `current_max` says where the characteristic stops, because past
     * the largest fault the network can deliver the curve describes a
     * current that cannot flow. A mark placed beyond it was still
     * drawn -- floating off the end of its own curve, at a current the
     * study has already said is impossible, looking exactly like a
     * reading taken from the line.
     *
     * A stage may stop earlier than its element, so the ceiling is the
     * largest of the stages actually drawn.
     */
    const ceiling = element
      ? (element.stages.some((s) => s.current_max_A == null)
        ? element.current_max_A
        : Math.max(...element.stages.map((s) => s.current_max_A ?? 0)))
      : undefined;
    if (ceiling != null && I > ceiling) {
      unplaceableAnnotations.push(
        `${annotation.label ?? annotation.on_curve?.text ?? 'an annotation'} `
        + `(past ${formatSi(ceiling, 'A')}, where that curve stops)`,
      );
      continue;
    }

    /* Placed on the axis the sheet is drawn in, as the curve it marks
     * is -- otherwise the mark sits off its own curve. */
    const I_view = onAxisCurrent(element, I, device?.voltage_kV);
    if (I_view == null) {
      unplaceableAnnotations.push(annotation.label ?? annotation.on_curve?.text ?? 'an annotation');
      continue;
    }
    if (!anchorOnPlot(I_view, t)) {
      offPlotAnnotations.push(annotation.label ?? annotation.on_curve?.text ?? 'an annotation');
      continue;
    }
    const px = xScale.toPx(I_view);
    const py = yScale.toPx(t);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      unplaceableAnnotations.push(annotation.label ?? annotation.on_curve?.text ?? 'an annotation');
      continue;
    }

    const base = annotation.label ?? annotation.on_curve?.text ?? '';
    const text = annotation.coords ? `${base} (${coordText(I_view, t)})` : base;

    if (annotation.style !== 'tag') {
      out.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="${colour}"/>`);
      placer.reserve({ x: px - 5, y: py - 5, w: 10, h: 10 });
    }
    if (annotation.style === 'leader') {
      /*
       * The label goes where there is room, and the leader follows it.
       *
       * It used to go at a fixed offset up and to the right, and only
       * *reserve* that box afterwards -- so it avoided nothing already
       * on the sheet and would print straight over a marked point's
       * caption, another annotation, or a margin figure. Reserving
       * after the fact stops the next label landing on this one; it
       * cannot move this one out of the way of the last.
       *
       * Asking the placer first keeps the elbow -- which is what makes
       * a leader read as a leader -- while letting the label go
       * wherever it fits. `above` is preferred so it still points away
       * from the curve it marks.
       */
      const size = {
        w: labelWidthPx(text, FONT_DETAIL),
        h: Math.max(FONT_DETAIL + 2, labelLines(text).length * FONT_DETAIL * LINE_SPACING),
      };
      const placement = placer.place({
        anchor: { x: px, y: py },
        size,
        prefer: ['above', 'right', 'left', 'below'],
        gap: leaderGap(24),
      });

      /*
       * Elbow: away from the marker, then a short horizontal run into
       * the near edge of the label, so the line meets the text rather
       * than ending in space.
       */
      const labelCy = placement.rect.y + placement.rect.h / 2;
      const toRight = placement.anchorText === 'start';
      const nearX = toRight ? placement.rect.x : placement.rect.x + placement.rect.w;
      const elbowX = nearX + (toRight ? -10 : 10);
      out.push(
        `<path d="M${px.toFixed(1)} ${py.toFixed(1)} ` +
        `L${elbowX.toFixed(1)} ${labelCy.toFixed(1)} ` +
        `L${nearX.toFixed(1)} ${labelCy.toFixed(1)}" ` +
        `fill="none" stroke="${leaderColour(colour)}" stroke-width="${leaderWidth(1)}"/>`,
      );
      out.push(
        `<text x="${placement.x.toFixed(1)}" y="${placement.y.toFixed(1)}" ` +
        `text-anchor="${placement.anchorText}" ` +
        `font-size="${FONT_DETAIL}" fill="${colour}">` +
        `${labelBody(text, placement.x, FONT_DETAIL)}</text>`,
      );
    } else if (annotation.style === 'tag') {
      /* A tag reads as a caption above its point, then beside it. */
      out.push(...placeLabel(text, { x: px, y: py }, colour, {
        prefer: ['above', 'right', 'left', 'below'],
        gap: 8,
      }));
    }
  }

  out.push('</g>');

  /*
   * Fault leaders and names, in the band below the axis.
   *
   * Names are stacked into rows so that adjacent faults do not print
   * on top of each other. A study with several faults at similar
   * currents -- which is the normal case in a cascade -- otherwise
   * produces an unreadable pile of overlapping text.
   */
  const faultBandY = topMargin + plotH + FAULT_BAND_DY;

  /* Rows were packed before the vertical margins were settled, so the
   * band below the axis could be sized to them. */
  for (const { i, px, row, flipped, caption } of faultLayout) {
    const labelY = faultBandY + row * (LINE_DETAIL - 1);
    const dash = faultDash(i);
    out.push(
      `<line x1="${px}" y1="${topMargin + plotH}" x2="${px}" y2="${(labelY - 9).toFixed(1)}" ` +
      `class="tc-fault" stroke="${faultColour}" stroke-width="${faultWidth}"` +
      `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
    );
    out.push(
      `<text x="${(px + (flipped ? -FAULT_LABEL_DX : FAULT_LABEL_DX)).toFixed(1)}" y="${labelY.toFixed(1)}" ` +
      `text-anchor="${flipped ? 'end' : 'start'}" ` +
      `class="tc-fault-label" fill="${faultColour}" font-weight="600" font-size="${FONT_DETAIL}">` +
      `${escapeXml(caption)}</text>`,
    );
  }

  /*
   * Legend.
   *
   * Laid out on an explicit vertical rhythm rather than by nudging a
   * cursor: a heading, then per-entry blocks of a title line plus
   * detail lines, with a gap between entries. Detail lines are wrapped
   * to the column width so a long relay model cannot run off the page.
   *
   * Built by a function of its origin so the same panel can be drawn
   * down the right-hand gutter or floated over a corner of the plot;
   * an inside panel has to be measured before it can be placed against
   * a bottom corner, which a single pass over a moving cursor could
   * not do.
   */
  const legendTitle = opts.page?.legend?.title ?? 'Curves';
  const legendInk = opts.page?.legend?.color ?? th.foreground;
  const swatchW = 26;

  /**
   * How much of each entry to print.
   *
   * A study with a couple of relays wants everything: make, model,
   * settings, the note on each fault. A real coordination sheet with
   * nine characteristics and seven described faults does not fit, and
   * silently running off the bottom of the page -- over the title
   * block -- is the worst of the options. The legend is built at the
   * fullest density that fits the space it has, and only then starts
   * dropping entries.
   */
  type LegendDensity = 'full' | 'compact' | 'minimal';

  const buildLegend = (
    originX: number,
    originY: number,
    width: number,
    /** Column mode drops the faults to the foot of the plot. */
    anchorFaultsToPlotBottom: boolean,
    density: LegendDensity = 'full',
    /** Vertical space available; entries past it are summarised. */
    budget: number = Infinity,
  ): { lines: string[]; height: number; dropped: number } => {
    const showDetail = density === 'full';
    const showSomeDetail = density !== 'minimal';
    const entryGap = density === 'full' ? LEGEND_ENTRY_GAP : 2;
    let dropped = 0;
    const lines: string[] = [];
    const textX = originX + swatchW + 10;
    const textWidth = width - swatchW - 10;

    let cursorY = originY + FONT_HEADING;
    lines.push(
      `<text x="${originX}" y="${cursorY}" font-size="${FONT_HEADING}" font-weight="600" class="tc-legend" fill="${legendInk}">${escapeXml(legendTitle)}</text>`,
    );
    cursorY += LINE_HEADING;

    /*
     * Notes about the axis itself.
     *
     * A strict sheet leaves elements off and moves others onto an
     * abscissa they do not measure. Both are stated: a missing curve
     * should read as a choice, and a converted one rests on the
     * depicted condition's fault type rather than on its own setting,
     * which the reader is entitled to know.
     */
    const axisNotes: string[] = [];
    if (condition) {
      const kind = condition.type ? faultTypeLabel(condition.type) : 'declared';
      axisNotes.push(`drawn for ${conditionName} (${kind})`);
      /*
       * A scenario named as the sheet's condition but silent about the
       * level being drawn supplies no ratios, so nothing converts and
       * every curve measuring something else is left off. Without this
       * the panel claimed the sheet was drawn for a condition and then
       * gave no reason for the curves that went missing.
       */
      if (condition.kind === 'scenario' && condition.voltage == null) {
        axisNotes.push(
          `${conditionName} declares no currents at ${viewLevelName ?? 'this level'}, `
          + 'so no curve converts onto this axis',
        );
      }
    }
    /*
     * Named, one apiece, with the multiplier that placed them.
     *
     * A count said that some curve on the sheet was not where its own
     * setting would put it, without saying which -- so a reader
     * checking a pickup against the axis had no way to know whether
     * this was the converted one. The factor is quoted because the
     * position rests on the depicted condition's ratios rather than on
     * the element, and it is the number that makes that checkable: a
     * 100 A phase pickup shown at 0.57x sits at 57 A on an I2 axis.
     */
    if (condition) {
      for (const [label, { measures, factor, fromLevel }] of convertedElements) {
        const shown = trimZeros(Number((1 / factor).toPrecision(3)));
        if (fromLevel != null) {
          /*
           * A cross-level factor carries the change of level as well as
           * the change of quantity, and a bare number would look like
           * the quantity ratio alone -- 0.005 where the reader expects
           * something near sqrt(3). Naming both levels and the source of
           * the ratio is what makes it checkable, and saying it did not
           * come from the turns ratio is the whole point: for this
           * condition the turns ratio would be wrong.
           */
          axisNotes.push(
            `${label}: ${fromLevel} ${quantityLabel(measures)} drawn on the `
            + `${viewLevelName ?? 'sheet'} ${quantityLabel(viewQuantity)} axis, x${shown} `
            + `-- from ${conditionName ?? 'the condition'}, not the turns ratio`,
          );
        } else {
          axisNotes.push(
            `${label}: ${quantityLabel(measures)} drawn on the `
            + `${quantityLabel(viewQuantity)} axis, x${shown}`,
          );
        }
      }
    }
    if (offAxisElements.length > 0) {
      axisNotes.push(
        `${offAxisElements.length} element${offAxisElements.length === 1 ? '' : 's'} `
        + `not on this axis (${quantityLabel(viewQuantity)})`,
      );
    }
    /*
     * A scenario that could not be marked is named individually rather
     * than counted. Unlike a converted curve, the reader has no way to
     * work out which condition is missing or why, and grading may well
     * be reporting a margin against it.
     */
    for (const note of unmarkedScenarios) axisNotes.push(note);
    for (const note of blockedElements.values()) axisNotes.push(note);
    /*
     * Curves that *are* drawn, by a ratio the study has told us not to
     * trust for them. Advisory rather than suppressing: the sheet is
     * still worth reading, and the fix is one line of source.
     */
    for (const note of referralCaveats.values()) axisNotes.push(note);
    /*
     * Counted, not named. Zooming is interactive, so this list changes
     * with every gesture; naming each one would turn the panel into a
     * running commentary on the viewport.
     */
    if (offPlotAnnotations.length > 0) {
      axisNotes.push(
        `${offPlotAnnotations.length} annotation`
        + `${offPlotAnnotations.length === 1 ? '' : 's'} outside the plotted range`,
      );
    }
    /*
     * Named, unlike the off-plot count: no amount of zooming brings
     * these back, so the reader needs to know which mark is absent.
     */
    if (unanchoredTimes.length > 0) {
      axisNotes.push(
        `caption anchor not in ${quantityLabel(viewQuantity)}, drawn at the left: `
        + unanchoredTimes.join(', '),
      );
    }
    if (unplaceableAnnotations.length > 0) {
      axisNotes.push(
        `could not place ${unplaceableAnnotations.length === 1 ? 'annotation' : 'annotations'}: `
        + unplaceableAnnotations.join(', '),
      );
    }

    /*
     * Pickups the legend could not put into secondary amps. Stated,
     * because a panel headed one way and figured the other is off by
     * the CT ratio -- an error that ends up in a relay.
     */
    if (missingCtRatio.size > 0) {
      const names = [...missingCtRatio];
      axisNotes.push(
        `${names.length === 1 ? names[0] : `${names.length} elements`} `
        + 'shown in primary amps: no ct_ratio to convert with',
      );
    }
    for (const note of unreferrablePoints) axisNotes.push(note);
    if (otherQuantityPoints.length > 0) {
      axisNotes.push(
        `${otherQuantityPoints.length} point${otherQuantityPoints.length === 1 ? '' : 's'} `
        + `declare no ${quantityLabel(viewQuantity)}: ${otherQuantityPoints.join(', ')}`,
      );
    }

    /*
     * One bullet per note, with the continuation lines indented under
     * the text rather than under the marker.
     *
     * These notes are sentences, several of them name a relay, and most
     * are long enough to wrap. Set flush left in one muted block they
     * ran together: there was no way to see where one ended and the
     * next began, so a panel carrying three of them read as a
     * paragraph. The bullet is in WinAnsi, so it survives the PDF
     * export as itself rather than becoming a question mark.
     */
    /*
     * The notes are emitted at the *foot* of the panel, under their own
     * heading -- see `emitNotes` below. Set immediately under the
     * legend title they pushed the curves down the page and read as
     * preamble, when what a reader wants first is the list of
     * characteristics; the caveats are what they come back for.
     */
    const BULLET_INDENT = 9;
    const notesWrapped = axisNotes.map(
      (note) => wrapText(note, width - BULLET_INDENT, FONT_DETAIL - 1));
    /*
     * Height the notes will take, reserved *before* the conditions
     * block is anchored to the foot of the plot.
     *
     * Emitting them after an already-anchored block ran them off the
     * bottom of the page: the anchor put the conditions flush with the
     * plot, leaving nothing beneath. Counted first, the conditions move
     * up and the notes land in the space that opens.
     */
    const showNotes = opts.page?.legend?.notes !== false && density !== 'minimal';
    const notesHeight = axisNotes.length === 0 || !showNotes
      ? 0
      : 10 + LINE_HEADING
        + notesWrapped.reduce((n, w) => n + w.length, 0) * (LINE_DETAIL - 2);

    /*
     * The author's own remarks, above the tool's notes.
     *
     * Two different things that both live at the foot of the panel and
     * must not be confused: `Notes` is the tool accounting for what it
     * could not draw, and changes as the study does. This is standing
     * text the office put there deliberately -- the issue it was
     * checked against, the assumption it rests on -- and the reader has
     * to be able to tell which is which, so each keeps its own heading.
     *
     * Set in the ordinary legend ink rather than the muted italic the
     * notes use: it is content, not a caveat.
     */
    const commentLines = opts.page?.legend?.comment ?? [];
    const commentWrapped = commentLines.map((line) => wrapText(line, width, FONT_DETAIL));
    const showComment = commentLines.length > 0 && density !== 'minimal';
    const commentHeight = !showComment
      ? 0
      : 10 + LINE_HEADING
        + commentWrapped.reduce((n, w) => n + w.length, 0) * (LINE_DETAIL - 1);

    const emitComment = (): void => {
      if (!showComment) return;
      cursorY += 10;
      lines.push(
        `<text x="${originX}" y="${cursorY}" font-size="${FONT_HEADING}" ` +
        `font-weight="600" class="tc-legend" fill="${legendInk}">Comment</text>`,
      );
      cursorY += LINE_HEADING;
      for (const wrapped of commentWrapped) {
        for (const line of wrapped) {
          lines.push(
            `<text x="${originX}" y="${cursorY}" class="tc-legend" fill="${legendInk}" ` +
            `font-size="${FONT_DETAIL}">${escapeXml(line)}</text>`,
          );
          cursorY += LINE_DETAIL - 1;
        }
      }
    };

    const emitNotes = (): void => {
      if (axisNotes.length === 0 || !showNotes) return;
      cursorY += 10;
      lines.push(
        `<text x="${originX}" y="${cursorY}" font-size="${FONT_HEADING}" ` +
        `font-weight="600" class="tc-legend" fill="${legendInk}">Notes</text>`,
      );
      cursorY += LINE_HEADING;
      for (const wrapped of notesWrapped) {
        for (const [i, line] of wrapped.entries()) {
          const x = originX + (i === 0 ? 0 : BULLET_INDENT);
          const text = i === 0 ? `• ${line}` : line;
          lines.push(
            `<text x="${x}" y="${cursorY}" class="tc-legend-muted" fill="${th.label}" ` +
            `font-size="${FONT_DETAIL - 1}" font-style="italic">${escapeXml(text)}</text>`,
          );
          cursorY += LINE_DETAIL - 2;
        }
      }
    };

    for (const c of curves) {
      /* Out of room: count what is left and say so at the end. */
      if (cursorY - originY > budget) { dropped++; continue; }

      /*
       * The entry for the curve the cursor is on is emphasised with it.
       * Following a highlighted curve to its settings meant reading
       * down a column of identical-looking blocks and matching by
       * colour, which is precisely the work the highlight exists to
       * save.
       */
      const isHighlighted = hlLabel !== '' && c.label.trim() === hlLabel
        && (!hlVolt || (c.voltage ?? '').trim() === hlVolt);

      const swatchY = cursorY - FONT_LABEL / 3;
      if (c.band) {
        /* A band's swatch is a hatched block, matching the plot. */
        const bh = 9;
        const clipId = `tc-swatch-${originX.toFixed(0)}-${cursorY.toFixed(0)}`;
        lines.push(
          `<defs><clipPath id="${clipId}">` +
          `<rect x="${originX}" y="${(swatchY - bh / 2).toFixed(1)}" width="${swatchW}" height="${bh}"/>` +
          `</clipPath></defs>`,
        );
        lines.push(
          `<rect x="${originX}" y="${(swatchY - bh / 2).toFixed(1)}" width="${swatchW}" height="${bh}" ` +
          `fill="${c.color}" fill-opacity="0.10" stroke="${c.color}" stroke-width="1"/>`,
        );
        lines.push(hatchLines(clipId, originX, swatchY - bh / 2, originX + swatchW, swatchY + bh / 2, c.color, 5));
      } else {
        /*
         * `page { legend = { swatch } }` was parsed, validated and
         * offered while being read by nothing, so a study asking for
         * boxes or circles got lines and no indication otherwise.
         *
         * A line is the default because it can carry the curve's own
         * dash pattern, which is half of how two curves are told apart
         * when the palette runs out; box and circle cannot, so they are
         * only right where every curve has its own hue.
         */
        const swatchKind = opts.page?.legend?.swatch ?? 'line';
        const w = isHighlighted ? 4.5 : 2.5;
        if (swatchKind === 'box') {
          lines.push(
            `<rect x="${originX}" y="${(swatchY - 5).toFixed(1)}" ` +
            `width="${swatchW}" height="10" fill="${c.color}" stroke="none"/>`,
          );
        } else if (swatchKind === 'circle') {
          lines.push(
            `<circle cx="${(originX + swatchW / 2).toFixed(1)}" cy="${swatchY.toFixed(1)}" ` +
            `r="${isHighlighted ? 6 : 5}" fill="${c.color}" stroke="none"/>`,
          );
        } else {
          lines.push(
            `<line x1="${originX}" y1="${swatchY}" x2="${originX + swatchW}" y2="${swatchY}" ` +
            `stroke="${c.color}" stroke-width="${w}"` +
            `${(c.dashArray ?? (c.dashed ? '6 4' : '')) ? ` stroke-dasharray="${c.dashArray ?? '6 4'}"` : ''}` +
            ` stroke-linecap="round"/>`,
          );
        }
      }
      /* Wrapped like the detail lines beneath it: a declared `name`
       * is free text and routinely outruns the column. */
      for (const wrapped of wrapText(oneLine(c.label), textWidth, FONT_LABEL)) {
        lines.push(
          `<text x="${textX}" y="${cursorY}" class="tc-legend${isHighlighted ? ' tc-legend-snap' : ''}" ` +
          `fill="${isHighlighted ? c.color : th.foreground}" font-size="${FONT_LABEL}" font-weight="600">` +
          `${escapeXml(wrapped)}</text>`,
        );
        cursorY += LINE_LABEL;
      }

      /*
       * `compact` keeps the settings -- curve, pickup, TMS or delay,
       * the line an engineer checks -- and drops the make, model and
       * voltage around it. Selected by role, not by position.
       */
      const detail = showDetail
        ? c.detailLines
        : showSomeDetail
          ? c.detailLines.filter((l) => l.role === 'settings')
          : [];
      for (const line of detail) {
        for (const wrapped of wrapText(oneLine(line.text), textWidth, FONT_DETAIL)) {
          lines.push(
            `<text x="${textX}" y="${cursorY}" class="tc-legend-muted" fill="${th.label}" font-size="${FONT_DETAIL}">` +
            `${escapeXml(wrapped)}</text>`,
          );
          cursorY += LINE_DETAIL;
        }
      }
      cursorY += entryGap;
    }

    /*
     * Points section: marked coordinates are part of the study's
     * argument, so they belong in the legend with their values rather
     * than only as a glyph on the plot.
     */
    const legendPoints = study.points
      .filter((p) => !pointsOnPlot.has(p.id) && !pointsAccountedFor.has(p.id));
    if (legendPoints.length > 0) {
      lines.push(
        `<text x="${originX}" y="${cursorY}" font-size="${FONT_HEADING}" font-weight="600" fill="${legendInk}">Points</text>`,
      );
      cursorY += LINE_HEADING;

      for (const point of legendPoints) {
        /* A marked point is not a fault current; it gets its own ink. */
    const colour = point.color ?? th.point;
        const swatchY = cursorY - FONT_LABEL / 3;
        lines.push(pointMarker(point.shape ?? 'cross', originX + swatchW / 2, swatchY, colour));

        /*
         * Author line breaks are ignored here. A `\n` positions text
         * beside a marker on the plot, where the author chose the
         * shape of the label; in a list it just makes a ragged entry,
         * and the column does its own wrapping anyway.
         */
        for (const wrapped of wrapText(oneLine(point.label ?? point.id), textWidth, FONT_LABEL)) {
          lines.push(
            `<text x="${textX}" y="${cursorY}" class="tc-legend" fill="${legendInk}" ` +
            `font-size="${FONT_LABEL}">${escapeXml(wrapped)}</text>`,
          );
          cursorY += LINE_LABEL;
        }
        const coords = coordText(project(point.I_A, point.voltage_kV), point.t_s);
        for (const wrapped of showSomeDetail ? wrapText(coords, textWidth, FONT_DETAIL) : []) {
          lines.push(
            `<text x="${textX}" y="${cursorY}" class="tc-legend-muted" fill="${th.label}" ` +
            `font-size="${FONT_DETAIL}">${escapeXml(wrapped)}</text>`,
          );
          cursorY += LINE_DETAIL;
        }
        cursorY += LEGEND_ENTRY_GAP;
      }
    }

    /*
     * Faults.
     *
     * Only those the view actually shows. A legend entry maps a dash
     * pattern to a name, which says nothing when that dash is nowhere
     * on the plot -- and a fault outside the zoom has no rule drawn and
     * no name below the axis, so the entry pointed at nothing. It also
     * cost the panel a line it needs for the faults that are there.
     *
     * Indices are kept from the declared order, because the dash
     * pattern is assigned from it: filtering with fresh indices would
     * have the swatch show a different dash from the rule it names.
     */
    const shownFaults = [...faults.keys()].filter((i) => {
      const I = faults[i].I_view ?? faults[i].I_A;
      return inDomain(I);
    });

    if (shownFaults.length > 0) {
      /* Wrapped up front: a long fault name plus its current and
       * voltage runs past the column, and the block has to be
       * anchored by the height it will actually take. */
      const faultText = new Map(shownFaults.map((i) => {
        const f = faults[i];
        /*
         * The *declared* current against the level it was declared on.
         *
         * This used to print the projected current -- the value the
         * rule is drawn at, in the view's frame -- beside the fault's
         * own voltage label, which states something false: a 460 A
         * fault at 0.48 kV was listed as "6.69 A · LV · 0.48 kV",
         * that being its equivalent at 33 kV. Where the two frames
         * differ the projection is now shown as well, and marked as
         * such.
         */
        const where = f.voltageLabel ? ` · ${f.voltageLabel}` : '';
        return [i, wrapText(
          `${f.name} · ${formatSi(f.I_A, 'A')}${where}`,
          textWidth,
          FONT_DETAIL,
        )] as const;
      }));

      /*
       * The projection onto the plotted axis goes on its own muted
       * line. Appended inline it pushed the entry over the column
       * width and broke it mid-figure -- "... 11 kV ->" then a bare
       * "2.13 kA" on the next line, which reads as a separate value.
       */
      const faultProjection = new Map(shownFaults.map((i) => {
        const f = faults[i];
        const referred = f.I_view != null && Math.abs(f.I_view - f.I_A) > f.I_A * 1e-6;
        /*
         * A scenario says so, in one word. Its figure is the one the
         * study wrote down for the level on the line above rather than a
         * fault current carried there by the turns ratio, and once
         * faults and scenarios can share a sheet that difference is
         * something the reader has to be able to see. Kept to a word
         * because on a sheet of nothing but scenarios a full sentence
         * repeats itself down the whole panel.
         */
        const provenance = f.kind === 'scenario' ? ['scenario'] : [];
        return [i, [
          ...provenance,
          ...(referred ? [`-> ${formatSi(f.I_view!, 'A')} on axis`] : []),
        ].flatMap((line) => wrapText(line, textWidth, FONT_DETAIL - 1))] as const;
      }));
      /* `description` is the author's note on what the fault *is*;
       * it belongs with the entry rather than being parsed and
       * dropped, which is what used to happen to it. */
      const faultNotes = new Map(shownFaults.map((i) => {
        const f = faults[i];
        return [i, showDetail && f.description
          ? wrapText(oneLine(f.description), textWidth, FONT_DETAIL - 1)
          : []] as const;
      }));

      const countLines = (m: Map<number, string[]>): number =>
        [...m.values()].reduce((n, l) => n + l.length, 0);
      const faultLineCount =
        countLines(faultText) + countLines(faultProjection) + countLines(faultNotes);

      let faultsY = cursorY + FONT_HEADING;
      if (anchorFaultsToPlotBottom) {
        const wanted = topMargin + plotH - (faultLineCount * LINE_LABEL)
          - LINE_HEADING + FONT_HEADING - notesHeight - commentHeight;
        faultsY = Math.max(wanted, cursorY + 12);
      }

      /*
       * "Faults" while they all are; "Conditions" once a scenario is
       * among them, since a scenario is not a fault current and heading
       * a list of both with the narrower word misnames half of it.
       */
      const heading = shownFaults.some((i) => faults[i].kind === 'scenario')
        ? 'Conditions'
        : 'Faults';
      lines.push(
        `<text x="${originX}" y="${faultsY}" font-size="${FONT_HEADING}" font-weight="600" fill="${faultColour}">${heading}</text>`,
      );
      faultsY += LINE_HEADING;

      for (const i of shownFaults) {
        const swatchY = faultsY - FONT_LABEL / 3;
        const dash = faultDash(i);
        lines.push(
          `<line x1="${originX}" y1="${swatchY}" x2="${originX + swatchW}" y2="${swatchY}" ` +
          `stroke="${faultColour}" stroke-width="${Math.max(faultWidth, 1.5)}"` +
          `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
        );
        for (const wrapped of faultText.get(i) ?? []) {
          lines.push(
            `<text x="${textX}" y="${faultsY}" class="tc-legend" fill="${th.foreground}" font-size="${FONT_DETAIL}">` +
            `${escapeXml(wrapped)}</text>`,
          );
          faultsY += LINE_LABEL;
        }
        for (const wrapped of faultProjection.get(i) ?? []) {
          lines.push(
            `<text x="${textX}" y="${faultsY}" class="tc-legend-muted" fill="${th.label}" ` +
            `font-size="${FONT_DETAIL - 1}">${escapeXml(wrapped)}</text>`,
          );
          faultsY += LINE_DETAIL - 2;
        }
        for (const wrapped of faultNotes.get(i) ?? []) {
          lines.push(
            `<text x="${textX}" y="${faultsY}" class="tc-legend-muted" fill="${th.label}" ` +
            `font-size="${FONT_DETAIL - 1}">${escapeXml(wrapped)}</text>`,
          );
          faultsY += LINE_DETAIL - 2;
        }
      }
      cursorY = faultsY;
    }

    /*
     * Times.
     *
     * Their own section, because they answer a different question from
     * the conditions above -- "is the curve under this?" rather than
     * "what happens at this current?" -- and a reader tracing a
     * horizontal rule should not have to search a list of currents for
     * its name.
     */
    if (timesOnPlot.length > 0) {
      cursorY += 8;
      lines.push(
        `<text x="${originX}" y="${cursorY}" font-size="${FONT_HEADING}" ` +
        `font-weight="600" fill="${timeColour}">Times</text>`,
      );
      cursorY += LINE_HEADING;

      for (const t of timesOnPlot) {
        const swatchY = cursorY - FONT_LABEL / 3;
        lines.push(
          `<line x1="${originX}" y1="${swatchY}" x2="${originX + swatchW}" y2="${swatchY}" ` +
          `stroke="${timeColour}" stroke-width="${Math.max(timeWidth, 1.5)}"` +
          `${timeDash ? ` stroke-dasharray="${timeDash}"` : ''}/>`,
        );
        for (const wrapped of wrapText(`${t.name} · ${formatSi(t.t_s, 's')}`, textWidth, FONT_DETAIL)) {
          lines.push(
            `<text x="${textX}" y="${cursorY}" class="tc-legend" fill="${th.foreground}" ` +
            `font-size="${FONT_DETAIL}">${escapeXml(wrapped)}</text>`,
          );
          cursorY += LINE_LABEL;
        }
        if (showDetail && t.description) {
          for (const wrapped of wrapText(oneLine(t.description), textWidth, FONT_DETAIL - 1)) {
            lines.push(
              `<text x="${textX}" y="${cursorY}" class="tc-legend-muted" fill="${th.label}" ` +
              `font-size="${FONT_DETAIL - 1}">${escapeXml(wrapped)}</text>`,
            );
            cursorY += LINE_DETAIL - 2;
          }
        }
      }
    }

    /*
     * A required time off the sheet is worth saying: it is the limit
     * the drawing exists to demonstrate being met.
     */
    for (const t of times) {
      if (timesOnPlot.includes(t)) continue;
      lines.push(
        `<text x="${originX}" y="${cursorY}" class="tc-legend-muted" fill="${th.label}" ` +
        `font-size="${FONT_DETAIL - 1}" font-style="italic">` +
        `${escapeXml(`• ${t.name} (${formatSi(t.t_s, 's')}) is outside the plotted times`)}</text>`,
      );
      cursorY += LINE_DETAIL - 2;
    }

    /* The office's own words first, then the tool's account of what it
     * could not do. */
    emitComment();
    emitNotes();

    if (dropped > 0) {
      lines.push(
        `<text x="${originX}" y="${cursorY}" class="tc-legend-muted" fill="${th.label}" ` +
        `font-size="${FONT_DETAIL}" font-style="italic">` +
        `${escapeXml(`+${dropped} more not shown`)}</text>`,
      );
      cursorY += LINE_DETAIL;
    }
    return { lines, height: cursorY - originY, dropped };
  };

  /**
   * Build the legend at the fullest density that fits `budget`.
   *
   * Measured rather than estimated: the wrapping depends on the text,
   * so the only reliable way to know whether a legend fits is to lay
   * it out and look at the height it came to.
   */
  const fitLegend = (
    originX: number,
    originY: number,
    width: number,
    anchorFaults: boolean,
    budget: number,
  ): { lines: string[]; height: number } => {
    for (const density of ['full', 'compact', 'minimal'] as LegendDensity[]) {
      /*
       * Measured unanchored, always. In column mode the faults block
       * is dropped to the foot of the plot, so its laid-out height
       * runs from the top of the column to below the plot -- larger
       * than the budget by construction, which would have condemned
       * even a two-curve study to the least detail.
       */
      const natural = buildLegend(originX, originY, width, false, density);
      if (natural.height <= budget) {
        return anchorFaults
          ? buildLegend(originX, originY, width, true, density)
          : natural;
      }
    }
    /* Still over at the least detail: drop entries and say how many. */
    return buildLegend(originX, originY, width, anchorFaults, 'minimal', budget);
  };

  if (legendMode === 'column') {
    const legX = leftMargin + plotW + LEGEND_GUTTER + (mirrorAxes ? 46 : 0);
    const legendWidth = rightMargin - LEGEND_GUTTER - 12 - (mirrorAxes ? 46 : 0);
    /*
     * The column runs to the title block, not merely to the foot of
     * the plot: the fault-name band and the axis title below the plot
     * sit under the *plot*, and leave the gutter beside them empty.
     * Budgeting only `plotH` threw away that band and pushed studies
     * to names-only detail that had room for their settings.
     */
    const columnBudget = H - sheetInset - titleBlockH - 10 - topMargin;
    /*
     * The blocks flow one after another: curves, then conditions, then
     * times, then the comment and the notes.
     *
     * The conditions block used to be pinned to the foot of the plot,
     * which left a hand's width of empty gutter between the last curve
     * and it -- on a two-relay study, most of the column. The reader
     * has to look down an inch of nothing to find out what the
     * vertical rules mean, and a sheet with a short legend reads as
     * though something failed to draw.
     *
     * Anchoring bought alignment with nothing: the fault *rules* are
     * vertical and their names sit under the axis, so the block was
     * not lining up with anything it described.
     */
    out.push(...fitLegend(legX, topMargin, legendWidth, false, columnBudget).lines);
  } else if (legendMode === 'inside') {
    /*
     * Floated over the plot. Measured first, because a panel pinned to
     * a bottom corner has to know its own height before it can be
     * placed, and drawn on an opaque card so the gridlines beneath it
     * do not read through the text.
     */
    const pad = 12;
    const panelW = Math.min(300, Math.max(180, plotW * 0.42));
    /* A floating panel may cover at most three-quarters of the plot;
     * past that it is hiding the curves it is meant to explain. */
    const panelBudget = plotH * 0.75;
    const measured = fitLegend(0, 0, panelW, false, panelBudget).height;
    const panelH = Math.min(measured + pad, panelBudget + pad);

    const corner = legendCorner(opts.page?.legend?.position);
    const onLeft = corner === 'top_left' || corner === 'bottom_left';
    const onTop = corner === 'top_left' || corner === 'top_right';
    const panelX = onLeft ? leftMargin + 14 : leftMargin + plotW - panelW - 2 * pad - 14;
    const panelY = onTop ? topMargin + 14 : topMargin + plotH - panelH - 14;

    out.push(
      `<rect x="${panelX.toFixed(1)}" y="${panelY.toFixed(1)}" ` +
      `width="${(panelW + 2 * pad).toFixed(1)}" height="${panelH.toFixed(1)}" rx="4" ` +
      `fill="${th.background}" fill-opacity="0.92" stroke="${th.axis}" stroke-width="0.8"/>`,
    );
    out.push(...fitLegend(panelX + pad, panelY + pad / 2, panelW, false, panelBudget).lines);
  }

  /*
   * Footer (spec: _Title / footer / watermark_). Three slots, each
   * able to carry `[date]`, `[meta.*]`, `[page]` and `[of]` macros.
   * Suppressed when the sheet has a title block, which already carries
   * the same information.
   */
  const footer = opts.page?.footer;
  if (footer && !bordered) {
    const footerY = H - 6 - sheetInset;
    if (footer.border !== false) {
      out.push(
        `<line x1="${leftMargin}" y1="${footerY - 14}" x2="${leftMargin + plotW}" y2="${footerY - 14}" ` +
        `stroke="${th.axis}" stroke-width="0.8" stroke-opacity="0.6"/>`,
      );
    }
    const slots: Array<[string | undefined, number, string]> = [
      [footer.left, leftMargin, 'start'],
      [footer.center, leftMargin + plotW / 2, 'middle'],
      [footer.right, leftMargin + plotW, 'end'],
    ];
    for (const [raw, x, anchor] of slots) {
      if (!raw) continue;
      out.push(
        `<text x="${x}" y="${footerY}" text-anchor="${anchor}" ` +
        `font-size="${footer.font_size_px ?? FONT_DETAIL - 1}" ` +
        `fill="${footer.color ?? th.label}">${escapeXml(expandMacros(raw, study))}</text>`,
      );
    }
  }

  /* watermark */
  if (opts.page?.watermark) {
    out.push(`<text transform="rotate(-30 ${W/2} ${H/2})" x="${W/2}" y="${H/2}" text-anchor="middle" font-size="64" fill="${th.fault}" opacity="0.08">${escapeXml(opts.page.watermark)}</text>`);
  }

  out.push('</svg>');
  return out.join('\n');
}


/**
 * Short display name for a curve id.
 *
 * Standards bodies and vendors are acronyms and belong in capitals --
 * "IEC SI", not "Iec Si". Curve families are acronyms too (SI, VI, EI,
 * LTI, STI, MI), except the few vendor families that are words.
 */
function curveDisplayName(curveId: string): string {
  if (!curveId || curveId.indexOf('.') < 0) return curveId;
  const ix = curveId.indexOf('.');
  const ns = curveId.slice(0, ix);
  const family = curveId.slice(ix + 1);

  const NAMESPACES: Record<string, string> = {
    iec: 'IEC', ansi: 'ANSI', sel: 'SEL', ge: 'GE',
    abb: 'ABB', siemens: 'Siemens', schneider: 'Schneider',
  };

  /* Families that are words rather than acronyms. */
  const WORDS: Record<string, string> = {
    inv: 'Inverse',
    long_inv: 'Long inverse',
    long_vi: 'Long VI',
    long_ei: 'Long EI',
  };

  const part = (p: string): string =>
    WORDS[p] ?? (/^[a-z]{1,4}\d*$/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1));

  return `${NAMESPACES[ns] ?? ns.toUpperCase()} ${family.split('.').map(part).join(' ')}`;
}

function trimZeros(n: number): string {
  if (!Number.isFinite(n)) return '-';   // ASCII: safe in every PDF encoding
  let s = n.toFixed(3);
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

function sampleLog(min: number, max: number, n: number): number[] {
  const out: number[] = [];
  const lmin = Math.log(min);
  const lmax = Math.log(max);
  for (let i = 0; i <= n; i++) {
    out.push(Math.exp(lmin + (i / n) * (lmax - lmin)));
  }
  return out;
}


function escapeXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c] as string));
}

/* ---------------------- fault label rows ---------------------- */

interface PlacedFault {
  f: FaultEntry;
  /** Index in the declared fault order, which picks the dash. */
  i: number;
  px: number;
  row: number;
  /** Drawn to the left of its rule, because a right-hand label would
   * have run past the frame. */
  flipped: boolean;
  /**
   * The text as drawn -- name, and the current where it is shown.
   *
   * Carried rather than rebuilt at the drawing site, because the
   * packer has to measure the same string it will later place. It
   * measured `f.name` alone while the caption gained the current
   * beside it, so every label was under-measured by the width of its
   * own figure and the rows overlapped.
   */
  caption: string;
}

/**
 * Pack the fault names below the axis into non-overlapping rows.
 *
 * Run before the vertical margins are settled so the band can be
 * sized to the rows it needs, then reused by the drawing pass -- one
 * packing, so the reserve and the labels can never disagree.
 */
function packFaultLabels(
  faults: FaultEntry[],
  xScale: LogScale,
  I_min: number,
  I_max: number,
  showLabels: boolean,
  /** Right-hand edge of the plot; labels may not cross it. */
  plotRight: number,
  /** Print each current beside its name. */
  showCurrents: boolean,
): PlacedFault[] {
  if (!showLabels) return [];

  const placed: PlacedFault[] = [];
  const taken: Array<{ left: number; right: number; row: number }> = [];

  const visible = faults
    .map((f, i) => ({ f, i, I: f.I_view ?? f.I_A }))
    .filter(({ I }) => I > 0 && I >= I_min && I <= I_max)
    .sort((a, b) => a.I - b.I);

  for (const { f, i, I } of visible) {
    const px = xScale.toPx(I);
    if (!Number.isFinite(px)) continue;

    /*
     * A name is normally drawn to the right of its rule. Near the
     * right-hand edge that runs off the sheet -- a long fault name at
     * the maximum fault current does it every time -- so the label
     * flips and hangs to the left of the rule instead.
     */
    /*
     * The figure is the reason the rule is drawn, so it goes beside
     * the name -- and it is measured here, with the name, because
     * this is what decides which row the label lands on.
     */
    const caption = showCurrents && Number.isFinite(I)
      ? `${f.name} \u00b7 ${formatSi(I, 'A')}`
      : f.name;

    const width = caption.length * FONT_DETAIL * CHAR_ADVANCE + 10;
    const flipped = px + width > plotRight;
    const left = flipped ? px - width : px;
    const right = left + width;

    /* First row this label's span does not collide with. */
    let row = 0;
    while (taken.some((p) => p.row === row && p.right > left && p.left < right)) row++;
    taken.push({ left, right, row });
    placed.push({ f, i, px, row, flipped, caption });
  }
  return placed;
}

/* ---------------------- legend placement ---------------------- */

/**
 * Which identification scheme a page has asked for.
 *
 * `show = false` is kept as the older spelling of `style = "none"`;
 * an explicit style wins, so a study can say `show = true` alongside
 * `style = "direct"` without contradiction.
 */
function resolveLegendMode(legend: PageLegend | undefined): LegendStyle {
  if (legend?.style) return legend.style;
  return legend?.show === false ? 'none' : 'column';
}

/** Corner an inside panel is pinned to; defaults to the top right. */
function legendCorner(position: PageLegend['position']): LegendCorner {
  switch (position) {
    case 'top_left':
    case 'bottom_left':
    case 'bottom_right':
    case 'top_right':
      return position;
    /* The edge keywords a column legend uses, read as a corner. */
    case 'left':
      return 'top_left';
    case 'bottom':
      return 'bottom_right';
    default:
      return 'top_right';
  }
}

interface DirectLabelGeometry {
  leftMargin: number;
  topMargin: number;
  plotW: number;
  plotH: number;
  background: string;
  ink: string;
}

/**
 * Label each characteristic where it lives, instead of in a legend.
 *
 * Direct labelling is the better reading on a crowded sheet -- the
 * eye never leaves the curve to match a colour against a key -- and it
 * costs no width, which is why it earns its place on a portrait page.
 *
 * Each label is anchored to the right-hand end of its curve, where TCC
 * characteristics are flattest and furthest apart, then the column of
 * labels is spread vertically so that none overlap, with a leader back
 * to the true anchor. Curves that leave the top of the plot are
 * anchored wherever they last crossed it.
 */
function directLabels(
  curves: CurveEntry[],
  geo: DirectLabelGeometry,
): { markup: string[]; boxes: Rect[] } {
  const { leftMargin, topMargin, plotW, plotH } = geo;
  const boxH = FONT_LABEL + 8;
  const gap = 3;

  interface Placed {
    label: string;
    color: string;
    anchorX: number;
    anchorY: number;
    y: number;
    width: number;
  }

  /*
   * Every box hangs off the same right-hand edge, just inside the
   * plot, and each curve is anchored at its own rightmost visible
   * point -- which on a TCC is where it leaves through the right or
   * bottom edge. The leader is then a short stub running outward from
   * the box to the curve, whatever the label's width.
   *
   * Sharing one *left* edge instead makes a short label's leader run
   * back across the curves it passes, which long names make
   * unmissable; anchoring at the x where each box begins trades that
   * for a worse failure, since a curve that starts partway across --
   * a definite-time stage picking up at 9 kA -- has no point there at
   * all, and the label climbs its vertical riser.
   */
  const boxRight = leftMargin + plotW - 22;
  const placed: Placed[] = [];
  const boxes: Rect[] = [];
  for (const c of curves) {
    const anchor = lastPointInside(c.pathD, topMargin, topMargin + plotH);
    if (!anchor) continue;
    placed.push({
      label: c.label,
      color: c.color,
      anchorX: anchor.x,
      anchorY: anchor.y,
      y: anchor.y,
      width: labelWidthPx(c.label, FONT_LABEL) + 14,
    });
  }
  if (placed.length === 0) return { markup: [], boxes };

  /*
   * Spread the labels apart, top-down then bottom-up, so the column
   * stays inside the plot even when every curve converges -- which is
   * the normal case at the right-hand end of a TCC.
   */
  placed.sort((a, b) => a.y - b.y);
  const minY = topMargin + boxH / 2 + 2;
  const maxY = topMargin + plotH - boxH / 2 - 2;
  for (let i = 0; i < placed.length; i++) {
    const floor = i === 0 ? minY : placed[i - 1].y + boxH + gap;
    placed[i].y = Math.max(placed[i].y, floor);
  }
  for (let i = placed.length - 1; i >= 0; i--) {
    const ceiling = i === placed.length - 1 ? maxY : placed[i + 1].y - boxH - gap;
    placed[i].y = Math.min(placed[i].y, ceiling);
  }

  const out: string[] = [];
  for (const p of placed) {
    /* Each box hangs off the right edge; the leader is the short run
     * from the curve to the box's own left edge. Drawn first, so the
     * box paints over its end. */
    const boxX = Math.max(leftMargin + 4, boxRight - p.width);
    out.push(
      `<path d="M${p.anchorX.toFixed(1)} ${p.anchorY.toFixed(1)} ` +
      `L${(boxRight + 8).toFixed(1)} ${p.y.toFixed(1)} L${boxRight.toFixed(1)} ${p.y.toFixed(1)}" ` +
      `fill="none" stroke="${p.color}" stroke-width="1" stroke-opacity="0.8"/>`,
    );
    out.push(
      `<rect x="${boxX.toFixed(1)}" y="${(p.y - boxH / 2).toFixed(1)}" ` +
      `width="${p.width.toFixed(1)}" height="${boxH}" rx="3" ` +
      `fill="${geo.background}" fill-opacity="0.94" stroke="${p.color}" stroke-width="1.2"/>`,
    );
    out.push(
      `<text x="${(boxX + 7).toFixed(1)}" y="${(p.y + FONT_LABEL / 3).toFixed(1)}" ` +
      `class="tc-legend" font-size="${FONT_LABEL}" font-weight="600" fill="${geo.ink}">` +
      `${escapeXml(p.label)}</text>`,
    );
    boxes.push({ x: boxX, y: p.y - boxH / 2, w: p.width, h: boxH });
  }
  return { markup: out, boxes };
}

/**
 * Rightmost point of a traced path that is still on the plot.
 *
 * Not simply the last point: a characteristic is sampled across the
 * whole current domain and clipped for drawing, so a steep curve's
 * final point routinely sits below the axis. Anchoring a label there
 * would put it off the sheet -- or, when the anchor was rejected
 * outright, leave that curve as the one thing on the plot with no
 * name.
 */
/**
 * A path's points, split into the runs the pen actually drew.
 *
 * `M` lifts the pen, so the gap it leaves is not part of the line and
 * a label may sit across it -- a characteristic that stops operating
 * and starts again leaves exactly such a gap. Splitting on `M` keeps
 * that gap available instead of spanning it with a phantom segment.
 */
function polylineRuns(pathD: string): Array<Array<{ x: number; y: number }>> {
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];

  for (const m of pathD.matchAll(/([ML])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (m[1] === 'M') {
      if (current.length > 1) runs.push(current);
      current = [{ x, y }];
    } else {
      current.push({ x, y });
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

function lastPointInside(
  pathD: string,
  topY: number,
  bottomY: number,
): { x: number; y: number } | null {
  const matches = [...pathD.matchAll(/[ML]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const x = Number(matches[i][1]);
    const y = Number(matches[i][2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (y >= topY - 1 && y <= bottomY + 1) return { x, y };
  }
  return null;
}

/* ------------------- multi-line author text ------------------- */

/** Line spacing for author-supplied labels, as a multiple of size. */
const LINE_SPACING = 1.25;

/**
 * A label flattened to a single line.
 *
 * Used for `data-` attributes, which feed the viewer's readout: a
 * newline there would be normalised to a space by the XML parser
 * anyway, and the readout is one line of text.
 */
function oneLine(text: string): string {
  return String(text).replace(/\s*\n\s*/g, ' ');
}

/** Split an author label into its lines. */
function labelLines(text: string): string[] {
  /*
   * Each line is trimmed, so a break written for readability in the
   * source does not carry the author's indentation onto the drawing:
   * `"TX1 inrush\n    12 x FLC"` sets its second line flush, not four
   * spaces in.
   */
  return String(text).split('\n').map((line) => line.trim());
}

/**
 * Rendered width of a label, in pixels.
 *
 * A wrapped label is only as wide as its *longest* line, so the
 * flip-to-the-left tests must measure that rather than the whole
 * string -- otherwise a two-line label reads as twice as wide as it
 * draws and flips away from a side it would have fitted on.
 */
function labelWidthPx(text: string, fontSize: number): number {
  let longest = 0;
  for (const line of labelLines(text)) longest = Math.max(longest, line.length);
  return longest * fontSize * CHAR_ADVANCE;
}

/** Height a label occupies beyond its first line, in pixels. */
function labelExtraHeightPx(text: string, fontSize: number): number {
  return (labelLines(text).length - 1) * fontSize * LINE_SPACING;
}

/**
 * Body of a `<text>` for a label that may contain newlines.
 *
 * SVG does no line breaking of its own, so each line becomes a
 * `<tspan>` carrying an explicit `x` (to reset the anchor) and `dy`.
 *
 * `anchor` decides what the caller's `y` means. `'middle'` centres the
 * block on it, which is what a label pinned beside a marker or an
 * arrow wants: adding a second line then grows it symmetrically
 * instead of sliding it down off the thing it names. `'first'` keeps
 * the first line on the caller's baseline and hangs the rest below,
 * which is what a title or a legend entry wants, since those are laid
 * out top-down and the caller advances its own cursor.
 *
 * A label with no newline emits plain escaped text, so the common case
 * produces byte-identical output to before this existed.
 */
function labelBody(
  text: string,
  x: number,
  fontSize: number,
  anchor: 'first' | 'middle' = 'middle',
): string {
  const lines = labelLines(text);
  if (lines.length === 1) return escapeXml(text);

  const step = fontSize * LINE_SPACING;
  const lead = anchor === 'middle' ? -((lines.length - 1) * step) / 2 : 0;
  return lines
    .map((line, i) =>
      `<tspan x="${x.toFixed(1)}" dy="${(i === 0 ? lead : step).toFixed(1)}">` +
      `${escapeXml(line)}</tspan>`,
    )
    .join('');
}

function placeholderSvg(message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="100%" height="100%" fill="#fff"/><text x="20" y="30" font-family="monospace" font-size="14" fill="#333">${escapeXml(message)}</text></svg>`;
}

/**
 * Marker glyph for a plotted point.
 *
 * A cross is the default because it reads as a *coordinate* rather
 * than a data sample: an inrush point is an assertion about one
 * (I, t), not a measurement on a curve.
 */
function pointMarker(
  shape: 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'x',
  px: number,
  py: number,
  colour: string,
  /**
   * Page colour, for the ring that separates the marker from whatever
   * it sits on.
   *
   * A marked point is usually *at* a curve -- that is the comparison
   * being made -- so the two collide by design, and drawing the marker
   * later is not enough to make it read as being in front: a 2 px
   * stroke through a 10 px marker still looks like one shape. A ring in
   * the surface colour cuts the line where the marker crosses it, which
   * is the ordinary way to show which of two marks is on top.
   */
  surface?: string,
  /** Half-size in px, from `page { points = { size_px } }`. */
  size?: number,
): string {
  const r = size != null && size > 0 ? size / 2 : 5;
  const stroke = `stroke="${colour}" stroke-width="1.8" fill="none"`;
  const filled = `fill="${colour}" stroke="none"`;

  /*
   * The halo is a second, larger copy of the same shape drawn
   * underneath, rather than a wide stroke on the marker itself.
   * `paint-order="stroke"` would be tidier but is not carried by every
   * renderer this output has to survive -- where it is ignored the
   * stroke lands on top of the fill and eats the marker instead of
   * ringing it.
   */
  const ring = (body: string): string => (surface ? body : '');
  const haloFill = `fill="${surface ?? 'none'}" stroke="none"`;
  const hr = r + 1.75;

  switch (shape) {
    case 'circle':
      return ring(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${hr}" ${haloFill}/>`)
        + `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r}" ${filled}/>`;
    case 'square':
      return ring(`<rect x="${(px - hr).toFixed(1)}" y="${(py - hr).toFixed(1)}" `
        + `width="${(hr * 2).toFixed(1)}" height="${(hr * 2).toFixed(1)}" ${haloFill}/>`)
        + `<rect x="${(px - r).toFixed(1)}" y="${(py - r).toFixed(1)}" `
        + `width="${r * 2}" height="${r * 2}" ${filled}/>`;
    case 'diamond':
      return ring(`<polygon points="${px},${py - hr} ${px + hr},${py} ${px},${py + hr} ${px - hr},${py}" ${haloFill}/>`)
        + `<polygon points="${px},${py - r} ${px + r},${py} ${px},${py + r} ${px - r},${py}" ${filled}/>`;
    case 'triangle':
      return ring(`<polygon points="${px},${(py - hr).toFixed(1)} ${(px + hr).toFixed(1)},${(py + hr).toFixed(1)} ${(px - hr).toFixed(1)},${(py + hr).toFixed(1)}" ${haloFill}/>`)
        + `<polygon points="${px},${py - r} ${px + r},${py + r} ${px - r},${py + r}" ${filled}/>`;
    /* An open mark has no fill to hide the halo, so its ring is a wider
     * stroke along the same path. */
    case 'x': {
      const d = `M${px - r} ${py - r} L${px + r} ${py + r} M${px + r} ${py - r} L${px - r} ${py + r}`;
      return ring(`<path d="${d}" fill="none" stroke="${surface}" stroke-width="4.5" stroke-linecap="round"/>`)
        + `<path d="${d}" ${stroke}/>`;
    }
    case 'cross':
    default: {
      const d = `M${px - r} ${py} L${px + r} ${py} M${px} ${py - r} L${px} ${py + r}`;
      return ring(`<path d="${d}" fill="none" stroke="${surface}" stroke-width="4.5" stroke-linecap="round"/>`)
        + `<path d="${d}" ${stroke}/>`;
    }
  }
}

/** A fuse band ready to draw: two bounds plus the closed area between. */
interface DeviceBand {
  id: string;
  color: string;
  /** Minimum-melt boundary. */
  lowerD: string;
  /** Total-clear boundary. */
  upperD: string;
  /** Closed region between the two. */
  areaD: string;
}

/** Human-readable names for the device kinds. */
const DEVICE_KIND_LABEL: Record<string, string> = {
  fuse: 'Fuse',
  recloser: 'Recloser',
  cable: 'Cable withstand',
  transformer_damage: 'Transformer damage',
  motor_startup: 'Motor starting',
  breaker: 'Breaker',
};

/**
 * Diagonal hatch across a fuse band.
 *
 * Drawn as explicit clipped lines rather than an SVG `<pattern>`:
 * pattern fills are poorly supported by SVG-to-PDF converters, and
 * this renderer's output has to survive that trip intact. Explicit
 * geometry renders identically everywhere.
 *
 * The hatch also does accessibility work -- it distinguishes the band
 * from a solid region by *texture* rather than colour alone, which is
 * what a colour-blind reader or a monochrome print needs.
 */
function hatchLines(
  clipId: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  spacing = 7,
): string {
  const out: string[] = [];
  const w = x1 - x0;
  const h = y1 - y0;
  /* 45-degree lines: sweep the intercept from -h to +w. */
  for (let offset = -h; offset < w; offset += spacing) {
    const ax = x0 + offset;
    const ay = y1;
    const bx = x0 + offset + h;
    const by = y0;
    out.push(
      `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" ` +
      `x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" ` +
      `stroke="${color}" stroke-width="0.7" stroke-opacity="0.55"/>`,
    );
  }
  return `<g clip-path="url(#${clipId})">${out.join('')}</g>`;
}

/** Small filled arrowhead, pointing up (+1) or down (-1). */
function arrowHead(px: number, py: number, direction: 1 | -1, colour: string): string {
  const w = 3.2;
  const h = 6;
  const tipY = py;
  const baseY = py + direction * h;
  return `<polygon points="${px.toFixed(1)},${tipY.toFixed(1)} ` +
    `${(px - w).toFixed(1)},${baseY.toFixed(1)} ${(px + w).toFixed(1)},${baseY.toFixed(1)}" ` +
    `fill="${colour}"/>`;
}

/** The same arrowhead lying down: pointing right (+1) or left (-1). */
function arrowHeadH(px: number, py: number, direction: 1 | -1, colour: string): string {
  const w = 3.2;
  const h = 6;
  const baseX = px + direction * h;
  return `<polygon points="${px.toFixed(1)},${py.toFixed(1)} ` +
    `${baseX.toFixed(1)},${(py - w).toFixed(1)} ${baseX.toFixed(1)},${(py + w).toFixed(1)}" ` +
    `fill="${colour}"/>`;
}

/**
 * Expand the footer macros the spec defines.
 *
 * `[page]` and `[of]` resolve to "?" for a single unpaginated SVG, as
 * the spec requires -- the renderer has no pagination to report, and
 * inventing "1 / 1" would be a claim it cannot make.
 */
function expandMacros(text: string, study: Study): string {
  return text.replace(/\[([\w.]+)\]/g, (match, key: string) => {
    if (key === 'date') return new Date().toISOString().slice(0, 10);
    /* Spec: pagination macros resolve to "?" for a single SVG, which
     * has no pagination to report. The PDF exporter paginates. */
    if (key === 'page' || key === 'of') return '?';
    if (key.startsWith('meta.')) {
      const value = study.meta[key.slice(5)];
      return value == null ? match : String(value);
    }
    return match;
  });
}

/**
 * Should this sub-decade tick carry a label?
 *
 * Only the 2x and 5x intervals. Labelling all of 2..9 crowds a
 * log axis to the point of illegibility, while labelling none forces
 * the reader to interpolate by eye across a decade -- which on a
 * logarithmic scale they will get wrong. Two per decade is the
 * conventional compromise on a published TCC.
 */
function isLabelledInterval(value: number): boolean {
  const exponent = Math.floor(Math.log10(value));
  const mantissa = value / Math.pow(10, exponent);
  return Math.abs(mantissa - 2) < 1e-6 || Math.abs(mantissa - 5) < 1e-6;
}

/** `(current, time)` as it is written on a chart. */
function coordText(I_A: number, t_s: number): string {
  return `${formatSi(I_A, 'A')}, ${formatSi(t_s, 's')}`;
}
