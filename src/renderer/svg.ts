/**
 * SVG composer.
 *
 * Produces a self-contained `<svg>` for a parsed `.tc` document.
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
  SystemBlock,
  ViewBlock,
} from '../parser/ast.js';
import { LogScale } from './scale.js';
import { ticks, formatSi } from './ticks.js';
import { paletteFor, paletteFromList, strokeDashFor, type Palette } from './palette.js';
import { measuredQuantityOf, quantityLabel } from '../semantics/quantity.js';
import { theme as loadTheme, type ThemeName } from './theme.js';
import { buildStudy, allElements, resolveRef, type Annotation, type Device, type Element, type Stage, type Study } from '../semantics/model.js';
import { tTripStage } from '../semantics/curves.js';
import { tTripElement } from '../semantics/stages.js';
import { tTripCombine } from '../semantics/combine.js';
import { tTripFlex } from '../semantics/curves.js';
import { faultCurrentAt } from '../semantics/xvoltage.js';

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

interface CurveEntry {
  label: string;
  color: string;
  pathD: string;
  pickupPx: number;       // in the view frame
  /** Legend body, one entry per rendered line. */
  detailLines: string[];
  voltage?: string;
  voltage_kV?: number;    // <<< the relay's own nominal voltage -- useful for the hover overlay
  opAt?: { I_A: number; t_s: number };
  /** Explicit stroke-dasharray, for combines and repeated hues. */
  dashArray?: string;
  /** Synthetic `combine` curves may ask for a dashed stroke. */
  dashed?: boolean;
  /** True for a fuse band, whose legend swatch is a hatched block. */
  band?: boolean;
}

interface FaultEntry {
  name: string;
  /** Author's note on what the fault is; shown under the legend entry. */
  description?: string;
  I_A: number;            // original fault current, declared voltage
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

  const currentAxisTitle =
    axisMode === 'secondary' && referenceCt
      ? `Current (A secondary, CT ${trimZeros(referenceCt)}:1 · ${viewLabel})`
      : `Current (A primary · ${viewLabel})`;

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

  const faults: FaultEntry[] = [];
  for (const item of doc.items) {
    if (item.type === 'faults') {
      const fb = item as FaultsBlock;
      for (const f of fb.faults) {
        if (!Number.isFinite(f.I_A)) continue;
        const V_fault = f.voltage ? voltageKvs.get(f.voltage) : undefined;
        const I_view = V_fault && V_view_kV ? f.I_A * (V_fault / V_view_kV) : f.I_A;
        if (I_view * 0.8 < I_lo) I_lo = I_view * 0.8;
        if (I_view * 1.5 > I_hi) I_hi = I_view * 1.5;
        faults.push({
          name: f.name,
          description: f.description,
          I_A: f.I_A,
          voltage: f.voltage,
          voltage_kV: V_fault,
          voltageLabel: f.voltage ? `${f.voltage} · ${voltageKvs.get(f.voltage) ?? '?'} kV` : undefined,
          I_view,
        });
      }
    }
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
  const titleBlockH = bordered ? 54 : 0;

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

  const pageTitle = opts.page?.title;
  const titleText = typeof pageTitle === 'string' ? pageTitle : pageTitle?.text;
  const subtitleText = typeof pageTitle === 'string' ? undefined : pageTitle?.subtitle;

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
    (opts.page?.title ? 52 : 32) + (mirrorAxes ? 22 : 0) + headingExtra + sheetInset;
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
  );
  const faultRows = faultLayout.reduce((n, f) => Math.max(n, f.row + 1), 0);

  const faultBandH = faultRows > 0 ? 44 + (faultRows - 1) * (LINE_DETAIL - 1) + 6 : 26;
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

  const samples = sampleLog(I_min, I_max, 200);

  /**
   * Trace one time-current characteristic across the plotted domain.
   *
   * `tAt` is given the current in the *source's own* voltage frame,
   * while the path is drawn against the view frame -- so a study
   * spanning a transformer compares curves on one axis without any
   * caller having to pre-convert.
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
  ): string => {
    const xs = [...samples];
    for (const bp of breakpoints) {
      if (!(bp > 0) || bp < I_min || bp > I_max) continue;
      xs.push(bp * (1 - 1e-9), bp);
    }
    xs.sort((a, b) => a - b);

    const parts: string[] = [];
    let started = false;
    let previousOperated = false;

    for (const I_view of xs) {
      /* Invert the projection to ask the curve about its own frame. */
      const I_source =
        V_view_kV != null && V_source != null && V_source > 0 && V_view_kV > 0
          ? I_view * (V_view_kV / V_source)
          : I_view;
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
  ): { d: string; reversed: string[] } | null => {
    const pts: string[] = [];
    for (const point of points) {
      const px = xScale.toPx(point.I_A);
      const py = yScale.toPx(point.t_s);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      pts.push(`${px.toFixed(1)} ${py.toFixed(1)}`);
    }
    if (pts.length < 2) return null;
    return { d: `M${pts.join(' L')}`, reversed: [...pts].reverse() };
  };

  /** Legend body for a device. */
  const deviceDetailLines = (device: Device): string[] => {
    const lines: string[] = [];
    const identity = [device.maker, device.model].filter(Boolean).join(' ');
    if (identity) lines.push(identity);

    const bits: string[] = [];
    if (device.kind) bits.push(DEVICE_KIND_LABEL[device.kind] ?? device.kind);
    if (device.rating_A != null) bits.push(formatSi(device.rating_A, 'A'));
    if (device.t_delay_s != null) bits.push(`clearing ${formatSi(device.t_delay_s, 's')}`);
    if (bits.length) lines.push(bits.join(' \u00b7 '));

    if (device.min_melt && device.total_clear) {
      /*
       * ASCII arrow deliberately: U+2192 is outside the PDF core
       * fonts' WinAnsi encoding and comes out as mojibake on the
       * printed sheet.
       */
      lines.push('min melt -> total clear');
    }
    return lines.filter(Boolean);
  };

  /**
   * Current an annotation refers to, in the referenced device's own
   * frame. A named `fault` is projected onto that level; a bare
   * `at_I_A` is taken as already being in it.
   */
  const annotationCurrent = (
    _study: Study,
    annotation: Annotation,
    voltage: string | undefined,
  ): number | null => {
    if (annotation.fault) {
      const fault = study.faults.get(annotation.fault);
      if (!fault) return null;
      return faultCurrentAt(study, fault, voltage, 'I').I_A;
    }
    return Number.isFinite(annotation.at_I_A) ? annotation.at_I_A! : null;
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
  const breakpointsOf = (element: Element): number[] =>
    element.stages
      .filter((s) => s.I_pu_A != null && Number.isFinite(s.I_pu_A))
      .map((s) => project(s.I_pu_A!, element.voltage_kV));

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
    if (axisMode !== 'secondary' || !element.ct_ratio) return primaryA;
    const secondary = stage.I_pu_A / element.ct_ratio;
    return `${primaryA} (${trimZeros(secondary)} A sec)`;
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
      bits.push(`TMS ${trimZeros(stage.tms)}${stage.tms_auto ? ' (auto)' : ''}`);
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

    return bits.join(' \u00b7 ');
  };

  /**
   * Legend body for an element, as *separate lines*.
   *
   * A multi-stage element used to be flattened onto one line joined by
   * pipes, which ran together and overflowed the legend column. One
   * line per stage is both readable and naturally width-bounded.
   */
  const elementDetailLines = (element: Element): string[] => {
    const lines: string[] = [];

    const identity = [element.maker, element.model].filter(Boolean).join(' ');
    if (identity) lines.push(identity);

    if (element.stages.length === 1) {
      lines.push(stageDetail(element.stages[0], element));
    } else {
      for (const stage of element.stages) {
        lines.push(`${stage.id}: ${stageDetail(stage, element)}`);
      }
    }

    if (element.voltage) {
      lines.push(element.voltage_kV != null
        ? `${element.voltage} \u00b7 ${trimZeros(element.voltage_kV)} kV`
        : element.voltage);
    }
    return lines.filter(Boolean);
  };

  const pickupPxOf = (element: Element): number => {
    /* The lowest pickup is where the composite curve starts. */
    let lowest = Infinity;
    for (const stage of element.stages) {
      if (stage.I_pu_A != null && Number.isFinite(stage.I_pu_A) && stage.I_pu_A < lowest) {
        lowest = stage.I_pu_A;
      }
    }
    if (!Number.isFinite(lowest)) return NaN;
    return xScale.toPx(project(lowest, element.voltage_kV));
  };

  /*
   * Spec _Stages and composite curves_: one curve per element by
   * default; `view { stages = "individual"; }` splits them apart.
   */
  const individual = view?.stages === 'individual';

  for (const element of allElements(study)) {
    const { color, dash } = pickStyle();
    const V_source = element.voltage_kV;

    if (individual && element.stages.length > 1) {
      for (const stage of element.stages) {
        const pathD = trace(
          V_source,
          (I) => tTripStage(stage, I),
          stage.I_pu_A != null ? [project(stage.I_pu_A, V_source)] : [],
        );
        if (!pathD) continue;
        curves.push({
          label: `${element.label}/${stage.id}`,
          color,
          pathD,
          pickupPx: stage.I_pu_A != null ? xScale.toPx(project(stage.I_pu_A, V_source)) : NaN,
          detailLines: [
            [element.maker, element.model].filter(Boolean).join(' '),
            stageDetail(stage, element),
          ].filter(Boolean),
          dashArray: dash,
          voltage: element.voltage,
          voltage_kV: V_source,
        });
      }
      continue;
    }

    const pathD = trace(V_source, (I) => tTripElement(element, I), breakpointsOf(element));
    if (!pathD) continue;
    curves.push({
      label: element.label,
      color,
      pathD,
      pickupPx: pickupPxOf(element),
      detailLines: elementDetailLines(element),
      voltage: element.voltage,
      voltage_kV: V_source,
      dashArray: dash,
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
      const lower = flexPath(device.min_melt);
      const upper = flexPath(device.total_clear);
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
      pathD = flexPath(points)?.d ?? '';
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
      detailLines: [`Combine · ${combine.as}`],
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
      out.push(`<text x="${px}" y="${topMargin + plotH + 20}" text-anchor="middle" class="tc-current-axis" fill="${th.label}" font-weight="600" font-size="${FONT_AXIS}">${escapeXml(axisTickLabel(t.value))}</text>`);
    } else if (isLabelledInterval(t.value)) {
      /* 2x and 5x of each decade: enough to read an intermediate
       * value off the chart without crowding the axis. */
      out.push(`<text x="${px}" y="${topMargin + plotH + 20}" text-anchor="middle" fill="${th.label}" fill-opacity="0.7" font-size="${FONT_AXIS - 2}">${escapeXml(axisTickLabel(t.value))}</text>`);
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
      `data-fault="${escapeXml(f.name)}" data-current="${I}" ` +
      `stroke="${faultColour}" stroke-opacity="0.7" stroke-width="${faultWidth}"` +
      `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
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
    /* `page { curves { line_width_px } }` sets the data-line weight. */
    const baseWidth = opts.page?.curves?.line_width_px ?? 2;
    const sw = isHl ? String(baseWidth * 1.6) : String(baseWidth);
    const dashValue = c.dashArray ?? (c.dashed ? '6 4' : undefined);
    const dash = dashValue ? ` stroke-dasharray="${dashValue}"` : '';
    out.push(`<path d="${c.pathD}" class="${cls}" fill="none" stroke-linejoin="round" stroke-linecap="round" stroke="${c.color}" stroke-width="${sw}"${dash} data-curve="${escapeXml(c.label)}" data-voltage="${escapeXml(c.voltage ?? '')}"/>`);
  }

  /*
   * Direct labels, drawn here rather than with the legend so that the
   * marked points and margin annotations that follow paint *over*
   * them. A boxed name covering a CTI figure hides the study's
   * conclusion; the reverse costs only part of a name that is still
   * traceable by colour.
   */
  if (legendMode === 'direct') {
    out.push(...directLabels(curves, {
      leftMargin, topMargin, plotW, plotH, background: th.background, ink: th.foreground,
    }));
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

  for (const point of study.points) {
    if (!(point.I_A > 0) || !(point.t_s > 0)) continue;
    const I_view = project(point.I_A, point.voltage_kV);
    const px = xScale.toPx(I_view);
    const py = yScale.toPx(point.t_s);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

    const onPlot =
      I_view >= I_min && I_view <= I_max && point.t_s >= t_min && point.t_s <= t_max;
    if (onPlot) pointsOnPlot.add(point.id);

    const colour = point.color ?? th.fault;
    out.push(
      `<g class="tc-point" data-point="${escapeXml(oneLine(point.label ?? point.id))}" ` +
      `data-current="${I_view}" data-time="${point.t_s}" ` +
      `data-px="${px.toFixed(1)}" data-py="${py.toFixed(1)}">`,
    );
    out.push(pointMarker(point.shape ?? 'cross', px, py, colour));

    const base = point.label ?? point.id;
    const text = point.coords ? `${base} (${coordText(I_view, point.t_s)})` : base;
    if (text) {
      /* Flip the label to the left of the marker when a right-hand
       * one would run past the plot and under the legend -- which a
       * portrait sheet, with less width to spare, does readily. */
      const labelWidth = labelWidthPx(text, FONT_DETAIL);
      const fitsRight = px + 10 + labelWidth < leftMargin + plotW;
      const lx = px + (fitsRight ? 10 : -10);
      out.push(
        `<text x="${lx.toFixed(1)}" y="${(py + 4).toFixed(1)}" ` +
        `text-anchor="${fitsRight ? 'start' : 'end'}" ` +
        `font-size="${FONT_DETAIL}" fill="${colour}">` +
        `${labelBody(text, lx, FONT_DETAIL)}</text>`,
      );
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
  for (const annotation of study.annotations) {
    const colour = annotation.color ?? th.foreground;

    if (annotation.kind === 'margin') {
      const primary = resolveRef(study, annotation.primary);
      const backup = resolveRef(study, annotation.backup);

      /*
       * Each side is evaluated at the current *it* measures, exactly as
       * `grades.ts` does. Projecting the fault onto the primary's level
       * and evaluating both sides there would divide an LV current by
       * an HV pick-up and report a margin that does not exist -- the
       * annotation would then contradict the margin report for the
       * same pair and fault.
       */
      const I = annotationCurrent(study, annotation, primary.element?.voltage);
      const I_backup = annotationCurrent(study, annotation, backup.element?.voltage);
      if (I == null || I_backup == null) continue;

      const tP = sideTime(primary, I, 'primary');
      const tB = sideTime(backup, I_backup, 'backup');
      if (!Number.isFinite(tP) || !Number.isFinite(tB)) continue;

      const I_view = project(I, primary.element?.voltage_kV);
      const px = xScale.toPx(I_view);
      const pyP = yScale.toPx(tP);
      const pyB = yScale.toPx(tB);
      if (![px, pyP, pyB].every(Number.isFinite)) continue;

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

      const midY = (pyP + pyB) / 2;
      /*
       * Flipped on the same rule as the point labels: a margin drawn at
       * the right-hand fault of a study has little room left before the
       * legend, and the number is the whole point of the annotation.
       */
      const marginWidth = labelWidthPx(text, FONT_DETAIL);
      const marginRight = px + 10 + marginWidth < leftMargin + plotW;
      const mx = px + (marginRight ? 10 : -10);
      out.push(
        `<text x="${mx.toFixed(1)}" y="${(midY + 4).toFixed(1)}" ` +
        `text-anchor="${marginRight ? 'start' : 'end'}" ` +
        `font-size="${FONT_DETAIL}" font-weight="600" fill="${colour}">` +
        `${labelBody(text, mx, FONT_DETAIL)}</text>`,
      );
      continue;
    }

    /* Point form: mark one curve at one current. */
    const { element, device } = resolveRef(study, annotation.on_curve);
    const I = annotationCurrent(study, annotation, element?.voltage);
    if (I == null) continue;
    const t = element
      ? tTripElement(element, I)
      : device
        ? deviceTime(device, I)
        : Infinity;
    if (!Number.isFinite(t)) continue;

    const I_view = project(I, element?.voltage_kV);
    const px = xScale.toPx(I_view);
    const py = yScale.toPx(t);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

    const base = annotation.label ?? annotation.on_curve?.text ?? '';
    const text = annotation.coords ? `${base} (${coordText(I_view, t)})` : base;

    if (annotation.style !== 'tag') {
      out.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="${colour}"/>`);
    }
    if (annotation.style === 'leader') {
      /*
       * Leader up and away from the curve, flipping to the left when a
       * right-hand label would run past the plot and under the legend.
       */
      const labelWidth = labelWidthPx(text, FONT_DETAIL);
      const wantRight = px + 26 + 12 + 16 + labelWidth < leftMargin + plotW;
      const dir = wantRight ? 1 : -1;

      const lx = px + dir * 26;
      /*
       * A leader points *away* from its curve, so extra lines have to
       * grow upwards; anchoring the block's middle would push the
       * lower line back down onto the point being annotated.
       */
      const ly = py - 22 - labelExtraHeightPx(text, FONT_DETAIL);
      const elbow = lx + dir * 12;
      out.push(
        `<path d="M${px.toFixed(1)} ${py.toFixed(1)} L${lx.toFixed(1)} ${ly.toFixed(1)} ` +
        `L${elbow.toFixed(1)} ${ly.toFixed(1)}" fill="none" stroke="${colour}" stroke-width="1"/>`,
      );
      const tx = elbow + dir * 4;
      out.push(
        `<text x="${tx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" ` +
        `text-anchor="${wantRight ? 'start' : 'end'}" ` +
        `font-size="${FONT_DETAIL}" fill="${colour}">` +
        `${labelBody(text, tx, FONT_DETAIL, 'first')}</text>`,
      );
    } else if (annotation.style === 'tag') {
      const labelWidth = labelWidthPx(text, FONT_DETAIL);
      const fitsRight = px + 6 + labelWidth < leftMargin + plotW;
      const tx = px + (fitsRight ? 6 : -6);
      /* Tags sit above their point, so they too grow upwards. */
      const ty = py - 6 - labelExtraHeightPx(text, FONT_DETAIL);
      out.push(
        `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" ` +
        `text-anchor="${fitsRight ? 'start' : 'end'}" ` +
        `font-size="${FONT_DETAIL}" fill="${colour}">` +
        `${labelBody(text, tx, FONT_DETAIL, 'first')}</text>`,
      );
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
  const faultBandY = topMargin + plotH + 44;

  /* Rows were packed before the vertical margins were settled, so the
   * band below the axis could be sized to them. */
  for (const { f, i, px, row, flipped } of faultLayout) {
    const labelY = faultBandY + row * (LINE_DETAIL - 1);
    const dash = faultDash(i);
    out.push(
      `<line x1="${px}" y1="${topMargin + plotH}" x2="${px}" y2="${(labelY - 9).toFixed(1)}" ` +
      `class="tc-fault" stroke="${faultColour}" stroke-opacity="0.7" stroke-width="${faultWidth}"` +
      `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
    );
    out.push(
      `<text x="${(px + (flipped ? -4 : 4)).toFixed(1)}" y="${labelY.toFixed(1)}" ` +
      `text-anchor="${flipped ? 'end' : 'start'}" ` +
      `class="tc-fault-label" fill="${faultColour}" font-weight="600" font-size="${FONT_DETAIL}">` +
      `${escapeXml(f.name)}</text>`,
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

    for (const c of curves) {
      /* Out of room: count what is left and say so at the end. */
      if (cursorY - originY > budget) { dropped++; continue; }

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
        lines.push(
          `<line x1="${originX}" y1="${swatchY}" x2="${originX + swatchW}" y2="${swatchY}" ` +
          `stroke="${c.color}" stroke-width="2.5"` +
          `${(c.dashArray ?? (c.dashed ? '6 4' : '')) ? ` stroke-dasharray="${c.dashArray ?? '6 4'}"` : ''}` +
          ` stroke-linecap="round"/>`,
        );
      }
      /* Wrapped like the detail lines beneath it: a declared `name`
       * is free text and routinely outruns the column. */
      for (const wrapped of wrapText(oneLine(c.label), textWidth, FONT_LABEL)) {
        lines.push(
          `<text x="${textX}" y="${cursorY}" class="tc-legend" fill="${th.foreground}" font-size="${FONT_LABEL}" font-weight="600">` +
          `${escapeXml(wrapped)}</text>`,
        );
        cursorY += LINE_LABEL;
      }

      /* `compact` keeps the settings line -- which is the one an
       * engineer checks -- and drops the make and model above it. */
      const detail = showDetail ? c.detailLines
        : showSomeDetail ? c.detailLines.slice(-1)
          : [];
      for (const line of detail) {
        for (const wrapped of wrapText(line, textWidth, FONT_DETAIL)) {
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
    const legendPoints = study.points.filter((p) => !pointsOnPlot.has(p.id));
    if (legendPoints.length > 0) {
      lines.push(
        `<text x="${originX}" y="${cursorY}" font-size="${FONT_HEADING}" font-weight="600" fill="${legendInk}">Points</text>`,
      );
      cursorY += LINE_HEADING;

      for (const point of legendPoints) {
        const colour = point.color ?? th.fault;
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

    /* Faults. */
    if (faults.length > 0) {
      /* Wrapped up front: a long fault name plus its current and
       * voltage runs past the column, and the block has to be
       * anchored by the height it will actually take. */
      const faultText = faults.map((f) => {
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
        return wrapText(
          `${f.name} · ${formatSi(f.I_A, 'A')}${where}`,
          textWidth,
          FONT_DETAIL,
        );
      });

      /*
       * The projection onto the plotted axis goes on its own muted
       * line. Appended inline it pushed the entry over the column
       * width and broke it mid-figure -- "... 11 kV ->" then a bare
       * "2.13 kA" on the next line, which reads as a separate value.
       */
      const faultProjection = faults.map((f) =>
        f.I_view != null && Math.abs(f.I_view - f.I_A) > f.I_A * 1e-6
          ? wrapText(`-> ${formatSi(f.I_view, 'A')} on axis`, textWidth, FONT_DETAIL - 1)
          : []);
      /* `description` is the author's note on what the fault *is*;
       * it belongs with the entry rather than being parsed and
       * dropped, which is what used to happen to it. */
      const faultNotes = faults.map((f) =>
        showDetail && f.description
          ? wrapText(oneLine(f.description), textWidth, FONT_DETAIL - 1)
          : []);

      const faultLineCount = faultText.reduce((n, l) => n + l.length, 0)
        + faultProjection.reduce((n, l) => n + l.length, 0)
        + faultNotes.reduce((n, l) => n + l.length, 0);

      let faultsY = cursorY + FONT_HEADING;
      if (anchorFaultsToPlotBottom) {
        const wanted = topMargin + plotH - (faultLineCount * LINE_LABEL) - LINE_HEADING + FONT_HEADING;
        faultsY = Math.max(wanted, cursorY + 12);
      }

      lines.push(
        `<text x="${originX}" y="${faultsY}" font-size="${FONT_HEADING}" font-weight="600" fill="${faultColour}">Faults</text>`,
      );
      faultsY += LINE_HEADING;

      for (const i of faults.keys()) {
        const swatchY = faultsY - FONT_LABEL / 3;
        const dash = faultDash(i);
        lines.push(
          `<line x1="${originX}" y1="${swatchY}" x2="${originX + swatchW}" y2="${swatchY}" ` +
          `stroke="${faultColour}" stroke-width="${Math.max(faultWidth, 1.5)}"` +
          `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
        );
        for (const wrapped of faultText[i]) {
          lines.push(
            `<text x="${textX}" y="${faultsY}" class="tc-legend" fill="${th.foreground}" font-size="${FONT_DETAIL}">` +
            `${escapeXml(wrapped)}</text>`,
          );
          faultsY += LINE_LABEL;
        }
        for (const wrapped of faultProjection[i]) {
          lines.push(
            `<text x="${textX}" y="${faultsY}" class="tc-legend-muted" fill="${th.label}" ` +
            `font-size="${FONT_DETAIL - 1}">${escapeXml(wrapped)}</text>`,
          );
          faultsY += LINE_DETAIL - 2;
        }
        for (const wrapped of faultNotes[i]) {
          lines.push(
            `<text x="${textX}" y="${faultsY}" class="tc-legend-muted" fill="${th.label}" ` +
            `font-size="${FONT_DETAIL - 1}">${escapeXml(wrapped)}</text>`,
          );
          faultsY += LINE_DETAIL - 2;
        }
      }
      cursorY = faultsY;
    }

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
    out.push(...fitLegend(legX, topMargin, legendWidth, true, columnBudget).lines);
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
    const width = f.name.length * FONT_DETAIL * CHAR_ADVANCE + 10;
    const flipped = px + width > plotRight;
    const left = flipped ? px - width : px;
    const right = left + width;

    /* First row this label's span does not collide with. */
    let row = 0;
    while (taken.some((p) => p.row === row && p.right > left && p.left < right)) row++;
    taken.push({ left, right, row });
    placed.push({ f, i, px, row, flipped });
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
function directLabels(curves: CurveEntry[], geo: DirectLabelGeometry): string[] {
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
  if (placed.length === 0) return [];

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
  }
  return out;
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
): string {
  const r = 5;
  const stroke = `stroke="${colour}" stroke-width="1.8" fill="none"`;
  const filled = `fill="${colour}" stroke="none"`;

  switch (shape) {
    case 'circle':
      return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r}" ${filled}/>`;
    case 'square':
      return `<rect x="${(px - r).toFixed(1)}" y="${(py - r).toFixed(1)}" ` +
        `width="${r * 2}" height="${r * 2}" ${filled}/>`;
    case 'diamond':
      return `<polygon points="${px},${py - r} ${px + r},${py} ${px},${py + r} ${px - r},${py}" ${filled}/>`;
    case 'triangle':
      return `<polygon points="${px},${py - r} ${px + r},${py + r} ${px - r},${py + r}" ${filled}/>`;
    case 'x':
      return `<path d="M${px - r} ${py - r} L${px + r} ${py + r} M${px + r} ${py - r} L${px - r} ${py + r}" ${stroke}/>`;
    case 'cross':
    default:
      return `<path d="M${px - r} ${py} L${px + r} ${py} M${px} ${py - r} L${px} ${py + r}" ${stroke}/>`;
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
