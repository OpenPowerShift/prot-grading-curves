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
system { voltages { "HV" { kV = 33.0; } "LV" { kV = 11.0; } } }
faults {
  "F_max" { I_A = 6.40 kA; voltage = "LV"; }
  "F_min" { I_A = 2.50 kA; voltage = "LV"; }
}
relay R_FDR { voltage = "LV"; ct_ratio = 400/5;
  element 51 { curve = iec.vi; I_pu = 480 A; tms = 0.25; } }
relay R_INC { voltage = "HV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pu = 720 A; tms = 0.30; } }

grade { primary = R_FDR:51; backup = R_INC:51; fault = "F_max"; CTI_min_s = 0.30; }

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
    system { voltages { "MV" { kV = 11.0; } } }
    faults { "F" { I_A = 4000 A; } }
    relay R { voltage = "MV"; ct_ratio = 600/5;
      element 51 { curve = iec.si; I_pu = 400 A; tms = 0.3; } }
    annotate { on_curve = R:51; at_I_A = 4000 A; label = "Bus fault"; style = "leader"; }
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
system { voltages { "HV" { kV = 33; } } }
faults { "F" { I_A = 900 A; I2_A = 900 A; voltage = "HV"; } }
relay R_P {
  voltage = "HV"; ct_ratio = 250/1;
  element 46 {
    function = "neg_seq"; measures = "I2";
    stages {
      stage main  { curve = definite; I_pu = 75 A; t_delay = 0.10 s; }
      stage energ { curve = definite; I_pu = 75 A; t_delay = 0.35 s; }
    }
  }
}
relay R_B {
  voltage = "HV"; ct_ratio = 250/1;
  element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pu = 75 A; t_delay = 0.45 s; }
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

  it('still works when neither side has stages', () => {
    const simple = STAGED.replace(
      /stages \{[\s\S]*?\n    \}\n  \}/,
      'curve = definite; I_pu = 75 A; t_delay = 0.10 s; }',
    );
    const { svg } = parseAndRender(simple, { theme: 'light' });
    expect(svg).toContain('CTI 350 ms');
  });
});
