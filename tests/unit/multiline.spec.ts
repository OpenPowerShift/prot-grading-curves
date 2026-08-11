/**
 * Multi-line author text.
 *
 * `\n` in a quoted string survives the lexer (it is a spec escape
 * sequence), but SVG does no line breaking of its own, so the renderer
 * has to split the label into `<tspan>`s. These tests pin both halves:
 * that the escape reaches the model, and that the renderer honours it
 * without disturbing the single-line case.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { parseAndRender } from '@tc/index';

const BASE = `
meta { project = "Multiline"; }
system { voltages { hv { V  = 11 kV; } } }
faults { "F" { I   = 4 kA; voltage = hv; } }
relay R {
  voltage = hv;
  element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
}
`;

function render(extra: string): string {
  return parseAndRender(BASE + extra, { theme: 'light' }).svg;
}

describe('escape sequences', () => {
  it('turns \\n in a string into a real newline at parse time', () => {
    const doc = parse('point P { I   = 100 A; t   = 1 s; label = "one\\ntwo"; }').document!;
    const point = doc.items.find((i) => i.type === 'point') as { label?: string };
    expect(point.label).toBe('one\ntwo');
  });

  it('still handles the other escapes the spec lists', () => {
    const doc = parse('point P { I   = 100 A; t   = 1 s; label = "a\\tb \\"q\\" c"; }').document!;
    const point = doc.items.find((i) => i.type === 'point') as { label?: string };
    expect(point.label).toBe('a\tb "q" c');
  });
});

describe('point labels', () => {
  it('splits a two-line label into tspans', () => {
    const svg = render('point P { I   = 2 kA; t   = 0.3 s; label = "Inrush\\n12 x FLC"; }');
    expect(svg).toContain('<tspan');
    expect(svg).toContain('>Inrush</tspan>');
    expect(svg).toContain('>12 x FLC</tspan>');
    /* Nothing may carry a raw newline: not the text, and not the
     * `data-point` attribute the viewer's readout reads. */
    expect(svg).not.toContain('Inrush\n12 x FLC');
    expect(svg).toContain('data-point="Inrush 12 x FLC"');
  });

  it('leaves a single-line label as plain text', () => {
    const svg = render('point P { I   = 2 kA; t   = 0.3 s; label = "Inrush"; }');
    expect(svg).toContain('>Inrush</text>');
    expect(svg).not.toContain('<tspan');
  });

  it('gives every line the same x, so the block stays aligned', () => {
    const svg = render('point P { I   = 2 kA; t   = 0.3 s; label = "One\\nTwo\\nThree"; }');
    /* Scoped to the marker's own group: the legend entry wraps too. */
    const group = svg.match(/<g class="tc-point"[\s\S]*?<\/g>/)![0];
    const xs = [...group.matchAll(/<tspan x="([-\d.]+)"/g)].map((m) => m[1]);
    expect(xs).toHaveLength(3);
    expect(new Set(xs).size).toBe(1);
  });

  it('centres unequal lines on each other, rather than sharing an edge', () => {
    /*
     * Every line still shares one x (the block-stays-aligned test
     * above), but that x is now the block's own centre, not its left
     * edge -- so the outer <text> reads `text-anchor="middle"` for a
     * multi-line label, where a single-line one still gets whichever
     * side of the anchor it landed on. A ragged-right block read as a
     * paragraph; a centred one reads as the one short phrase it is.
     */
    const svg = render('point P { I   = 2 kA; t   = 0.3 s; label = "A long first line\\nshort"; }');
    const group = svg.match(/<g class="tc-point"[\s\S]*?<\/g>/)![0];
    expect(group).toMatch(/<text x="[-\d.]+" y="[-\d.]+" text-anchor="middle"/);
  });

  it('keeps a single-line label on its own side of the anchor', () => {
    /* The centring above must not spread to the ordinary case: a label
     * with nothing to centre against still reads start/end, as every
     * other label on the sheet does. */
    const svg = render('point P { I   = 2 kA; t   = 0.3 s; label = "One line only"; }');
    const group = svg.match(/<g class="tc-point"[\s\S]*?<\/g>/)![0];
    expect(group).not.toContain('text-anchor="middle"');
  });

  it('centres the block on the marker, so a second line does not shove it down', () => {
    const svg = render('point P { I   = 2 kA; t   = 0.3 s; label = "One\\nTwo"; }');
    const group = svg.match(/<g class="tc-point"[\s\S]*?<\/g>/)![0];
    const dys = [...group.matchAll(/<tspan x="[-\d.]+" dy="([-\d.]+)"/g)].map((m) => Number(m[1]));
    expect(dys).toHaveLength(2);
    /* First line lifted by half the block, the second dropped a line. */
    expect(dys[0]).toBeLessThan(0);
    expect(dys[1]).toBeGreaterThan(0);
    expect(dys[0] + dys[1]).toBeCloseTo(dys[1] / 2, 5);
  });
});

describe('annotation labels', () => {
  it('wraps a margin annotation and keeps the computed time with it', () => {
    const svg = render(`
      relay R2 {
        voltage = hv;
        element 51 { curve = iec.si; I_pickup = 200 A; tms = 0.4; }
      }
      annotate {
        primary = R:51;
        backup = R2:51;
        fault = "F";
        label = "Feeder to incomer\\nCTI";
      }
    `);
    expect(svg).toContain('>Feeder to incomer</tspan>');
    /* The time is appended to the label, so it lands on the last line. */
    expect(svg).toMatch(/>CTI [\d.]+\s?m?s<\/tspan>/);
  });

  it('wraps a leader annotation, growing it away from the curve', () => {
    const svg = render(`
      annotate {
        on_curve = R:51;
        at_I   = 4 kA;
        style = leader;
        label = "Fault level\\nreviewed 2026";
      }
    `);
    expect(svg).toContain('>Fault level</tspan>');
    expect(svg).toContain('>reviewed 2026</tspan>');
  });
});

describe('titles', () => {
  it('wraps a page title and pushes the subtitle clear of it', () => {
    const svg = render(`
      page {
        title {
          text = "Main intake\\nprotection study";
          subtitle = "Sheet 1";
        }
      }
    `);
    /*
     * Titles are laid out top-down and are also wrapped to the sheet,
     * so each line is its own <text> rather than a tspan of one.
     */
    expect(svg).toContain('>Main intake</text>');
    expect(svg).toContain('>protection study</text>');

    /* The subtitle's baseline must clear the title's second line. */
    const subY = Number(svg.match(/y="([\d.]+)"[^>]*>Sheet 1</)![1]);
    const secondLineY = Number(svg.match(/y="([\d.]+)"[^>]*>protection study</)![1]);
    expect(subY).toBeGreaterThan(secondLineY);
  });
});
