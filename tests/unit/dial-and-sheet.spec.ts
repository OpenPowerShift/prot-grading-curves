/**
 * Two things the documentation promised and the code did not do.
 *
 * *The dial range was keyed on the namespace string.* `ANSI_NAMESPACES`
 * held exactly `'ansi'`, so `ge.ur.mi` -- which the constants table
 * itself labels "(C37.112 mi)" -- rejected a perfectly legal time dial
 * of 3.0 as outside `[0.025, 1.5]`. The obvious response to that error
 * is to divide by ten, which gives a curve ten times fast. It also made
 * the solver declare a satisfiable grade *unsatisfiable* and advise
 * changing the curve family.
 *
 * A namespace is a *vendor*, and vendors ship both dials: GE's UR
 * series carries `ur.mi` (time dial) beside `ur.si` (TMS) in the same
 * table.
 *
 * *`page { size = { width_mm; height_mm } }` never parsed.*
 * `grammar.adoc` has published the object form since the first draft.
 * Everything downstream was built for it -- `resolvePageMm`,
 * `sheetSize`, and a `PAGE_SIZE_INCOMPLETE` check that could never
 * fire -- and the parser swallowed the object whole, leaving the sheet
 * at A4 with nothing said.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';
import { CURVES, allCurveIds, tmsRangeFor, TMS_RANGE_ANSI, TMS_RANGE_IEC }
  from '@tc/constants/curves';
import { sheetSize } from '@tc/renderer/sheet';
import { DEFAULT_PAGE_MARGIN_MM } from '@tc/export/export-pdf';
import { parse as parseSource } from '@tc/parser';

const study = (curve: string, tms: number): string => `
system { voltages { MV { V = 11 kV; } } }
relay R { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = ${curve}; I_pickup = 400 A; tms = ${tms}; } }
view { voltage = MV; }
`;

const rangeErrors = (curve: string, tms: number): string[] =>
  [...parse(study(curve, tms)).parseErrors, ...parse(study(curve, tms)).diagnostics]
    .filter((d) => d.code === 'TMS_OUT_OF_RANGE')
    .map((d) => d.message);

describe('which dial a curve is set in', () => {
  it('is carried on the curve, so one vendor may use both', () => {
    /*
     * The case that was wrong. Both are GE UR curves in one namespace;
     * `mi` is C37.112 and `si` is IEC, and they take different dials.
     */
    expect(tmsRangeFor('ge.ur.mi')).toEqual(TMS_RANGE_ANSI);
    expect(tmsRangeFor('ge.ur.si')).toEqual(TMS_RANGE_IEC);
  });

  it('accepts a time dial of 3.0 on every C37.112 curve', () => {
    for (const id of ['ansi.mi', 'ge.ur.mi', 'ge.ur.vi', 'sel.u1', 'siemens.inv']) {
      expect(rangeErrors(id, 3.0), `${id} should accept a dial of 3`).toEqual([]);
    }
  });

  it('still refuses 3.0 on an IEC curve, whatever namespace it is filed in', () => {
    for (const id of ['iec.si', 'ge.ur.si', 'sel.c1', 'schneider.sit']) {
      expect(rangeErrors(id, 3.0), `${id} should refuse a dial of 3`).toHaveLength(1);
    }
  });

  it('refuses a TMS-sized figure on a time-dial curve', () => {
    /* The other direction: 0.2 is a plausible TMS and not a legal
     * time dial, and reads as ten times fast. */
    expect(rangeErrors('ansi.mi', 0.2)).toHaveLength(1);
    expect(rangeErrors('ge.ur.mi', 0.2)).toHaveLength(1);
  });

  it('names the curve rather than a family, so the reader can check it', () => {
    expect(rangeErrors('ge.ur.si', 3.0)[0]).toContain('ge.ur.si');
    expect(rangeErrors('ge.ur.si', 3.0)[0]).toContain('[0.025, 1.5]');
  });
});

describe('the constants table', () => {
  it('states a dial for every curve, so a new row cannot forget', () => {
    for (const id of allCurveIds()) {
      const ix = id.indexOf('.');
      const c = CURVES[id.slice(0, ix)]![id.slice(ix + 1)]!;
      expect(['iec', 'ansi'], `${id}`).toContain(c.dial);
    }
  });

  it('agrees with the additive term, which is what makes the C37.112 shape', () => {
    /*
     * Not how the lookup works -- the dial is written out so a reader
     * can audit it against the standard rather than infer it from a
     * coefficient -- but the two must not disagree, and this is what
     * would catch a mistyped row.
     *
     * The ABB forms are excluded: `ri` and `log` are not IDMT at all,
     * so `c` means nothing for them.
     */
    for (const id of allCurveIds()) {
      const ix = id.indexOf('.');
      const c = CURVES[id.slice(0, ix)]![id.slice(ix + 1)]!;
      if (c.form === 'ri' || c.form === 'log') continue;
      expect(c.dial === 'ansi', `${id} (c = ${c.c})`).toBe(c.c !== 0);
    }
  });
});

describe('the solver on a time-dial curve', () => {
  it('solves what it used to call unsatisfiable', () => {
    /*
     * Clamped to the IEC maximum of 1.5, the solver reported the pair
     * unsatisfiable and advised changing the curve family -- for a
     * study that was correct as written.
     */
    const r = parse(`
system { voltages { MV { V = 11 kV; } } }
faults { F { I = 6 kA; type = three_phase; voltage = MV; } }
relay R_P { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = ge.ur.mi; I_pickup = 400 A; tms = 2.0; } }
relay R_B { voltage = MV; ct_ratio = 800/5;
  element 51 { function = phase_oc; curve = ge.ur.mi; I_pickup = 800 A; tms = 1.0; } }
grade { primary = R_P:51; backup = R_B:51; fault = F; margin = 1.5 s; upstream = false;
        solve { strategy = tight; } }
view { voltage = MV; }
`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.reports[0]!.solve?.ok).toBe(true);
    expect(r.reports[0]!.solve!.tms).toBeGreaterThan(1.5);
    expect(r.reports[0]!.pass).toBe(true);
  });
});

describe('a sheet stated in millimetres', () => {
  const page = (size: string): string => `
system { voltages { MV { V = 11 kV; } } }
relay R { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
page { size = ${size} orientation = landscape; }
view { voltage = MV; }
`;

  const sizeOf = (src: string): unknown => {
    const doc = parseSource(src).document!;
    return (doc.items.find((i) => i.type === 'page') as { size?: unknown } | undefined)?.size;
  };

  it('parses, where the object used to be swallowed whole', () => {
    expect(sizeOf(page('{ width_mm = 420; height_mm = 200; };')))
      .toEqual({ width_mm: 420, height_mm: 200 });
  });

  it('reaches the canvas, so the sheet is the one that was asked for', () => {
    /*
     * The canvas matches the *printable* area -- the sheet less its
     * margins -- because that is what the PDF export scales into. The
     * long edge is fixed at 1400 px, so the check is on the aspect.
     */
    const canvasFor = (size: string) => {
      const doc = parseSource(page(size)).document!;
      return sheetSize(doc.items.find((i) => i.type === 'page')! as never);
    };
    const m = DEFAULT_PAGE_MARGIN_MM;
    const wide = canvasFor('{ width_mm = 420; height_mm = 200; };');
    expect(wide.width).toBe(1400);
    expect(wide.height / wide.width)
      .toBeCloseTo((200 - 2 * m) / (420 - 2 * m), 2);

    /* ...and a different sheet gives a different canvas, which is the
     * whole point: it used to be A4 whatever was asked for. A square
     * sheet, rather than a portrait one -- `orientation = landscape`
     * puts the long edge horizontal whichever way round it was
     * written, so 200 x 420 and 420 x 200 are the same paper. */
    const square = canvasFor('{ width_mm = 300; height_mm = 300; };');
    expect(square.width).toBe(square.height);
    expect(square.height).toBeGreaterThan(wide.height);
  });

  it('keeps the paper keyword working', () => {
    expect(sizeOf(page('"A3";'))).toBe('A3');
    expect(sizeOf(page('A3;'))).toBe('A3');
  });

  it('reports one dimension without the other, a check that could not fire', () => {
    const r = parse(page('{ width_mm = 420; };'));
    expect(r.diagnostics.map((d) => d.code)).toContain('PAGE_SIZE_INCOMPLETE');
  });

  it('still draws a sheet when it does, so the diagnostic has something to sit beside', () => {
    /*
     * One dimension makes every figure downstream NaN and the SVG
     * comes out with no width at all. A study is rendered alongside
     * its errors in the playground.
     */
    const doc = parseSource(page('{ width_mm = 420; };')).document!;
    const block = doc.items.find((i) => i.type === 'page')!;
    const { width, height } = sheetSize(block as never);
    expect(Number.isFinite(width) && width > 0).toBe(true);
    expect(Number.isFinite(height) && height > 0).toBe(true);
  });

  it('refuses a key that is not a dimension', () => {
    const errors = parseSource(page('{ width_mm = 420; depth_mm = 3; };')).errors;
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_SETTING');
  });
});
