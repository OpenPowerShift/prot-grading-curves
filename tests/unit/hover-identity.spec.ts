/**
 * What the hover readout calls the thing under the cursor.
 *
 * A relay that declares a `name` is *drawn* as "11 kV feeder · Phase
 * TOC" and *referred to* as `R_FDR:51`, and only the second can be
 * typed into a `grade` or an `annotate`. Someone building a file has
 * the curve under the cursor and, before this, no way to get from the
 * one to the other without going back to the source and reading relay
 * blocks.
 *
 * The geometry stubs mirror `viewer-interaction.spec.ts`: jsdom
 * implements no SVG geometry, so an identity CTM is supplied and
 * client coordinates are user coordinates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAndRender, process as processStudy } from '@tc/index';
import '@tc/components/tc-viewer.js';
import type { TcViewer } from '@tc/components/tc-viewer.js';

const NAMED = `
system { voltages { "MV" { V = 11 kV; } } }
faults { "Board max" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R_FDR {
  name = "11 kV feeder"; voltage = "MV"; ct_ratio = 400/5;
  element 51 { name = "Phase TOC"; function = "phase_oc";
               curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
point "Inrush" { I = 2 kA; t = 100 ms; label = "Transformer inrush"; }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA;
       time_min = 20 ms; time_max = 100 s; }
`;

const ANONYMOUS = `
system { voltages { "MV" { V = 11 kV; } } }
relay R_FDR { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA; }
`;

describe('the sheet carries each curve\'s reference', () => {
  it('emits data-ref beside data-curve', () => {
    const { svg } = parseAndRender(NAMED, { theme: 'light' });
    const found = /data-curve="([^"]*)" data-ref="([^"]*)"/.exec(svg);
    expect(found, 'a curve was drawn with both attributes').not.toBeNull();
    expect(found![2]).toBe('R_FDR:51');
  });

  it('gives the reference even where the label is the drawing\'s own words', () => {
    const { svg } = parseAndRender(NAMED, { theme: 'light' });
    const found = /data-curve="([^"]*)" data-ref="([^"]*)"/.exec(svg)!;
    expect(found[1]).toContain('11 kV feeder');
    expect(found[1]).not.toBe(found[2]);
  });

  it('names each stage of a multi-stage element separately', () => {
    const staged = `
      system { voltages { "MV" { V = 11 kV; } } }
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; stages {
          stage main { curve = iec.si; I_pickup = 480 A; tms = 0.1; }
          stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
        } } }
      view { voltage = "MV"; stages = "individual"; }`;
    const { svg } = parseAndRender(staged, { theme: 'light' });
    const refs = [...svg.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]);
    expect(refs).toContain('R:51/main');
    expect(refs).toContain('R:51/inst');
  });
});

describe('the readout', () => {
  class TestPoint {
    constructor(public x = 0, public y = 0) {}
    matrixTransform(m: { a: number; b: number; c: number; d: number; e: number; f: number }): TestPoint {
      return new TestPoint(this.x * m.a + this.y * m.c + m.e, this.x * m.b + this.y * m.d + m.f);
    }
  }
  (globalThis as unknown as { DOMPoint: unknown }).DOMPoint = TestPoint;

  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => { host.remove(); });

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

  const hoverState = (el: TcViewer): { curveLabel?: string; ref?: string } | null =>
    (el as unknown as Record<string, { curveLabel?: string; ref?: string } | null>).hover;

  /**
   * Put the cursor on a curve and return what it latched onto.
   *
   * The position is read off the drawn path rather than searched for.
   * A grid sweep also works, but thousands of synchronous mousemove
   * handlers in one tick starve the event loop enough to make the
   * debounced parse in `app.spec.ts` miss its timer -- a test that
   * makes another suite flaky is a bad test however green it is.
   */
  const findSnap = (el: TcViewer): { curveLabel?: string; ref?: string } | null => {
    const move = (el as unknown as Record<string, (e: MouseEvent) => void>).handleMouseMove;
    const path = el.querySelector('path.tc-curve');
    const d = path?.getAttribute('d') ?? '';

    /* Any vertex of the polyline is by definition on the curve. */
    for (const vertex of [...d.matchAll(/[ML]\s*([\d.]+)[\s,]+([\d.]+)/g)]) {
      const x = Number(vertex[1]);
      const y = Number(vertex[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      move.call(el, new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      const state = hoverState(el);
      if (state?.ref) return state;
    }
    return null;
  };

  it('carries the reference through to the hover state', async () => {
    const el = await mount(NAMED);
    const snapped = findSnap(el);
    expect(snapped, 'the cursor latched onto something').not.toBeNull();
    expect(snapped!.ref).toBeTruthy();
  });

  it('gives a named relay a reference distinct from its label', async () => {
    const el = await mount(NAMED);
    const snapped = findSnap(el);
    if (snapped?.ref === 'R_FDR:51') {
      expect(snapped.curveLabel).not.toBe(snapped.ref);
    }
  });

  it('gives an unnamed relay a reference equal to its label, so it is not shown twice', async () => {
    /*
     * The suppression case: with nothing named, the drawing's word for
     * a curve *is* its reference, and a second identical line in the
     * readout would be noise.
     */
    const el = await mount(ANONYMOUS);
    const snapped = findSnap(el);
    expect(snapped, 'the cursor latched onto something').not.toBeNull();
    expect(snapped!.ref).toBe(snapped!.curveLabel);
  });

  /**
   * The readout box's own text lines.
   *
   * Scoped to what the overlay *added*: the sheet beneath it already
   * names every curve in its legend, so reading the whole document
   * counts those too.
   */
  const readout = (el: TcViewer): string[] => {
    const draw = (el as unknown as Record<string, (s: string) => string>).renderWithOverlay;
    const base = el.querySelector('svg')?.outerHTML ?? '';
    const added = draw.call(el, base).slice(base.length - '</svg>'.length);
    return [...added.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
  };

  it('prints the reference in the box, under the label', async () => {
    const el = await mount(NAMED);
    const snapped = findSnap(el);
    expect(snapped, 'the cursor latched onto something').not.toBeNull();

    const lines = readout(el);
    expect(lines, 'the readout names the curve').toContain(snapped!.curveLabel);
    if (snapped!.ref !== snapped!.curveLabel) {
      expect(lines, 'the readout gives the reference too').toContain(snapped!.ref);
      expect(lines.indexOf(snapped!.ref!))
        .toBeGreaterThan(lines.indexOf(snapped!.curveLabel!));
    }
  });

  it('does not print the reference twice when it is the label', async () => {
    const el = await mount(ANONYMOUS);
    const snapped = findSnap(el);
    expect(snapped).not.toBeNull();

    const lines = readout(el);
    expect(lines.filter((l) => l === snapped!.curveLabel)).toHaveLength(1);
  });
});
