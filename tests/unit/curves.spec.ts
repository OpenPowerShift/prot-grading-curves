/**
 * Numerical conformance against the spec's normative tables.
 *
 * Sources:
 *   spec/sections/worked-examples.adoc -- _Operate time_
 *   spec/sections/semantics.adoc       -- _Standard curve identifiers_
 *
 * These are the acceptance vectors named in the implementation plan's
 * Phase 1: the operate times must agree within +/- 0.005 s.
 */

import { describe, expect, it } from 'vitest';
import {
  tTripIDMT,
  tTripDefinite,
  tTripFlex,
  tTripRI,
  tTripLog,
  curveParamsFromId,
} from '@tc/semantics/curves';
import { CURVES, lookupCurve, allCurveIds, suggestCurveId } from '@tc/constants/curves';

const TOL = 0.005;

/** spec/sections/worked-examples.adoc -- _Operate time_, at TMS = 1.0. */
const OPERATE_TIME: Array<[number, number, number, number, number]> = [
  //  M     iec.si   iec.vi   iec.ei   ansi.mi
  [   2,   10.029,  13.500,  26.667,   3.803],
  [   5,    4.280,   3.375,   3.333,   1.688],
  [  10,    2.971,   1.500,   0.808,   1.207],
  [  20,    2.267,   0.711,   0.201,   0.948],
  [  50,    1.720,   0.276,   0.032,   0.747],
];

describe('IDMT operate time -- spec worked table', () => {
  for (const [M, si, vi, ei, mi] of OPERATE_TIME) {
    it(`matches every curve at M = ${M}`, () => {
      expect(tTripIDMT(M, curveParamsFromId('iec.si')!, 1)).toBeCloseTo(si, 2);
      expect(tTripIDMT(M, curveParamsFromId('iec.vi')!, 1)).toBeCloseTo(vi, 2);
      expect(tTripIDMT(M, curveParamsFromId('iec.ei')!, 1)).toBeCloseTo(ei, 2);
      expect(tTripIDMT(M, curveParamsFromId('ansi.mi')!, 1)).toBeCloseTo(mi, 2);
    });
  }

  it('hits the tolerance the spec calls out explicitly', () => {
    const t = tTripIDMT(10, curveParamsFromId('iec.si')!, 1);
    expect(Math.abs(t - 2.971)).toBeLessThanOrEqual(TOL);
  });

  it('scales linearly with tms', () => {
    const p = curveParamsFromId('iec.si')!;
    expect(tTripIDMT(10, p, 0.3)).toBeCloseTo(tTripIDMT(10, p, 1) * 0.3, 10);
  });

  it('does not operate at or below pickup', () => {
    const p = curveParamsFromId('iec.si')!;
    expect(tTripIDMT(1, p, 1)).toBe(Infinity);
    expect(tTripIDMT(0.5, p, 1)).toBe(Infinity);
  });

  it('honours an explicit G_D ceiling when one is supplied', () => {
    const p = { ...curveParamsFromId('iec.si')!, G_D: 20 };
    // clamped at M = 20, so M = 50 gives the M = 20 value
    expect(tTripIDMT(50, p, 1)).toBeCloseTo(2.267, 2);
  });
});

describe('curve constants table matches the spec', () => {
  // spec/sections/semantics.adoc -- IEC 60255-151:2009 Annex A (curves A-F)
  const EXPECTED: Record<string, { k: number; c: number; alpha: number }> = {
    'iec.si':  { k: 0.14,   c: 0,       alpha: 0.02 },
    'iec.vi':  { k: 13.5,   c: 0,       alpha: 1.0 },
    'iec.ei':  { k: 80,     c: 0,       alpha: 2.0 },
    'iec.lti': { k: 120,    c: 0,       alpha: 1.0 },
    'iec.sti': { k: 0.05,   c: 0,       alpha: 0.04 },
    'ansi.mi': { k: 0.0515, c: 0.114,   alpha: 0.02 },
    'ansi.vi': { k: 19.61,  c: 0.491,   alpha: 2.0 },
    'ansi.ei': { k: 28.2,   c: 0.1217,  alpha: 2.0 },
    'sel.c1':  { k: 0.14,   c: 0,       alpha: 0.02 },
    'sel.u1':  { k: 0.0226, c: 0.0104,  alpha: 0.02 },
    'siemens.inv':     { k: 0.0086, c: 0.0185, alpha: 0.02 },
    'siemens.long_vi': { k: 28.55,  c: 0.712,  alpha: 2.0 },
    'ge.ur.mi': { k: 0.0515, c: 0.114,  alpha: 0.02 },
    'ge.ur.si': { k: 0.14,   c: 0,      alpha: 0.02 },
  };

  for (const [id, want] of Object.entries(EXPECTED)) {
    it(`${id} carries the published constants`, () => {
      const got = curveParamsFromId(id);
      expect(got, `${id} is missing from the constants table`).toBeDefined();
      expect(got!.k).toBeCloseTo(want.k, 6);
      expect(got!.c).toBeCloseTo(want.c, 6);
      expect(got!.alpha).toBeCloseTo(want.alpha, 6);
    });
  }

  it('exposes every namespace the spec declares processor-known', () => {
    for (const ns of ['iec', 'ansi', 'sel', 'ge', 'abb', 'schneider', 'siemens']) {
      expect(Object.keys(CURVES)).toContain(ns);
    }
  });

  it('leaves the IEC reset constant manufacturer-defined', () => {
    // spec table writes `_mfr_` for curves A, B, C
    expect(lookupCurve('iec', 'si')!.t_r).toBeNull();
    expect(lookupCurve('iec', 'vi')!.t_r).toBeNull();
    expect(lookupCurve('iec', 'ei')!.t_r).toBeNull();
    // ANSI rows D, E, F do publish one
    expect(lookupCurve('ansi', 'mi')!.t_r).toBeCloseTo(4.85, 6);
  });

  it('suggests a close curve id for a typo', () => {
    expect(suggestCurveId('iec.s1')).toBe('iec.si');
    expect(suggestCurveId('ansi.mo')).toBe('ansi.mi');
    expect(suggestCurveId('completely.wrong')).toBeUndefined();
  });

  it('lists ids as namespace.family', () => {
    const ids = allCurveIds();
    expect(ids).toContain('iec.si');
    expect(ids).toContain('ge.ur.vi');
    expect(ids).toContain('abb.ri');
  });
});

describe('non-IDMT forms', () => {
  it('definite time operates only at or above pickup', () => {
    expect(tTripDefinite(4000, 3200, 0.05)).toBe(0.05);
    expect(tTripDefinite(3200, 3200, 0.05)).toBe(0.05);
    expect(tTripDefinite(3199, 3200, 0.05)).toBe(Infinity);
  });

  it('ABB RI is hyperbolic in the multiple', () => {
    // t = 1 / (0.339 - 0.236 / M)
    expect(tTripRI(2, 0.339, 0.236, 1)).toBeCloseTo(4.5249, 4);
    expect(tTripRI(5, 0.339, 0.236, 1)).toBeCloseTo(3.4270, 4);
  });

  it('ABB RI decays towards an asymptote, never to zero', () => {
    /*
     * The regression this replaces: RI carried RD's constants in a
     * linear form, `t = 5.8 - 1.35 M`, which crosses zero at M = 4.3
     * and was clamped there. Every fault above four times pickup
     * therefore read as cleared in 0.000 s -- the fastest answer
     * available, asserted where the curve had simply run out.
     */
    const asymptote = 1 / 0.339;
    for (const M of [5, 10, 50, 1000]) {
      const t = tTripRI(M, 0.339, 0.236, 1);
      expect(t).toBeGreaterThan(asymptote);
    }
    expect(tTripRI(1e6, 0.339, 0.236, 1)).toBeCloseTo(asymptote, 4);
    /* Monotonically decreasing, so the curve slopes the right way. */
    expect(tTripRI(10, 0.339, 0.236, 1)).toBeLessThan(tTripRI(5, 0.339, 0.236, 1));
  });

  it('scales with tms', () => {
    expect(tTripRI(3, 0.339, 0.236, 0.5)).toBeCloseTo(tTripRI(3, 0.339, 0.236, 1) / 2, 6);
  });

  it('ABB RD is logarithmic in the multiple', () => {
    // t = 5.8 - 1.35 * ln(M)
    expect(tTripLog(Math.E, 5.8, 1.35, 1)).toBeCloseTo(5.8 - 1.35, 6);
    expect(tTripLog(10, 5.8, 1.35, 1)).toBeCloseTo(5.8 - 1.35 * Math.LN10, 6);
  });

  it('RD says nothing past its zero crossing rather than claiming 0 s', () => {
    /* exp(5.8 / 1.35) ~ 73.4, beyond which the published form is
     * negative. Infinity draws no curve and grades as no operation;
     * zero would have claimed instantaneous clearance. */
    expect(tTripLog(73, 5.8, 1.35, 1)).toBeGreaterThan(0);
    expect(tTripLog(74, 5.8, 1.35, 1)).toBe(Infinity);
  });

});

describe('FlexCurve piecewise interpolation', () => {
  const points = [
    { I_A: 240, t_s: 50.0 },
    { I_A: 600, t_s: 5.0 },
    { I_A: 1200, t_s: 1.0 },
    { I_A: 5000, t_s: 0.20 },
  ];

  it('reproduces the tabulated points exactly', () => {
    for (const p of points) {
      expect(tTripFlex(p.I_A, points)).toBeCloseTo(p.t_s, 6);
    }
  });

  it('interpolates linearly in log-log space', () => {
    // midpoint in log10(I) between 600 and 1200 -> midpoint in log10(t)
    const I = Math.pow(10, (Math.log10(600) + Math.log10(1200)) / 2);
    const want = Math.pow(10, (Math.log10(5.0) + Math.log10(1.0)) / 2);
    expect(tTripFlex(I, points)).toBeCloseTo(want, 6);
  });

  it('does not operate below the table and holds above it', () => {
    expect(tTripFlex(100, points)).toBe(Infinity);
    expect(tTripFlex(50_000, points)).toBeCloseTo(0.20, 6);
  });

  it('absorbs tms linearly', () => {
    expect(tTripFlex(600, points, 0.5)).toBeCloseTo(2.5, 6);
  });
});
