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
import { theme } from '@tc/renderer/theme';
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

describe('keeping labels off the drawn lines', () => {
  /** A horizontal line across the middle of the plot. */
  const SHELF = [{ x: 0, y: 300 }, { x: 1000, y: 300 }];

  it('knows a box is on a line it was given', () => {
    const placer = new LabelPlacer(PLOT);
    placer.avoidLine(SHELF);

    /* Straddling it, and clear of it. */
    expect(placer.onLine({ x: 400, y: 295, w: 100, h: 12 })).toBe(true);
    expect(placer.onLine({ x: 400, y: 200, w: 100, h: 12 })).toBe(false);
  });

  it('catches a long segment with no point inside the box', () => {
    /*
     * The case point-sampling misses: a definite-time stage is two
     * points a plot's width apart, so a caption sitting squarely on
     * that shelf contains neither of them -- and it is exactly the
     * caption a reader complains about.
     */
    const placer = new LabelPlacer(PLOT);
    placer.avoidLine(SHELF);
    expect(placer.onLine({ x: 480, y: 294, w: 40, h: 12 })).toBe(true);
  });

  it('does not span the gap where the pen was lifted', () => {
    /* Two runs, not one: a characteristic that stops operating and
     * starts again leaves a real gap a label may sit in. */
    const placer = new LabelPlacer(PLOT);
    placer.avoidLine([{ x: 0, y: 300 }, { x: 200, y: 300 }]);
    placer.avoidLine([{ x: 800, y: 300 }, { x: 1000, y: 300 }]);
    expect(placer.onLine({ x: 400, y: 295, w: 100, h: 12 })).toBe(false);
  });

  it('moves a label off the line when there is room', () => {
    const placer = new LabelPlacer(PLOT);
    placer.avoidLine(SHELF);

    /* Anchored right on the shelf: to the right at the same height
     * would print along it, so it has to go somewhere else. */
    const p = placer.place({ anchor: { x: 400, y: 300 }, size: SIZE, gap: 8 });
    expect(placer.onLine(p.rect)).toBe(false);
  });

  it('places the label anyway when the line cannot be dodged', () => {
    /*
     * A curve is a preference, not an obstruction. Two labels on top of
     * each other are unreadable; a label crossing a curve is untidy. On
     * a sheet that is mostly curve, refusing every position that touches
     * one would push labels somewhere worse than the crossing avoided.
     */
    const placer = new LabelPlacer({ x: 0, y: 0, w: 1000, h: 40 });
    /* A line through every row of a plot only one label tall. */
    for (let y = 0; y <= 40; y += 4) placer.avoidLine([{ x: 0, y }, { x: 1000, y }]);

    const p = placer.place({ anchor: { x: 400, y: 20 }, size: SIZE, gap: 8 });
    expect(p.rect.w).toBe(SIZE.w);
    expect(p.rect.y).toBeGreaterThanOrEqual(0);
    expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(40);
  });

  it('still keeps labels off each other while dodging lines', () => {
    const placer = new LabelPlacer(PLOT);
    placer.avoidLine(SHELF);

    const placed = Array.from({ length: 6 }, () =>
      placer.place({ anchor: { x: 400, y: 300 }, size: SIZE, gap: 8 }));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i].rect, placed[j].rect), `${i} vs ${j}`).toBe(false);
      }
    }
  });
});

/* ---------------------------------------------------------------- */

describe('a point caption sitting on a curve', () => {
  /*
   * The worst case, and the one that prompted this: a marked point on a
   * definite-time shelf. The caption's natural place is to the right of
   * the marker, at the same height -- printed along the line.
   */
  const ON_A_SHELF = `
system { voltages { hv { V  = 11 kV; } } }
relay R { voltage = hv; element 50 { curve = definite; I_pickup = 400 A; t_delay = 0.5 s; } }
point "P" { I   = 3000 A; t   = 0.5 s; voltage = hv; label = "clears in 500 ms"; }
view { voltage = hv; current_min = 100 A; current_max = 30 kA; time_min = 10 ms; time_max = 100 s; }
`;

  const svg = parseAndRender(ON_A_SHELF, { theme: 'light' }).svg;

  /** Polyline runs of every drawn curve, as the placer sees them. */
  function curveRuns(src: string): Array<Array<{ x: number; y: number }>> {
    const runs: Array<Array<{ x: number; y: number }>> = [];
    for (const path of src.matchAll(/<path d="([^"]+)"[^>]*class="tc-curve/g)) {
      let current: Array<{ x: number; y: number }> = [];
      for (const m of path[1].matchAll(/([ML])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
        const point = { x: Number(m[2]), y: Number(m[3]) };
        if (m[1] === 'M') {
          if (current.length > 1) runs.push(current);
          current = [point];
        } else current.push(point);
      }
      if (current.length > 1) runs.push(current);
    }
    return runs;
  }

  it('draws the curve and the caption', () => {
    expect(curveRuns(svg).length).toBeGreaterThan(0);
    expect(svg).toContain('clears in 500 ms');
  });

  it('does not print the caption along the line', () => {
    const caption = svg.match(
      /<text x="([\d.-]+)" y="([\d.-]+)" text-anchor="(start|end)" font-size="11"[^>]*>clears in 500 ms</,
    );
    expect(caption).not.toBeNull();

    const FONT = 11;
    const w = 'clears in 500 ms'.length * FONT * 0.6;
    const box = {
      x: caption![3] === 'end' ? Number(caption![1]) - w : Number(caption![1]),
      y: Number(caption![2]) - FONT,
      w,
      h: FONT + 2,
    };

    /* Judged with the same geometry the placer used. */
    const probe = new LabelPlacer({ x: 0, y: 0, w: 10_000, h: 10_000 });
    for (const run of curveRuns(svg)) probe.avoidLine(run);
    expect(probe.onLine(box)).toBe(false);
  });

  it('draws the marker after the curve, so it sits in front', () => {
    const curveAt = svg.indexOf('class="tc-curve');
    const markerAt = svg.indexOf('<g class="tc-point"');
    expect(curveAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(curveAt);
  });

  it('rings the marker in the page colour, so the line stops at it', () => {
    /*
     * Drawing it later is not enough: a 2 px stroke through a 10 px
     * marker still reads as one shape. Checked against the theme rather
     * than a literal, since the surface is off-white and a test that
     * assumed `#fff` would pass only by luck.
     */
    const group = svg.slice(svg.indexOf('<g class="tc-point"'));
    const marker = group.slice(0, group.indexOf('<text'));
    const surface = theme('light').background;

    expect(marker).toContain(`stroke="${surface}"`);
    /* Wider than the mark it rings, and drawn before it. */
    expect(marker.indexOf(surface)).toBeLessThan(marker.indexOf('stroke-width="1.8"'));
  });
});

/* ---------------------------------------------------------------- */

describe('the renderer, on a study whose points are piled up', () => {
  const CROWDED = `
system { voltages { hv { V  = 11 kV; } } }
faults { "F" { I   = 9 kA; voltage = hv; } }
relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
point "A" { I   = 2000 A; t   = 1.00 s; voltage = hv; label = "Alpha point"; }
point "B" { I   = 2050 A; t   = 1.02 s; voltage = hv; label = "Bravo point"; }
point "C" { I   = 2100 A; t   = 0.99 s; voltage = hv; label = "Charlie point"; }
point "D" { I   = 1980 A; t   = 1.01 s; voltage = hv; label = "Delta point"; }
point "E" { I   = 2020 A; t   = 0.98 s; voltage = hv; label = "Echo point"; }
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

/* ---------------------------------------------------------------- */

describe('a point caption and an annotation at the same spot', () => {
  /*
   * The leader style used to go at a fixed offset up and to the right,
   * and only *reserve* that box afterwards -- so it avoided nothing
   * already on the sheet and printed straight over a marked point's
   * caption. Reserving after the fact stops the next label landing on
   * this one; it cannot move this one clear of the last.
   */
  const COLLIDING = `
system { voltages { hv { V  = 11 kV; } } }
faults { "F" { I   = 4 kA; voltage = hv; } }
relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }

# A marked point sitting exactly where the annotation wants to be.
point "P" { I   = 4000 A; t   = 0.30 s; voltage = hv; label = "inrush limit"; }

annotate { on_curve = R:51; at_I   = 4000 A; label = "bus fault"; style = "leader"; }
view { voltage = hv; current_min = 100 A; current_max = 30 kA; }
`;

  const svg = parseAndRender(COLLIDING, { theme: 'light' }).svg;

  /** Boxes of the two labels, from the emitted text. */
  function box(text: string): Rect {
    const m = svg.match(
      new RegExp(`<text x="([\\d.-]+)" y="([\\d.-]+)" text-anchor="(start|end)" font-size="11"[^>]*>${text}<`),
    );
    if (!m) throw new Error(`no label for ${text}`);
    const FONT = 11;
    const w = text.length * FONT * 0.6;
    return {
      x: m[3] === 'end' ? Number(m[1]) - w : Number(m[1]),
      y: Number(m[2]) - FONT,
      w,
      h: FONT + 2,
    };
  }

  it('draws both labels', () => {
    expect(svg).toContain('inrush limit');
    expect(svg).toContain('bus fault');
  });

  it('keeps them off each other', () => {
    expect(overlaps(box('inrush limit'), box('bus fault'))).toBe(false);
  });

  it('still draws the annotation its leader', () => {
    /* The elbow is what makes a leader read as one; it follows the
     * label rather than the label following it. */
    expect(svg).toMatch(/<path d="M[\d.]+ [\d.]+ L[\d.-]+ [\d.]+ L[\d.-]+ [\d.]+" fill="none" stroke="[^"]*" stroke-width="1"\/>/);
  });

  it('keeps a caption off the marker it names', () => {
    /* A caption printed across the very mark it labels is the same
     * fault as one printed along a curve. */
    const marker = svg.match(/data-px="([\d.]+)" data-py="([\d.]+)"/);
    expect(marker).not.toBeNull();
    const markerBox: Rect = {
      x: Number(marker![1]) - 7, y: Number(marker![2]) - 7, w: 14, h: 14,
    };
    expect(overlaps(box('inrush limit'), markerBox)).toBe(false);
  });
});

/* ---------------------------------------------------------------- */

describe('a box only clear on a line, once the search is exhausted', () => {
  it('is still reported displaced, so the caller draws a leader', () => {
    /*
     * A regression pin for a real bug: the search used to run twice,
     * once dodging drawn lines and once not, and take whichever pass
     * succeeded first. Where nothing ever cleared both, the second
     * pass re-tried the very first preferred position -- which is
     * exactly the one the first pass had already rejected for sitting
     * on the line -- and returned it as `displaced: false`, since that
     * pass's own first-preference loop always marks its result
     * undisplaced. A label sitting on a line with no leader looks
     * deliberate; it was a fallback.
     *
     * Here the anchor sits on a vertical line running the full height
     * of a plot too narrow for `above`/`below` to ever step clear of
     * it sideways, so every candidate the search tries is on the
     * line. The only question is whether the fallback admits it.
     */
    const placer = new LabelPlacer({ x: 0, y: 0, w: 60, h: 600 });
    placer.avoidLine([{ x: 30, y: 0 }, { x: 30, y: 600 }]);

    const p = placer.place({
      anchor: { x: 30, y: 300 },
      size: { w: 50, h: 12 },
      prefer: ['above', 'below'],
      gap: 4,
    });

    expect(placer.onLine(p.rect)).toBe(true);
    expect(p.displaced).toBe(true);
  });
});

/* ---------------------------------------------------------------- */

describe('a long on-plot caption', () => {
  const LONG_CAPTION = `
system { voltages { hv { V = 11 kV; } } }
faults { "F" { I = 4 kA; voltage = hv; } }
relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
annotate { on_curve = R:51; at_I = 4000 A;
  label = "a caption long enough that it has to wrap onto more than one line"; style = "leader"; }
view { voltage = hv; current_min = 100 A; current_max = 30 kA; }
`;

  it('wraps to a column instead of running out as one long line', () => {
    /*
     * A caption this long, printed as one line, is wider than most of
     * the plot it sits on -- narrower and taller reads better, and
     * gives the placer's search more positions that are actually clear
     * of the other things on the sheet.
     */
    const svg = parseAndRender(LONG_CAPTION, { theme: 'light' }).svg;
    const tspans = svg.match(/<tspan x="[\d.]+" dy="[\d.-]+">[^<]*<\/tspan>/g) ?? [];
    expect(tspans.length).toBeGreaterThan(1);
  });
});
