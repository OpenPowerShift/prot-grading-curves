/**
 * Display names on relays and elements.
 *
 * `name` is what the drawing calls a thing; `id` stays what `grade`
 * and `annotate` resolve against. The point of the split is that
 * renaming for the reader must never break a reference, so most of
 * these tests check the identifier still works after the rename.
 */

import { describe, expect, it } from 'vitest';
import { process, parseAndRender } from '@tc/index';

const NAMED = `
system { voltages { hv { V  = 11 kV; } } }
faults { "F" { I   = 4 kA; voltage = hv; } }
relay R_INC {
  voltage = hv;
  name    = "Incomer 11 kV, panel 3";
  maker   = "ABB";
  model   = "REF615";
  element 51 { name = "Phase OC (main)"; curve = iec.si; I_pickup = 600 A; tms = 0.3; }
  element 50 { curve = definite; I_pickup = 3 kA; t_delay = 60 ms; }
}
relay R_FDR {
  voltage = hv;
  element 51 { curve = iec.si; I_pickup = 300 A; tms = 0.12; }
}
`;

describe('declaring names', () => {
  const result = process(NAMED);

  it('parses without complaint', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('keeps the identifier as the reference', () => {
    const relay = result.study!.relays.get('R_INC')!;
    expect(relay.id).toBe('R_INC');
    expect(relay.name).toBe('Incomer 11 kV, panel 3');
    expect(relay.elements.map((e) => e.ref)).toEqual(['R_INC:51', 'R_INC:50']);
  });

  it('builds a display label from whichever names are given', () => {
    const [main, inst] = result.study!.relays.get('R_INC')!.elements;
    expect(main.label).toBe('Incomer 11 kV, panel 3 · Phase OC (main)');
    /* The unnamed element falls back to its device number. */
    expect(inst.label).toBe('Incomer 11 kV, panel 3 · 50');
  });

  it('leaves an unnamed relay reading exactly as its reference', () => {
    const [element] = result.study!.relays.get('R_FDR')!.elements;
    expect(element.label).toBe('R_FDR:51');
  });
});

describe('names on the drawing', () => {
  const svg = parseAndRender(NAMED, { theme: 'light' }).svg;

  it('labels the curve with the name, not the identifier', () => {
    expect(svg).toContain('data-curve="Incomer 11 kV, panel 3 · Phase OC (main)"');
  });

  it('wraps a long name inside the legend column', () => {
    /*
     * A free-text name routinely outruns the column; unwrapped it ran
     * off the sheet. Wrapping splits it across lines, so the whole
     * name is present but no single text run carries it all.
     */
    expect(svg).not.toContain('>Incomer 11 kV, panel 3 · Phase OC (main)</text>');
    expect(svg).toContain('Incomer 11 kV');
    expect(svg).toContain('Phase OC (main)');
  });
});

describe('references are unaffected by naming', () => {
  it('grades a named pair by identifier', () => {
    const src = NAMED + `
      grade {
        primary   = R_FDR:51;
        backup    = R_INC:51;
        fault     = "F";
        margin    = 0.30 s;
      }
    `;
    const result = process(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(result.reports).toHaveLength(1);
    expect(Number.isFinite(result.reports[0].rows[0].margin_s)).toBe(true);
  });

  it('annotates a named curve by identifier', () => {
    const src = NAMED + `
      annotate { on_curve = R_INC:51; at_I   = 4 kA; label = "checked"; }
    `;
    const { svg, result } = parseAndRender(src, { theme: 'light' });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
    expect(svg).toContain('>checked</text>');
  });
});
