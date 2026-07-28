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

import { describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';
import { toExportableSvg } from '@tc/export/exportable-svg';

const STUDY = `
meta { project = "Export check"; }
system { voltages { "HV" { kV = 33.0; } "LV" { kV = 11.0; } } }
faults { "F1" { I_A = 6.4 kA; voltage = "LV"; } }
point "inrush" { I_A = 5250 A; t_s = 0.1 s; voltage = "HV"; label = "Inrush"; }
relay R_INC { voltage = "HV"; maker = "ABB"; model = "REF615"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pu = 720 A; tms = 0.30; } }
relay R_FDR { voltage = "LV"; ct_ratio = 400/5;
  element 51 { curve = iec.vi; I_pu = 480 A; tms = 0.25; } }
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
