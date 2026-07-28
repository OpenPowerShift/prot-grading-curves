/**
 * PNG export.
 *
 * Two backends, one result: `@resvg/resvg-js` under Node (a real
 * rasteriser, no browser needed) and the canvas under a browser. Both
 * are reached through the same call so the CLI, the playground, and
 * the Asciidoctor extension cannot drift apart in what they produce.
 *
 * Both dependencies are loaded *lazily*: `@resvg/resvg-js` is a native
 * addon that must never be pulled into a browser bundle, and the
 * canvas path must never be attempted under Node.
 */

import { toExportableSvg, svgDimensions } from './exportable-svg.js';

export interface PngOptions {
  /** Output width in pixels; height follows the SVG's aspect ratio. */
  width?: number;
  /** Scale factor applied when `width` is not given (2 = retina). */
  scale?: number;
  /** Background colour; `null` keeps the alpha channel transparent. */
  background?: string | null;
}

const isNode =
  typeof process !== 'undefined' &&
  process.versions?.node != null &&
  typeof window === 'undefined';

/**
 * Rasterise an SVG string to PNG bytes.
 *
 * Returns a `Uint8Array` in both environments -- callers that want a
 * Node `Buffer` can wrap it, and browser callers can hand it straight
 * to `Blob`.
 */
export async function exportPng(svg: string, options: PngOptions = {}): Promise<Uint8Array> {
  const standalone = toExportableSvg(svg, {
    background: options.background ?? '#ffffff',
  });
  return isNode ? renderWithResvg(standalone, options) : renderWithCanvas(standalone, options);
}

/** Node path: `@resvg/resvg-js`. */
async function renderWithResvg(svg: string, options: PngOptions): Promise<Uint8Array> {
  let Resvg: typeof import('@resvg/resvg-js').Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch (cause) {
    throw new Error(
      'PNG export needs @resvg/resvg-js, which failed to load. ' +
      'Install it (npm i @resvg/resvg-js) or export SVG instead.',
      { cause },
    );
  }

  const fitTo: { mode: 'width'; value: number } | { mode: 'zoom'; value: number } =
    options.width != null
      ? { mode: 'width', value: Math.round(options.width) }
      : { mode: 'zoom', value: options.scale ?? 2 };

  const resvg = new Resvg(svg, {
    fitTo,
    background: options.background ?? undefined,
    font: { loadSystemFonts: true },
  });
  return new Uint8Array(resvg.render().asPng());
}

/** Browser path: draw the SVG into a canvas and read it back. */
async function renderWithCanvas(svg: string, options: PngOptions): Promise<Uint8Array> {
  const { width: srcW, height: srcH } = svgDimensions(svg);
  const scale = options.width != null ? options.width / srcW : options.scale ?? 2;
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('PNG export failed: this browser gave no 2D canvas context.');

    if (options.background) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(image, 0, 0, width, height);

    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!out) throw new Error('PNG export failed: canvas.toBlob returned nothing.');
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('PNG export failed: the SVG could not be decoded.'));
    image.src = url;
  });
}
