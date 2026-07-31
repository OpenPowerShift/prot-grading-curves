/**
 * Annotations.
 *
 * The margin form is the one a coordination study exists to produce,
 * and its defining property is that it must agree with the margin
 * *report* for the same pair and fault. An annotation that contradicts
 * the report is worse than no annotation: the chart and the numbers
 * would be arguing with each other.
 */

import { describe, expect, it } from 'vitest';
import { process, parseAndRender } from '@tc/index';

/** LV feeder graded against an HV incomer, so the two see different currents. */
const CROSS_VOLTAGE = `
system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 11.0 kV; } } }
faults {
  "F_max" { I   = 6.40 kA; voltage = "LV"; }
  "F_min" { I   = 2.50 kA; voltage = "LV"; }
}
relay R_FDR { voltage = "LV"; ct_ratio = 400/5;
  element 51 { curve = iec.vi; I_pickup = 480 A; tms = 0.25; } }
relay R_INC { voltage = "HV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pickup = 720 A; tms = 0.30; } }

grade { primary = R_FDR:51; backup = R_INC:51; fault = "F_max"; margin    = 0.30 s; }

annotate { primary = R_FDR:51; backup = R_INC:51; fault = "F_max"; label = "CTI"; }
view { voltage = "HV"; }
`;

/** Times the renderer would draw, recomputed the way grading does. */
function reportedMargin(src: string): number {
  return process(src).reports[0].rows.find((r) => r.at === 'I')!.margin_s;
}

describe('margin annotations', () => {
  it('parses the margin form', () => {
    const result = process(CROSS_VOLTAGE);
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);

    const [annotation] = result.study!.annotations;
    expect(annotation.kind).toBe('margin');
    expect(annotation.primary?.text).toBe('R_FDR:51');
    expect(annotation.backup?.text).toBe('R_INC:51');
    /* `fault` and `scenario` both resolve to one named condition. */
    expect(annotation.condition).toBe('F_max');
  });

  it('labels the same margin the report computes', () => {
    /*
     * The regression this guards: evaluating both sides at the
     * primary's current divides an LV current by an HV pick-up. It
     * gave 667 ms against a true margin of 1.639 s.
     */
    const { svg } = parseAndRender(CROSS_VOLTAGE, { theme: 'light' });
    const margin = reportedMargin(CROSS_VOLTAGE);
    expect(margin).toBeCloseTo(1.639, 2);

    // The label is formatted as the renderer formats seconds.
    expect(svg).toContain('CTI 1.64 s');
    expect(svg).not.toContain('CTI 667 ms');
  });

  it('draws the span with arrowheads and end ticks', () => {
    const { svg } = parseAndRender(CROSS_VOLTAGE, { theme: 'light' });
    expect(svg).toMatch(/<polygon points="[^"]*"\s*fill="/);
  });

  it('accepts a bare current instead of a named fault', () => {
    const withCurrent = CROSS_VOLTAGE.replace('fault   = "F_max";', 'at_I_A = 6400 A;');
    const { svg } = parseAndRender(withCurrent, { theme: 'light' });
    expect(svg).toContain('CTI ');
  });

  it('is skipped rather than crashing when a reference does not resolve', () => {
    const broken = CROSS_VOLTAGE.replace('primary = R_FDR:51; backup = R_INC:51; fault',
                                          'primary = R_NOPE:51; backup = R_INC:51; fault');
    expect(() => parseAndRender(broken, { theme: 'light' })).not.toThrow();
  });
});

describe('point annotations', () => {
  const POINT = `
    system { voltages { "MV" { V  = 11.0 kV; } } }
    faults { "F" { I   = 4000 A; } }
    relay R { voltage = "MV"; ct_ratio = 600/5;
      element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.3; } }
    annotate { on_curve = R:51; at_I   = 4000 A; label = "Bus fault"; style = "leader"; }
  `;

  it('resolves as a point annotation', () => {
    const [annotation] = process(POINT).study!.annotations;
    expect(annotation.kind).toBe('point');
    expect(annotation.at_I_A).toBe(4000);
    expect(annotation.style).toBe('leader');
  });

  it('draws a marker, a leader, and the label', () => {
    const { svg } = parseAndRender(POINT, { theme: 'light' });
    expect(svg).toContain('Bus fault');
    expect(svg).toMatch(/<circle[^>]*r="3\.5"/);
  });

  it('honours the tag style, which is label-only', () => {
    const { svg } = parseAndRender(POINT.replace('"leader"', '"tag"'), { theme: 'light' });
    expect(svg).toContain('Bus fault');
    expect(svg).not.toMatch(/<circle[^>]*r="3\.5"/);
  });
});

/* ---------------------------------------------------------------- */

describe('a margin annotation on a multi-stage element', () => {
  /*
   * Two stages on the primary (0.10 s and 0.35 s) under a 0.45 s
   * backup. The composite -- what the element trips at, and what the
   * margin report uses -- is the faster stage, so a margin drawn to it
   * spans 0.35 s while a slower stage of the same element sits 0.10 s
   * from the backup.
   *
   * On a study whose stages are alternatives under different conditions
   * -- one inrush-blocked, one not -- the wide gap is not the binding
   * one, and drawing it overstates the coordination by the difference
   * between the stages. The closest pair is the honest figure to put on
   * a drawing, and with `stages = "individual"` it is the gap between
   * two curves the reader can see.
   */
  const STAGED = `
system { voltages { "HV" { V  = 33 kV; } } }
faults { "F" { I   = 900 A; I2   = 900 A; voltage = "HV"; } }
relay R_P {
  voltage = "HV"; ct_ratio = 250/1;
  element 46 {
    function = "neg_seq"; measures = "I2";
    stages {
      stage main  { curve = definite; I_pickup = 75 A; t_delay = 0.10 s; }
      stage energ { curve = definite; I_pickup = 75 A; t_delay = 0.35 s; }
    }
  }
}
relay R_B {
  voltage = "HV"; ct_ratio = 250/1;
  element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pickup = 75 A; t_delay = 0.45 s; }
}
annotate { primary = R_P:46; backup = R_B:46; fault = "F"; label = "CTI"; }
view { voltage = "HV"; stages = "individual"; current_min = 10 A; current_max = 40 kA;
       time_min = 10 ms; time_max = 10 s; }
`;

  it('measures the smallest gap, not the widest', () => {
    const { svg } = parseAndRender(STAGED, { theme: 'light' });
    expect(svg).toContain('CTI 100 ms');
    expect(svg).not.toContain('CTI 350 ms');
  });

  it('spans the two stages that are actually closest', () => {
    /* The arrow's ends are the 0.35 s stage and the 0.45 s backup, so
     * it is short; drawn to the composite it would reach 0.10 s. */
    const { svg } = parseAndRender(STAGED, { theme: 'light' });
    const arrow = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="\1" y2="([\d.]+)" stroke="[^"]*" stroke-width="1.4"\/>/);
    expect(arrow).not.toBeNull();
    /* Both ends inside the band the two slow curves occupy. */
    const span = Math.abs(Number(arrow![2]) - Number(arrow![3]));
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(60);
  });

  it('lands on the composite when the stages are not drawn apart', () => {
    /*
     * The closest pair is the honest margin only when the reader can
     * see both stages. A sheet drawing the composite has one line per
     * element -- the pointwise minimum -- so an arrow ending at a
     * slower stage stops in mid-air, a hundred pixels short of the
     * curve it should touch. That is what it did on the capability
     * tour: the lower end sat at y=554.8 with the drawn curve at 656.1.
     */
    const composite = STAGED.replace('stages = "individual"; ', '');
    const svg = parseAndRender(composite, { theme: 'light' }).svg;

    const arrow = svg.match(
      /<line x1="([\d.]+)" y1="([\d.]+)" x2="\1" y2="([\d.]+)" stroke="[^"]*" stroke-width="1\.4"\/>/,
    );
    expect(arrow).not.toBeNull();
    const px = Number(arrow![1]);
    const ends = [Number(arrow![2]), Number(arrow![3])];

    /* Every end sits on a drawn curve at that abscissa. */
    const nearestOnCurves = (x: number): number[] =>
      [...svg.matchAll(/<path d="([^"]+)" class="tc-curve"/g)].map((m) => {
        const pts = [...m[1].matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)]
          .map((q) => [Number(q[1]), Number(q[2])] as const);
        return pts.reduce((best, [cx, cy]) =>
          Math.abs(cx - x) < Math.abs(best[0] - x) ? [cx, cy] : best, pts[0])[1];
      });

    const ys = nearestOnCurves(px);
    for (const end of ends) {
      expect(ys.some((y) => Math.abs(y - end) < 3), `end ${end} vs ${ys}`).toBe(true);
    }
  });

  it('still works when neither side has stages', () => {
    const simple = STAGED.replace(
      /stages \{[\s\S]*?\n {4}\}\n {2}\}/,
      'curve = definite; I_pickup = 75 A; t_delay = 0.10 s; }',
    );
    const { svg } = parseAndRender(simple, { theme: 'light' });
    expect(svg).toContain('CTI 350 ms');
  });
});

/* ---------------------------------------------------------------- */

describe('current margins, measured horizontally', () => {
  /*
   * The vertical arrow measures a time margin between two curves at one
   * current; this is its counterpart -- the gap in *current* at one
   * time, as a percentage, which is how a current-grading margin is
   * quoted. Amps alone mean little without knowing where on the axis
   * you are.
   */
  const STUDY = (annotations: string) => `
system { voltages { "HV" { V  = 33 kV; } } }
faults { "2ph min" { I   = 390 A; type = two_phase; voltage = "HV"; } }
relay R {
  voltage = "HV"; ct_ratio = 250/1;
  element 50 { function = "phase_oc"; curve = definite; I_pickup = 255 A; t_delay = 20 ms; }
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.15; }
}
point "TX inrush" { I   = 212 A; t   = 0.12 s; voltage = "HV"; label = "inrush"; }
${annotations}
view { voltage = "HV"; current_min = 100 A; current_max = 5 kA;
       time_min = 10 ms; time_max = 10 s; }
`;

  const drawn = (annotations: string): string =>
    parseAndRender(STUDY(annotations), { theme: 'light' }).svg;

  it('measures to a declared fault level', () => {
    /* A 255 A pickup against a 390 A fault: (390 - 255) / 255. */
    const svg = drawn('annotate { primary = R:50; at_t   = 20 ms; fault = "2ph min"; label = "m"; }');
    expect(svg).toContain('m +52.9%');
  });

  it('measures to a marked point, and signs it', () => {
    /* The inrush is *below* the pickup, so the margin is negative --
     * which is the fact the drawing is there to show. */
    const svg = drawn('annotate { primary = R:50; at_t   = 20 ms; point = "TX inrush"; label = "m"; }');
    expect(svg).toContain('m -16.9%');
  });

  it('measures between two characteristics', () => {
    const svg = drawn('annotate { primary = R:50; backup = R:51; at_t   = 1 s; label = "m"; }');
    expect(svg).toMatch(/m [+-][\d.]+%/);
  });

  it('takes a definite-time stage at its pickup, not somewhere on its shelf', () => {
    /*
     * A flat stage gives the same time at every current above pickup,
     * so an equality solve would land wherever it started. The current
     * read is the *smallest* that achieves the time, which is the
     * pickup -- and that is what makes the 52.9% above exact.
     */
    const svg = drawn('annotate { primary = R:50; at_t   = 20 ms; fault = "2ph min"; label = "m"; }');
    expect(svg).toContain('m +52.9%');
  });

  it('draws a horizontal span with arrowheads', () => {
    const svg = drawn('annotate { primary = R:50; at_t   = 20 ms; fault = "2ph min"; label = "m"; }');
    const arrow = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2" stroke="[^"]*" stroke-width="1\.4"\/>/);
    expect(arrow).not.toBeNull();
    expect(Number(arrow![3])).not.toBeCloseTo(Number(arrow![1]), 1);
  });

  it('keeps its label off its own arrow', () => {
    const svg = drawn('annotate { primary = R:50; at_t   = 20 ms; fault = "2ph min"; label = "m"; }');
    const arrowY = Number(svg.match(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1" stroke="[^"]*" stroke-width="1\.4"\/>/)![1]);
    const labelY = Number(svg.match(/<text x="[\d.-]+" y="([\d.-]+)"[^>]*>m [+-]/)![1]);
    expect(Math.abs(labelY - arrowY)).toBeGreaterThan(6);
  });

  it('is skipped, not crashed, when the far end resolves to nothing', () => {
    expect(() => drawn('annotate { primary = R:50; at_t   = 20 ms; point = "nonesuch"; }')).not.toThrow();
  });
});

describe('saying where an annotation goes', () => {
  const BASE = `
system { voltages { "HV" { V  = 33 kV; } } }
faults { "F" { I   = 9 kA; voltage = "HV"; } }
relay R_A { voltage = "HV"; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.15; } }
relay R_B { voltage = "HV"; element 51 { curve = iec.si; I_pickup = 700 A; tms = 0.30; } }
view { voltage = "HV"; current_min = 100 A; current_max = 40 kA; }
`;

  it('moves the margin when at_I_A moves', () => {
    /* The margin arrow specifically -- `stroke-width="1.4"` -- not the
     * first vertical line in the document, which is a gridline. */
    const at = (a: string): number => Number(
      parseAndRender(BASE + a, { theme: 'light' }).svg
        .match(/<line x1="([\d.]+)" y1="[\d.]+" x2="\1" y2="[\d.]+" stroke="[^"]*" stroke-width="1\.4"\/>/)![1]);
    const near = at('annotate { primary = R_A:51; backup = R_B:51; at_I   = 2 kA; label = "m"; }');
    const far = at('annotate { primary = R_A:51; backup = R_B:51; at_I   = 20 kA; label = "m"; }');
    expect(far).toBeGreaterThan(near + 100);
  });

  it('refuses a condition and a bare current together', () => {
    /*
     * The condition quietly won, so adding `at_I_A` to an annotation
     * that already named one did nothing and gave no reason.
     */
    const codes = process(
      `${BASE}annotate { primary = R_A:51; backup = R_B:51; fault = "F"; at_I   = 2 kA; }`,
    ).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
    expect(codes).toContain('ANNOTATE_CURRENT_AND_CONDITION');
  });

  it('reads at_I_A at the level named, so it agrees with the report', () => {
    /*
     * Handed to each side unchanged, one number was read once at 11 kV
     * and once at 33 kV -- two different currents -- and the drawn
     * margin contradicted the report: 667 ms against 1.639 s.
     */
    const cross = `
system { voltages { "HV" { V  = 33 kV; } "LV" { V  = 11 kV; } } }
faults { "F" { I   = 6.4 kA; voltage = "LV"; } }
relay R_FDR { voltage = "LV"; ct_ratio = 400/5; element 51 { curve = iec.vi; I_pickup = 480 A; tms = 0.25; } }
relay R_INC { voltage = "HV"; ct_ratio = 600/5; element 51 { curve = iec.si; I_pickup = 720 A; tms = 0.30; } }
grade { primary = R_FDR:51; backup = R_INC:51; fault = "F"; margin    = 0.3 s; }
annotate { primary = R_FDR:51; backup = R_INC:51; at_I   = 6.4 kA; voltage = "LV"; label = "CTI"; }
view { voltage = "HV"; }
`;
    const reported = process(cross).reports[0].rows.find((r) => r.at === 'I')!.margin_s;
    expect(reported).toBeCloseTo(1.639, 2);
    expect(parseAndRender(cross, { theme: 'light' }).svg).toContain('CTI 1.64 s');
  });
});
