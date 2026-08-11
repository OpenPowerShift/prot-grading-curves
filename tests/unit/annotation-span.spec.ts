/**
 * `from` / `to`: a dimension between two figures the study names.
 *
 * Both margin forms measure between two *characteristics*, which is
 * the common case and not the only one. A grading band an authority
 * requires, the window a setting has to fall inside, the range a
 * supplier quotes for a fuse -- none of those is a curve, so before
 * this none of them could be drawn at all.
 *
 * The unit decides the orientation: two times draw a vertical span,
 * two currents a horizontal one. Units are mandatory everywhere else
 * precisely so a figure cannot be misread, and taking the orientation
 * from a separate key would let the two disagree.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender, process } from '@tc/index';

const BASE = `
system { voltages { "HV" { V = 33 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "HV"; } }
relay R { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = "HV"; current_min = 100 A; current_max = 50 kA;
       time_min = 10 ms; time_max = 100 s; }
`;

const drawn = (annotate: string): string =>
  parseAndRender(`${BASE}\n${annotate}`, { theme: 'light' }).svg;

const codes = (annotate: string): string[] => {
  const r = process(`${BASE}\n${annotate}`);
  return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
};

/* A residual axis, for spans anchored by a component: `at_residual` (or
 * `at_I1` / `at_I2` / `at_I0`) has nothing to convert to on a phase
 * sheet with no fault type to derive from, exactly as a bare current
 * does not. */
const RESIDUAL_BASE = `
system { voltages { "HV" { V = 33 kV; } } }
faults { "F" { I = 6 kA; residual = 18 kA; type = single_phase_earth; voltage = "HV"; } }
relay R { voltage = "HV"; ct_ratio = 600/5;
  element 51G { function = earth_fault; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = "HV"; quantity = 3I0; current_min = 100 A; current_max = 50 kA;
       time_min = 10 ms; time_max = 100 s; }
`;
const drawnResidual = (annotate: string): string =>
  parseAndRender(`${RESIDUAL_BASE}\n${annotate}`, { theme: 'light' }).svg;
const codesResidual = (annotate: string): string[] => {
  const r = process(`${RESIDUAL_BASE}\n${annotate}`);
  return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
};

/** Text of every label drawn on the sheet. */
const labels = (svg: string): string =>
  [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1]).join(' | ');

describe('a span between two times', () => {
  const SPAN = 'annotate { from = 300 ms; to = 800 ms; at_I = 2 kA; label = "band"; }';

  it('is drawn, and labelled with the elapsed time', () => {
    expect(labels(drawn(SPAN))).toContain('band 500 ms');
  });

  it('runs vertically at the current it was anchored to', () => {
    /* Both ends share an x; the two y values differ. */
    const svg = drawn(SPAN);
    const vertical = /<line x1="([\d.]+)" y1="([\d.]+)" x2="\1" y2="([\d.]+)" stroke="[^"]*" stroke-width="1\.4"\/>/
      .exec(svg);
    expect(vertical, 'a vertical dimension was drawn').not.toBeNull();
    expect(Number(vertical![2])).not.toBeCloseTo(Number(vertical![3]), 1);
  });

  it('reads the same written the other way round', () => {
    expect(labels(drawn('annotate { from = 800 ms; to = 300 ms; at_I = 2 kA; label = "band"; }')))
      .toContain('band 500 ms');
  });

  it('takes a named condition instead of a bare current', () => {
    expect(labels(drawn('annotate { from = 300 ms; to = 800 ms; fault = "F"; label = "band"; }')))
      .toContain('band 500 ms');
  });

  it('needs a current to stand at', () => {
    expect(codes('annotate { from = 300 ms; to = 800 ms; label = "band"; }'))
      .toContain('SPAN_NO_ANCHOR');
  });

  /*
   * A regression pin: the anchor check and the renderer both used to
   * read only `at_I`, so a span on an earth-fault or sequence sheet --
   * anchored the way every other annotation on that sheet is, with
   * `at_residual` or a component -- was refused as though nothing had
   * been given at all.
   */
  it('stands at a declared residual component', () => {
    expect(codesResidual('annotate { from = 300 ms; to = 800 ms; at_residual = 2 kA; label = "band"; }'))
      .not.toContain('SPAN_NO_ANCHOR');
    expect(labels(drawnResidual('annotate { from = 300 ms; to = 800 ms; at_residual = 2 kA; label = "band"; }')))
      .toContain('band 500 ms');
  });

  it('takes at_3I0 as an alias for at_residual', () => {
    const viaResidual = drawnResidual('annotate { from = 300 ms; to = 800 ms; at_residual = 2 kA; label = "band"; }');
    const via3I0 = drawnResidual('annotate { from = 300 ms; to = 800 ms; at_3I0 = 2 kA; label = "band"; }');
    const x = (svg: string): string | undefined =>
      /<line x1="([\d.]+)" y1="[\d.]+" x2="\1"/.exec(svg)?.[1];
    expect(x(via3I0)).toBe(x(viaResidual));
  });

  it('stands at a declared I1, I2 or I0 component', () => {
    for (const key of ['at_I1', 'at_I2', 'at_I0']) {
      expect(codesResidual(`annotate { from = 300 ms; to = 800 ms; ${key} = 2 kA; label = "band"; }`),
        key).not.toContain('SPAN_NO_ANCHOR');
    }
  });
});

describe('a span between two currents', () => {
  const SPAN = 'annotate { from = 400 A; to = 900 A; at_t = 1 s; label = "window"; }';

  it('is drawn, and labelled as the larger over the smaller', () => {
    /* 900 / 400 = 2.25, the same convention the current margin uses. */
    expect(labels(drawn(SPAN))).toContain('window 225%');
  });

  it('runs horizontally at the time it was anchored to', () => {
    const svg = drawn(SPAN);
    const horizontal = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2" stroke="[^"]*" stroke-width="1\.4"\/>/
      .exec(svg);
    expect(horizontal, 'a horizontal dimension was drawn').not.toBeNull();
    expect(Number(horizontal![1])).not.toBeCloseTo(Number(horizontal![3]), 1);
  });

  it('reads the same written the other way round', () => {
    expect(labels(drawn('annotate { from = 900 A; to = 400 A; at_t = 1 s; label = "window"; }')))
      .toContain('window 225%');
  });

  it('needs a time to sit at', () => {
    expect(codes('annotate { from = 400 A; to = 900 A; label = "window"; }'))
      .toContain('SPAN_NO_ANCHOR');
  });
});

describe('a current span ending at a named condition', () => {
  /*
   * "from 840 A to F_HV_3PH": one end already has a declared current,
   * so it needs no number typed in -- the same figure the fault rule
   * itself is drawn from, kept in one place.
   */
  const SPAN = 'annotate { from = 840 A; to = "F"; at_t = 8 s; label = "reach"; }';

  it('is drawn, at the condition\'s own current', () => {
    /* "F" is 6 kA in BASE; 6000 / 840 = 714.3%. */
    expect(labels(drawn(SPAN))).toContain('reach 714.3%');
  });

  it('reads the same with the condition on either end', () => {
    expect(labels(drawn('annotate { from = "F"; to = 840 A; at_t = 8 s; label = "reach"; }')))
      .toContain('reach 714.3%');
  });

  it('refuses a condition that is not declared', () => {
    expect(codes('annotate { from = 840 A; to = NOPE; at_t = 8 s; label = "reach"; }'))
      .toContain('UNRESOLVED_REFERENCE');
  });

  it('does not warn SPAN_EMPTY just because neither end is a bare figure', () => {
    /* Two different condition names given no number to compare -- the
     * check is skipped rather than comparing "undefined === undefined". */
    expect(codesResidual('annotate { from = "F"; to = "F"; at_t = 8 s; label = "x"; }'))
      .not.toContain('SPAN_EMPTY');
  });
});

describe('a span that is not one', () => {
  it('refuses one end without the other', () => {
    expect(codes('annotate { from = 300 ms; at_I = 2 kA; }')).toContain('SPAN_INCOMPLETE');
    expect(codes('annotate { to = 300 ms; at_I = 2 kA; }')).toContain('SPAN_INCOMPLETE');
  });

  it('refuses a current at one end and a time at the other', () => {
    /* There is no distance between a current and a time. */
    expect(codes('annotate { from = 400 A; to = 800 ms; at_t = 1 s; }'))
      .toContain('SPAN_MIXED_QUANTITIES');
  });

  it('warns about a span from a figure to itself', () => {
    expect(codes('annotate { from = 300 ms; to = 300 ms; at_I = 2 kA; }'))
      .toContain('SPAN_EMPTY');
  });

  it('does not draw one it could not place, and says so', () => {
    expect(drawn('annotate { from = 400 A; to = 800 ms; at_t = 1 s; label = "bad"; }'))
      .toContain('could not place');
  });
});

describe('a span does not disturb the other annotate forms', () => {
  it('leaves a point annotation alone', () => {
    expect(codes('annotate { on_curve = R:51; at_I = 3 kA; label = "p"; }'))
      .not.toContain('SPAN_INCOMPLETE');
  });

  it('does not ask a point annotation for span anchors', () => {
    expect(codes('annotate { on_curve = R:51; at_I = 3 kA; label = "p"; }'))
      .not.toContain('SPAN_NO_ANCHOR');
  });

  it('does not judge a span as a point with no position', () => {
    expect(codes('annotate { from = 300 ms; to = 800 ms; at_I = 2 kA; }'))
      .not.toContain('ANNOTATE_NO_POSITION');
  });
});
