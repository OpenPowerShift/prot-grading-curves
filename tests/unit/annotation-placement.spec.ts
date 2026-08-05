/**
 * Annotations that cannot be drawn have to say so.
 *
 * The renderer used to drop a point annotation with a bare `continue`
 * at five separate places: no resolvable current, a non-finite operate
 * time, no position on the sheet's axis, a non-finite pixel. Three of
 * the five annotations in the shipped sequence sample were being lost
 * that way -- nothing on the sheet, nothing in the report, and a study
 * that looked complete.
 *
 * What can be seen without a viewport is a diagnostic; what depends on
 * the window is a note on the sheet.
 */

import { describe, expect, it } from 'vitest';
import { process, parseAndRender, renderStudy } from '@tc/index';

const SYS = 'system { voltages { "HV" { V = 33 kV; } } }\n';

const STUDY = `${SYS}
faults { "F" { I = 6 kA; type = single_phase_earth; voltage = "HV"; } }
relay R { voltage = "HV"; ct_ratio = 400/5;
  element 51  { function = "phase_oc";    curve = iec.si; I_pickup = 480 A; tms = 0.12; }
  element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 240 A; tms = 0.10; }
  element 46  { function = "neg_seq"; measures = 3I2; curve = definite;
                I_pickup = 900 A; t_delay = 1.2 s; }
}
`;

const codes = (src: string): string[] => {
  const r = process(src);
  return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
};

describe('a label that will never be drawn', () => {
  it('is refused on a pin, which is specified as a marker only', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51; at_I = 3 kA; label = "x"; style = pin; }`))
      .toContain('ANNOTATE_LABEL_NOT_DRAWN');
  });

  it('is fine on a pin with no label', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51; at_I = 3 kA; style = pin; }`))
      .not.toContain('ANNOTATE_LABEL_NOT_DRAWN');
  });

  for (const style of ['leader', 'tag']) {
    it(`is fine on a ${style}, which draws it`, () => {
      expect(codes(`${STUDY}annotate { on_curve = R:51; at_I = 3 kA; label = "x"; style = ${style}; }`))
        .not.toContain('ANNOTATE_LABEL_NOT_DRAWN');
    });
  }
});

describe('a component the annotated element does not measure', () => {
  it('is refused rather than dropped', () => {
    /* Positive sequence is not negative sequence, and nothing will
     * substitute one for the other -- so this used to vanish. */
    expect(codes(`${STUDY}annotate { on_curve = R:46; at_I1 = 800 A; label = "x"; }`))
      .toContain('ANNOTATE_QUANTITY_MISMATCH');
  });

  it('names the element and what it measures', () => {
    const found = process(`${STUDY}annotate { on_curve = R:46; at_I1 = 800 A; }`)
      .diagnostics.find((d) => d.code === 'ANNOTATE_QUANTITY_MISMATCH');
    expect(found?.message).toContain('R:46');
    expect(found?.message).toContain('3I2');
  });

  it('accepts the component it does measure', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:46; at_I2 = 800 A; label = "x"; }`))
      .not.toContain('ANNOTATE_QUANTITY_MISMATCH');
  });

  it('accepts a residual on an earth-fault element', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51G; at_residual = 2 kA; label = "x"; }`))
      .not.toContain('ANNOTATE_QUANTITY_MISMATCH');
  });

  it('derives the residual from I0, which is three times smaller', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51G; at_I0 = 700 A; label = "x"; }`))
      .not.toContain('ANNOTATE_QUANTITY_MISMATCH');
  });
});

describe('an annotation with nowhere to go', () => {
  it('is refused when it names a curve but no position', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51; label = "x"; }`))
      .toContain('ANNOTATE_NO_POSITION');
  });

  it('is satisfied by a time', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51; at_t = 300 ms; label = "x"; }`))
      .not.toContain('ANNOTATE_NO_POSITION');
  });

  it('is satisfied by a named fault', () => {
    expect(codes(`${STUDY}annotate { on_curve = R:51; fault = "F"; label = "x"; }`))
      .not.toContain('ANNOTATE_NO_POSITION');
  });

  it('does not fire on a margin, which is positioned by its two ends', () => {
    expect(codes(`${STUDY}annotate { primary = R:51; backup = R:51G; fault = "F"; }`))
      .not.toContain('ANNOTATE_NO_POSITION');
  });
});

describe('at_t on a point annotation', () => {
  /*
   * Reads the curve the other way round: "at what current is this one
   * this fast". The parser accepted it, the model carried it, and the
   * point path read it with nothing at all -- so it drew nothing and
   * gave no reason.
   */
  const sheet = (placement: string) => parseAndRender(
    `${STUDY}annotate { on_curve = R:51; ${placement} label = "MARK"; style = leader; }
     view { voltage = "HV"; current_min = 50 A; current_max = 50 kA; }`,
    { theme: 'light' },
  ).svg;

  /** Where the annotation's dot landed, in sheet pixels. */
  const markerAt = (svg: string): { x: number; y: number } | null => {
    const m = /<circle cx="([\d.]+)" cy="([\d.]+)" r="3\.5"/.exec(svg);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };

  it('draws the mark', () => {
    expect(sheet('at_t = 300 ms;')).toContain('MARK');
  });

  it('places it where the same current written as at_I would go', () => {
    /*
     * IEC SI inverted: t = tms * 0.14 / (M^0.02 - 1), so at 300 ms
     * M = (1 + 0.12 * 0.14 / 0.3) ^ 50, and I = 480 * M.
     *
     * Compared against the `at_I` form rather than against a pixel
     * computed here: that calibrates itself against whatever the axis
     * is doing, and tests the inversion rather than the scale.
     */
    const expected = 480 * Math.pow(1 + (0.12 * 0.14) / 0.3, 50);
    expect(expected).toBeCloseTo(7318.8, 0);

    const byTime = markerAt(sheet('at_t = 300 ms;'));
    const byCurrent = markerAt(sheet(`at_I = ${expected.toFixed(1)} A;`));
    expect(byTime, 'the at_t form drew a marker').not.toBeNull();
    expect(byCurrent, 'the at_I form drew a marker').not.toBeNull();

    expect(byTime!.x).toBeCloseTo(byCurrent!.x, 0);
    expect(byTime!.y).toBeCloseTo(byCurrent!.y, 0);
  });

  it('says so when the curve is never that fast', () => {
    /* 1 ms is below anything an IDMT element reaches in the window. */
    expect(sheet('at_t = 1 ms;')).toContain('could not place');
  });
});

describe('the shipped sequence sample', () => {
  it('places every annotation it declares, on every sheet', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('examples/17-sequence-sheets.tc', 'utf8');
    const result = process(src);
    const sheets = result.study?.views ?? [];
    expect(sheets.length, 'the sample declares four sheets').toBe(4);

    for (const view of sheets) {
      const svg = renderStudy(result, { theme: 'light', view });
      expect(svg, `${view.name} lost an annotation`).not.toContain('could not place');
    }
  });
});

describe('a margin that cannot be computed', () => {
  /*
   * Every exit from the two margin paths was a bare `continue`, so a
   * pair that never operates at the current asked for drew nothing and
   * said nothing. The study looked complete and the argument it was
   * written to make was simply absent.
   */
  const MARGIN = `${SYS}
faults { "F" { I = 6 kA; type = three_phase; voltage = "HV"; } }
relay R_A { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 600 A; tms = 0.55; } }
relay R_B { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.35; } }
view { voltage = "HV"; current_min = 100 A; current_max = 40 kA; }
`;

  it('says so when neither side operates at the current given', () => {
    /* 400 A is below R_A's 600 A pickup, so there is no gap to draw. */
    const svg = parseAndRender(
      `${MARGIN}annotate { primary = R_A:51; backup = R_B:51; at_I = 0.4 kA; }`,
      { theme: 'light' },
    ).svg;
    expect(svg).toContain('could not place');
  });

  it('names the pair, so the reader knows which margin is missing', () => {
    const svg = parseAndRender(
      `${MARGIN}annotate { primary = R_A:51; backup = R_B:51; at_I = 0.4 kA; }`,
      { theme: 'light' },
    ).svg;
    expect(svg).toContain('R_A:51');
    expect(svg).toContain('R_B:51');
  });

  it('draws it, and says nothing, where both sides do operate', () => {
    const svg = parseAndRender(
      `${MARGIN}annotate { primary = R_A:51; backup = R_B:51; at_I = 6 kA; }`,
      { theme: 'light' },
    ).svg;
    expect(svg).not.toContain('could not place');
  });
});

describe('a mark past the end of the curve it marks', () => {
  /*
   * `current_max` says where the characteristic stops, because past
   * the largest fault the network can deliver the curve describes a
   * current that cannot flow. A mark beyond it floated off the end of
   * its own curve, at an impossible current, looking exactly like a
   * reading taken from the line.
   */
  const bounded = (at: string): string => parseAndRender(`${SYS}
relay R { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A;
               tms = 0.35; current_max = 3 kA; } }
annotate { on_curve = R:51; ${at} label = "MARK"; style = leader; }
view { voltage = "HV"; current_min = 100 A; current_max = 50 kA; }
`, { theme: 'light' }).svg;

  const hasMarker = (svg: string): boolean =>
    /<circle cx="[\d.]+" cy="[\d.]+" r="3\.5"/.test(svg);

  it('is drawn when it sits within the ceiling', () => {
    const svg = bounded('at_I = 2 kA;');
    expect(hasMarker(svg)).toBe(true);
    expect(svg).not.toContain('could not place');
  });

  it('is suppressed when it sits beyond it', () => {
    expect(hasMarker(bounded('at_I = 20 kA;'))).toBe(false);
  });

  it('says where the curve stops, not merely that it failed', () => {
    const svg = bounded('at_I = 20 kA;');
    expect(svg).toContain('could not place');
    expect(svg).toContain('3 kA');
  });
});
