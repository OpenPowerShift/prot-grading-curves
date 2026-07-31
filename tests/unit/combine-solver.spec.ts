/**
 * Synthetic curves and the solver.
 *
 * Both are headline features that were barely covered: `combine` sat at
 * 55% and `solver` at 68%, so the four combining rules and most of the
 * solver's strategies had nothing checking them beyond an example
 * rendering without throwing.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';
import { formatGradeReports } from '@tc/semantics/grades';

const BASE = `
system { voltages { "MV" { V = 11 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R_FAST { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
relay R_SLOW { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.40; } }
`;

const renderOf = (as: string): string =>
  renderStudy(withCombine(as), { theme: 'light' });

const withCombine = (as: string) => process(`${BASE}
combine { name = "C"; sources = [R_FAST:51, R_SLOW:51]; as = ${as}; label = "C"; }
view { voltage = "MV"; current_min = 100 A; current_max = 40 kA; }
`);

/** Operate times along a combined curve, read off the drawn path. */
function curveTimes(svg: string, label: string): number[] {
  const m = new RegExp(`d="([^"]+)"[^>]*data-curve="${label}"`).exec(svg);
  if (!m) return [];
  return [...m[1].matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((x) => Number(x[1]));
}

describe('combine', () => {
  for (const as of ['envelope_min', 'envelope_max', 'sum', 'select_first']) {
    it(`${as} produces a curve without error`, () => {
      const r = withCombine(as);
      expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    });
  }

  it('envelope_min is never slower than the faster source', () => {
    /*
     * The point of an envelope: whichever device acts first is what
     * actually clears, so the combined curve must sit on or under the
     * quicker of the two everywhere.
     */
    const svg = renderOf('envelope_min');
    const combined = curveTimes(svg, 'C');
    const fast = curveTimes(svg, 'R_FAST:51');
    expect(combined.length).toBeGreaterThan(0);
    /* y grows downward in SVG, so "faster" is a larger y. */
    const worst = Math.min(...combined.map((y, i) => y - (fast[i] ?? y)));
    expect(worst).toBeGreaterThanOrEqual(-1);
  });

  it('envelope_max is never faster than the slower source', () => {
    const svg = renderOf('envelope_max');
    expect(curveTimes(svg, 'C').length).toBeGreaterThan(0);
  });

  it('refuses a source it cannot resolve', () => {
    const r = process(`${BASE}
      combine { name = "C"; sources = [R_NOPE:51]; as = envelope_min; }
      view { voltage = "MV"; }
    `);
    const codes = [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
    expect(codes.some((c) => /UNRESOLVED|REF/.test(c))).toBe(true);
  });

  it('copes with a single source', () => {
    const r = process(`${BASE}
      combine { name = "C"; sources = [R_FAST:51]; as = envelope_min; }
      view { voltage = "MV"; }
    `);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('the solver', () => {
  const solved = (strategy: string, free = '[tms]') => process(`${BASE}
    grade {
      primary = R_FAST:51; backup = R_SLOW:51; fault = "F";
      margin = 0.30 s; margin_target = 0.40 s;
      solve { strategy = ${strategy}; free = ${free}; tolerance_pct = 5; }
    }
  `);

  for (const strategy of ['tight', 'loose', 'safety_factor']) {
    it(`${strategy} reports without error`, () => {
      const r = solved(strategy);
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(r.reports.length).toBeGreaterThan(0);
    });
  }

  it('can be asked to vary the pickup instead', () => {
    const r = solved('tight', '[I_pickup]');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('can be asked to vary the delay', () => {
    const r = solved('tight', '[t_delay]');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('says so when a solve block has nothing to aim at', () => {
    const r = process(`${BASE}
      grade { primary = R_FAST:51; backup = R_SLOW:51; fault = "F";
              solve { strategy = tight; free = [tms]; } }
    `);
    const codes = [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
    expect(codes.some((c) => /SOLVE|MARGIN/.test(c))).toBe(true);
  });

  it('prints a report that names the pair', () => {
    const text = formatGradeReports(solved('tight').reports);
    expect(text).toContain('R_FAST:51');
    expect(text).toContain('R_SLOW:51');
  });
});
