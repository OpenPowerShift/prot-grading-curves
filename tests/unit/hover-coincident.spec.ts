/**
 * What the hover says when two curves lie on top of each other.
 *
 * Curves coincide often: two feeders set identically, a composite and
 * the stage that forms it, an element drawn on two sheets. The readout
 * named whichever path happened to come first in the document -- an
 * arbitrary answer with an authoritative look, on the one question the
 * hover exists to answer.
 *
 * Geometry stubs as in `viewer-interaction.spec.ts`: jsdom implements
 * no SVG geometry, so an identity CTM makes client coordinates user
 * coordinates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { process as processStudy } from '@tc/index';
import '@tc/components/tc-viewer.js';
import type { TcViewer } from '@tc/components/tc-viewer.js';

/** Two relays set identically, so their characteristics are one line. */
const TWINS = `
system { voltages { "MV" { V = 11 kV; } } }
relay R_A { name = "Feeder A"; voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
relay R_B { name = "Feeder B"; voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA; }
`;

/**
 * Two relays that are nowhere near each other.
 *
 * Different *pickups* as well as different dials. Sharing a pickup is
 * not enough separation: both characteristics rise vertically at the
 * same current, so near that riser they really are coincident and
 * saying so is correct.
 */
const APART = `
system { voltages { "MV" { V = 11 kV; } } }
relay R_A { name = "Feeder A"; voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 300 A; tms = 0.05; } }
relay R_B { name = "Incomer"; voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 3 kA; tms = 1.20; } }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA; }
`;

class TestPoint {
  constructor(public x = 0, public y = 0) {}
  matrixTransform(m: { a: number; b: number; c: number; d: number; e: number; f: number }): TestPoint {
    return new TestPoint(this.x * m.a + this.y * m.c + m.e, this.x * m.b + this.y * m.d + m.f);
  }
}
(globalThis as unknown as { DOMPoint: unknown }).DOMPoint = TestPoint;

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); });
afterEach(() => { host.remove(); });

type Hover = {
  curveLabel?: string;
  ref?: string;
  alsoHere?: Array<{ curveLabel: string; ref?: string }>;
} | null;

const mount = async (source: string): Promise<TcViewer> => {
  const result = processStudy(source);
  const el = document.createElement('tc-viewer') as TcViewer;
  el.document = result.document;
  el.study = result.study;
  el.errors = result.parseErrors;
  host.append(el);
  await el.updateComplete;

  const svg = el.querySelector('svg');
  if (svg) {
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse() { return this; } };
    Object.assign(svg, { getScreenCTM: () => identity, createSVGPoint: () => new TestPoint() });
    svg.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 1500, height: 1000, top: 0, left: 0,
      right: 1500, bottom: 1000, toJSON: () => ({}),
    }) as DOMRect;
  }
  return el;
};

/** Hover a vertex of the first drawn curve and return the snap state. */
const hoverACurve = (el: TcViewer): Hover => {
  const move = (el as unknown as Record<string, (e: MouseEvent) => void>).handleMouseMove;
  const d = el.querySelector('path.tc-curve')?.getAttribute('d') ?? '';
  for (const vertex of [...d.matchAll(/[ML]\s*([\d.]+)[\s,]+([\d.]+)/g)]) {
    move.call(el, new MouseEvent('mousemove', {
      clientX: Number(vertex[1]), clientY: Number(vertex[2]), bubbles: true,
    }));
    const state = (el as unknown as Record<string, Hover>).hover;
    if (state?.ref) return state;
  }
  return null;
};

describe('two curves on the same line', () => {
  it('are both reported', async () => {
    const el = await mount(TWINS);
    const state = hoverACurve(el);
    expect(state, 'the cursor latched onto a curve').not.toBeNull();
    expect(state!.alsoHere, 'the second curve was reported too').toBeDefined();
    expect(state!.alsoHere).toHaveLength(1);
  });

  it('name the two different relays', async () => {
    const el = await mount(TWINS);
    const state = hoverACurve(el)!;
    const refs = [state.ref, ...(state.alsoHere ?? []).map((o) => o.ref)].sort();
    expect(refs).toEqual(['R_A:51', 'R_B:51']);
  });

  it('carry a reference each, not just a label', async () => {
    const el = await mount(TWINS);
    const state = hoverACurve(el)!;
    for (const other of state.alsoHere ?? []) {
      expect(other.ref).toBeTruthy();
      expect(other.curveLabel).toBeTruthy();
    }
  });
});

describe('two curves that are far apart', () => {
  it('do not get bundled together', async () => {
    /*
     * The check is on *position*, not on distance from the cursor: two
     * curves equidistant either side of the pointer are two answers,
     * not one coincidence.
     */
    const el = await mount(APART);
    const state = hoverACurve(el);
    expect(state, 'the cursor latched onto a curve').not.toBeNull();
    expect(state!.alsoHere).toBeUndefined();
  });
});

describe('two curves sharing only a pickup', () => {
  it('are reported together at the riser, where they do coincide', async () => {
    /*
     * Not a false positive. Both characteristics rise vertically at
     * the same current, so on that riser the two really are in the
     * same place and the honest answer names both.
     */
    const SHARED_PICKUP = `
      system { voltages { "MV" { V = 11 kV; } } }
      relay R_A { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.05; } }
      relay R_B { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 1.20; } }
      view { voltage = "MV"; current_min = 100 A; current_max = 40 kA; }`;
    const el = await mount(SHARED_PICKUP);
    const state = hoverACurve(el);
    expect(state!.alsoHere).toBeDefined();
  });
});

describe('the readout box', () => {
  const readout = (el: TcViewer): string[] => {
    const draw = (el as unknown as Record<string, (s: string) => string>).renderWithOverlay;
    const base = el.querySelector('svg')?.outerHTML ?? '';
    const added = draw.call(el, base).slice(base.length - '</svg>'.length);
    return [...added.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
  };

  it('lists both curves', async () => {
    const el = await mount(TWINS);
    hoverACurve(el);
    const lines = readout(el);
    expect(lines).toContain('R_A:51');
    expect(lines).toContain('R_B:51');
  });

  it('bolds every relay name, not only the first', async () => {
    /*
     * The second curve's identity used to run on underneath the
     * first's in ordinary weight, reading as though it belonged to it.
     */
    const el = await mount(TWINS);
    hoverACurve(el);
    const draw = (el as unknown as Record<string, (s: string) => string>).renderWithOverlay;
    const base = el.querySelector('svg')?.outerHTML ?? '';
    const added = draw.call(el, base).slice(base.length - '</svg>'.length);
    const bolded = [...added.matchAll(/<text[^>]*font-weight="600"[^>]*>([^<]*)</g)]
      .map((m) => m[1]);
    expect(bolded).toHaveLength(2);
    expect(bolded.every((b) => b.includes('Feeder'))).toBe(true);
  });

  it('describes each curve in the same shape', async () => {
    /* name, reference, level -- per curve, so the two read line
     * against line rather than as one run-on list. */
    const el = await mount(TWINS);
    hoverACurve(el);
    const lines = readout(el);
    const a = lines.indexOf('R_A:51');
    const b = lines.indexOf('R_B:51');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    /* Each reference is preceded by its own name and followed by its
     * own level, so the blocks are the same length. */
    expect(b - a).toBe(3);
  });

  it('puts the identities above the coordinates', async () => {
    /* The numbers are shared by everything here; which curves they
     * belong to is the part a reader cannot infer. */
    const el = await mount(TWINS);
    hoverACurve(el);
    const lines = readout(el);
    const lastName = Math.max(lines.indexOf('R_A:51'), lines.indexOf('R_B:51'));
    const firstNumber = lines.findIndex((l) => l.startsWith('I ='));
    expect(firstNumber).toBeGreaterThan(lastName);
  });
});

describe('a marked point sitting on a curve', () => {
  /*
   * Points are usually placed *on* a characteristic -- that is what
   * makes them worth marking -- so the two are within a pixel of each
   * other and the curve won by being tested first. The point is the
   * more specific answer: a curve is continuous and says the same
   * thing either side of the cursor, where a point is a single
   * coordinate the study asserts.
   */
  const ON_CURVE = `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = definite;
               I_pickup = 400 A; t_delay = 500 ms; } }
point "Inrush" { I = 2 kA; t = 500 ms; voltage = "MV"; label = "Inrush"; }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA;
       time_min = 10 ms; time_max = 100 s; }
`;

  /** Hover the marker the renderer drew, wherever it put it. */
  const hoverThePoint = (el: TcViewer): Hover => {
    const move = (el as unknown as Record<string, (e: MouseEvent) => void>).handleMouseMove;
    const group = el.querySelector('g[data-point]');
    const x = Number(group?.getAttribute('data-px'));
    const y = Number(group?.getAttribute('data-py'));
    expect(Number.isFinite(x) && Number.isFinite(y), 'the point was drawn').toBe(true);
    move.call(el, new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    return (el as unknown as Record<string, Hover>).hover;
  };

  it('reports the point, not the curve under it', async () => {
    const el = await mount(ON_CURVE);
    const state = hoverThePoint(el);
    expect(state).not.toBeNull();
    expect(state!.ref).toBe('Inrush');
  });

  it('still names the curve it displaced', async () => {
    /* The curve is under the cursor too, and losing by a pixel is no
     * reason to drop it. */
    const el = await mount(ON_CURVE);
    const state = hoverThePoint(el);
    const also = (state!.alsoHere ?? []).map((o) => o.ref);
    expect(also).toContain('R:51');
  });
});
