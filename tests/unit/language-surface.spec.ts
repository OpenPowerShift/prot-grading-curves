/**
 * Constructs the shipped studies happen not to use.
 *
 * The examples cover every *key*, but not every shape a key can take:
 * a `formula` block inside a stage rather than an element, a structured
 * `page { title }` rather than a bare string, a unicode escape in a
 * string, a scale window declared backwards. Those are the parser and
 * validator paths nothing had run.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { process, renderStudy } from '@tc/index';
import { formatGradeReports } from '@tc/semantics/grades';

const SYS = 'system { voltages { "MV" { V = 11 kV; } "LV" { V = 400 V; } } }\n';
const codes = (src: string): string[] => {
  const r = process(src);
  return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
};

describe('curves given as a formula', () => {
  it('takes one on an element', () => {
    const r = process(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; formula { k = 0.14; c = 0; alpha = 0.02; }
                   I_pickup = 400 A; tms = 0.1; } }`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(renderStudy(r, { theme: 'light' })).toContain('data-curve=');
  });

  it('takes one on a stage', () => {
    /* The stage form has its own parse path, and no example uses it. */
    const r = process(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; stages {
        stage main { formula { k = 80; c = 0.1; alpha = 2; } I_pickup = 400 A; tms = 0.2; }
        stage inst { curve = definite; I_pickup = 5 kA; t_delay = 40 ms; }
      } } }`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const stages = r.study?.relays.get('R')?.elements[0].stages ?? [];
    expect(stages).toHaveLength(2);
  });

  it('takes a flex table on a stage', () => {
    const r = process(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 49 { function = "thermal"; stages {
        stage warm { flex_points = [(500 A, 100 s), (2 kA, 8 s)]; }
      } } }`);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('strings', () => {
  it('takes a unicode escape', () => {
    expect(process('meta { project = "33 \\u{2013} 11 kV"; }').study?.meta.project)
      .toContain('–');
  });

  it('takes the usual backslash escapes', () => {
    expect(process('meta { project = "a \\"quoted\\" name"; }').study?.meta.project)
      .toContain('"quoted"');
  });

  it('leaves a malformed escape alone rather than failing', () => {
    expect(() => parse('meta { project = "\\u{zzzz}"; }')).not.toThrow();
  });
});

describe('the structured page title', () => {
  it('takes every field', () => {
    const r = process(`${SYS}page { title = {
      text = "A heading"; subtitle = "and a subheading";
      color = "#123456"; align = "center"; font_size_px = 18; }; }`);
    expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
    const svg = renderStudy(r, { theme: 'light' });
    expect(svg).toContain('A heading');
    expect(svg).toContain('and a subheading');
  });

  it('still takes a bare string', () => {
    const svg = renderStudy(process(`${SYS}page { title = "Just a heading"; }`),
      { theme: 'light' });
    expect(svg).toContain('Just a heading');
  });

  for (const align of ['left', 'center', 'right']) {
    it(`aligns ${align}`, () => {
      const r = process(`${SYS}page { title = { text = "T"; align = "${align}"; }; }`);
      expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
    });
  }
});

describe('notes', () => {
  it('carries free text onto the sheet', () => {
    const r = process(`${SYS}notes { engineer = "A. Cooper"; date = "2026-08-01";
      revision = "C"; comment = "checked against the 2025 study"; }`);
    expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(() => renderStudy(r, { theme: 'light' })).not.toThrow();
  });
});

describe('the page scale window', () => {
  /* Judged only where the window is actually used: with `auto` left on
   * the declared bounds are ignored, so an inverted pair is harmless. */
  it('accepts one declared the right way round', () => {
    expect(codes(`${SYS}page { scale = { auto = false; x_min = 100; x_max = 10000;
      y_min = 0.02; y_max = 100; }; }`)).not.toContain('PAGE_SCALE_INVERTED');
  });

  it('refuses a current window declared backwards', () => {
    expect(codes(`${SYS}page { scale = { auto = false; x_min = 10000; x_max = 100; }; }`))
      .toContain('PAGE_SCALE_INVERTED');
  });

  it('refuses a time window declared backwards', () => {
    expect(codes(`${SYS}page { scale = { auto = false; y_min = 100; y_max = 0.02; }; }`))
      .toContain('PAGE_SCALE_INVERTED');
  });

  it('ignores an inverted window while auto is on', () => {
    expect(codes(`${SYS}page { scale = { x_min = 10000; x_max = 100; }; }`))
      .not.toContain('PAGE_SCALE_INVERTED');
  });
});

describe('a watermark on a finished study', () => {
  it('is warned about, because it risks being filed as issued', () => {
    expect(codes(`meta { study = "final"; }\n${SYS}page { watermark = "DRAFT"; }`))
      .toContain('WATERMARK_ON_FINAL');
  });

  it('is not warned about on a study still in progress', () => {
    expect(codes(`meta { study = "in progress"; }\n${SYS}page { watermark = "DRAFT"; }`))
      .not.toContain('WATERMARK_ON_FINAL');
  });
});

describe('elements that cannot be graded as one thing', () => {
  const pair = (body: string) => `${SYS}
    faults { "F" { I = 6 kA; type = single_phase_earth; voltage = "MV"; } }
    relay R_B { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.3; } }
    relay R_A { voltage = "MV"; ct_ratio = 400/5; ${body} }
    grade { primary = R_A:46; backup = R_B:51; fault = "F"; margin = 0.3 s; }`;

  it('refuses a neg_seq element that does not say what it measures', () => {
    const r = process(pair(`element 46 { function = "neg_seq"; curve = definite;
      I_pickup = 100 A; t_delay = 1 s; }`));
    const all = [...r.diagnostics, ...r.reports.flatMap((x) => x.diagnostics)];
    expect(all.map((d) => d.code)).toContain('MEASURES_REQUIRED');
  });

  it('refuses an element whose stages measure different currents', () => {
    const r = process(pair(`element 46 { function = "neg_seq"; stages {
        stage a { measures = I2;  curve = definite; I_pickup = 100 A; t_delay = 1 s; }
        stage b { measures = 3I2; curve = definite; I_pickup = 300 A; t_delay = 2 s; }
      } }`));
    const all = [...r.diagnostics, ...r.reports.flatMap((x) => x.diagnostics)];
    expect(all.map((d) => d.code)).toContain('MEASURES_MIXED');
  });
});

describe('the report a study that cannot grade produces', () => {
  it('says an element never operates rather than inventing a margin', () => {
    const r = process(`${SYS}
      faults { "F" { I = 600 A; type = three_phase; voltage = "MV"; } }
      relay R_A { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
      relay R_B { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 40 kA; tms = 0.3; } }
      grade { primary = R_A:51; backup = R_B:51; fault = "F"; margin = 0.3 s; }`);
    const text = formatGradeReports(r.reports);
    expect(text).toMatch(/no-op|NO_OPERATION/);
  });

  it('prints a report for a study with no grade blocks at all', () => {
    const r = process(`${SYS}relay R { voltage = "MV"; ct_ratio = 400/5;
      element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }`);
    expect(() => formatGradeReports(r.reports)).not.toThrow();
  });

  it('reports a pair spanning a transformer with both currents', () => {
    const text = formatGradeReports(process(`${SYS}
      faults { "F" { I = 12 kA; type = three_phase; voltage = "LV"; } }
      relay R_LV { voltage = "LV"; ct_ratio = 2000/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 1.6 kA; tms = 0.1; } }
      relay R_MV { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 200 A; tms = 0.3; } }
      grade { primary = R_LV:51; backup = R_MV:51; fault = "F"; margin = 0.3 s; }`).reports);
    expect(text).toMatch(/seen by/);
  });
});

describe('combine members the examples do not exercise', () => {
  it('takes a style and a colour', () => {
    const r = process(`${SYS}
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
      combine { name = "C"; sources = [R:51]; as = envelope_min;
                label = "Envelope"; color = "#884400"; style = "dashed"; }
      view { voltage = "MV"; }`);
    expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(renderStudy(r, { theme: 'light' })).toContain('Envelope');
  });
});
