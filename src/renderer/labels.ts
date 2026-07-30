/**
 * Keeping labels off one another.
 *
 * Every label on a TCC is anchored to something -- a marked point, a
 * spot on a curve, the ends of a margin arrow -- and the obvious
 * placement is a fixed offset from that anchor. That works until two
 * anchors are close together, which on a coordination sheet they
 * routinely are: an inrush point beside a damage point, two
 * annotations at the same fault current, a margin figure landing on a
 * point's caption. Fixed offsets then overprint, and the reader is
 * left with two labels they cannot separate.
 *
 * The scheme here is the usual one for this problem, and deliberately
 * simple enough to reason about:
 *
 *   1. try the caller's preferred placements in order -- typically
 *      right of the anchor, then left, then above, then below;
 *   2. if all of them collide, push the label away vertically in
 *      small steps until it is clear, since a log-log plot has more
 *      slack vertically than horizontally;
 *   3. clamp to the plot, and report how far the label ended up from
 *      its anchor so the caller can draw a leader when the connection
 *      is no longer obvious.
 *
 * Greedy, in the order labels are offered. That makes placement
 * deterministic -- the same study always produces the same sheet,
 * which matters when a drawing is reissued and diffed.
 */

/** An axis-aligned box in SVG user units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a label may sit relative to its anchor. */
export type LabelSide = 'right' | 'left' | 'above' | 'below';

export interface PlacementRequest {
  /** The point the label belongs to. */
  anchor: { x: number; y: number };
  /** Rendered size of the text. */
  size: { w: number; h: number };
  /**
   * Sides to try, in order of preference. The first that does not
   * collide wins, so put the placement you would choose by hand first.
   */
  prefer?: readonly LabelSide[];
  /** Gap between the anchor and the near edge of the label. */
  gap?: number;
}

export interface Placement {
  /** Box the label occupies, after any displacement. */
  rect: Rect;
  /** Which side it ended up on. */
  side: LabelSide;
  /** Baseline x for the text, given `anchorText`. */
  x: number;
  /** Baseline y for the text. */
  y: number;
  /** `start` when the label sits right of its anchor, `end` when left. */
  anchorText: 'start' | 'end';
  /**
   * True when the label had to be moved clear of others, far enough
   * that a reader would not otherwise connect it to its anchor.
   */
  displaced: boolean;
}

const DEFAULT_PREFER: readonly LabelSide[] = ['right', 'left', 'above', 'below'];

/** Do two boxes touch? A shared edge does not count as a collision. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Places labels so that none overlap.
 *
 * One instance per drawing. Reserve anything already on the sheet with
 * {@link reserve} before placing, so labels avoid it too.
 */
export class LabelPlacer {
  private readonly taken: Rect[] = [];

  /** Plot area labels must stay inside. */
  constructor(private readonly bounds: Rect) {}

  /**
   * Mark a region as occupied without placing a label in it.
   *
   * Used for things drawn earlier that a label must not cover: the
   * direct-label column, a legend panel floated over the plot.
   */
  reserve(rect: Rect): void {
    this.taken.push(rect);
  }

  /** Boxes taken so far, for tests and for diagnostics. */
  occupied(): readonly Rect[] {
    return this.taken;
  }

  place(request: PlacementRequest): Placement {
    const { anchor, size } = request;
    const gap = request.gap ?? 8;
    const prefer = request.prefer ?? DEFAULT_PREFER;

    /* 1. The caller's preferred sides, in order. */
    for (const side of prefer) {
      const rect = this.rectFor(side, anchor, size, gap);
      if (this.fits(rect)) {
        this.taken.push(rect);
        return this.result(rect, side, size, false);
      }
    }

    /*
     * 2. Nothing free: step away vertically, trying each preferred
     * side in turn. Alternating up and down keeps a cluster balanced
     * about its anchors rather than trailing off in one direction.
     *
     * Each candidate is pulled inside the plot first. Searching from an
     * unclamped base means an anchor near a corner -- where every side
     * fails on the bounds, not on a collision -- searches a column of
     * positions that are all outside the plot, and the label ends up
     * off the sheet.
     */
    const step = size.h + 3;
    for (let n = 1; n <= 40; n++) {
      for (const side of prefer) {
        const base = this.clamp(this.rectFor(side, anchor, size, gap));
        for (const direction of [-1, 1]) {
          const rect = this.clamp({ ...base, y: base.y + direction * n * step });
          if (this.fits(rect)) {
            this.taken.push(rect);
            return this.result(rect, side, size, true);
          }
        }
      }
    }

    /*
     * 3. Nowhere clear at all. Placing it at the preferred spot and
     * saying so beats dropping it: an overlapping label can still be
     * read, a missing one cannot, and the caller draws a leader. It is
     * still clamped -- a label outside the plot is worse than one that
     * overlaps, because it may be off the paper entirely.
     */
    const side = prefer[0] ?? 'right';
    const fallback = this.clamp(this.rectFor(side, anchor, size, gap));
    this.taken.push(fallback);
    return this.result(fallback, side, size, true);
  }

  /** Pull a box inside the plot, preserving its size. */
  private clamp(rect: Rect): Rect {
    const maxX = this.bounds.x + this.bounds.w - rect.w;
    const maxY = this.bounds.y + this.bounds.h - rect.h;
    return {
      ...rect,
      x: Math.min(Math.max(rect.x, this.bounds.x), Math.max(this.bounds.x, maxX)),
      y: Math.min(Math.max(rect.y, this.bounds.y), Math.max(this.bounds.y, maxY)),
    };
  }

  /** Inside the plot, and clear of everything placed so far. */
  private fits(rect: Rect): boolean {
    if (rect.x < this.bounds.x || rect.x + rect.w > this.bounds.x + this.bounds.w) return false;
    if (rect.y < this.bounds.y || rect.y + rect.h > this.bounds.y + this.bounds.h) return false;
    return !this.taken.some((other) => overlaps(rect, other));
  }

  private rectFor(
    side: LabelSide,
    anchor: { x: number; y: number },
    size: { w: number; h: number },
    gap: number,
  ): Rect {
    switch (side) {
      case 'right':
        return { x: anchor.x + gap, y: anchor.y - size.h / 2, w: size.w, h: size.h };
      case 'left':
        return { x: anchor.x - gap - size.w, y: anchor.y - size.h / 2, w: size.w, h: size.h };
      case 'above':
        return { x: anchor.x - size.w / 2, y: anchor.y - gap - size.h, w: size.w, h: size.h };
      case 'below':
        return { x: anchor.x - size.w / 2, y: anchor.y + gap, w: size.w, h: size.h };
    }
  }

  /**
   * Text coordinates for a box.
   *
   * A label left of its anchor is right-aligned against the anchor, so
   * the text grows away from it rather than towards it. The baseline
   * sits a third of the cap height below centre, which is what makes
   * text look vertically centred on a marker.
   */
  private result(rect: Rect, side: LabelSide, size: { w: number; h: number }, displaced: boolean): Placement {
    const anchorText = side === 'left' ? 'end' : 'start';
    return {
      rect,
      side,
      x: anchorText === 'end' ? rect.x + rect.w : rect.x,
      y: rect.y + size.h / 2 + size.h / 6,
      anchorText,
      displaced,
    };
  }
}
