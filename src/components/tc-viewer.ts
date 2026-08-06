/**
 * <tc-viewer> — interactive SVG renderer host.
 *
 * v0.1.x features beyond a static plot:
 *   - **Mouse snap**: as the cursor moves over the plot area, find the
 *     closest point on the nearest curve and show a readout box with
 *     `(I, t, voltage, curve label)`.
 *   - **Crosshair**: thin red crosshair lines follow the cursor
 *     when hovering above a curve (within `SNAP_RADIUS_PX`).
 *   - **Wheel zoom**: ctrl-wheel / mouse-wheel changes the displayed
 *     current-domain (current_min / current_max). Auto-rescale
 *     re-computes the view if the user shrinks the window past the
 *     data. The wheel gesture *around* the cursor's data point keeps
 *     that data point under the cursor (standard zoom UX).
 *   - **Middle-drag pan**: holding the middle button and dragging
 *     translates the current domain in log space.
 *   - **Reset button**: restore the original view block's bounds.
 *
 * No D3. Snap math uses point-to-segment distance against each path's
 * polyline.
 */

import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { Document, ParseError } from '../parser/index.js';
import { renderSvg, type RenderOptions } from '../renderer/index.js';
import type { ThemeName } from '../renderer/theme.js';
import type { Study } from '../semantics/model.js';
import { exportPdf } from '../export/export-pdf.js';
import { sheetSize } from '../renderer/sheet.js';

/*
 * Snap radius. Tight enough that the readout tracks the curve the
 * pointer is actually near, rather than grabbing a neighbour several
 * pixels away. Halved from 24: on a sheet with several curves in a
 * band, a radius that wide latched onto whichever was nearest rather
 * than the one being pointed at.
 */
const SNAP_RADIUS_PX = 12;

/**
 * How close two things must be to count as being in the same place.
 *
 * Judged on position, not on distance from the cursor: two curves
 * equidistant either side of the pointer are two answers, not one
 * coincidence.
 */
const COINCIDENT_PX = 3;
const ZOOM_STEP = 1.25;

/**
 * A screen position in the SVG's own user units.
 *
 * Everything the pointer does -- snapping to a curve, anchoring a zoom,
 * dragging a pan -- is computed against coordinates the renderer wrote,
 * so the conversion has to be exact.
 *
 * It was being done by hand as `(clientX - rect.left) * viewBox.width /
 * rect.width`, which is only correct when the element and the viewBox
 * have the same aspect ratio. They generally do not: the drawing has a
 * fixed shape and the pane is whatever shape the window and the
 * splitter leave it, and with no `preserveAspectRatio` the default
 * `xMidYMid meet` letterboxes the content -- scaling both axes by the
 * *smaller* factor and centring the result. Two independent scales and
 * no offset then put the cursor further and further from the truth the
 * further it is from the middle of the sheet: on a 1702 x 954 pane
 * holding a 1500 x 1000 drawing the error reached 128 user units at the
 * edges, about 145 screen pixels, which is six times the snap radius.
 * Hiding the source pane makes the pane wider and the mismatch worse,
 * which is how it was noticed.
 *
 * `getScreenCTM` is the transform the browser actually used, so it
 * carries the viewBox, the letterboxing and any CSS transform above the
 * element. The manual arithmetic is kept only for the case where there
 * is no CTM at all -- a detached or display:none element -- where the
 * answer is unused anyway.
 */
function toUserSpace(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (ctm) {
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }

  const rect = svg.getBoundingClientRect();
  const vbW = svg.viewBox.baseVal.width || rect.width;
  const vbH = svg.viewBox.baseVal.height || rect.height;
  return {
    x: rect.width ? (clientX - rect.left) * (vbW / rect.width) : 0,
    y: rect.height ? (clientY - rect.top) * (vbH / rect.height) : 0,
  };
}

interface SnapState {
  pxI: number;
  pxT: number;
  I_A: number;
  t_s: number;
  curveLabel: string;
  /**
   * The identifier a `grade` or `annotate` block would name -- the
   * relay reference for a curve, the declared name for a fault or a
   * marked point.
   *
   * Shown beneath the label whenever the two differ, which they do
   * whenever a relay or element declares a `name`. Someone building a
   * file has the curve in front of them and needs to know what to
   * type; the drawing's own words for it are no help.
   */
  ref?: string;
  /**
   * Other curves whose nearest point is the same spot.
   *
   * Curves coincide often -- two feeders set identically, a composite
   * and the stage that forms it, an element that appears on two sheets
   * -- and reporting only the first one found gave an arbitrary answer
   * with an authoritative look. Naming all of them is the honest
   * reading of "what is under the cursor".
   */
  alsoHere?: Array<{ curveLabel: string; ref?: string; voltage: string }>;
  voltage: string;
  protocol: 'snap' | 'free';
  /** polyline SVG path string */
  pathD: string;
  /**
   * What the cursor latched onto. Curves report a time at a current;
   * a fault marker reports its declared current; a marked point
   * reports the coordinate it asserts.
   */
  target?: 'curve' | 'fault' | 'point' | 'time';
  /**
   * Which form declared a condition rule: a `fault` is one current at
   * one level, a `scenario` the same condition at every level. The
   * readout says which, since "fault level" is wrong for a scenario.
   */
  conditionKind?: 'fault' | 'scenario';
}

@customElement('tc-viewer')
export class TcViewer extends LitElement {
  @property({ attribute: false }) document: Document | undefined;
  /**
   * Resolved study from the app. Carries any settings the solver
   * computed, so passing it through is what makes an auto-solved
   * `tms` appear on the plot rather than the value in the source.
   */
  @property({ attribute: false }) study: Study | undefined;
  /**
   * UI theme for the plot. On screen the theme is a viewing
   * preference, so it overrides the source's `page { theme = ... }`;
   * exports still honour the page block.
   */
  @property({ type: String }) theme: ThemeName = 'light';
  @property({ type: Array }) errors: ParseError[] = [];
  /**
   * How many error-severity findings the study has, from both the
   * parser and the validator.
   *
   * The viewer used to be handed parse errors only, so a study with
   * nine semantic errors drew a clean-looking sheet -- at a thousand
   * times and a thousandth of the intended settings, in the case that
   * found this -- with every export button live and nothing on the
   * face of it to say so. The CLI has refused to write that file since
   * the beginning. The two surfaces now apply one policy.
   */
  @property({ type: Number }) errorCount = 0;
  /**
   * Which declared `view` to draw, by index.
   *
   * A study may declare several sheets; the app's picker selects one.
   * Clamped on use, so an index left over from a previous study cannot
   * blank the plot.
   */
  @property({ type: Number }) viewIndex = 0;
  @property({ type: Number }) width = 1500;
  @property({ type: Number }) height = 1000;

  /** Live hover state */
  @state() private hover: SnapState | null = null;
  /** Whether the controls popover is open. */
  @state() private showHelp = false;
  /** Export in flight, for button feedback. */
  @state() private exporting: 'pdf' | null = null;
  /** Last export failure, surfaced rather than swallowed. */
  @state() private exportError: string | null = null;
  /** zoom-resolved current domain (overrides view block clamps); null = use parsed view block */
  @state() private currentMin: number | null = null;
  @state() private currentMax: number | null = null;
  /**
   * The declared view bounds last seen, so an edit to them can be
   * told apart from a re-render.
   */
  private declaredBounds: string | null = null;

  /** True once a ResizeObserver has measured the host element so we
   * know what (W, H) to render at. Until then the view uses the
   * initial fallback dims (1500x1000). */
  @state() private measured = false;
  /** Live pane size, after measurement. */
  @state() private measuredW = 1500;
  @state() private measuredH = 1000;

  /**
   * How large the drawing is shown, independent of the axes.
   *
   * The plot used to be laid out to the pane and stretched to fill it,
   * so on a phone a 640 px sheet was squeezed into 390 and every
   * label rendered at 61% -- 11 px legend text arriving as under seven
   * physical pixels. Pinch made it no better: it zooms the *domain*,
   * re-laying the sheet out at the same size over a narrower range, so
   * no gesture existed that made the drawing bigger.
   *
   * This is that gesture. It scales the rendered sheet and lets the
   * pane scroll, the way any document viewer behaves, and leaves the
   * axes alone.
   */
  @state() private displayScale = 1;

  /** True once the reader has set a scale, so `fit` stops overriding. */

  @query('div.pane-host') private paneEl?: HTMLDivElement;
  /** Cached reference to the rendered SVG element so we can pull the
   * embedded <desc data-plot="..."> from it and inject the crosshair
   * overlay group directly without re-running render(). */
  private svgEl: SVGSVGElement | null = null;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: #fff;
      position: relative;
      overflow: hidden;
    }
    .empty {
      padding: 24px;
      color: var(--tc-fg-muted);
      font-family: var(--tc-font);
    }
    .diagnostics {
      background: var(--tc-bg-elevated);
      color: var(--tc-fg);
      padding: 8px 12px;
      border-radius: 4px;
      margin: 0;
      font-family: var(--tc-font);
      font-size: 12px;
      max-height: 33%;
      overflow: auto;
    }
    .diagnostics li.error   { color: var(--tc-error);   }
    .diagnostics li.warning { color: var(--tc-warning); }

    svg { width: 100%; height: 100%; display: block; cursor: crosshair; }
    .pane-host {
      flex: 1 1 0;
      min-height: 0;
      width: 100%;
      /*
       * Scrolls rather than clipping, because the drawing may now be
       * larger than the pane -- which on a phone it always is, and
       * which is the point: a sheet shown at a readable size and
       * panned is worth more than one shrunk to fit and unreadable.
       */
      overflow: auto;
      position: relative;
      overscroll-behavior: contain;
    }
    /*
     * The drawing at its chosen size. The SVG fills this box, so the
     * scale is applied once here rather than being threaded through
     * every coordinate the renderer emits.
     */
    .sheet {
      position: relative;
      flex: none;
    }
    .toolbar {
      display: flex;
      gap: 6px;
      padding: 4px 10px;
      height: 28px;
      flex: 0 0 28px;
      background: var(--tc-bg-elevated);
      border-bottom: 1px solid var(--tc-border);
      font-family: var(--tc-font);
      font-size: 11px;
      color: var(--tc-fg);
      align-items: center;
      overflow: hidden;
      white-space: nowrap;
    }
    .toolbar .dim-hint {
      color: var(--tc-fg-muted);
      font-size: 10px;
      margin-left: 4px;
    }
    .toolbar button {
      font-family: inherit;
      font-size: 11px;
      background: var(--tc-bg-sunken);
      color: var(--tc-fg);
      border: 1px solid var(--tc-border);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .toolbar button:hover { background: var(--tc-accent); color: var(--tc-accent-fg); }
    .toolbar .readout { margin-left: auto; color: var(--tc-fg-muted); }
  `;

  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  /* Bind the SVG size to the host pane so the plot fills the
   * available vertical height. ResizeObserver eats host size changes
   * (sidebar collapse, window resize). */
  private ro?: ResizeObserver;

  /**
   * Attach the observer the first time the pane exists.
   *
   * This used to be `firstUpdated`, which runs while the viewer is
   * still showing its empty state -- there is no pane yet, the guard
   * returned, and nothing ever tried again. The observer was
   * therefore *never* attached, and every sheet was laid out at the
   * hardcoded 1500x1000 default whatever size the pane actually was.
   * Running on each update instead means it attaches on the update
   * that first draws a plot.
   */
  protected updated(): void {
    this.observePane();
  }

  private observePane(): void {
    if (this.ro) return;
    const host = this.paneEl;
    if (!host || typeof ResizeObserver === 'undefined') return;
    this.ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      /*
       * A floor the layout can actually use.
       *
       * 640 was too small to *compose*, never mind to read: a legend
       * column is 330 px, so a 640 px sheet gave the plot itself under
       * 250. The sheet is drawn at a size a sheet needs and the pane
       * scrolls, rather than the drawing being folded to fit a phone.
       */
      const w = Math.max(960, Math.floor(r.width));
      const h = Math.max(620, Math.floor(r.height - 4));
      if (w !== this.measuredW || h !== this.measuredH) {
        this.measuredW = w;
        this.measuredH = h;
        this.measured = true;
      }
      /*
       * A narrow pane deliberately does *not* fit the sheet to it.
       *
       * Auto-fitting is what the old layout did in effect, and it is
       * the complaint: on a 390px screen the whole sheet fits at 0.3,
       * where 11px legend text renders at 3px and the drawing is a
       * smudge. Full size and scrolled is legible; `Fit` is one tap
       * away for a reader who wants the overview instead.
       */
    });
    this.ro.observe(host);
    this.measured = true;
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.endPan();
  }

  private handleMouseMove(ev: MouseEvent): void {
    /* A pan owns the pointer: snapping mid-drag would fight the drag. */
    if (this.pan?.active) {
      this.handlePanMove(ev);
      return;
    }

    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    // Find the closest path (curve) under the cursor.
    const paths = Array.from(svg.querySelectorAll('path.tc-curve')) as SVGPathElement[];
    if (paths.length === 0) { this.hover = null; return; }

    let best: SnapState | null = null;
    let bestDist = Infinity;
    const SNAP_SQ = SNAP_RADIUS_PX * SNAP_RADIUS_PX;

    const { x: cursorPxI, y: cursorPxT } = toUserSpace(svg, ev.clientX, ev.clientY);

    /* Plot rectangle, for deciding whether the pointer is over the
     * chart at all. */
    const geom = projectDomain(paths[0]);
    const plot = geom
      ? geom.scale
      : { xMin: 0, xMax: Infinity, yMin: 0, yMax: Infinity };

    /*
     * The closest point on *each* curve, kept separately.
     *
     * Curves routinely lie on top of one another -- two feeders with
     * identical settings, a composite and the stage that forms it, an
     * element drawn on two sheets -- and taking only the nearest named
     * whichever happened to be first in the document. Which is worse
     * than useless when the question is "what is here": the answer was
     * arbitrary, and looked authoritative.
     */
    const perCurve: Array<{ state: SnapState; distSq: number }> = [];

    for (const p of paths) {
      const points = navFromPath(p);
      const proj = projectDomain(p);
      if (!proj) continue;

      let nearest: { state: SnapState; distSq: number } | null = null;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[i + 1] ?? points[i];
        const dx = b.pxI - a.pxI;
        const dy = b.pxT - a.pxT;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0
          ? Math.max(0, Math.min(1, ((cursorPxI - a.pxI) * dx + (cursorPxT - a.pxT) * dy) / len2))
          : 0;
        const projX = a.pxI + t * dx;
        const projY = a.pxT + t * dy;
        const distSq = (cursorPxI - projX) ** 2 + (cursorPxT - projY) ** 2;
        if (nearest != null && distSq >= nearest.distSq) continue;

        const I_at_x = proj.domain.I_min * Math.pow(10, (projX - proj.scale.xMin) / (proj.scale.xMax - proj.scale.xMin) * (Math.log10(proj.domain.I_max) - Math.log10(proj.domain.I_min)));
        const t_at_y = proj.domain.t_max * Math.pow(10, -(projY - proj.scale.yMin) / (proj.scale.yMax - proj.scale.yMin) * (Math.log10(proj.domain.t_max) - Math.log10(proj.domain.t_min)));
        nearest = {
          distSq,
          state: {
            pxI: projX,
            pxT: projY,
            I_A: I_at_x,
            t_s: t_at_y,
            curveLabel: p.getAttribute('data-curve') ?? '',
            ref: p.getAttribute('data-ref') || undefined,
            voltage: p.getAttribute('data-voltage') ?? '',
            protocol: 'snap',
            pathD: '',
          },
        };
      }
      if (nearest) perCurve.push(nearest);
    }

    perCurve.sort((a, b) => a.distSq - b.distSq);
    if (perCurve.length > 0) {
      best = perCurve[0].state;
      bestDist = perCurve[0].distSq;

      /*
       * Everything else whose nearest point lands on the same spot.
       *
       * Judged on *position* rather than on distance from the cursor:
       * two curves equidistant from the pointer but on opposite sides
       * of it are two different answers, not one coincidence.
       */
      best.alsoHere = perCurve.slice(1)
        .filter((c) => Math.hypot(c.state.pxI - best!.pxI, c.state.pxT - best!.pxT) <= COINCIDENT_PX)
        .map((c) => ({
          curveLabel: c.state.curveLabel,
          ref: c.state.ref,
          voltage: c.state.voltage,
        }));
      if (best.alsoHere.length === 0) best.alsoHere = undefined;
    }

    if (best == null) {
      // No curves at all; render nothing in the hover overlay. The
      // mouse coordinates will not be useful.
      this.hover = null;
      (this as any)._cursorPx = { x: cursorPxI, y: cursorPxT };
      return;
    }

    // If the closest polyline is still beyond the snap radius, demote
    // the snap indicator to free mode, but show the curve's identity
    // and a "Closest" readout so the user knows which curve the
    // mouse is heading toward.
    /*
     * Fault markers and marked points are interrogable too: a study
     * argues about specific currents and coordinates, so the cursor
     * should be able to latch onto them and read them back, not only
     * onto the curves.
     */
    for (const line of Array.from(svg.querySelectorAll('line[data-fault]'))) {
      const x = Number(line.getAttribute('x1'));
      const current = Number(line.getAttribute('data-current'));
      if (!Number.isFinite(x) || !Number.isFinite(current)) continue;

      /* A vertical rule: distance is horizontal, anywhere along it. */
      const y1 = Number(line.getAttribute('y1'));
      const y2 = Number(line.getAttribute('y2'));
      if (cursorPxT < Math.min(y1, y2) || cursorPxT > Math.max(y1, y2)) continue;

      const distSq = (cursorPxI - x) ** 2;
      if (distSq < bestDist) {
        bestDist = distSq;
        best = {
          pxI: x,
          pxT: cursorPxT,
          I_A: current,
          t_s: NaN,
          curveLabel: line.getAttribute('data-fault') ?? 'fault',
          /* A condition's declared name *is* its reference. */
          ref: line.getAttribute('data-fault') || undefined,
          voltage: '',
          protocol: 'snap',
          pathD: '',
          target: 'fault',
          conditionKind: line.getAttribute('data-kind') === 'scenario' ? 'scenario' : 'fault',
        };
      }
    }

    /*
     * Required-time rules are interrogable too.
     *
     * A `times` rule asserts a clearance the study is judged against,
     * exactly as a fault asserts a current -- and the fault rules could
     * be latched onto while these could not, so the one figure a
     * reader most wants to check had to be read off the axis by eye.
     */
    for (const line of Array.from(svg.querySelectorAll('line[data-time-name]'))) {
      const y = Number(line.getAttribute('y1'));
      const seconds = Number(line.getAttribute('data-time'));
      if (!Number.isFinite(y) || !Number.isFinite(seconds)) continue;

      /* A horizontal rule: the distance is vertical, anywhere along
       * it, mirroring how a fault's vertical rule is measured. */
      const x1 = Number(line.getAttribute('x1'));
      const x2 = Number(line.getAttribute('x2'));
      if (cursorPxI < Math.min(x1, x2) || cursorPxI > Math.max(x1, x2)) continue;

      const distSq = (cursorPxT - y) ** 2;
      if (distSq < bestDist) {
        bestDist = distSq;
        best = {
          pxI: cursorPxI,
          pxT: y,
          I_A: NaN,
          t_s: seconds,
          curveLabel: line.getAttribute('data-time-name') ?? 'time',
          ref: line.getAttribute('data-time-name') || undefined,
          voltage: '',
          protocol: 'snap',
          pathD: '',
          target: 'time',
        };
      }
    }

    for (const group of Array.from(svg.querySelectorAll('g[data-point]'))) {
      const x = Number(group.getAttribute('data-px'));
      const y = Number(group.getAttribute('data-py'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const distSq = (cursorPxI - x) ** 2 + (cursorPxT - y) ** 2;
      /*
       * A marked point wins a tie against a curve it sits on.
       *
       * Points are usually placed *on* a characteristic -- that is
       * what makes them worth marking -- so the two are within a pixel
       * of each other and the curve won by being tested first. The
       * point is the more specific answer: a curve is continuous and
       * says the same thing either side of the cursor, where a point
       * is a single coordinate the study asserts.
       *
       * `<=` rather than a distance bias, so it only takes precedence
       * where it is genuinely at least as close.
       */
      if (distSq <= bestDist) {
        const displaced = best;
        best = {
          pxI: x,
          pxT: y,
          I_A: Number(group.getAttribute('data-current')),
          t_s: Number(group.getAttribute('data-time')),
          curveLabel: group.getAttribute('data-point') ?? 'point',
          ref: group.getAttribute('data-point') || undefined,
          voltage: '',
          protocol: 'snap',
          pathD: '',
          target: 'point',
        };
        /*
         * The curve it displaced is still under the cursor and still
         * worth naming, so it joins whatever else was coincident
         * rather than being dropped for having lost by a pixel.
         */
        const alsoWas = displaced?.alsoHere ?? [];
        const carried = displaced != null
          && Math.hypot(displaced.pxI - x, displaced.pxT - y) <= COINCIDENT_PX
          ? [{
            curveLabel: displaced.curveLabel,
            ref: displaced.ref,
            voltage: displaced.voltage,
          }, ...alsoWas]
          : [];
        best.alsoHere = carried.length > 0 ? carried : undefined;
        bestDist = distSq;
      }
    }

    /*
     * Outside the snap radius there is nothing meaningful to read, so
     * drop the overlay entirely and let the cursor go back to normal.
     * Previously it fell back to a "free" crosshair that followed the
     * pointer everywhere, which looked like a stuck artifact.
     */
    const insidePlot =
      cursorPxI >= plot.xMin && cursorPxI <= plot.xMax &&
      cursorPxT >= plot.yMin && cursorPxT <= plot.yMax;

    if (bestDist > SNAP_SQ || !insidePlot) {
      this.hover = null;
      this.setOverPlot(false);
      return;
    }
    this.setOverPlot(true);
    // Track the cursor location for the visible readout overlay.
    (this as any)._cursorPx = { x: cursorPxI, y: cursorPxT };
    this.hover = best;
  }

  private handleMouseLeave(): void {
    this.hover = null;
    (this as any)._cursorPx = null;
    this.setOverPlot(false);
    /*
     * A pan in progress is deliberately *not* ended here. The drag is
     * tracked on the window while it lasts, so leaving the pane keeps
     * panning instead of dropping the gesture halfway.
     */
  }

  /**
   * Crosshair cursor only while the pointer is over a curve. Away from
   * one the pointer is an ordinary arrow, so the chart does not claim
   * a gesture it will not act on.
   */
  private setOverPlot(over: boolean): void {
    const host = this.querySelector('div.pane-host') as HTMLElement | null;
    host?.classList.toggle('over-curve', over);
  }

  /* ---------------- middle-drag panning ---------------- */

  /**
   * Pan state, captured on middle-button press.
   *
   * The axis is logarithmic, so panning is a *translation in log
   * space*: dragging by a given number of pixels shifts the domain by
   * the same fraction of a decade wherever you are on the axis, which
   * is what makes the gesture feel linear to the hand.
   */
  private pan: {
    active: boolean;
    startX: number;
    /** Log10 domain bounds at the moment the drag began. */
    logLo: number;
    logHi: number;
    /** Pixels per log10 unit, from the plot geometry. */
    pxPerDecade: number;
  } | null = null;

  /**
   * Window-level handlers held for the duration of a pan.
   *
   * The drag has to be tracked on the window, not on the plot pane.
   * Bound to the pane, a middle-drag that wandered left over the
   * splitter delivered its *mouseup to the editor* -- and on X11 a
   * middle click over a contenteditable pastes the primary selection.
   * Panning the graph therefore injected whatever text was last
   * selected into the study, which read as a duplicated block and a
   * row of syntax errors.
   */
  private panListeners: {
    move: (ev: MouseEvent) => void;
    up: (ev: MouseEvent) => void;
  } | null = null;

  private handleMouseDown(ev: MouseEvent): void {
    /* Button 1 is the middle button. Left stays free for future
     * curve dragging (spec v0.2), right for the context menu. */
    if (ev.button !== 1) return;

    const svg = this.querySelector('svg') as SVGSVGElement | null;
    const proj = svg ? projectDomain(svg.querySelector('path.tc-curve')) : null;
    if (!svg || !proj) return;

    const logLo = Math.log10(proj.domain.I_min);
    const logHi = Math.log10(proj.domain.I_max);
    const spanPx = proj.scale.xMax - proj.scale.xMin;
    if (!(spanPx > 0) || !(logHi > logLo)) return;

    /* Middle-click otherwise triggers autoscroll in most browsers. */
    ev.preventDefault();

    this.pan = {
      active: true,
      startX: ev.clientX,
      logLo,
      logHi,
      pxPerDecade: spanPx / (logHi - logLo),
    };

    /* Own the gesture until the button comes up, wherever that is. */
    const move = (e: MouseEvent): void => this.handlePanMove(e);
    const up = (e: MouseEvent): void => {
      /* Swallow the release so it cannot act on whatever it landed
       * over -- the editor included. */
      e.preventDefault();
      this.endPan();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    this.panListeners = { move, up };

    (this.querySelector('div.pane-host') as HTMLElement | null)?.classList.add('panning');
  }

  private handlePanMove(ev: MouseEvent): void {
    const pan = this.pan;
    if (!pan?.active) return;

    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;

    /* Convert screen pixels to SVG user units before dividing. */
    const dxUser = toUserSpace(svg, ev.clientX, 0).x - toUserSpace(svg, pan.startX, 0).x;

    /* Drag right => look at lower currents, so the domain moves left. */
    const shift = -dxUser / pan.pxPerDecade;
    this.currentMin = Math.pow(10, pan.logLo + shift);
    this.currentMax = Math.pow(10, pan.logHi + shift);
  }

  private endPan(): void {
    if (this.panListeners) {
      window.removeEventListener('mousemove', this.panListeners.move, true);
      window.removeEventListener('mouseup', this.panListeners.up, true);
      this.panListeners = null;
    }
    if (!this.pan) return;
    this.pan = null;
    (this.querySelector('div.pane-host') as HTMLElement | null)?.classList.remove('panning');
  }

  /**
   * Wheel zoom on the current (X) axis.
   *
   * The zoom is anchored on the *cursor's* current, so the value under
   * the pointer stays put while the axis expands or contracts around
   * it. The anchor comes from the raw pointer position rather than the
   * snap state, which only exists while the pointer is near a curve.
   *
   * The axis is logarithmic, so all the arithmetic happens in log
   * space: a zoom is a scaling of the log-span about the anchor.
   */
  private handleWheel(ev: WheelEvent): void {
    const svg = this.querySelector('svg') as SVGSVGElement | null;
    const proj = svg ? projectDomain(svg.querySelector('path.tc-curve')) : null;
    if (!svg || !proj) return;

    ev.preventDefault();

    /* Pointer position in the SVG's own pixel space. */
    const px = toUserSpace(svg, ev.clientX, ev.clientY).x;

    const { xMin, xMax } = proj.scale;
    const logLo = Math.log10(proj.domain.I_min);
    const logHi = Math.log10(proj.domain.I_max);

    /* Anchor: where the pointer sits, clamped to the plot area. */
    const frac = Math.min(1, Math.max(0, (px - xMin) / Math.max(1, xMax - xMin)));
    const anchor = logLo + frac * (logHi - logLo);

    const k = ev.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    let newLo = anchor - (anchor - logLo) * k;
    let newHi = anchor + (logHi - anchor) * k;

    /* Keep the span sane: at least a third of a decade, at most six. */
    const span = newHi - newLo;
    if (span < 0.33) {
      const mid = (newLo + newHi) / 2;
      newLo = mid - 0.165;
      newHi = mid + 0.165;
    } else if (span > 6) {
      const mid = (newLo + newHi) / 2;
      newLo = mid - 3;
      newHi = mid + 3;
    }

    this.currentMin = Math.pow(10, newLo);
    this.currentMax = Math.pow(10, newHi);
  }

  /* ------------------- touch: drag and pinch ------------------- */

  /**
   * Live touch gesture.
   *
   * One finger pans, two pinch. Both work on the same log-space
   * domain the wheel and middle-drag use, so a phone and a mouse
   * arrive at the same view -- there is one notion of what is on
   * screen, not a separate touch one.
   */
  private touch: {
    /** Log10 bounds when the gesture began. */
    logLo: number;
    logHi: number;
    pxPerDecade: number;
    /** Plot edges in SVG pixel space, for anchoring a pinch. */
    xMin: number;
    xMax: number;
    /** Midpoint of the touches at the start, in SVG pixel space. */
    startCentre: number;
    /** Distance between two touches at the start; 0 for one finger. */
    startSpread: number;
    /*
     * The same gesture in the *screen's* coordinates, and where the
     * pane was scrolled to. A drag on a drawing larger than the pane
     * moves the paper rather than the axes, and that is a scroll --
     * measured in the pixels the finger actually travelled, not in
     * decades.
     */
    startClientX: number;
    startClientY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null = null;

  /** Touch positions in the SVG's own pixel space. */
  private touchGeometry(ev: TouchEvent): { centre: number; spread: number } | null {
    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg || ev.touches.length === 0) return null;

    const toSvg = (clientX: number): number => toUserSpace(svg, clientX, 0).x;

    if (ev.touches.length === 1) {
      return { centre: toSvg(ev.touches[0].clientX), spread: 0 };
    }
    const a = toSvg(ev.touches[0].clientX);
    const b = toSvg(ev.touches[1].clientX);
    return { centre: (a + b) / 2, spread: Math.abs(a - b) };
  }

  /**
   * Show the drawing larger or smaller.
   *
   * Clamped to a range where the sheet is still a sheet: below about a
   * third the labels are gone, and above four times a phone is looking
   * at one curve through a keyhole.
   */
  setDisplayScale(scale: number): void {
    const next = Math.min(4, Math.max(0.3, scale));
    if (Math.abs(next - this.displayScale) < 0.001) return;
    this.displayScale = next;
  }

  zoomDisplayBy(factor: number): void {
    this.setDisplayScale(this.displayScale * factor);
  }

  /** Scale the drawing so the whole sheet is visible at once. */
  fitDisplay(): void {
    const host = this.paneEl;
    if (!host) return;
    const w = host.clientWidth / Math.max(1, this.measuredW);
    const h = host.clientHeight / Math.max(1, this.measuredH);
    this.setDisplayScale(Math.min(w, h));
  }

  /** Back to one drawn pixel per CSS pixel. */
  actualSize(): void {
    this.setDisplayScale(1);
  }

  private handleTouchStart(ev: TouchEvent): void {
    const svg = this.querySelector('svg') as SVGSVGElement | null;
    const proj = svg ? projectDomain(svg.querySelector('path.tc-curve')) : null;
    const geo = this.touchGeometry(ev);
    if (!proj || !geo) return;

    const logLo = Math.log10(proj.domain.I_min);
    const logHi = Math.log10(proj.domain.I_max);
    const spanPx = proj.scale.xMax - proj.scale.xMin;
    if (!(spanPx > 0) || !(logHi > logLo)) return;

    this.touch = {
      logLo,
      logHi,
      pxPerDecade: spanPx / (logHi - logLo),
      xMin: proj.scale.xMin,
      xMax: proj.scale.xMax,
      startCentre: geo.centre,
      startSpread: geo.spread,
      startClientX: ev.touches[0].clientX,
      startClientY: ev.touches[0].clientY,
      startScrollLeft: this.paneEl?.scrollLeft ?? 0,
      startScrollTop: this.paneEl?.scrollTop ?? 0,
    };
  }

  private handleTouchMove(ev: TouchEvent): void {
    const start = this.touch;
    const geo = this.touchGeometry(ev);
    if (!start || !geo) return;

    /* Own the gesture: without this the page scrolls instead. */
    ev.preventDefault();

    const { logLo, logHi, pxPerDecade } = start;

    /*
     * Pinch first, so the scale is settled before the pan is applied
     * about it. A second finger arriving mid-drag has no starting
     * spread to compare against, so that case stays a pan until the
     * gesture is lifted and begun again.
     */
    let lo = logLo;
    let hi = logHi;
    if (start.startSpread > 10 && geo.spread > 10) {
      /*
       * Two fingers make the drawing bigger, not the axes narrower.
       *
       * This used to zoom the domain, the way the wheel does. On a
       * desktop that is the analysis gesture and it stays on the
       * wheel; on a phone a pinch means "let me see that" -- and since
       * the domain zoom re-lays the sheet out at the same size, it was
       * the one gesture that could never answer the one question a
       * small screen asks.
       *
       * The pan below still moves the domain, so a finger drag reads
       * the sheet the way it always did.
       */
      this.setDisplayScale(this.displayScale * (geo.spread / start.startSpread));
      this.touch = { ...start, startSpread: geo.spread };
      return;
    }

    /*
     * One finger on a drawing bigger than the pane moves the paper.
     *
     * The domain pan below is the right gesture when the whole sheet
     * is on screen and there is nowhere to scroll to. Once the reader
     * has zoomed in, though, a drag means "show me the part I can't
     * see" -- and since the pane claims touch outright
     * (`touch-action: none`, so a pinch is ours and not the browser's
     * page zoom), the scroll has to be driven here.
     */
    const host = this.paneEl;
    const overflows = host !== undefined
      && (host.scrollWidth > host.clientWidth + 1 || host.scrollHeight > host.clientHeight + 1);
    if (overflows && ev.touches.length === 1) {
      host.scrollLeft = start.startScrollLeft - (ev.touches[0].clientX - start.startClientX);
      host.scrollTop = start.startScrollTop - (ev.touches[0].clientY - start.startClientY);
      return;
    }

    /* Then the pan, from how far the centre of the gesture moved. */
    const shift = -(geo.centre - start.startCentre) / pxPerDecade;
    lo += shift;
    hi += shift;

    /* Same limits as the wheel: a third of a decade to six decades. */
    const span = hi - lo;
    if (span < 0.33) {
      const mid = (lo + hi) / 2;
      lo = mid - 0.165;
      hi = mid + 0.165;
    } else if (span > 6) {
      const mid = (lo + hi) / 2;
      lo = mid - 3;
      hi = mid + 3;
    }

    this.currentMin = Math.pow(10, lo);
    this.currentMax = Math.pow(10, hi);
  }

  private handleTouchEnd(): void {
    this.touch = null;
  }

  /** Show or hide the controls crib. Driven by the toolbar's `?`. */
  toggleHelp(): void {
    this.showHelp = !this.showHelp;
  }

  /**
   * Ask the host app to open the language guide.
   *
   * Raised as an event rather than owned here: the guide is a modal
   * over the whole window, not a plot control, so the app places it.
   */
  private openGuide(): void {
    this.showHelp = false;
    this.dispatchEvent(new CustomEvent('tc-open-guide', { bubbles: true, composed: true }));
  }

  /**
   * Put the sheet back as the study declared it.
   *
   * Both zooms, because "reset" from a reader who has pinched their
   * way into a corner has to be one button.
   */
  resetZoom(): void {
    this.currentMin = null;
    this.currentMax = null;
    this.displayScale = 1;
  }

  /**
   * Canvas size for an exported sheet.
   *
   * A study that declares a `page` is drawn at *its* proportions, not
   * the pane's. Exporting at the pane size instead produced a wide,
   * short drawing that `exportPdf` then letterboxed into the middle of
   * a portrait page, leaving most of the height empty -- the plot was
   * the right shape for the screen and the wrong shape for the paper.
   *
   * With no page declared the pane size is still right: the export
   * then matches what is on screen.
   */
  private exportSize(): { width: number; height: number } {
    const page = this.study?.page;
    if (!page?.size && !page?.orientation) {
      return { width: this.measuredW, height: this.measuredH };
    }
    return sheetSize(page);
  }

  /** Export the current SVG plot as a downloaded .svg file. */
  saveSvg(): void {
    const onScreen = this.querySelector('svg') as SVGSVGElement | null;
    if (!onScreen) return;

    /*
     * Re-rendered at the declared sheet size when there is one, for
     * the same reason as the PDF; otherwise the on-screen SVG is
     * serialised as-is, keeping its theme and dimensions.
     */
    const page = this.study?.page;
    const sized = page?.size || page?.orientation;
    const { width, height } = this.exportSize();
    const xml = sized
      ? renderSvg(this.document, {
        page: page ?? null,
        system: null,
        faults: null,
        view: this.currentView(),
        study: this.study ?? null,
        invalidErrors: this.errorCount,
        theme: this.theme,
        width,
        height,
      })
      : new XMLSerializer().serializeToString(onScreen);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.exportStem()}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Save the sheet as a PNG file.
   *
   * `Copy PNG` puts one on the clipboard, which suits pasting into an
   * email and does not suit filing it beside the study -- and on a
   * browser without `ClipboardItem` it silently degrades to a line of
   * text. A raster on disk is what goes into a report.
   *
   * Rendered at the declared sheet size like the SVG and the PDF, so
   * the three exports of one study agree with each other rather than
   * with whatever shape the pane happened to be.
   */
  async savePng(): Promise<void> {
    const onScreen = this.querySelector('svg') as SVGSVGElement | null;
    if (!onScreen) return;

    const page = this.study?.page;
    const sized = page?.size || page?.orientation;
    const { width, height } = this.exportSize();
    const xml = sized
      ? renderSvg(this.document, {
        page: page ?? null,
        system: null,
        faults: null,
        view: this.currentView(),
        study: this.study ?? null,
        invalidErrors: this.errorCount,
        theme: this.theme,
        width,
        height,
      })
      : new XMLSerializer().serializeToString(onScreen);

    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = url;
      await img.decode();

      /* 2x, so the file stands up to being placed in a document and
       * printed rather than only viewed at its natural size. */
      const SCALE = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(320, width) * SCALE;
      canvas.height = Math.max(200, height) * SCALE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2D context');
      /*
       * Painted opaque first. A PNG of a sheet whose background never
       * got drawn is transparent, and transparent reads as white
       * until it is placed on anything dark.
       */
      ctx.fillStyle = this.theme === 'dark' ? '#111111' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const png: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
      });
      const href = URL.createObjectURL(png);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${this.exportStem()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Export the plot as a PDF.
   *
   * Goes through the library's `exportPdf`, the same call the CLI
   * makes, so a sheet saved from the playground matches one generated
   * in a build. The page size and orientation come from the study's
   * `page` block when it declares them.
   *
   * `jspdf` and `svg2pdf.js` are loaded lazily inside `exportPdf`, so
   * opening the playground does not pay for them.
   */
  async savePdf(): Promise<void> {
    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;

    this.exporting = 'pdf';
    try {
      const page = this.study?.page;

      /*
       * Render a *fresh light* plot rather than serialising what is on
       * screen. A PDF gets printed and filed, so it is always light;
       * re-rendering gives true light-theme colours instead of a
       * recoloured dark capture, and drops the hover overlay, which
       * has no business in an exported document.
       */
      const { width, height } = this.exportSize();
      const lightSvg = renderSvg(this.document, {
        page: page ?? null,
        system: null,
        faults: null,
        view: this.currentView(),
        study: this.study ?? null,
        invalidErrors: this.errorCount,
        theme: 'light',
        width,
        height,
      });

      const bytes = await exportPdf(lightSvg, {
        size: typeof page?.size === 'string' ? page.size : undefined,
        orientation: page?.orientation ?? 'landscape',
        margins_mm: page?.margins_mm,
      });

      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.exportStem()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this.exportError = (error as Error).message;
      /* Clear the notice after long enough to read it. */
      setTimeout(() => { this.exportError = null; }, 6000);
    } finally {
      this.exporting = null;
    }
  }

  /**
   * The `view` block as currently displayed, i.e. including any
   * interactive zoom or pan. Exports use this so the sheet matches
   * what the engineer is looking at.
   */
  private currentView(): import('../parser/index.js').ViewBlock | null {
    /*
     * The sheet the picker has open, not the first one declared.
     *
     * This took `items.find(i => i.type === 'view')` while the screen
     * drew `selectedView()`, so an export of a multi-sheet study gave
     * whichever sheet happened to be written first -- and appeared to
     * work whenever that was the one being looked at, which is what
     * made it read as intermittent rather than as always wrong.
     */
    const declared = this.selectedView()
      ?? (this.document?.items.find((i) => i.type === 'view') as
        import('../parser/index.js').ViewBlock | undefined) ?? null;
    if (this.currentMin == null && this.currentMax == null) return declared;
    return {
      ...(declared ?? { type: 'view', loc: { line: 1, column: 1, offset: 0 } }),
      current_min: this.currentMin ?? declared?.current_min,
      current_max: this.currentMax ?? declared?.current_max,
    } as import('../parser/index.js').ViewBlock;
  }

  /** File stem for an export, taken from the study's project name. */
  private exportStem(): string {
    const project = this.study?.meta?.project;
    const base = typeof project === 'string' && project.trim() ? project : 'tcc';
    return base.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  }

  /**
   * Rasterize the current SVG into a PNG and copy it to the system
   * clipboard. We draw to a 2× canvas so retina displays get crisp
   * output.
   */
  async copyPngToClipboard(): Promise<void> {
    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const SCALE = 2;
      const canvas = document.createElement('canvas');
      canvas.width  = Math.max(320, (svg.viewBox.baseVal.width  || svg.clientWidth  || this.measuredW)) * SCALE;
      canvas.height = Math.max(200, (svg.viewBox.baseVal.height || svg.clientHeight || this.measuredH)) * SCALE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2D context');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pngBlob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png');
      });
      const items: Record<string, Blob> = { 'image/png': pngBlob };
      // Firefox/Safari accept a list of ClipboardItems, not raw blobs.
      const anyCtor = (globalThis as any);
      if (anyCtor?.ClipboardItem) {
        await navigator.clipboard.write([new anyCtor.ClipboardItem(items)]);
      } else {
        await navigator.clipboard.writeText(`[png ${pngBlob.size} bytes — clipboard image type unavailable in this browser]`);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

render() {
    if (!this.document) {
      return html`<div class="empty">No document parsed.</div>`;
    }
    const page = (this.document.items.find((i: any) => i.type === 'page') as import('../parser/index.js').PageBlock | undefined) ?? null;
    const system = (this.document.items.find((i: any) => i.type === 'system') as import('../parser/index.js').SystemBlock | undefined) ?? null;
    const faults = (this.document.items.find((i: any) => i.type === 'faults') as import('../parser/index.js').FaultsBlock | undefined) ?? null;
    /*
     * The selected sheet, of however many the study declares. Falls
     * back to the first, which is what a single-view study has.
     */
    const view: import('../parser/index.js').ViewBlock | null = this.selectedView() ?? null;
    /*
     * A wheel zoom is expressed as the same current bounds a `view`
     * block would declare, so the renderer has one notion of "what is
     * on screen". This applies even when the source declares no view
     * block at all -- otherwise a study without one could not be
     * zoomed.
     */
    let viewClamped = view;
    if (this.currentMin != null || this.currentMax != null) {
      viewClamped = {
        ...(view ?? { type: 'view', loc: { line: 1, column: 1, offset: 0 } }),
        current_min: this.currentMin ?? view?.current_min,
        current_max: this.currentMax ?? view?.current_max,
      } as import('../parser/index.js').ViewBlock;
    }
    const opts: RenderOptions = {
      page, system, faults, view: viewClamped ?? null,
      study: this.study ?? null,
      theme: this.theme,
      invalidErrors: this.errorCount,
      width: this.measuredW,
      height: this.measuredH,
      highlightLabel: this.hover?.protocol === 'snap' ? this.hover.curveLabel : null,
      highlightVoltage: this.hover?.protocol === 'snap' ? this.hover.voltage : null,
    };
    const svg = this.renderCached(opts);

    return html`
      ${this.showHelp ? html`
        <div class="help-popover" role="dialog" aria-label="Plot controls">
          <h4>Plot controls</h4>
          <dl>
            <dt>Hover</dt><dd>snap to the nearest curve, fault rule, or point (${SNAP_RADIUS_PX} px) and read I / t</dd>
            <dt>Wheel</dt><dd>zoom the current axis about the pointer</dd>
            <dt>Middle-drag</dt><dd>pan the current axis</dd>
            <dt>&minus; / +</dt><dd>show the drawing larger or smaller &mdash; the axes do not change</dd>
            <dt>Pinch</dt><dd>the same, by touch; one finger then moves the paper</dd>
            <dt>Reset</dt><dd>return to the view block's bounds, at actual size</dd>
          </dl>
          <button class="help-guide"
                  title="Open the language specification"
                  @click=${() => this.openGuide()}>Language guide →</button>
        </div>` : ''}
      <div class="pane-host"
           @mousedown=${(e: MouseEvent) => this.handleMouseDown(e)}
           @mousemove=${(e: MouseEvent) => this.handleMouseMove(e)}
           @mouseup=${() => this.endPan()}
           @mouseleave=${() => this.handleMouseLeave()}
           @auxclick=${(e: MouseEvent) => { if (e.button === 1) e.preventDefault(); }}
           @wheel=${(e: WheelEvent) => this.handleWheel(e)}
           @touchstart=${(e: TouchEvent) => this.handleTouchStart(e)}
           @touchmove=${(e: TouchEvent) => this.handleTouchMove(e)}
           @touchend=${() => this.handleTouchEnd()}
           @touchcancel=${() => this.handleTouchEnd()}>
        <div class="sheet"
             style=${`width:${Math.round(this.measuredW * this.displayScale)}px;`
               + `height:${Math.round(this.measuredH * this.displayScale)}px;`}>
          ${unsafeHTML(this.renderWithOverlay(svg))}
        </div>
      </div>
      <!--
        Outside the pane, not inside it. The pane scrolls now, and a
        warning that the drawing is not the study would scroll off the
        edge of the one drawing it is warning about.
      -->
      ${this.renderFailure !== null ? html`
        <div class="plot-stale" role="alert">
          <strong>This plot could not be redrawn.</strong>
          ${this.lastGoodSvg
            ? html`<span>You are looking at the last sheet that drew, which is
                   <em>not</em> the study now in the editor.</span>`
            : html`<span>Nothing has drawn yet.</span>`}
          <code>${this.renderFailure}</code>
        </div>` : null}
    `;
  }

  /**
   * Inject a live crosshair + readout overlay into the SVG so the
   * snap state is visible without re-rendering the whole plot.
   * Anchors the crosshair to the plot rectangle pulled from the
   * <desc data-plot="..."> embedded by the renderer.
   */
  private renderWithOverlay(svg: string): string {
    if (!this.hover) return svg;
    const hover = this.hover;
    const px = hover.pxI;
    const py = hover.pxT;

    // Read plot dims from the renderer-embedded <desc>.
    const m = svg.match(/<desc [^>]*data-plot="(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)"/);
    const xMin = m ? Number(m[1]) : 80;
    const yMin = m ? Number(m[2]) : 40;
    const w    = m ? Number(m[3]) : (this.measuredW - 370);
    const h    = m ? Number(m[4]) : (this.measuredH - 170);

    const snapped = hover.protocol === 'snap';
    const accent = snapped ? '#cc0000' : '#888888';

    /*
     * Readout box, anchored to the cursor rather than the toolbar so
     * the numbers are where the eye already is. It flips to the other
     * side of the crosshair near an edge so it never leaves the plot.
     */
    /*
     * One block per curve, then the coordinates they share.
     *
     * Each block is identical in shape -- name in bold, then its
     * reference and level -- so two coincident curves are
     * read the same way and compared line against line. Before this
     * only the first name was bold and the second curve's identity ran
     * on underneath it as though it belonged to the first.
     */
    interface Line { text: string; bold?: boolean }
    const lines: Line[] = [];

    const describe = (curve: {
      curveLabel: string; ref?: string; voltage: string;
    }): void => {
      lines.push({ text: curve.curveLabel, bold: true });
      /*
       * The reference, when it is not simply the label again. A relay
       * that declares a `name` is drawn as "Feeder 4 (Mill Road) 51"
       * and referred to as `R_FDR:51`, and only the second can be
       * typed into a `grade`. Suppressed when they match, since a
       * study that names nothing would otherwise repeat itself.
       */
      if (curve.ref && curve.ref !== curve.curveLabel) lines.push({ text: curve.ref });
      /* The level, per curve rather than once at the foot: two
       * coincident curves may sit on different windings, and a single
       * trailing line could only name one of them. */
      if (curve.voltage) lines.push({ text: curve.voltage });
    };

    if (snapped && hover.curveLabel) {
      describe(hover);
      /*
       * Anything else lying on the same spot, described identically.
       * Listed before the coordinates because the numbers are shared
       * by all of them; it is which curves they belong to that a
       * reader cannot infer.
       */
      for (const other of hover.alsoHere ?? []) describe(other);
    }

    /* A fault rule asserts a current; a required-time rule asserts a
     * time. Each is drawn for one figure, and quoting the other would
     * be quoting wherever the cursor happened to be. */
    if (hover.target !== 'time') lines.push({ text: `I = ${prettyNum(hover.I_A)}` });
    if (hover.target !== 'fault') lines.push({ text: `t = ${prettyTime(hover.t_s)}` });
    if (hover.target === 'time') lines.push({ text: 'required time' });
    if (hover.target === 'fault') {
      /* A scenario's figure was declared for this level, not referred
       * to it, so calling it a fault level would misstate where it
       * came from. */
      lines.push({
        text: hover.conditionKind === 'scenario' ? 'scenario, this level' : 'fault level',
      });
    }

    const lineH = 13;
    const padX = 7;
    const padY = 6;
    const fontPx = 11;
    /*
     * The sheet sets a monospace stack on the root `<svg>`, so every
     * glyph is the same width and 0.60 em is that width -- the same
     * constant the renderer measures its own labels with. It was 6.1
     * here against a true 6.6, so the box came out 8% narrow and the
     * text ran out through the right-hand edge. A relay's full name is
     * fifty characters, which is where that showed.
     */
    const charW = fontPx * 0.60;

    /*
     * Wrapped rather than allowed to set the width: a curve's label is
     * free text -- maker, model and function -- and one long enough
     * would otherwise stretch the readout across a third of the plot it
     * is meant to be read against.
     */
    const MAX_CHARS = 34;
    const wrapped: string[] = [];
    const bold = new Set<number>();
    for (const line of lines) {
      /* Every wrapped fragment of a bold line stays bold, so a relay
       * name long enough to run over does not half-fade. */
      const emit = (text: string): void => {
        if (line.bold) bold.add(wrapped.length);
        wrapped.push(text);
      };
      if (line.text.length <= MAX_CHARS) {
        emit(line.text);
        continue;
      }
      let rest = line.text;
      while (rest.length > MAX_CHARS) {
        /* Break at a space where there is one, so a word is not split. */
        const cut = rest.lastIndexOf(' ', MAX_CHARS);
        const at = cut > MAX_CHARS / 2 ? cut : MAX_CHARS;
        emit(rest.slice(0, at).trimEnd());
        rest = rest.slice(at).trimStart();
      }
      if (rest) emit(rest);
    }

    const boxW = Math.max(...wrapped.map((l) => l.length)) * charW + padX * 2;
    const boxH = wrapped.length * lineH + padY * 2 - 2;

    // Prefer up-and-right of the point; flip when that would overflow.
    const flipX = px + 14 + boxW > xMin + w;
    const flipY = py - 14 - boxH < yMin;
    const boxX = flipX ? px - 14 - boxW : px + 14;
    const boxY = flipY ? py + 14 : py - 14 - boxH;

    const text = wrapped
      .map((l, i) => {
        const weight = bold.has(i) ? ' font-weight="600"' : '';
        return `<text x="${(boxX + padX).toFixed(1)}" y="${(boxY + padY + 9 + i * lineH).toFixed(1)}"` +
          `${weight} font-size="${fontPx}" fill="${escapeXmlAttr(this.readoutFg())}">` +
          `${escapeXmlAttr(l)}</text>`;
      })
      .join('');

    const overlay = `
      <g class="tc-overlay-live" pointer-events="none">
        <line x1="${px.toFixed(1)}" y1="${yMin}" x2="${px.toFixed(1)}" y2="${yMin + h}" stroke="${accent}" stroke-width="0.7" stroke-dasharray="2 3"/>
        <line x1="${xMin}" y1="${py.toFixed(1)}" x2="${xMin + w}" y2="${py.toFixed(1)}" stroke="${accent}" stroke-width="0.7" stroke-dasharray="2 3"/>
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${snapped ? 3.5 : 2.5}" fill="${accent}"/>
        <rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}"
              rx="3" fill="${escapeXmlAttr(this.readoutBg())}" stroke="${accent}" stroke-width="0.8" opacity="0.96"/>
        ${text}
      </g>
    `;
    return svg.replace('</svg>', overlay + '</svg>');
  }

  /**
   * Render the plot, reusing the previous SVG when nothing that
   * affects it has changed.
   *
   * `render()` re-runs on every mousemove, because the hover state
   * drives the crosshair. Re-composing the whole plot at that rate is
   * wasteful and makes the crosshair lag behind the pointer, which
   * reads as "hover is broken". The overlay is injected separately, so
   * the plot itself only needs recomputing when the document, the
   * zoom, the size, the theme, or *which* curve is highlighted change
   * -- not when the pointer moves a pixel along the same curve.
   */
  private svgCache: { key: string; svg: string } | null = null;

  /**
   * The last sheet that drew successfully, and why the current one did
   * not.
   *
   * A render that throws used to take the pane down with it: Lit's
   * render fails, the previous DOM is left on screen, and the reader is
   * looking at a drawing of a study that is no longer the one in the
   * editor with nothing to say so. A stale plot presented as a current
   * one is the same fault as a sheet drawn from a broken study --
   * confident, wrong, and indistinguishable from right.
   */
  @state() private renderFailure: string | null = null;
  private lastGoodSvg: string | null = null;

  private renderCached(opts: RenderOptions): string {
    const key = JSON.stringify([
      this.docRevision,
      /*
       * Which sheet, not just its bounds. Two views of one study
       * routinely share a current and time range and differ only in
       * quantity, condition or title -- so keying on the bounds alone
       * returned the previous sheet's SVG and the picker appeared to
       * do nothing.
       */
      this.viewIndex,
      opts.width, opts.height, opts.theme,
      opts.view?.current_min, opts.view?.current_max,
      opts.view?.time_min, opts.view?.time_max,
      opts.highlightLabel, opts.highlightVoltage,
      opts.invalidErrors,
    ]);
    if (this.svgCache?.key === key) return this.svgCache.svg;
    try {
      const svg = renderSvg(this.document, opts);
      this.svgCache = { key, svg };
      this.lastGoodSvg = svg;
      if (this.renderFailure !== null) this.renderFailure = null;
      return svg;
    } catch (error) {
      /*
       * Keep the last good sheet rather than blanking the pane -- it
       * is still the best picture of the study available -- but say
       * plainly that it is not the current one.
       */
      const message = error instanceof Error ? error.message : String(error);
      if (this.renderFailure !== message) this.renderFailure = message;
      return this.lastGoodSvg ?? '';
    }
  }

  /**
   * Bumped whenever a new document or study arrives, so the cache key
   * changes without having to serialise the whole AST.
   */
  private docRevision = 0;
  private lastDoc: Document | undefined;
  private lastStudy: Study | undefined;

  protected willUpdate(): void {
    if (this.document !== this.lastDoc || this.study !== this.lastStudy) {
      this.lastDoc = this.document;
      this.lastStudy = this.study;
      this.docRevision++;
      this.dropZoomIfBoundsEdited();
    }
  }

  /**
   * Let an edit to the source override an interactive zoom.
   *
   * A wheel zoom or a pan is held here as `currentMin` / `currentMax`
   * and takes precedence over the study's `view` block -- which is
   * right while the reader is driving, and wrong the moment they go
   * back to the source and change `current_min` themselves. Editing
   * the declared bounds looked as though it did nothing at all,
   * because a stale zoom was still winning. Changing them now drops
   * the zoom; re-rendering for any other reason leaves it alone.
   */
  /**
   * The declared view this sheet is drawn from.
   *
   * One place, so the zoom-reset check and the render agree about
   * which sheet is on screen -- otherwise switching sheets kept the
   * previous one's zoom and the new bounds were ignored.
   */
  private selectedView(): import('../parser/index.js').ViewBlock | undefined {
    const views = (this.document?.items ?? [])
      .filter((i) => i.type === 'view') as import('../parser/index.js').ViewBlock[];
    if (views.length === 0) return undefined;
    return views[Math.min(Math.max(this.viewIndex, 0), views.length - 1)];
  }

  private dropZoomIfBoundsEdited(): void {
    const view = this.selectedView();
    const bounds = view
      ? `${this.viewIndex}|${view.current_min ?? ''}|${view.current_max ?? ''}|` +
        `${view.time_min ?? ''}|${view.time_max ?? ''}`
      : `${this.viewIndex}|`;

    if (this.declaredBounds !== null && bounds !== this.declaredBounds) {
      this.currentMin = null;
      this.currentMax = null;
    }
    this.declaredBounds = bounds;
  }

  /** Readout box fill, matching the active theme. */
  private readoutBg(): string {
    return this.theme === 'dark' ? '#1e1e1e' : '#ffffff';
  }

  /** Readout box ink, matching the active theme. */
  private readoutFg(): string {
    return this.theme === 'dark' ? '#eeeeee' : '#1a1a1a';
  }
}

/* ------------------------------------------------------------------ */
/* path / domain helpers (shared with the overlay code)                  */
/* ------------------------------------------------------------------ */

/**
 * Polyline points of a rendered curve, in SVG user units.
 *
 * The renderer writes commands glued to their first coordinate
 * (`M123.4 567.8 L234.5 678.9`), which is compact and valid SVG but
 * means the command letter is *not* a separate whitespace token. A
 * split-on-whitespace parser therefore matched no commands at all and
 * returned an empty polyline, which silently disabled hover snapping.
 *
 * Matching command-and-coordinates as one regex handles both the glued
 * and the spaced form, so it cannot break again if the emitter changes.
 */
function navFromPath(p: SVGPathElement): Array<{ pxI: number; pxT: number }> {
  const d = p.getAttribute('d') ?? '';
  const pts: Array<{ pxI: number; pxT: number }> = [];
  const cmd = /([MLml])\s*(-?\d*\.?\d+)[\s,]+(-?\d*\.?\d+)/g;
  for (let m = cmd.exec(d); m; m = cmd.exec(d)) {
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ pxI: x, pxT: y });
  }
  return pts;
}

interface DomainProj {
  domain: { I_min: number; I_max: number; t_min: number; t_max: number };
  scale:  { xMin: number; xMax: number; yMin: number; yMax: number };
}

function projectDomain(anyEl: Element | null): DomainProj | null {
  if (!anyEl) return null;
  const svg = anyEl.closest('svg');
  if (!svg) return null;
  const desc = svg.querySelector('desc.tc-data') as HTMLElement | null;
  if (!desc) return null;
  const dattr = desc.getAttribute('data-domain-i') ?? '';
  const tattr = desc.getAttribute('data-domain-t') ?? '';
  const pattr = desc.getAttribute('data-plot') ?? '';
  const [Imin, Imax] = dattr.split(',').map(Number);
  const [tmin, tmax] = tattr.split(',').map(Number);
  const [xMin, yMin, w, h] = pattr.split(',').map(Number);
  if (![Imin, Imax, tmin, tmax, xMin, yMin, w, h].every(Number.isFinite)) return null;
  return {
    domain: { I_min: Imin, I_max: Imax, t_min: tmin, t_max: tmax },
    scale:  { xMin, xMax: xMin + w, yMin, yMax: yMin + h },
  };
}

function prettyNum(x: number): string {
  if (!Number.isFinite(x)) return '–';
  if (x >= 1e3) return `${(x / 1e3).toFixed(2)} kA`;
  if (x >= 1)   return `${x.toFixed(2)} A`;
  return `${(x * 1e3).toFixed(2)} mA`;
}
function prettyTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '∞ s';
  if (t >= 1)     return `${t.toFixed(2)} s`;
  if (t >= 0.001) return `${(t * 1e3).toFixed(2)} ms`;
  return `${(t * 1e6).toFixed(2)} µs`;
}

/** Escape text destined for an SVG attribute or text node. */
function escapeXmlAttr(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c] as string));
}
