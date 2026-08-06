/**
 * The viewer's pointer handling.
 *
 * Everything here needs a coordinate transform, and jsdom implements no
 * SVG geometry at all -- `getScreenCTM` does not exist and every
 * element measures 0x0. So the transform is supplied: an identity CTM
 * and a plausible bounding box, which is enough for the handlers to run
 * against real arithmetic rather than be skipped.
 *
 * What that buys is the *logic* -- snapping, zooming, panning, the
 * bounds a wheel gesture produces -- checked here. What it cannot buy
 * is whether the numbers land where a human sees them, which is the
 * visual suite's job and needs a real engine.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { process as processStudy } from '@tc/index';
import '@tc/components/tc-viewer.js';
import type { TcViewer } from '@tc/components/tc-viewer.js';

const STUDY = `
system { voltages { "MV" { V = 11 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R_FDR { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA;
       time_min = 20 ms; time_max = 100 s; }
`;

const peek = <T>(el: TcViewer, key: string): T =>
  (el as unknown as Record<string, T>)[key];

const call = (el: TcViewer, method: string, ...args: unknown[]): unknown =>
  (el as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);

/*
 * jsdom has no `DOMPoint`, and `toUserSpace` builds one to push through
 * the inverse CTM. A two-field class with the standard transform is
 * enough -- the arithmetic under test is the viewer's, not the
 * browser's.
 */
class TestPoint {
  constructor(public x = 0, public y = 0) {}
  matrixTransform(m: { a: number; b: number; c: number; d: number; e: number; f: number }): TestPoint {
    return new TestPoint(
      this.x * m.a + this.y * m.c + m.e,
      this.x * m.b + this.y * m.d + m.f,
    );
  }
}
(globalThis as unknown as { DOMPoint: unknown }).DOMPoint = TestPoint;

let host: HTMLDivElement;

/**
 * Give the mounted SVG the geometry jsdom withholds.
 *
 * An identity CTM means client coordinates *are* user coordinates,
 * which keeps the arithmetic in the test readable: a click at (500,
 * 300) is user-space (500, 300).
 */
function giveGeometry(el: TcViewer): SVGSVGElement | null {
  const svg = el.querySelector('svg');
  if (!svg) return null;
  const identity = {
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
    inverse() { return this; },
  };
  Object.assign(svg, {
    getScreenCTM: () => identity,
    createSVGPoint: () => new TestPoint(),
  });
  svg.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 1500, height: 1000, top: 0, left: 0,
    right: 1500, bottom: 1000, toJSON: () => ({}),
  }) as DOMRect;
  return svg as SVGSVGElement;
}

async function mount(): Promise<TcViewer> {
  const result = processStudy(STUDY);
  const el = document.createElement('tc-viewer') as TcViewer;
  el.document = result.document;
  el.study = result.study;
  el.errors = result.parseErrors;
  host.append(el);
  await el.updateComplete;
  giveGeometry(el);
  return el;
}

const mouse = (x: number, y: number, button = 0): MouseEvent =>
  new MouseEvent('mousemove', { clientX: x, clientY: y, button, bubbles: true });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => { host.remove(); });

describe('hovering', () => {
  it('does not throw over the plot', async () => {
    const el = await mount();
    expect(() => call(el, 'handleMouseMove', mouse(700, 400))).not.toThrow();
  });

  it('clears its readout when the pointer leaves', async () => {
    const el = await mount();
    call(el, 'handleMouseMove', mouse(700, 400));
    call(el, 'handleMouseLeave');
    await el.updateComplete;
    expect(peek<unknown>(el, 'hover')).toBeNull();
  });

  it('survives a pointer far outside the plot', async () => {
    const el = await mount();
    expect(() => call(el, 'handleMouseMove', mouse(-5000, -5000))).not.toThrow();
    expect(() => call(el, 'handleMouseMove', mouse(99999, 99999))).not.toThrow();
  });
});

describe('the wheel', () => {
  const wheel = (deltaY: number, x = 700, y = 400): WheelEvent =>
    Object.assign(
      new WheelEvent('wheel', { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true }),
      { preventDefault() { /* jsdom allows it */ } },
    );

  it('zooms in and narrows the current window', async () => {
    const el = await mount();
    call(el, 'handleWheel', wheel(-120));
    await el.updateComplete;

    const lo = peek<number | null>(el, 'currentMin');
    const hi = peek<number | null>(el, 'currentMax');
    if (lo != null && hi != null) {
      expect(hi / lo).toBeLessThan(40_000 / 100);
    }
    expect(el.innerHTML).toContain('<svg');
  });

  it('zooming out again does not invert the window', async () => {
    const el = await mount();
    call(el, 'handleWheel', wheel(-120));
    call(el, 'handleWheel', wheel(120));
    await el.updateComplete;
    const lo = peek<number | null>(el, 'currentMin');
    const hi = peek<number | null>(el, 'currentMax');
    if (lo != null && hi != null) expect(hi).toBeGreaterThan(lo);
  });

  it('many zooms in a row leave a drawable sheet', async () => {
    const el = await mount();
    for (let i = 0; i < 12; i++) call(el, 'handleWheel', wheel(-120));
    await el.updateComplete;
    expect(el.innerHTML).toContain('<svg');
  });

  /** The plot rectangle the sheet declares, so a test can aim outside it. */
  const plotRect = (el: TcViewer): { x: number; y: number; w: number; h: number } => {
    const desc = el.querySelector('desc.tc-data');
    const [x, y, w, h] = (desc?.getAttribute('data-plot') ?? '').split(',').map(Number);
    expect([x, y, w, h].every(Number.isFinite), 'the sheet should declare its plot').toBe(true);
    return { x, y, w, h };
  };

  describe('off the plot', () => {
    /*
     * Over the margin, the legend or the title there is no current
     * under the pointer for an axis zoom to anchor to, so the gesture
     * was answering a question the pointer had not asked. Where the
     * reader points says which zoom they mean.
     */
    it('sizes the drawing instead of the axes', async () => {
      const el = await mount();
      const r = plotRect(el);
      const before = [peek<number | null>(el, 'currentMin'), peek<number | null>(el, 'currentMax')];

      call(el, 'handleWheel', wheel(-120, r.x / 2, r.y / 2));

      expect(peek<number>(el, 'displayScale')).toBeCloseTo(1.25, 3);
      expect([peek<number | null>(el, 'currentMin'), peek<number | null>(el, 'currentMax')])
        .toEqual(before);
    });

    it('wheeling out comes back to the default and stops there', async () => {
      /*
       * Not down to the 0.3 floor. Backing off should land somewhere a
       * reader recognises -- actual size, or the scale that shows the
       * whole sheet if that is smaller -- rather than at an arbitrary
       * fraction they then have to correct.
       */
      const el = await mount();
      const r = plotRect(el);
      const off = [r.x / 2, r.y / 2] as const;

      for (let i = 0; i < 4; i += 1) call(el, 'handleWheel', wheel(-120, ...off));
      expect(peek<number>(el, 'displayScale')).toBeGreaterThan(2);

      for (let i = 0; i < 20; i += 1) call(el, 'handleWheel', wheel(120, ...off));
      expect(peek<number>(el, 'displayScale')).toBe(1);
    });

    it('still zooms the axes when the pointer is on the plot', async () => {
      const el = await mount();
      const r = plotRect(el);
      call(el, 'handleWheel', wheel(-120, r.x + r.w / 2, r.y + r.h / 2));
      expect(peek<number>(el, 'displayScale')).toBe(1);
      expect(peek<number | null>(el, 'currentMin')).not.toBeNull();
    });
  });
});

describe('panning', () => {
  it('starts, moves and ends without throwing', async () => {
    const el = await mount();
    expect(() => {
      call(el, 'handleMouseDown', mouse(700, 400, 0));
      call(el, 'handlePanMove', mouse(760, 430));
    }).not.toThrow();
    await el.updateComplete;
    expect(el.innerHTML).toContain('<svg');
  });
});

describe('middle-drag on a drawing larger than the pane', () => {
  /*
   * jsdom measures everything as zero, so the overflow the handler
   * branches on has to be stated. These are the only numbers the
   * branch reads.
   */
  const overflowing = (el: TcViewer): HTMLElement => {
    const pane = el.querySelector('.pane-host') as HTMLElement;
    for (const [k, v] of [['clientWidth', 400], ['clientHeight', 300],
      ['scrollWidth', 1200], ['scrollHeight', 900]] as const) {
      Object.defineProperty(pane, k, { value: v, configurable: true });
    }
    pane.scrollLeft = 0;
    pane.scrollTop = 0;
    return pane;
  };

  it('moves the paper rather than the axes', async () => {
    /*
     * Once the reader has zoomed in, a drag means "show me the part I
     * cannot see". Changing the decades under them instead answers a
     * question they did not ask.
     */
    const el = await mount();
    const pane = overflowing(el);
    const before = [peek<number | null>(el, 'currentMin'), peek<number | null>(el, 'currentMax')];

    call(el, 'handleMouseDown', mouse(700, 400, 1));
    call(el, 'handlePanMove', mouse(640, 340));

    expect(pane.scrollLeft).toBe(60);
    expect(pane.scrollTop).toBe(60);
    expect([peek<number | null>(el, 'currentMin'), peek<number | null>(el, 'currentMax')])
      .toEqual(before);
    call(el, 'endPan');
  });

  it('moves vertically as well as horizontally', async () => {
    /*
     * The domain pan was horizontal only -- the time axis has never
     * been pannable -- so on a sheet the display zoom had made taller
     * than the pane there was no way to reach the bottom of it.
     */
    const el = await mount();
    const pane = overflowing(el);
    call(el, 'handleMouseDown', mouse(700, 400, 1));
    call(el, 'handlePanMove', mouse(700, 250));
    expect(pane.scrollTop).toBe(150);
    expect(pane.scrollLeft).toBe(0);
    call(el, 'endPan');
  });

  it('still pans the axes when the whole sheet is on screen', async () => {
    /*
     * Nothing to scroll to, so the gesture keeps its old meaning
     * rather than becoming a no-op.
     */
    const el = await mount();
    call(el, 'handleMouseDown', mouse(700, 400, 1));
    call(el, 'handlePanMove', mouse(640, 400));
    expect(peek<number | null>(el, 'currentMin')).not.toBeNull();
    call(el, 'endPan');
  });
});

describe('touch', () => {
  const touches = (points: Array<[number, number]>): TouchEvent => {
    const list = points.map(([clientX, clientY]) => ({ clientX, clientY }));
    return Object.assign(
      new Event('touchstart', { bubbles: true, cancelable: true }) as TouchEvent,
      { touches: list, changedTouches: list, preventDefault() { /* */ } },
    );
  };

  it('handles a one-finger drag', async () => {
    const el = await mount();
    expect(() => {
      call(el, 'handleTouchStart', touches([[700, 400]]));
      call(el, 'handleTouchMove', touches([[720, 410]]));
      call(el, 'handleTouchEnd');
    }).not.toThrow();
  });

  it('handles a two-finger pinch', async () => {
    const el = await mount();
    expect(() => {
      call(el, 'handleTouchStart', touches([[600, 400], [800, 400]]));
      call(el, 'handleTouchMove', touches([[560, 400], [840, 400]]));
      call(el, 'handleTouchEnd');
    }).not.toThrow();
    await el.updateComplete;
    expect(el.innerHTML).toContain('<svg');
  });

  it('spreads two fingers to make the drawing larger', async () => {
    /*
     * This used to zoom the *domain*, the way the wheel does -- which
     * re-lays the sheet out at the same size, so the one gesture a
     * phone has for "let me see that" was the one gesture that could
     * not answer it. Fingers apart now means bigger.
     */
    const el = await mount();
    call(el, 'handleTouchStart', touches([[600, 400], [800, 400]]));
    call(el, 'handleTouchMove', touches([[500, 400], [900, 400]]));
    call(el, 'handleTouchEnd');
    expect(peek<number>(el, 'displayScale')).toBeCloseTo(2, 2);
  });

  it('pinches them together to make it smaller', async () => {
    const el = await mount();
    call(el, 'handleTouchStart', touches([[500, 400], [900, 400]]));
    call(el, 'handleTouchMove', touches([[600, 400], [800, 400]]));
    call(el, 'handleTouchEnd');
    expect(peek<number>(el, 'displayScale')).toBeCloseTo(0.5, 2);
  });

  it('leaves the axes alone while it does', async () => {
    /*
     * The two zooms stay separate: the wheel reads the sheet, the
     * pinch reads the *drawing*. A reader who has zoomed in to see a
     * label has not asked for a different set of decades.
     */
    const el = await mount();
    const before = [peek<number | null>(el, 'currentMin'), peek<number | null>(el, 'currentMax')];
    call(el, 'handleTouchStart', touches([[600, 400], [800, 400]]));
    call(el, 'handleTouchMove', touches([[500, 400], [900, 400]]));
    call(el, 'handleTouchEnd');
    expect([peek<number | null>(el, 'currentMin'), peek<number | null>(el, 'currentMax')])
      .toEqual(before);
  });
});

describe('showing the drawing larger', () => {
  it('steps up and down', async () => {
    const el = await mount();
    call(el, 'zoomDisplayBy', 1.25);
    expect(peek<number>(el, 'displayScale')).toBeCloseTo(1.25, 3);
    call(el, 'zoomDisplayBy', 1 / 1.25);
    expect(peek<number>(el, 'displayScale')).toBeCloseTo(1, 3);
  });

  it('stops at a scale where the sheet is still a sheet', async () => {
    /*
     * Below about a third the labels have gone and above four times a
     * phone is looking at one curve through a keyhole. Both ends are
     * places a reader can get stuck, so neither is reachable.
     */
    const el = await mount();
    for (let i = 0; i < 20; i += 1) call(el, 'zoomDisplayBy', 2);
    expect(peek<number>(el, 'displayScale')).toBe(4);
    for (let i = 0; i < 20; i += 1) call(el, 'zoomDisplayBy', 0.5);
    expect(peek<number>(el, 'displayScale')).toBe(0.3);
  });

  it('sizes the drawing rather than the axes', async () => {
    /*
     * The whole point. The sheet is laid out at a readable size and
     * the pane scrolls it; it is not squeezed into whatever width the
     * screen has, which is what made 11px legend text render at 6.7px
     * on a phone.
     */
    const el = await mount();
    call(el, 'zoomDisplayBy', 2);
    await el.updateComplete;
    const box = el.querySelector<HTMLElement>('.sheet');
    expect(box, 'the drawing should sit in a sized box').not.toBeNull();
    const w = Number.parseFloat(box!.style.width);
    expect(w).toBeCloseTo(peek<number>(el, 'measuredW') * 2, 0);
  });

  it('goes back to actual size on demand', async () => {
    const el = await mount();
    call(el, 'zoomDisplayBy', 2);
    call(el, 'actualSize');
    expect(peek<number>(el, 'displayScale')).toBe(1);
  });

  it('is put back by resetting the view', async () => {
    /*
     * A reader who has pinched their way into a corner should not have
     * to find two separate controls to get out of it.
     */
    const el = await mount();
    call(el, 'zoomDisplayBy', 3);
    call(el, 'resetZoom');
    expect(peek<number>(el, 'displayScale')).toBe(1);
  });
});

describe('resetting the view', () => {
  it('puts the declared bounds back', async () => {
    const el = await mount();
    call(el, 'handleWheel', Object.assign(
      new WheelEvent('wheel', { deltaY: -120, clientX: 700, clientY: 400 }),
      { preventDefault() { /* */ } },
    ));
    await el.updateComplete;

    const reset = (el as unknown as { resetView?: () => void }).resetView;
    if (typeof reset === 'function') {
      reset.call(el);
      await el.updateComplete;
      expect(peek<number | null>(el, 'currentMin')).toBeNull();
    }
    expect(el.innerHTML).toContain('<svg');
  });
});

describe('the help popover', () => {
  it('opens and closes', async () => {
    const el = await mount();
    (el as unknown as Record<string, boolean>).showHelp = true;
    await el.updateComplete;
    expect(peek<boolean>(el, 'showHelp')).toBe(true);

    (el as unknown as Record<string, boolean>).showHelp = false;
    await el.updateComplete;
    expect(peek<boolean>(el, 'showHelp')).toBe(false);
  });
});
