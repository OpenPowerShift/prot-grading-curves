/**
 * Sheet geometry: the pixel canvas a declared page should be drawn on.
 *
 * Its own module rather than part of the library barrel because the
 * browser needs it: importing it from `index.ts` drags in the Node
 * PNG exporter, and with it `fs`, `path`, and `child_process`, which
 * breaks the playground build.
 */

import type { PageBlock } from '../parser/ast.js';
import { resolvePageMm, DEFAULT_PAGE_MARGIN_MM } from '../export/export-pdf.js';

/**
 * Canvas size for a study, in pixels, matching its paper aspect.
 *
 * Scaled so the *long* edge is a fixed size, which keeps a portrait
 * and a landscape sheet at comparable detail rather than making
 * portrait output tiny.
 */
export function sheetSize(page: PageBlock | null): { width: number; height: number } {
  const LONG_EDGE_PX = 1400;
  const DEFAULT = { width: 1200, height: 750 };
  if (!page?.size && !page?.orientation) return DEFAULT;

  const [mmW, mmH] = resolvePageMm({
    size: typeof page.size === 'string' || (page.size && typeof page.size === 'object')
      ? page.size
      : undefined,
    orientation: page.orientation ?? 'landscape',
  });

  /*
   * Match the *printable* area, not the sheet.
   *
   * `exportPdf` scales uniformly to fit inside the margins, so the
   * aspect that has to agree is the margined one. Matching the raw
   * sheet instead left a portrait A4 study short of the top and bottom
   * margins -- 210:297 is not 190:277, and the difference is entirely
   * vertical slack, since the fit is width-limited.
   */
  const m = page.margins_mm;
  const inset = (side?: number): number => side ?? DEFAULT_PAGE_MARGIN_MM;
  const availW = Math.max(1, mmW - inset(m?.left) - inset(m?.right));
  const availH = Math.max(1, mmH - inset(m?.top) - inset(m?.bottom));

  const scale = LONG_EDGE_PX / Math.max(availW, availH);
  return {
    width: Math.round(availW * scale),
    height: Math.round(availH * scale),
  };
}
