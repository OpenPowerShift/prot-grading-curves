/**
 * Label placement.
 *
 * Every label on a TCC is anchored to something, and a fixed offset
 * from that anchor works until two anchors are close together -- which
 * on a coordination sheet they routinely are. These tests pin the
 * placer's contract, and then check the whole renderer against a study
 * whose points are deliberately piled on top of one another.
 */

import { describe, expect, it } from 'vitest';
import { LabelPlacer, overlaps, type Rect } from '@tc/renderer/labels';
import { parseAndRender } from '@tc/index';

const PLOT: Rect = { x: 0, y: 0, w: 1000, h: 600 };
const SIZE = { w: 100, h: 12 };

describe('overlaps', () => {
  it('is true for boxes that intersect', () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it('is false for boxes that merely touch', () => {
    /* A shared edge is not a collision: two labels flush against each
     * other still read as two labels. */
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('is false for boxes apart in one axis only', () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 40, w: 10, h: 10 })).toBe(false);
  });
});

describe('placing a single label', () => {
  it('takes the first preferred side when it is free', () => {
    const placer = new LabelPlacer(PLOT);
    const p = placer.place({ anchor: { x: 400, y: 300 }, size: SIZE, gap: 8 });

    expect(p.side).toBe('right');
    expect(p.displaced).toBe(false);
    expect(p.anchorText).toBe('start');
    expect(p.rect.x).toBe(408);
    /* Vertically centred on the anchor. */
    expect(p.rect.y + p.rect.h / 2).toBeCloseTo(300, 6);
  });

  it('right-aligns a label placed to the left, so it grows away', () => {
    const placer = new LabelPlacer(PLOT);
    /* No room on the right, so it must go left. */
    const p = placer.place({ anchor: { x: 995, y: 300 }, size: SIZE, gap: 8 });

    expect(p.side).toBe('left');
    expect(p.anchorText).toBe('end');
    expect(p.rect.x + p.rect.w).toBe(987);
  });

  it('keeps a label inside the plot', () => {
    const placer = new LabelPlacer(PLOT);
    for (const anchor of [{ x: 2, y: 2 }, { x: 998, y: 598 }, { x: 500, y: 1 }]) {
      const p = placer.place({ anchor, size: SIZE, gap: 8 });
      expect(p.rect.x, JSON.stringify(anchor)).toBeGreaterThanOrEqual(PLOT.x);
      expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(PLOT.x + PLOT.w);
      expect(p.rect.y).toBeGreaterThanOrEqual(PLOT.y);
      expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(PLOT.y + PLOT.h);
    }
  });

  it('honours the order of preference it is given', () => {
    const placer = new LabelPlacer(PLOT);
    const p = placer.place({
      anchor: { x: 400, y: 300 },
      size: SIZE,
      prefer: ['above', 'right'],
      gap: 8,
    });
    expect(p.side).toBe('above');
  });
});

describe('placing labels that compete', () => {
  it('separates two labels on the same anchor', () => {
    const placer = new LabelPlacer(PLOT);
    const a = placer.place({ anchor: { x: 400, y: 300 }, size: SIZE, gap: 8 });
    const b = placer.place({ anchor: { x: 400, y: 300 }, size: SIZE, gap: 8 });

    expect(overlaps(a.rect, b.rect)).toBe(false);
    /* The second went to the other side rather than being displaced. */
    expect(b.side).toBe('left');
  });

  it('separates a crowd of them, and says which were moved', () => {
    const placer = new LabelPlacer(PLOT);
    const placed = Array.from({ length: 8 }, (_, i) =>
      placer.place({ anchor: { x: 400 + i, y: 300 + i }, size: SIZE, gap: 8 }));

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i].rect, placed[j].rect), `${i} vs ${j}`).toBe(false);
      }
    }
    /* Past the four sides, the rest have to be pushed clear. */
    expect(placed.filter((p) => p.displaced).length).toBeGreaterThan(0);
  });

  it('avoids a region reserved by something already drawn', () => {
    const placer = new LabelPlacer(PLOT);
    /* The direct-label column, or a legend floated over the plot. */
    placer.reserve({ x: 400, y: 200, w: 300, h: 200 });

    const p = placer.place({ anchor: { x: 450, y: 300 }, size: SIZE, gap: 8 });
    expect(overlaps(p.rect, { x: 400, y: 200, w: 300, h: 200 })).toBe(false);
  });

  it('places rather than drops a label when nothing is free', () => {
    /* A missing label cannot be read at all; an overlapping one can,
     * and it is reported as displaced so a leader is drawn. */
    const tiny = new LabelPlacer({ x: 0, y: 0, w: 120, h: 14 });
    tiny.place({ anchor: { x: 10, y: 7 }, size: SIZE, gap: 2 });
    const second = tiny.place({ anchor: { x: 10, y: 7 }, size: SIZE, gap: 2 });

    expect(second.rect.w).toBe(SIZE.w);
    expect(second.displaced).toBe(true);
  });
});

/* ---------------------------------------------------------------- */

describe('the renderer, on a study whose points are piled up', () => {
  const CROWDED = `
system { voltages { hv { kV = 11; } } }
faults { "F" { I_A = 9 kA; voltage = hv; } }
relay R { voltage = hv; element 51 { curve = iec.si; I_pu = 400 A; tms = 0.2; } }
point "A" { I_A = 2000 A; t_s = 1.00 s; voltage = hv; label = "Alpha point"; }
point "B" { I_A = 2050 A; t_s = 1.02 s; voltage = hv; label = "Bravo point"; }
point "C" { I_A = 2100 A; t_s = 0.99 s; voltage = hv; label = "Charlie point"; }
point "D" { I_A = 1980 A; t_s = 1.01 s; voltage = hv; label = "Delta point"; }
point "E" { I_A = 2020 A; t_s = 0.98 s; voltage = hv; label = "Echo point"; }
view { voltage = hv; current_min = 100 A; current_max = 30 kA; }
`;

  /** Boxes of the point captions, recovered from the emitted text. */
  function captionBoxes(svg: string): Array<Rect & { text: string }> {
    const CHAR_ADVANCE = 0.6;
    const FONT = 11;
    const out: Array<Rect & { text: string }> = [];
    const re = /<text x="([\d.-]+)" y="([\d.-]+)" text-anchor="(start|end)" font-size="11"[^>]*>([^<]*)<\/text>/g;
    for (const m of svg.matchAll(re)) {
      const text = m[4];
      if (!text.includes('point')) continue;
      const w = text.length * FONT * CHAR_ADVANCE;
      out.push({
        text,
        x: m[3] === 'end' ? Number(m[1]) - w : Number(m[1]),
        y: Number(m[2]) - FONT,
        w,
        h: FONT + 2,
      });
    }
    return out;
  }

  const svg = parseAndRender(CROWDED, { theme: 'light' }).svg;

  it('draws every caption', () => {
    expect(captionBoxes(svg)).toHaveLength(5);
  });

  it('leaves none of them overlapping', () => {
    const boxes = captionBoxes(svg);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(
          overlaps(boxes[i], boxes[j]),
          `${boxes[i].text} overlaps ${boxes[j].text}`,
        ).toBe(false);
      }
    }
  });

  it('gives a leader to a caption it had to move', () => {
    /* Five labels cannot all sit at their preferred offset, so at
     * least one is displaced and gets a line back to its marker. */
    expect(svg).toMatch(/stroke-opacity="0\.6"/);
  });
});
