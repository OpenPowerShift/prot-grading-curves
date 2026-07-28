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

/*
 * Snap radius. Tight enough that the readout tracks the curve the
 * pointer is actually near, rather than grabbing a neighbour several
 * pixels away.
 */
const SNAP_RADIUS_PX = 24;
const ZOOM_STEP = 1.25;

interface SnapState {
  pxI: number;
  pxT: number;
  I_A: number;
  t_s: number;
  curveLabel: string;
  voltage: string;
  protocol: 'snap' | 'free';
  /** polyline SVG path string */
  pathD: string;
  /**
   * What the cursor latched onto. Curves report a time at a current;
   * a fault marker reports its declared current; a marked point
   * reports the coordinate it asserts.
   */
  target?: 'curve' | 'fault' | 'point';
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
  /** True once a ResizeObserver has measured the host element so we
   * know what (W, H) to render at. Until then the view uses the
   * initial fallback dims (1500x1000). */
  @state() private measured = false;
  /** Live pane size, after measurement. */
  @state() private measuredW = 1500;
  @state() private measuredH = 1000;

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
      overflow: hidden;
      position: relative;
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
  firstUpdated(): void {
    const host = this.paneEl;
    if (!host || typeof ResizeObserver === 'undefined') return;
    this.ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.max(640, Math.floor(r.width));
      const h = Math.max(400, Math.floor(r.height - 4));
      if (w !== this.measuredW || h !== this.measuredH) {
        this.measuredW = w;
        this.measuredH = h;
        this.measured = true;
      }
    });
    this.ro.observe(host);
    this.measured = true;
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
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

    const rect = svg.getBoundingClientRect();
    const scaleX = svg.viewBox.baseVal.width / rect.width;
    const scaleY = svg.viewBox.baseVal.height / rect.height;
    const cursorPxI = (ev.clientX - rect.left) * scaleX;
    const cursorPxT = (ev.clientY - rect.top) * scaleY;

    /* Plot rectangle, for deciding whether the pointer is over the
     * chart at all. */
    const geom = projectDomain(paths[0]);
    const plot = geom
      ? geom.scale
      : { xMin: 0, xMax: Infinity, yMin: 0, yMax: Infinity };

    for (const p of paths) {
      const points = navFromPath(p);
      const proj = projectDomain(p);
      if (!proj) continue;
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
        if (distSq < bestDist) {
          const I_at_x = proj.domain.I_min * Math.pow(10, (projX - proj.scale.xMin) / (proj.scale.xMax - proj.scale.xMin) * (Math.log10(proj.domain.I_max) - Math.log10(proj.domain.I_min)));
          const t_at_y = proj.domain.t_max * Math.pow(10, -(projY - proj.scale.yMin) / (proj.scale.yMax - proj.scale.yMin) * (Math.log10(proj.domain.t_max) - Math.log10(proj.domain.t_min)));
          best = {
            pxI: projX,
            pxT: projY,
            I_A: I_at_x,
            t_s: t_at_y,
            curveLabel: p.getAttribute('data-curve') ?? '',
            voltage: p.getAttribute('data-voltage') ?? '',
            protocol: 'snap',
            pathD: '',
          };
          bestDist = distSq;
        }
      }
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
          voltage: '',
          protocol: 'snap',
          pathD: '',
          target: 'fault',
        };
      }
    }

    for (const group of Array.from(svg.querySelectorAll('g[data-point]'))) {
      const x = Number(group.getAttribute('data-px'));
      const y = Number(group.getAttribute('data-py'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const distSq = (cursorPxI - x) ** 2 + (cursorPxT - y) ** 2;
      if (distSq < bestDist) {
        bestDist = distSq;
        best = {
          pxI: x,
          pxT: y,
          I_A: Number(group.getAttribute('data-current')),
          t_s: Number(group.getAttribute('data-time')),
          curveLabel: group.getAttribute('data-point') ?? 'point',
          voltage: '',
          protocol: 'snap',
          pathD: '',
          target: 'point',
        };
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
    this.endPan();
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
    (this.querySelector('div.pane-host') as HTMLElement | null)?.classList.add('panning');
  }

  private handlePanMove(ev: MouseEvent): void {
    const pan = this.pan;
    if (!pan?.active) return;

    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;

    /* Convert screen pixels to SVG user units before dividing. */
    const rect = svg.getBoundingClientRect();
    const scaleX = (svg.viewBox.baseVal.width || rect.width) / rect.width;
    const dxUser = (ev.clientX - pan.startX) * scaleX;

    /* Drag right => look at lower currents, so the domain moves left. */
    const shift = -dxUser / pan.pxPerDecade;
    this.currentMin = Math.pow(10, pan.logLo + shift);
    this.currentMax = Math.pow(10, pan.logHi + shift);
  }

  private endPan(): void {
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
    const rect = svg.getBoundingClientRect();
    const viewBoxW = svg.viewBox.baseVal.width || rect.width;
    const px = ((ev.clientX - rect.left) / rect.width) * viewBoxW;

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

  resetZoom(): void {
    this.currentMin = null;
    this.currentMax = null;
  }

  /** Export the current SVG plot as a downloaded .svg file. */
  saveSvg(): void {
    const svg = this.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    // The renderer already emits width/height/viewBox/style and an
    // embedded <style> block with the curve / grid / axis colors.
    // Serialise it as-is so the file opens at the same size and color
    // scheme it had on-screen.
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tcc-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      const lightSvg = renderSvg(this.document, {
        page: page ?? null,
        system: null,
        faults: null,
        view: this.currentView(),
        study: this.study ?? null,
        theme: 'light',
        width: this.measuredW,
        height: this.measuredH,
      });

      const bytes = await exportPdf(lightSvg, {
        size: typeof page?.size === 'string' ? page.size : undefined,
        orientation: page?.orientation ?? 'landscape',
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
    const declared =
      (this.document?.items.find((i) => i.type === 'view') as
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
    const view: import('../parser/index.js').ViewBlock | null =
      (this.document.items.find((i: any) => i.type === 'view') as import('../parser/index.js').ViewBlock | undefined) ?? null;
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
            <dt>Hover</dt><dd>snap to the nearest curve (${SNAP_RADIUS_PX} px) and read I / t</dd>
            <dt>Wheel</dt><dd>zoom the current axis about the pointer</dd>
            <dt>Middle-drag</dt><dd>pan the current axis</dd>
            <dt>Reset</dt><dd>return to the view block's bounds</dd>
          </dl>
        </div>` : ''}
      <div class="pane-host"
           @mousedown=${(e: MouseEvent) => this.handleMouseDown(e)}
           @mousemove=${(e: MouseEvent) => this.handleMouseMove(e)}
           @mouseup=${() => this.endPan()}
           @mouseleave=${() => this.handleMouseLeave()}
           @auxclick=${(e: MouseEvent) => { if (e.button === 1) e.preventDefault(); }}
           @wheel=${(e: WheelEvent) => this.handleWheel(e)}>
        ${unsafeHTML(this.renderWithOverlay(svg))}
      </div>
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
    const lines: string[] = [];
    if (snapped && hover.curveLabel) lines.push(hover.curveLabel);
    lines.push(`I = ${prettyNum(hover.I_A)}`);
    /* A fault marker asserts a current, not a time. */
    if (hover.target !== 'fault') lines.push(`t = ${prettyTime(hover.t_s)}`);
    if (hover.target === 'fault') lines.push('fault level');
    if (snapped && hover.voltage) lines.push(hover.voltage);

    const lineH = 13;
    const padX = 7;
    const padY = 6;
    const charW = 6.1;
    const boxW = Math.max(...lines.map((l) => l.length)) * charW + padX * 2;
    const boxH = lines.length * lineH + padY * 2 - 2;

    // Prefer up-and-right of the point; flip when that would overflow.
    const flipX = px + 14 + boxW > xMin + w;
    const flipY = py - 14 - boxH < yMin;
    const boxX = flipX ? px - 14 - boxW : px + 14;
    const boxY = flipY ? py + 14 : py - 14 - boxH;

    const text = lines
      .map((l, i) => {
        const bold = i === 0 && snapped && hover.curveLabel ? ' font-weight="600"' : '';
        return `<text x="${(boxX + padX).toFixed(1)}" y="${(boxY + padY + 9 + i * lineH).toFixed(1)}"` +
          `${bold} font-size="11" fill="${escapeXmlAttr(this.readoutFg())}">${escapeXmlAttr(l)}</text>`;
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

  private renderCached(opts: RenderOptions): string {
    const key = JSON.stringify([
      this.docRevision,
      opts.width, opts.height, opts.theme,
      opts.view?.current_min, opts.view?.current_max,
      opts.view?.time_min, opts.view?.time_max,
      opts.highlightLabel, opts.highlightVoltage,
    ]);
    if (this.svgCache?.key === key) return this.svgCache.svg;
    const svg = renderSvg(this.document, opts);
    this.svgCache = { key, svg };
    return svg;
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
    }
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
