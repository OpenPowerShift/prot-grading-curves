/**
 * Exported sheets are drawn at the declared page's proportions.
 *
 * The playground sizes its on-screen plot to the pane, which is wide
 * and short. Handing that canvas to `exportPdf` for a portrait study
 * letterboxed it into the middle of the page and left over half the
 * height empty. These tests pin the arithmetic that makes the drawing
 * fill the paper, and the mismatch that used to break it.
 */

import { describe, expect, it } from 'vitest';
import { sheetSize } from '@tc/index';
import { resolveMarginsMm, resolvePageMm } from '@tc/export/export-pdf';
import type { PageBlock } from '@tc/parser';

const LOC = { line: 1, column: 1, offset: 0 };

/** Fraction of the printable area a source canvas covers once fitted. */
function coverage(
  page: PageBlock,
  src: { width: number; height: number },
): { width: number; height: number } {
  const [pageW, pageH] = resolvePageMm({
    size: typeof page.size === 'string' ? page.size : undefined,
    orientation: page.orientation ?? 'landscape',
  });
  const [top, right, bottom, left] = resolveMarginsMm({ margins_mm: page.margins_mm });

  const availW = pageW - left - right;
  const availH = pageH - top - bottom;
  const scale = Math.min(availW / src.width, availH / src.height);

  return {
    width: (src.width * scale) / availW,
    height: (src.height * scale) / availH,
  };
}

const A4_PORTRAIT: PageBlock = {
  type: 'page', size: 'A4', orientation: 'portrait', loc: LOC,
} as PageBlock;

describe('sheet-sized exports', () => {
  it('fills the printable area in both directions', () => {
    const fit = coverage(A4_PORTRAIT, sheetSize(A4_PORTRAIT));
    expect(fit.width).toBeGreaterThan(0.99);
    expect(fit.height).toBeGreaterThan(0.99);
  });

  it('fills it for a landscape sheet too', () => {
    const page = { ...A4_PORTRAIT, orientation: 'landscape' } as PageBlock;
    const fit = coverage(page, sheetSize(page));
    expect(fit.width).toBeGreaterThan(0.99);
    expect(fit.height).toBeGreaterThan(0.99);
  });

  it('still fills it when the study trims its margins', () => {
    const page = {
      ...A4_PORTRAIT,
      margins_mm: { top: 4, right: 4, bottom: 4, left: 4, loc: LOC },
    } as PageBlock;
    const fit = coverage(page, sheetSize(page));
    expect(fit.width).toBeGreaterThan(0.99);
    expect(fit.height).toBeGreaterThan(0.99);
  });

  it('wastes most of the height if a pane-shaped canvas is exported instead', () => {
    /*
     * The defect this guards: a 1500x1000 pane canvas fitted to a
     * portrait page covers the width but under half the height. If
     * this ever stops being true the fit maths has changed and the
     * assertions above need rereading.
     */
    const fit = coverage(A4_PORTRAIT, { width: 1500, height: 1000 });
    expect(fit.width).toBeCloseTo(1, 2);
    expect(fit.height).toBeLessThan(0.5);
  });
});
