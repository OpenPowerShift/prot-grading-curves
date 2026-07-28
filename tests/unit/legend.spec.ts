/**
 * Legend placement: `page { legend { style = ... } }`.
 *
 * The column is the default and reserves a gutter. The other three
 * modes exist because that gutter is expensive on a portrait sheet,
 * so each test checks both halves of the bargain: that the mode draws
 * what it promises, and that the plot actually gets the width back.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';

const BASE = `
meta { project = "Legend"; }
system { voltages { hv { kV = 33; } lv { kV = 11; } } }
faults {
  "F_lv" { I_A = 6 kA; voltage = lv; }
  "F_hv" { I_A = 18 kA; voltage = hv; }
}
relay R_INC {
  voltage = hv;
  element 51 { curve = iec.si; I_pu = 720 A; tms = 0.3; }
}
relay R_FDR {
  voltage = lv;
  element 51 { curve = iec.vi; I_pu = 480 A; tms = 0.25; }
  element 50 { curve = definite; I_pu = 3.2 kA; t_delay = 50 ms; }
}
point "P" { I_A = 5 kA; t_s = 0.1 s; voltage = hv; label = "inrush"; }
view { voltage = hv; }
`;

function render(legend?: string): string {
  const page = legend ? `page { legend { ${legend} } }` : '';
  return parseAndRender(BASE + page, { theme: 'light' }).svg;
}

/** Width of the plot frame, read back out of the embedded plot rect. */
function plotWidth(svg: string): number {
  const desc = svg.match(/<desc data-plot="([^"]+)"/);
  if (desc) {
    const [, , w] = desc[1].split(',').map(Number);
    return w;
  }
  /* Fall back to the frame rect the renderer draws. */
  const rect = svg.match(/<rect x="92"[^>]*width="([\d.]+)"/);
  return Number(rect![1]);
}

const CURVE_LABELS = ['R_INC:51', 'R_FDR:51', 'R_FDR:50'];

describe('column legend (the default)', () => {
  const svg = render();

  it('draws the headed panel', () => {
    expect(svg).toContain('>Curves</text>');
    expect(svg).toContain('>Points</text>');
    expect(svg).toContain('>Faults</text>');
  });

  it('names every curve', () => {
    for (const label of CURVE_LABELS) expect(svg).toContain(`>${label}</text>`);
  });
});

describe('style = "inside"', () => {
  const svg = render('style = "inside";');

  it('keeps the whole panel, sections and all', () => {
    expect(svg).toContain('>Curves</text>');
    expect(svg).toContain('>Points</text>');
    expect(svg).toContain('>Faults</text>');
    for (const label of CURVE_LABELS) expect(svg).toContain(`>${label}</text>`);
  });

  it('gives the freed gutter to the plot', () => {
    expect(plotWidth(svg)).toBeGreaterThan(plotWidth(render()) + 200);
  });

  it('backs the panel with an opaque card, so the grid does not read through', () => {
    expect(svg).toMatch(/<rect [^>]*fill-opacity="0\.92"[^>]*stroke-width="0\.8"\/>/);
  });

  it('pins the panel to the requested corner', () => {
    const cardX = (s: string): number =>
      Number(s.match(/<rect x="([\d.]+)"[^>]*fill-opacity="0\.92"/)![1]);
    const cardY = (s: string): number =>
      Number(s.match(/<rect x="[\d.]+" y="([\d.]+)"[^>]*fill-opacity="0\.92"/)![1]);

    const topRight = render('style = "inside"; position = "top_right";');
    const topLeft = render('style = "inside"; position = "top_left";');
    const bottomRight = render('style = "inside"; position = "bottom_right";');

    expect(cardX(topLeft)).toBeLessThan(cardX(topRight));
    expect(cardY(bottomRight)).toBeGreaterThan(cardY(topRight));
  });
});

describe('style = "direct"', () => {
  const svg = render('style = "direct";');

  it('drops the panel', () => {
    expect(svg).not.toContain('>Curves</text>');
    expect(svg).not.toContain('>Points</text>');
  });

  it('still names every curve, on the plot', () => {
    for (const label of CURVE_LABELS) expect(svg).toContain(`>${label}</text>`);
  });

  it('labels a curve that runs off the bottom of the plot', () => {
    /*
     * The instantaneous element's trace leaves the plot, so its last
     * sampled point is below the axis. It must still be labelled --
     * anchoring naively to the final point drops it.
     */
    expect(svg).toContain('>R_FDR:50</text>');
  });

  it('gives each label a leader back to its curve', () => {
    const leaders = svg.match(/<path d="M[\d.]+ [\d.]+ L[\d.-]+ [\d.]+ L[\d.-]+ [\d.]+" fill="none" stroke="#[0-9a-f]{6}" stroke-width="1" stroke-opacity="0\.8"\/>/g);
    expect(leaders).toHaveLength(CURVE_LABELS.length);
  });

  it('spreads the boxes so none overlap', () => {
    const ys = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)"[^>]*rx="3"/g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    expect(ys).toHaveLength(CURVE_LABELS.length);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThan(10);
    }
  });

  it('gives the freed gutter to the plot', () => {
    expect(plotWidth(svg)).toBeGreaterThan(plotWidth(render()) + 200);
  });
});

describe('suppressing the legend', () => {
  it('draws none of it for style = "none"', () => {
    const svg = render('style = "none";');
    expect(svg).not.toContain('>Curves</text>');
    for (const label of CURVE_LABELS) expect(svg).not.toContain(`>${label}</text>`);
  });

  it('still honours the older show = false spelling', () => {
    const svg = render('show = false;');
    expect(svg).not.toContain('>Curves</text>');
  });

  it('lets an explicit style win over show', () => {
    const svg = render('show = false; style = "direct";');
    expect(svg).toContain('>R_INC:51</text>');
  });
});
