/**
 * Marks that belong to one sheet.
 *
 * A study with a phase sheet and a negative-sequence sheet routinely
 * carries marks that mean something on one and nothing on the other --
 * an inrush point in phase amps, a clearance that applies only to the
 * earth-fault story, a fault the other axis cannot show. Before this
 * the choices were to draw them on every sheet or split the study into
 * two files, and two files drift.
 *
 * `view` takes one name or a list. Absent, it means every sheet, so
 * nothing written before this changes.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const STUDY = `
  system { voltages { "MV" { V = 11 kV; } } }
  faults {
    "Everywhere" { I = 5 kA; voltage = "MV"; }
    "Phase only" { I = 3 kA; voltage = "MV"; view = "Phase"; }
    "Listed"     { I = 4 kA; voltage = "MV"; views = ["Phase", "I2"]; }
  }
  times {
    "Both"    { t = 1 s; }
    "I2 only" { t = 0.5 s; view = "I2"; }
  }
  relay R { voltage = "MV"; ct_ratio = 400/5;
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
  point "P phase" { I = 2 kA; t = 1 s; view = "Phase"; label = "phase only"; }
  point "P both"  { I = 1 kA; t = 2 s; label = "everywhere"; }
  annotate { on_curve = R:51; at_I = 2 kA; label = "note on I2"; view = "I2"; }
  view "Phase" { voltage = "MV"; quantity = any; }
  view "I2"    { voltage = "MV"; quantity = any; }
`;

const sheet = (name: string): string => {
  const r = process(STUDY);
  const v = r.study!.views.find((x) => x.name === name);
  return renderStudy(r, { theme: 'light', view: v });
};

const names = (svg: string, attr: string): string[] =>
  [...svg.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))]
    .map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i);

describe('faults', () => {
  it('draws an unscoped one on every sheet', () => {
    for (const s of ['Phase', 'I2']) {
      expect(names(sheet(s), 'data-fault'), s).toContain('Everywhere');
    }
  });

  it('keeps a scoped one to its own sheet', () => {
    expect(names(sheet('Phase'), 'data-fault')).toContain('Phase only');
    expect(names(sheet('I2'), 'data-fault')).not.toContain('Phase only');
  });

  it('honours a list of sheets', () => {
    for (const s of ['Phase', 'I2']) {
      expect(names(sheet(s), 'data-fault'), s).toContain('Listed');
    }
  });
});

describe('times', () => {
  it('draws an unscoped one on every sheet', () => {
    for (const s of ['Phase', 'I2']) {
      expect(names(sheet(s), 'data-time-name'), s).toContain('Both');
    }
  });

  it('keeps a scoped one to its own sheet', () => {
    expect(names(sheet('I2'), 'data-time-name')).toContain('I2 only');
    expect(names(sheet('Phase'), 'data-time-name')).not.toContain('I2 only');
  });
});

describe('points', () => {
  it('draws an unscoped one on every sheet', () => {
    for (const s of ['Phase', 'I2']) {
      expect(names(sheet(s), 'data-point'), s).toContain('everywhere');
    }
  });

  it('keeps a scoped one to its own sheet', () => {
    expect(names(sheet('Phase'), 'data-point')).toContain('phase only');
    expect(names(sheet('I2'), 'data-point')).not.toContain('phase only');
  });
});

describe('annotations', () => {
  it('keeps a scoped one to its own sheet', () => {
    expect(sheet('I2')).toContain('note on I2');
    expect(sheet('Phase')).not.toContain('note on I2');
  });
});

describe('a study that names no views', () => {
  it('is unaffected -- absent means everywhere', () => {
    const r = process(`
      system { voltages { "MV" { V = 11 kV; } } }
      faults { "F" { I = 5 kA; voltage = "MV"; } }
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
      point "P" { I = 2 kA; t = 1 s; label = "here"; }
    `);
    const svg = renderStudy(r, { theme: 'light' });
    expect(svg).toContain('data-fault="F"');
    expect(svg).toContain('here');
  });
});
