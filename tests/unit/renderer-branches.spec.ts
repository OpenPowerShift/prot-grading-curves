/**
 * Sheets the renderer has to cope with.
 *
 * `svg.ts` is the largest file in the project, and what was left
 * uncovered in it was the awkward cases: a study with nothing in it, a
 * curve that never operates, a label with nowhere to go, a condition
 * that suppresses everything. None of those appear in a study that
 * works, which is why they were the ones missing.
 *
 * The property throughout is that a sheet still comes out, and says
 * what it left off.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const draw = (src: string, theme: 'light' | 'dark' = 'light'): string =>
  renderStudy(process(src), { theme });

const SYS = 'system { voltages { "MV" { V = 11 kV; } "LV" { V = 400 V; } } }\n';

const notes = (svg: string): string =>
  [...svg.matchAll(/<text[^>]*font-style="italic"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1]).join(' ');

describe('sheets with nothing much on them', () => {
  it('draws axes for a study with no relays', () => {
    const svg = draw(SYS);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Current');
  });

  it('draws something for an entirely empty source', () => {
    expect(draw('')).toContain('<svg');
  });

  it('draws a study whose only content is a fault', () => {
    expect(draw(`${SYS}faults { "F" { I = 6 kA; voltage = "MV"; } }`)).toContain('<svg');
  });

  it('draws a study whose only content is a required time', () => {
    expect(draw(`${SYS}times { "T" { t = 500 ms; } }`)).toContain('<svg');
  });

  it('draws a study whose only content is a marked point', () => {
    expect(draw(`${SYS}point "P" { I = 1 kA; t = 1 s; label = "alone"; }`)).toContain('<svg');
  });
});

describe('curves at the edges of what can be drawn', () => {
  const relay = (body: string) =>
    `${SYS}relay R { voltage = "MV"; ct_ratio = 400/5; element 51 { ${body} } }\n`;

  it('copes with a pickup above the plotted range', () => {
    const svg = draw(`${relay('function = "phase_oc"; curve = iec.si; I_pickup = 900 kA; tms = 0.1;')}
      view { voltage = "MV"; current_min = 100 A; current_max = 10 kA; }`);
    expect(svg).toContain('<svg');
  });

  it('copes with a pickup below the plotted range', () => {
    const svg = draw(`${relay('function = "phase_oc"; curve = iec.si; I_pickup = 1 A; tms = 0.1;')}
      view { voltage = "MV"; current_min = 1 kA; current_max = 40 kA; }`);
    expect(svg).toContain('<svg');
  });

  it('copes with a definite time longer than the plotted range', () => {
    const svg = draw(`${relay('curve = definite; I_pickup = 400 A; t_delay = 5 ks;')}
      view { voltage = "MV"; time_min = 20 ms; time_max = 10 s; }`);
    expect(svg).toContain('<svg');
  });

  it('draws a very large study without falling over', () => {
    const many = Array.from({ length: 24 }, (_, i) =>
      `relay R${i} { voltage = "MV"; ct_ratio = 400/5;
         element 51 { function = "phase_oc"; curve = iec.si;
                      I_pickup = ${200 + i * 40} A; tms = ${0.05 + i * 0.02}; } }`).join('\n');
    const svg = draw(`${SYS}${many}\nview { voltage = "MV"; }`);
    expect(svg).toContain('<svg');
    expect([...svg.matchAll(/data-curve=/g)].length).toBeGreaterThan(20);
  });
});

describe('what a sheet says it left off', () => {
  it('names an element whose current cannot reach the sheet', () => {
    const svg = draw(`${SYS}
      scenario "S" { type = single_phase_earth;
        level "MV" { I = 900 A; I1 = 300 A; I2 = 300 A; I0 = 300 A; residual = 900 A; } }
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
      view { voltage = "MV"; quantity = 3I0; condition = "S"; }`);
    expect(notes(svg).length).toBeGreaterThan(0);
  });

  it('names a condition it could not mark', () => {
    const svg = draw(`${SYS}
      faults { "Balanced" { I = 6 kA; type = three_phase; voltage = "MV"; } }
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 46 { function = "neg_seq"; measures = I2; curve = definite;
                     I_pickup = 100 A; t_delay = 1 s; } }
      view { voltage = "MV"; quantity = I2; condition = "Balanced"; }`);
    /* A balanced fault carries no negative sequence, so there is
     * nothing to mark and the sheet has to say so. */
    expect(notes(svg).length).toBeGreaterThan(0);
  });
});

describe('themes and page options', () => {
  const STUDY = `${SYS}
    faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
    relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
  `;

  for (const theme of ['light', 'dark', 'monochrome', 'print']) {
    it(`draws in the ${theme} theme`, () => {
      expect(draw(`${STUDY}page { theme = "${theme}"; }`)).toContain('<svg');
    });
  }

  for (const style of ['column', 'inside', 'direct', 'none']) {
    it(`draws with a ${style} legend`, () => {
      expect(draw(`${STUDY}page { legend = { style = "${style}"; }; }`)).toContain('<svg');
    });
  }

  for (const palette of ['default', 'okabe_ito', 'high_contrast', 'grayscale', 'ieee', 'monochrome']) {
    it(`draws with the ${palette} palette`, () => {
      expect(draw(`${STUDY}page { curves = { palette = "${palette}"; }; }`)).toContain('<svg');
    });
  }

  it('draws portrait as readily as landscape', () => {
    expect(draw(`${STUDY}page { orientation = "portrait"; }`)).toContain('<svg');
  });

  it('draws with the axes mirrored', () => {
    expect(draw(`${STUDY}page { axes = { mirror = true; }; }`)).toContain('<svg');
  });

  it('draws with a watermark', () => {
    expect(draw(`${STUDY}page { watermark = "DRAFT"; }`)).toContain('DRAFT');
  });

  it('draws every marker shape', () => {
    for (const shape of ['circle', 'square', 'diamond', 'triangle', 'cross', 'x']) {
      const svg = draw(`${STUDY}point "P" { I = 2 kA; t = 1 s; shape = ${shape}; }`);
      expect(svg, shape).toContain('data-point=');
    }
  });

  it('draws in the dark theme when asked at the API', () => {
    expect(draw(STUDY, 'dark')).toContain('<svg');
  });
});

describe('labels with nowhere to go', () => {
  it('places many overlapping annotations without throwing', () => {
    const anns = Array.from({ length: 10 }, (_, i) =>
      `annotate { on_curve = R:51; at_I = ${1000 + i * 10} A; label = "mark ${i}"; style = leader; }`)
      .join('\n');
    const svg = draw(`${SYS}
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
      ${anns}
      view { voltage = "MV"; current_min = 100 A; current_max = 40 kA; }`);
    expect(svg).toContain('<svg');
  });

  it('copes with a very long label', () => {
    const long = 'a label that goes on and on '.repeat(8);
    const svg = draw(`${SYS}
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
      point "P" { I = 2 kA; t = 1 s; label = "${long}"; }
      view { voltage = "MV"; }`);
    expect(svg).toContain('<svg');
  });
});
