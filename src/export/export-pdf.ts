/**
 * PDF export.
 *
 * `jspdf` + `svg2pdf.js`, both loaded lazily -- they are the heaviest
 * dependencies in the tree and no consumer should pay for them unless
 * it actually asks for a PDF.
 *
 * The page size comes from the study's `page { size; orientation; }`
 * block so the printed sheet matches what the engineer declared
 * (spec: _Paper sizes and orientation_).
 */

import { svgDimensions, toExportableSvg } from './exportable-svg.js';

/** Built-in paper sizes in millimetres (spec: _Paper sizes_). */
export const PAPER_MM: Record<string, [number, number]> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
};

export interface PdfOptions {
  /** Paper keyword (`"A4"`) or explicit millimetre dimensions. */
  size?: string | { width_mm: number; height_mm: number };
  /** TCC plots default to landscape -- the X axis is logarithmic. */
  orientation?: 'portrait' | 'landscape';
  /** Page margin in millimetres, applied on all four sides. */
  margin_mm?: number;
}

/**
 * Font stack for PDF output.
 *
 * A PDF has no font fallback chain: whatever the SVG names must be a
 * font the writer can actually resolve, or the text is dropped or
 * silently substituted. `jspdf` ships the PDF standard-14, of which
 * Helvetica is the sane choice for chart labels, so the export is
 * pinned to it rather than to the screen stack (`ui-monospace`,
 * `SFMono-Regular`, ...) which exists on no PDF reader.
 */
const PDF_FONT = 'helvetica, Helvetica, Arial, sans-serif';

/** Resolve a size declaration to `[width_mm, height_mm]`, oriented. */
export function resolvePageMm(options: PdfOptions = {}): [number, number] {
  const orientation = options.orientation ?? 'landscape';

  let portrait: [number, number];
  if (options.size && typeof options.size === 'object') {
    portrait = [options.size.width_mm, options.size.height_mm];
  } else {
    const key = typeof options.size === 'string' ? options.size : 'A4';
    const match = Object.keys(PAPER_MM).find((k) => k.toLowerCase() === key.toLowerCase());
    portrait = PAPER_MM[match ?? 'A4'];
  }

  const [short, long] = portrait[0] <= portrait[1] ? portrait : [portrait[1], portrait[0]];
  return orientation === 'landscape' ? [long, short] : [short, long];
}

/**
 * Convert an SVG string to PDF bytes.
 *
 * The plot is scaled to fit inside the margins while preserving its
 * aspect ratio, and centred on the sheet -- a TCC stretched to fill a
 * page would misrepresent the log-log geometry.
 */
export async function exportPdf(svg: string, options: PdfOptions = {}): Promise<Uint8Array> {
  let jsPDF: typeof import('jspdf').jsPDF;
  let svg2pdf: typeof import('svg2pdf.js').svg2pdf;
  try {
    const jspdfMod = await import('jspdf');
    jsPDF = jspdfMod.jsPDF ?? (jspdfMod as unknown as { default: typeof jsPDF }).default;

    /*
     * `svg2pdf.js` ships both a named and a default export, and which
     * one a loader hands back differs: a bundler resolves the named
     * one, Node's ESM resolution gives only `default` (itself a
     * namespace object). Accepting either is what makes the CLI work
     * as well as the playground.
     */
    const svgMod = await import('svg2pdf.js');
    const nested = (svgMod as unknown as { default?: { svg2pdf?: typeof svg2pdf } }).default;
    svg2pdf = svgMod.svg2pdf ?? nested?.svg2pdf ?? (nested as unknown as typeof svg2pdf);

    if (typeof svg2pdf !== 'function') {
      throw new Error('svg2pdf.js did not export a callable svg2pdf');
    }
  } catch (cause) {
    throw new Error(
      'PDF export needs jspdf and svg2pdf.js, which failed to load. ' +
      'Install them (npm i jspdf svg2pdf.js) or export SVG instead.',
      { cause },
    );
  }

  const [pageW, pageH] = resolvePageMm(options);
  const margin = options.margin_mm ?? 10;

  /*
   * PDFs are printed and filed, so callers render a *light* plot and
   * pass it in. There is deliberately no colour-flipping here: an
   * earlier version remapped greys by luminance to force light output,
   * and on an already-light plot it turned the near-black title ink
   * white -- invisible on white paper. Rendering the right thing beats
   * recolouring the wrong thing.
   */
  const standalone = normaliseFontWeights(
    toExportableSvg(svg, { background: '#ffffff', fontFamily: PDF_FONT }),
  );
  const { width: srcW, height: srcH } = svgDimensions(standalone);

  const availW = Math.max(1, pageW - 2 * margin);
  const availH = Math.max(1, pageH - 2 * margin);
  const scale = Math.min(availW / srcW, availH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;

  const doc = new jsPDF({
    orientation: pageW >= pageH ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [pageW, pageH],
  });

  try {
    await svg2pdf(await parseSvgElement(standalone), doc, {
      x: (pageW - drawW) / 2,
      y: (pageH - drawH) / 2,
      width: drawW,
      height: drawH,
    });
    return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
  } finally {
    /* Leave the caller's globals as we found them. */
    restoreGlobals?.();
  }
}

/**
 * Map numeric font weights onto the two a PDF core font has.
 *
 * The renderer uses `font-weight="600"` for emphasis, which is a CSS
 * weight, not a PDF one: the standard-14 fonts come in regular and
 * bold only. `jspdf` cannot resolve "600normal", warns, and falls back
 * to regular -- so headings quietly lose their emphasis. Anything 600
 * or above becomes bold, everything else regular.
 */
function normaliseFontWeights(svg: string): string {
  return svg.replace(/font-weight\s*[:=]\s*"?(\d{3})"?/g, (match, weight: string) => {
    const bold = Number(weight) >= 600;
    return match.includes('=')
      ? `font-weight="${bold ? 'bold' : 'normal'}"`
      : `font-weight:${bold ? 'bold' : 'normal'}`;
  });
}

/**
 * `svg2pdf` walks a live DOM element, so the string has to be parsed
 * into one first.
 *
 * A browser has `DOMParser` already. Under Node there is none, so
 * `jsdom` is loaded lazily and a minimal DOM is stood up for the
 * duration of the conversion -- that is what makes
 * `tc-curves render --pdf` work from a build script. `jsdom` is an
 * optional dependency: if it is absent the error says exactly what to
 * install rather than failing on an undefined global.
 */
async function parseSvgElement(svg: string): Promise<Element> {
  if (typeof DOMParser !== 'undefined') {
    return finishParse(new DOMParser().parseFromString(svg, 'image/svg+xml'));
  }

  let JSDOM: typeof import('jsdom').JSDOM;
  try {
    /*
     * The specifier is held in a variable and marked `@vite-ignore` so
     * the bundler cannot resolve it statically.
     *
     * jsdom is pure JavaScript, so a bundler will happily inline it --
     * which put 5.8 MB of Node-only DOM implementation into the
     * browser bundle, for a branch a browser never reaches (it returns
     * above, where `DOMParser` already exists). The sibling native
     * module `@resvg/resvg-js` escapes this only because a bundler
     * cannot inline a `.node` binary.
     */
    const specifier = 'jsdom';
    ({ JSDOM } = (await import(/* @vite-ignore */ specifier)) as typeof import('jsdom'));
  } catch (cause) {
    throw new Error(
      'PDF export needs a DOM. Install jsdom (npm i jsdom) to export PDFs from Node, ' +
      'or export SVG and convert it separately.',
      { cause },
    );
  }

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { window } = dom;

  /*
   * `svg2pdf` and `jspdf` reach for these as globals rather than
   * taking them as arguments, so they have to be present on
   * `globalThis` for the duration of the call.
   */
  const globals = globalThis as Record<string, unknown>;
  const source = window as unknown as Record<string, unknown>;
  const added: string[] = [];

  /*
   * Copy the window's DOM surface onto `globalThis` wholesale rather
   * than enumerating what the libraries touch. `svg2pdf` reaches for
   * `CSSStyleSheet`, `getComputedStyle`, `Node`, and more besides,
   * and chasing them one failure at a time is a losing game.
   *
   * Only *missing* globals are added, so Node's own (`navigator`,
   * `fetch`, ...) are left alone -- several are getter-only and would
   * throw. Everything added is recorded and removed afterwards, so a
   * library consumer's environment is not permanently mutated.
   */
  const skip = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames', 'location']);
  for (const key of Object.getOwnPropertyNames(source)) {
    if (skip.has(key) || key in globals) continue;
    try {
      Object.defineProperty(globals, key, {
        value: source[key],
        configurable: true,
        writable: true,
      });
      added.push(key);
    } catch {
      /* Read-only or exotic descriptor; the libraries can live without it. */
    }
  }

  /* `window` and `document` are needed even though `window` is skipped
   * above (it would otherwise self-reference). */
  for (const key of ['window', 'document'] as const) {
    if (key in globals) continue;
    try {
      Object.defineProperty(globals, key, {
        value: key === 'window' ? source : source.document,
        configurable: true,
        writable: true,
      });
      added.push(key);
    } catch {
      /* As above. */
    }
  }

  installSvgGeometryShim(source);

  restoreGlobals = () => {
    for (const key of added) {
      try { delete globals[key]; } catch { /* leave it */ }
    }
    restoreGlobals = null;
  };

  return finishParse(new window.DOMParser().parseFromString(svg, 'image/svg+xml'));
}

/** Set while a Node-side DOM is installed, so it can be torn down. */
let restoreGlobals: (() => void) | null = null;

/**
 * Give jsdom's SVG elements just enough geometry for `svg2pdf`.
 *
 * jsdom implements the SVG DOM but not SVG *layout*, so `getBBox`,
 * `getCTM`, and friends are absent -- and `svg2pdf` calls them to
 * place anchored text. Rather than abandon Node-side PDF export, the
 * few methods it needs are approximated.
 *
 * The approximation is good because the input is ours: every label the
 * renderer emits is a single line in a known font at a known size, so
 * width follows from the character count and the font's mean advance.
 * That is enough to resolve `text-anchor` correctly, which is the only
 * thing the measurement is used for here.
 */
function installSvgGeometryShim(win: Record<string, unknown>): void {
  /*
   * jsdom gives every SVG tag the `SVGElement` interface -- a `<text>`
   * node's prototype chain is SVGElement -> Element -> Node, and never
   * reaches `SVGGraphicsElement`. So the shim has to land on
   * `SVGElement.prototype`; patching the graphics interface alone did
   * nothing.
   */
  for (const ctorName of ['SVGElement', 'SVGGraphicsElement'] as const) {
    const ctor = win[ctorName] as { prototype: Record<string, unknown> } | undefined;
    if (ctor?.prototype) patchGeometry(ctor.prototype);
  }
}

function patchGeometry(proto: Record<string, unknown>): void {
  if (typeof proto.getBBox !== 'function') {
    proto.getBBox = function getBBox(this: Element): DOMRect {
      const num = (name: string, fallback = 0): number => {
        const raw = this.getAttribute(name);
        const parsed = raw == null ? NaN : parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      if (this.tagName === 'text') {
        const fontSize = num('font-size', 12);
        /* Helvetica's mean advance is close to 0.52 em for mixed case. */
        const width = (this.textContent ?? '').length * fontSize * 0.52;
        const x = num('x');
        const y = num('y');
        const anchor = this.getAttribute('text-anchor');
        const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
        return rect(left, y - fontSize * 0.8, width, fontSize * 1.1);
      }

      if (this.tagName === 'rect') {
        return rect(num('x'), num('y'), num('width'), num('height'));
      }
      if (this.tagName === 'line') {
        const x1 = num('x1'); const x2 = num('x2');
        const y1 = num('y1'); const y2 = num('y2');
        return rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      if (this.tagName === 'circle') {
        const r = num('r');
        return rect(num('cx') - r, num('cy') - r, r * 2, r * 2);
      }
      /* Paths and groups: the caller only needs a finite box. */
      return rect(0, 0, 0, 0);
    };
  }

  if (typeof proto.getComputedTextLength !== 'function') {
    proto.getComputedTextLength = function getComputedTextLength(this: Element): number {
      const fontSize = parseFloat(this.getAttribute('font-size') ?? '12') || 12;
      return (this.textContent ?? '').length * fontSize * 0.52;
    };
  }

  for (const name of ['getCTM', 'getScreenCTM'] as const) {
    if (typeof proto[name] !== 'function') {
      proto[name] = function identityMatrix(): unknown {
        const Matrix = (globalThis as Record<string, unknown>).DOMMatrix as
          (new () => unknown) | undefined;
        return Matrix ? new Matrix() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      };
    }
  }
}

/** A plain object shaped like a `DOMRect`, which is all callers read. */
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x, y, width, height,
    top: y, left: x, right: x + width, bottom: y + height,
    toJSON() { return this; },
  } as DOMRect;
}

function finishParse(parsed: XMLDocument | Document): Element {
  const root = parsed.documentElement;
  if (!root || root.nodeName === 'parsererror') {
    throw new Error('PDF export failed: the rendered SVG did not parse.');
  }
  return root;
}
