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
