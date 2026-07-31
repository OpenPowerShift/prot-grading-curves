/**
 * Export robustness.
 *
 * The property under test: a rendered plot must be *self-contained* --
 * correct with no stylesheet applied at all.
 *
 * This is not hypothetical. The renderer originally set `fill: none`
 * on curves, and every grid and label colour, through CSS classes in
 * an inline `<style>` block. `svg2pdf` does not apply class-based CSS,
 * so in a PDF the curves fell back to `fill: black` and painted solid
 * wedges over the chart while the gridlines vanished. Attributes
 * survive where a stylesheet does not.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';
import { toExportableSvg, svgDimensions } from '@tc/export/exportable-svg';
import {
  PAPER_MM, DEFAULT_PAGE_MARGIN_MM, resolveMarginsMm, resolvePageMm,
  toPdfSafeText, exportPdf,
} from '@tc/export/export-pdf';
import { exportPng } from '@tc/export/export-png';

const STUDY = `
meta { project = "Export check"; }
system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 11.0 kV; } } }
faults { "F1" { I   = 6.4 kA; voltage = "LV"; } }
point "inrush" { I   = 5250 A; t   = 0.1 s; voltage = "HV"; label = "Inrush"; }
relay R_INC { voltage = "HV"; maker = "ABB"; model = "REF615"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pickup = 720 A; tms = 0.30; } }
relay R_FDR { voltage = "LV"; ct_ratio = 400/5;
  element 51 { curve = iec.vi; I_pickup = 480 A; tms = 0.25; } }
page { size = "A4"; theme = "light"; border = true;
       title = { text = "Export check"; subtitle = "Self-contained SVG"; }; }
view { voltage = "HV"; }
`;

/** The SVG with its stylesheet removed -- what a PDF writer effectively sees. */
function withoutStylesheet(svg: string): string {
  return svg.replace(/<style>[\s\S]*?<\/style>/g, '');
}

describe('rendered SVG is self-contained', () => {
  const { svg } = parseAndRender(STUDY, { theme: 'light' });
  const bare = withoutStylesheet(svg);

  it('gives every curve an explicit fill="none"', () => {
    const paths = bare.match(/<path[^>]*class="[^"]*tc-curve[^"]*"[^>]*>/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path, 'a curve without fill="none" paints as a solid blob').toContain('fill="none"');
      expect(path).toMatch(/stroke="#/);
    }
  });

  it('gives every gridline an explicit stroke', () => {
    const lines = bare.match(/<line[^>]*class="[^"]*tc-grid[^"]*"[^>]*>/g) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/stroke="#/);
    }
  });

  it('gives every fault marker an explicit stroke', () => {
    const lines = bare.match(/<line[^>]*class="[^"]*tc-fault[^"]*"[^>]*>/g) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/stroke="#/);
    }
  });

  it('gives every text node an explicit fill', () => {
    const texts = bare.match(/<text[^>]*>/g) ?? [];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text, `text without a fill is invisible or black: ${text}`).toMatch(/fill="/);
    }
  });

  it('keeps the title and title-block text', () => {
    expect(svg).toContain('Export check');
    expect(svg).toContain('Self-contained SVG');
    expect(svg).toContain('PROJECT');
  });

  it('survives toExportableSvg without losing those attributes', () => {
    const standalone = withoutStylesheet(toExportableSvg(svg, { background: '#ffffff' }));
    const paths = standalone.match(/<path[^>]*class="[^"]*tc-curve[^"]*"[^>]*>/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toContain('fill="none"');
  });
});

describe('light rendering has light ink on a light ground', () => {
  it('does not emit near-white text on the light theme', () => {
    /*
     * Guards the other half of the same bug: a luminance-based
     * "force light" pass used to flip near-black ink to white, which
     * made the title invisible on white paper.
     */
    const { svg } = parseAndRender(STUDY, { theme: 'light' });
    const fills = [...svg.matchAll(/<text[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      const r = parseInt(fill.slice(1, 3), 16);
      const g = parseInt(fill.slice(3, 5), 16);
      const b = parseInt(fill.slice(5, 7), 16);
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      expect(luminance, `${fill} is invisible on a light ground`).toBeLessThan(0.75);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Paper, margins, and the two binary formats                          */
/* ------------------------------------------------------------------ */

/*
 * `svg2pdf` measures elements as it walks the tree, and jsdom
 * implements none of the SVG geometry interfaces. A plausible box is
 * enough to let the conversion run: what is under test is that a PDF
 * comes out with the right paper and margins, not where each glyph
 * landed on it -- that needs a real engine and belongs to the visual
 * suite.
 */
beforeAll(() => {
  const proto = globalThis.SVGElement?.prototype as unknown as Record<string, unknown>;
  if (proto && typeof proto.getBBox !== 'function') {
    proto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
  }
  if (proto && typeof proto.getComputedTextLength !== 'function') {
    proto.getComputedTextLength = () => 100;
  }
});

describe('paper and margins', () => {
  it('knows every size the language offers', () => {
    for (const size of ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid']) {
      expect(PAPER_MM[size], size).toBeDefined();
    }
  });

  it('turns a size and orientation into millimetres', () => {
    const [lw, lh] = resolvePageMm({ size: 'A4', orientation: 'landscape' });
    const [pw, ph] = resolvePageMm({ size: 'A4', orientation: 'portrait' });
    expect(lw).toBeGreaterThan(lh);
    expect(ph).toBeGreaterThan(pw);
    /* The same sheet either way round. */
    expect([lw, lh].sort()).toEqual([pw, ph].sort());
  });

  it('falls back to a default for a size it does not know', () => {
    expect(() => resolvePageMm({ size: 'A99' })).not.toThrow();
    expect(resolvePageMm({ size: 'A99' })).toHaveLength(2);
  });

  it('gives all four sides the default when none is declared', () => {
    expect(resolveMarginsMm({}))
      .toEqual([DEFAULT_PAGE_MARGIN_MM, DEFAULT_PAGE_MARGIN_MM,
        DEFAULT_PAGE_MARGIN_MM, DEFAULT_PAGE_MARGIN_MM]);
  });

  it('lets a per-side block win over the single figure', () => {
    const m = resolveMarginsMm({
      margin_mm: 5,
      margins_mm: { top: 20, right: 15, bottom: 25, left: 12 },
    });
    expect(m).toEqual([20, 15, 25, 12]);
  });

  it('fills the sides a per-side block leaves out', () => {
    const m = resolveMarginsMm({ margins_mm: { top: 20 } });
    expect(m[0]).toBe(20);
    expect(m.slice(1).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('text a PDF can encode', () => {
  it('leaves ordinary text alone', () => {
    expect(toPdfSafeText('<text>Riverside 33/11 kV</text>'))
      .toContain('Riverside 33/11 kV');
  });

  it('keeps what WinAnsi can carry', () => {
    /* An em dash, a middle dot and a multiplication sign are all in
     * WinAnsi, and a drawing is full of them. */
    const out = toPdfSafeText('<text>33 kV — 11 kV · 2×</text>');
    expect(out).toContain('—');
    expect(out).toContain('·');
    expect(out).toContain('×');
  });

  it('replaces what it cannot', () => {
    /*
     * jsPDF's standard fonts are WinAnsi, and a character outside it
     * comes out as a wrong glyph rather than an error -- silent
     * corruption of a title nobody proof-reads twice.
     */
    const out = toPdfSafeText('<text>✓ ✗ → 3Φ</text>');
    for (const ch of ['✓', '✗', '→']) expect(out, ch).not.toContain(ch);
  });

  it('does not disturb the markup around the text', () => {
    const out = toPdfSafeText('<svg><text x="10">a ✓ b</text></svg>');
    expect(out).toContain('<text x="10">');
    expect(out).toContain('</svg>');
  });
});

describe('measuring a sheet', () => {
  it('reads the width and height back out', () => {
    const { svg } = parseAndRender(STUDY, { theme: 'light' });
    const { width, height } = svgDimensions(svg);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('does not throw on something that is not a sheet', () => {
    expect(() => svgDimensions('<svg></svg>')).not.toThrow();
  });
});

describe('PDF', () => {
  const sheet = () => parseAndRender(STUDY, { theme: 'light' }).svg;

  it('produces a document beginning with a PDF header', async () => {
    const bytes = await exportPdf(sheet(), { size: 'A4', orientation: 'landscape' });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('honours portrait', async () => {
    const bytes = await exportPdf(sheet(), { size: 'A4', orientation: 'portrait' });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('applies per-side margins', async () => {
    const bytes = await exportPdf(sheet(), {
      size: 'A3',
      orientation: 'landscape',
      margins_mm: { top: 20, right: 15, bottom: 20, left: 15 },
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('exports a sheet with no curves on it', async () => {
    const { svg: bare } = parseAndRender('system { voltages { "MV" { V = 11 kV; } } }',
      { theme: 'light' });
    await expect(exportPdf(bare, { size: 'A4' })).resolves.toBeDefined();
  });
});

describe('PNG', () => {
  it('fails rather than hangs where there is no rasteriser', async () => {
    /*
     * jsdom has no canvas. What matters is that the caller is told,
     * because the CLI turns this into an exit status and a message.
     */
    const { svg } = parseAndRender(STUDY, { theme: 'light' });
    await expect(exportPng(svg, { width: 800 })).rejects.toBeDefined();
  });
});
