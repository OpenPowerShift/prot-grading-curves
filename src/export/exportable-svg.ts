/**
 * Self-contained SVG factory.
 *
 * The renderer's SVG is written for the *browser*: it leans on the
 * host page for fonts and can carry CSS custom properties. An export
 * has no host page -- a rasteriser, a PDF converter, or a file opened
 * years from now must reproduce it unaided. This module closes that
 * gap so that all three export paths start from identical markup.
 *
 * What it does:
 *   - guarantees the `xmlns` / `xmlns:xlink` declarations;
 *   - resolves any `var(--token, fallback)` down to its fallback,
 *     since a standalone file has no cascade to read the token from;
 *   - substitutes a concrete font stack for the generic families;
 *   - optionally prepends an XML prolog for files written to disk.
 */

export interface ExportableSvgOptions {
  /** Emit the `<?xml ... ?>` prolog (wanted for `.svg` files on disk). */
  xmlProlog?: boolean;
  /** Font stack baked into the root element. */
  fontFamily?: string;
  /** Background painted behind the plot; `null` keeps it transparent. */
  background?: string | null;
  /** Override the pixel width/height attributes (viewBox is untouched). */
  width?: number;
  height?: number;
}

const DEFAULT_FONT =
  "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/**
 * Replace `var(--token, fallback)` with its fallback, and drop
 * fallback-less tokens to `currentColor` so nothing renders invisible.
 */
function resolveCssVars(svg: string): string {
  let out = svg;
  let previous: string;
  /* Loop because a fallback may itself contain a `var()`. */
  do {
    previous = out;
    out = out.replace(/var\(\s*--[\w-]+\s*,\s*([^()]*?)\s*\)/g, '$1');
  } while (out !== previous);
  return out.replace(/var\(\s*--[\w-]+\s*\)/g, 'currentColor');
}

/** Turn a rendered SVG string into a standalone document. */
export function toExportableSvg(svg: string, options: ExportableSvgOptions = {}): string {
  const font = options.fontFamily ?? DEFAULT_FONT;
  let out = resolveCssVars(svg);

  const openTag = out.match(/<svg\b[^>]*>/);
  if (openTag) {
    let tag = openTag[0];
    if (!/\bxmlns=/.test(tag)) {
      tag = tag.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!/\bxmlns:xlink=/.test(tag)) {
      tag = tag.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    tag = /\bfont-family=/.test(tag)
      ? tag.replace(/font-family="[^"]*"/, `font-family="${escapeAttr(font)}"`)
      : tag.replace(/^<svg/, `<svg font-family="${escapeAttr(font)}"`);

    if (options.width != null) {
      tag = /\bwidth=/.test(tag)
        ? tag.replace(/\bwidth="[^"]*"/, `width="${options.width}"`)
        : tag.replace(/^<svg/, `<svg width="${options.width}"`);
    }
    if (options.height != null) {
      tag = /\bheight=/.test(tag)
        ? tag.replace(/\bheight="[^"]*"/, `height="${options.height}"`)
        : tag.replace(/^<svg/, `<svg height="${options.height}"`);
    }

    out = out.replace(openTag[0], tag);

    /*
     * The sheet carries its own paper colour on the root element, as
     * `style="background:#1a1a19"` -- and that is CSS, which a
     * rasteriser is free to ignore, and every one of them does. So a
     * dark sheet exported to SVG or PNG came out on white paper with
     * white ink: the legend's curve names, the title and the title
     * block's values were all invisible, and the drawing looked blank
     * where it mattered most.
     *
     * Taking the declared colour as the default means the caller no
     * longer has to know the theme to export it correctly -- the CLI
     * never passed one, which is why both its paths were affected.
     */
    const declared = /style="[^"]*background:\s*([^;"']+)/.exec(tag)?.[1]?.trim();
    const background = options.background ?? declared;

    if (background) {
      /* A painted rect beats a `style` background: rasterisers honour
       * geometry far more consistently than root-element CSS. */
      out = out.replace(
        tag,
        `${tag}\n<rect x="0" y="0" width="100%" height="100%" fill="${escapeAttr(background)}"/>`,
      );
    }
  }

  return options.xmlProlog ? `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${out}` : out;
}

/** Width/height declared on the root element, for sizing a raster. */
export function svgDimensions(svg: string): { width: number; height: number } {
  const w = svg.match(/<svg\b[^>]*\bwidth="([\d.]+)"/);
  const h = svg.match(/<svg\b[^>]*\bheight="([\d.]+)"/);
  if (w && h) return { width: Number(w[1]), height: Number(h[1]) };

  const viewBox = svg.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
  if (viewBox) return { width: Number(viewBox[3]), height: Number(viewBox[4]) };
  return { width: 1200, height: 750 };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
