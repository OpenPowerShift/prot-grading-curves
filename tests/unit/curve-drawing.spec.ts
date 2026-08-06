/**
 * Per-curve drawing overrides, and where a curve stops.
 *
 * The automatic palette is right for an ordinary study and wrong
 * whenever a drawing has to match something outside itself -- a house
 * standard, a figure whose colours are fixed by the report around it, a
 * curve that is context rather than argument. `color`, `style` and
 * `width_px` on an element or a stage say so directly.
 *
 * `I_cutoff` (then spelled `current_max`) was an element-level ceiling
 * only, so every stage of a multi-stage element was drawn to the same
 * place whatever its own datasheet said.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender, process } from '@tc/index';

const SYS = 'system { voltages { "HV" { V = 33 kV; } } }\n';

const study = (element: string, view = ''): string => `${SYS}
relay R { voltage = "HV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; ${element} }
  element 50 { function = "phase_oc"; curve = definite; I_pickup = 8 kA; t_delay = 50 ms; }
}
view { voltage = "HV"; current_min = 100 A; current_max = 60 kA; ${view} }
`;

const IDMT = 'curve = iec.si; I_pickup = 400 A; tms = 0.2;';

const errors = (src: string): string[] => {
  const r = process(src);
  return [...r.parseErrors, ...r.diagnostics]
    .filter((d) => d.severity === 'error').map((d) => d.code);
};

/**
 * The `<path>` element drawing one curve, selected by its *reference*.
 *
 * Not by `data-curve`, which is the caption: captions are typeset --
 * a stage handle is shown in upper case now -- and a test that selects
 * on one is testing the wording. `data-ref` is the identity the study
 * wrote and what `grade` and `annotate` resolve against.
 */
const pathFor = (svg: string, ref: string): string => {
  const found = new RegExp(`<path [^>]*data-ref="${ref.replace(/[:/]/g, '\\$&')}"[^>]*>`)
    .exec(svg);
  expect(found, `no curve referenced ${ref}`).not.toBeNull();
  return found![0];
};

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

describe('a colour declared on a curve', () => {
  it('is used instead of the palette slot', () => {
    const svg = parseAndRender(study(`${IDMT} color = "#884400";`), { theme: 'light' }).svg;
    expect(attr(pathFor(svg, 'R:51'), 'stroke')).toBe('#884400');
  });

  it('leaves the other curves where the palette put them', () => {
    /*
     * The slot is still consumed, so declaring a colour on one element
     * does not shift the hues of the rest. A sheet is read against its
     * legend, and a study that recolours as curves come and go makes
     * two revisions of one drawing impossible to compare.
     */
    const plain = parseAndRender(study(IDMT), { theme: 'light' }).svg;
    const painted = parseAndRender(study(`${IDMT} color = "#884400";`), { theme: 'light' }).svg;
    expect(attr(pathFor(painted, 'R:50'), 'stroke'))
      .toBe(attr(pathFor(plain, 'R:50'), 'stroke'));
  });
});

describe('a style declared on a curve', () => {
  for (const [style, dash] of [['dashed', '6 4'], ['dotted', '1 3']] as const) {
    it(`draws ${style}`, () => {
      const svg = parseAndRender(study(`${IDMT} style = ${style};`), { theme: 'light' }).svg;
      expect(attr(pathFor(svg, 'R:51'), 'stroke-dasharray')).toBe(dash);
    });
  }

  it('draws solid when asked, beating any automatic pattern', () => {
    const svg = parseAndRender(study(`${IDMT} style = solid;`), { theme: 'light' }).svg;
    expect(pathFor(svg, 'R:51')).not.toContain('stroke-dasharray');
  });

  it('takes the word quoted as well as bare', () => {
    const svg = parseAndRender(study(`${IDMT} style = "dashed";`), { theme: 'light' }).svg;
    expect(attr(pathFor(svg, 'R:51'), 'stroke-dasharray')).toBe('6 4');
  });

  it('refuses a word it cannot draw', () => {
    /* Otherwise the sheet renders a solid line the source calls dashed,
     * and nothing on the drawing says so. */
    expect(errors(study(`${IDMT} style = dashed_line;`))).toContain('CURVE_STYLE_INVALID');
  });
});

describe('a width declared on a curve', () => {
  it('overrides the sheet-wide line weight', () => {
    const svg = parseAndRender(study(`${IDMT} width_px = 3.5;`), { theme: 'light' }).svg;
    expect(attr(pathFor(svg, 'R:51'), 'stroke-width')).toBe('3.5');
  });

  it('leaves the others at the sheet default', () => {
    const svg = parseAndRender(study(`${IDMT} width_px = 3.5;`), { theme: 'light' }).svg;
    expect(attr(pathFor(svg, 'R:50'), 'stroke-width')).toBe('2');
  });

  for (const bad of ['0', '-1']) {
    it(`refuses a width of ${bad}`, () => {
      expect(errors(study(`${IDMT} width_px = ${bad};`))).toContain('CURVE_WIDTH_INVALID');
    });
  }
});

describe('a stage', () => {
  const STAGED = (main: string, inst: string): string => study(`
    stages {
      stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; ${main} }
      stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; ${inst} }
    }`, 'stages = "individual";');

  it('inherits the element it belongs to', () => {
    const src = study(`color = "#116644";
      stages {
        stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
        stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
      }`, 'stages = "individual";');
    const svg = parseAndRender(src, { theme: 'light' }).svg;
    expect(attr(pathFor(svg, 'R:51/main'), 'stroke')).toBe('#116644');
    expect(attr(pathFor(svg, 'R:51/inst'), 'stroke')).toBe('#116644');
  });

  it('overrides its element where it says so', () => {
    const svg = parseAndRender(STAGED('', 'style = dotted; width_px = 3;'), { theme: 'light' }).svg;
    expect(pathFor(svg, 'R:51/main')).not.toContain('stroke-dasharray');
    expect(attr(pathFor(svg, 'R:51/inst'), 'stroke-dasharray')).toBe('1 3');
    expect(attr(pathFor(svg, 'R:51/inst'), 'stroke-width')).toBe('3');
  });
});

describe('where a stage stops', () => {
  /**
   * The largest x any point of a path reaches.
   *
   * A ceiling is a statement about the network, not the relay: past
   * the current the bus can deliver the curve describes something that
   * cannot flow, and drawing it there invites a margin to be read at a
   * fault that does not exist.
   */
  const rightEdge = (svg: string, label: string): number => {
    const d = attr(pathFor(svg, label), 'd') ?? '';
    const xs = [...d.matchAll(/[ML]([\d.]+)\s/g)].map((m) => Number(m[1]));
    expect(xs.length, `path for ${label} has points`).toBeGreaterThan(1);
    return Math.max(...xs);
  };

  const src = (instCeiling: string) => study(`
    stages {
      stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
      stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; ${instCeiling} }
    }`, 'stages = "individual";');

  it('runs to the edge of the sheet when nothing says otherwise', () => {
    const svg = parseAndRender(src(''), { theme: 'light' }).svg;
    expect(rightEdge(svg, 'R:51/inst')).toBeCloseTo(rightEdge(svg, 'R:51/main'), 0);
  });

  it('stops early when the stage declares its own ceiling', () => {
    const svg = parseAndRender(src('I_cutoff = 12 kA;'), { theme: 'light' }).svg;
    expect(rightEdge(svg, 'R:51/inst')).toBeLessThan(rightEdge(svg, 'R:51/main') - 20);
  });

  it('leaves the sibling stage alone', () => {
    const bounded = parseAndRender(src('I_cutoff = 12 kA;'), { theme: 'light' }).svg;
    const free = parseAndRender(src(''), { theme: 'light' }).svg;
    expect(rightEdge(bounded, 'R:51/main')).toBeCloseTo(rightEdge(free, 'R:51/main'), 0);
  });

  it('falls back to the element ceiling when the stage declares none', () => {
    const svg = parseAndRender(study(`I_cutoff = 12 kA;
      stages {
        stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
        stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
      }`, 'stages = "individual";'), { theme: 'light' }).svg;
    const free = parseAndRender(src(''), { theme: 'light' }).svg;
    expect(rightEdge(svg, 'R:51/inst')).toBeLessThan(rightEdge(free, 'R:51/inst') - 20);
  });
});
