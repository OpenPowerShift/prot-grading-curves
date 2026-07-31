/**
 * Mirrored axes and fault-marker styling.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';

const BASE = `
system { voltages { "MV" { V  = 11.0 kV; } } }
faults {
  "F_a" { I   = 1.0 kA; } "F_b" { I   = 1.1 kA; }
  "F_c" { I   = 3.0 kA; } "F_d" { I   = 8.0 kA; }
}
relay R { voltage = "MV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; } }
`;

const render = (page: string): string =>
  parseAndRender(`${BASE}\npage { ${page} }`, { theme: 'light' }).svg;

describe('page.axes.mirror', () => {
  it('is off by default', () => {
    const svg = render('theme = "light";');
    /* Only one label per major decade without mirroring. */
    expect((svg.match(/>1 kA</g) ?? []).length).toBe(1);
  });

  it('repeats the scales on the opposite edges', () => {
    const svg = render('axes { mirror = true; }');
    expect((svg.match(/>1 kA</g) ?? []).length).toBe(2);
    expect((svg.match(/>1 s</g) ?? []).length).toBe(2);
  });
});

describe('page.faults', () => {
  it('gives each marker its own dash so it can be traced', () => {
    const svg = render('theme = "light";');
    const dashes = new Set(
      [...svg.matchAll(/class="tc-fault"[^>]*stroke-dasharray="([^"]+)"/g)].map((m) => m[1]),
    );
    /* Four faults, four distinguishable patterns. */
    expect(dashes.size).toBeGreaterThanOrEqual(4);
  });

  it('honours an explicit width', () => {
    expect(render('faults { width_px = 3; }')).toMatch(/class="tc-fault"[^>]*stroke-width="3"/);
  });

  it('honours an explicit colour', () => {
    expect(render('faults { color = "#00aa00"; }')).toMatch(/class="tc-fault"[^>]*stroke="#00aa00"/);
  });

  it('makes markers uniform when a style is declared', () => {
    const svg = render('faults { style = "dashed"; }');
    const dashes = new Set(
      [...svg.matchAll(/class="tc-fault"[^>]*stroke-dasharray="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(dashes.size).toBe(1);
  });

  it('can suppress the labels', () => {
    /* Match drawn <text> elements, not the class in the stylesheet. */
    const labels = (svg: string): number =>
      (svg.match(/<text[^>]*class="tc-fault-label"/g) ?? []).length;
    expect(labels(render('theme = "light";'))).toBeGreaterThan(0);
    expect(labels(render('faults { labels = false; }'))).toBe(0);
  });

  it('stacks colliding labels into rows rather than overprinting', () => {
    /* F_a and F_b are 100 A apart: their labels must not share a row. */
    const svg = render('theme = "light";');
    const tags = svg.match(/<text[^>]*class="tc-fault-label"[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(4);

    const ys = tags.map((t) => Number(t.match(/\by="([\d.]+)"/)![1]));
    expect(new Set(ys).size, 'all fault labels are on one row').toBeGreaterThan(1);
  });
});
