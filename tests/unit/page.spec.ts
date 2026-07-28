/**
 * `page` block options.
 *
 * Each of these was parsed and validated but ignored by the renderer;
 * these tests pin that the declaration now changes the output.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';

const BASE = `
meta { project = "Page options"; engineer = "A. Cooper"; }
system { voltages { "MV" { kV = 11.0; } } }
faults { "F" { I_A = 4000 A; } }
relay R { voltage = "MV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pu = 400 A; tms = 0.3; } }
`;

const render = (page: string): string =>
  parseAndRender(`${BASE}\npage { ${page} }`, { theme: 'light' }).svg;

describe('page.legend', () => {
  it('drops the legend column when show = false', () => {
    expect(render('theme = "light";')).toContain('Curves');
    expect(render('theme = "light"; legend { show = false; }')).not.toContain('>Curves<');
  });

  it('honours a custom legend title', () => {
    expect(render('legend { title = "Devices"; }')).toContain('>Devices<');
  });
});

describe('page.axes', () => {
  it('overrides the grid colour', () => {
    expect(render('axes { grid_color = "#ff00ff"; }')).toContain('#ff00ff');
  });

  it('removes the plot frame when frame = false', () => {
    /* The plot rectangle is the one drawn with crisp edges. */
    const plotRect = (svg: string): string =>
      svg.match(/<rect[^>]*shape-rendering="crispEdges"[^>]*>/)![0];

    expect(plotRect(render('axes { frame = true; }'))).toMatch(/stroke="#/);
    expect(plotRect(render('axes { frame = false; }'))).toContain('stroke="none"');
  });
});

describe('page.curves', () => {
  it('sets the data line width', () => {
    expect(render('curves { line_width_px = 4; }')).toMatch(/class="tc-curve"[^>]*stroke-width="4"/);
  });
});

describe('page.scale', () => {
  it('thins the grid at sparse density', () => {
    const sparse = (render('scale { tick_density = "sparse"; }').match(/tc-grid/g) ?? []).length;
    const normal = (render('scale { tick_density = "normal"; }').match(/tc-grid/g) ?? []).length;
    expect(sparse).toBeLessThan(normal);
  });
});

describe('page.footer', () => {
  it('renders the three slots and expands macros', () => {
    const svg = render('footer { left = "[meta.project]"; center = "[meta.engineer]"; right = "[page] / [of]"; }');
    expect(svg).toContain('Page options');
    expect(svg).toContain('A. Cooper');
    /* Spec: pagination macros resolve to "?" for a single SVG. */
    expect(svg).toContain('? / ?');
  });

  it('gives way to the title block on a bordered sheet', () => {
    const svg = render('border = true; footer { left = "[meta.project]"; }');
    /* The title block already carries the project; no duplicate footer. */
    expect((svg.match(/Page options/g) ?? []).length).toBe(1);
  });
});

describe('sheet aspect ratio', () => {
  it('matches the declared paper, so a portrait study fills its page', () => {
    const landscape = render('size = "A4"; orientation = "landscape";');
    const portrait = render('size = "A4"; orientation = "portrait";');

    const box = (svg: string): [number, number] => {
      const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
      return [Number(m[1]), Number(m[2])];
    };

    const [lw, lh] = box(landscape);
    const [pw, ph] = box(portrait);

    expect(lw).toBeGreaterThan(lh);
    expect(ph).toBeGreaterThan(pw);
    /* A4 is 1:sqrt(2) either way round. */
    expect(lw / lh).toBeCloseTo(Math.SQRT2, 1);
    expect(ph / pw).toBeCloseTo(Math.SQRT2, 1);
  });

  it('leaves the default canvas alone when no page is declared', () => {
    const { svg } = parseAndRender(BASE, { theme: 'light' });
    expect(svg).toContain('viewBox="0 0 1200 750"');
  });
});
