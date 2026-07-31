/**
 * `page` block options.
 *
 * Each of these was parsed and validated but ignored by the renderer;
 * these tests pin that the declaration now changes the output.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender, sheetSize } from '@tc/index';

const BASE = `
meta { project = "Page options"; engineer = "A. Cooper"; }
system { voltages { "MV" { V  = 11.0 kV; } } }
faults { "F" { I   = 4000 A; } }
relay R { voltage = "MV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; } }
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

    /*
     * The aspect that has to match is the *printable* area, not the
     * sheet: `exportPdf` fits the plot inside the margins, so matching
     * 210:297 would leave the sheet short of its top and bottom
     * margins. A4 less the default 10 mm on each side is 190 x 277.
     */
    expect(lw / lh).toBeCloseTo(277 / 190, 2);
    expect(ph / pw).toBeCloseTo(277 / 190, 2);
  });

  it('reads a scalar margin as all four sides', () => {
    const src = BASE + 'page { size = "A4"; orientation = "portrait"; margins_mm = 0; }';
    const { svg, result } = parseAndRender(src, { theme: 'light' });

    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);

    /* Zero margins means the drawing matches the whole sheet, 210:297. */
    const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
    expect(Number(h) / Number(w)).toBeCloseTo(297 / 210, 2);
  });

  it('honours declared margins when sizing the sheet', () => {
    const wide = sheetSize({
      type: 'page', size: 'A4', orientation: 'portrait',
      margins_mm: { top: 40, bottom: 40, left: 10, right: 10 },
      loc: { line: 1, column: 1, offset: 0 },
    } as never);

    /* 190 x 217 once 40 mm is taken off each of top and bottom. */
    expect(wide.height / wide.width).toBeCloseTo(217 / 190, 2);
  });

  it('leaves the default canvas alone when no page is declared', () => {
    const { svg } = parseAndRender(BASE, { theme: 'light' });
    expect(svg).toContain('viewBox="0 0 1200 750"');
  });
});

describe('page { stretch }', () => {
  const study = (page: string): string =>
    parseAndRender(BASE + `page { ${page} }`, { theme: 'light' }).svg;

  /** The plot rectangle the renderer embeds for the viewer. */
  const plotRect = (svg: string): { x: number; y: number; w: number; h: number } => {
    const [x, y, w, h] = svg.match(/data-plot="([^"]+)"/)![1].split(',').map(Number);
    return { x, y, w, h };
  };

  it('gives the plot the band the furniture does not need', () => {
    const plain = plotRect(study('size = "A4"; orientation = "portrait";'));
    const tall = plotRect(study('size = "A4"; orientation = "portrait"; stretch = true;'));

    expect(tall.h).toBeGreaterThan(plain.h);
    /* Only the vertical is affected. */
    expect(tall.w).toBe(plain.w);
    expect(tall.y).toBe(plain.y);
  });

  it('still reserves room for the fault names it has to draw', () => {
    /*
     * Two faults far enough apart to pack onto one row, versus several
     * at similar currents that must stack. The stacked case has to end
     * up with the shorter plot, or the names collide with the axis
     * title.
     */
    const oneRow = `
      faults { "A" { I   = 200 A; voltage = hv; } "B" { I   = 9 kA; voltage = hv; } }
      page { size = "A4"; orientation = "portrait"; stretch = true; }
    `;
    const manyRows = `
      faults {
        "F_alpha_one" { I   = 3000 A; voltage = hv; }
        "F_alpha_two" { I   = 3100 A; voltage = hv; }
        "F_alpha_three" { I   = 3200 A; voltage = hv; }
        "F_alpha_four" { I   = 3300 A; voltage = hv; }
      }
      page { size = "A4"; orientation = "portrait"; stretch = true; }
    `;

    const a = plotRect(parseAndRender(BASE + oneRow, { theme: 'light' }).svg);
    const b = plotRect(parseAndRender(BASE + manyRows, { theme: 'light' }).svg);
    expect(b.h).toBeLessThan(a.h);
  });

  it('leaves the default layout alone', () => {
    const off = plotRect(study('size = "A4"; orientation = "portrait"; stretch = false;'));
    const absent = plotRect(study('size = "A4"; orientation = "portrait";'));
    expect(off.h).toBe(absent.h);
  });
});
