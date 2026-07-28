/**
 * Device rendering -- fuses in particular.
 *
 * A fuse is a *band*, not a curve: it may begin melting anywhere above
 * its minimum-melt characteristic and is guaranteed clear by its
 * total-clear characteristic. The plot has to show that, or the report
 * and the picture disagree about what is in the study.
 */

import { describe, expect, it } from 'vitest';
import { process, parseAndRender } from '@tc/index';
import { tTripFlex } from '@tc/semantics/curves';

const FUSE_STUDY = `
system { voltages { "MV" { kV = 11.0; } } }
faults { "F_spur" { I_A = 900 A; } }

device "fuse_100T" {
    kind        = "fuse";
    maker       = "Mersen";
    model       = "100T";
    rating_A    = 100 A;
    min_melt    = [(200 A, 60 s), (600 A, 0.60 s), (3000 A, 0.016 s)];
    total_clear = [(200 A, 105 s), (600 A, 1.00 s), (3000 A, 0.028 s)];
}

relay R_FEEDER { voltage = "MV"; ct_ratio = 400/5;
  element 51 { curve = iec.vi; I_pu = 200 A; tms = 0.35; } }

grade { primary = fuse_100T; backup = R_FEEDER:51; fault = "F_spur"; CTI_min_s = 0.15; }
`;

describe('fuse devices', () => {
  const result = process(FUSE_STUDY);

  it('parses and validates', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('resolves maker and model as strings, not tagged values', () => {
    const fuse = result.study!.devices.get('fuse_100T')!;
    expect(fuse.maker).toBe('Mersen');
    expect(fuse.model).toBe('100T');
    expect(fuse.rating_A).toBe(100);
  });

  it('keeps both boundaries of the band', () => {
    const fuse = result.study!.devices.get('fuse_100T')!;
    expect(fuse.min_melt).toHaveLength(3);
    expect(fuse.total_clear).toHaveLength(3);
    /* Total clear is always the slower boundary. */
    for (let i = 0; i < fuse.min_melt!.length; i++) {
      expect(fuse.total_clear![i].t_s).toBeGreaterThan(fuse.min_melt![i].t_s);
    }
  });

  it('grades on the total-clear boundary when the fuse is the primary', () => {
    /*
     * Coordination is judged against total clear: the backup must
     * still be holding when the fuse has finished clearing.
     */
    const fuse = result.study!.devices.get('fuse_100T')!;
    const row = result.reports[0].rows.find((r) => r.at === 'I')!;
    expect(row.t_primary_s).toBeCloseTo(tTripFlex(900, fuse.total_clear!), 9);
    expect(row.t_primary_s).not.toBeCloseTo(tTripFlex(900, fuse.min_melt!), 6);
  });

  it('draws the band, both boundaries, and a hatch', () => {
    const { svg } = parseAndRender(FUSE_STUDY, { theme: 'light' });

    // a filled region between the boundaries
    expect(svg).toMatch(/<path[^>]*fill-opacity="0\.10"/);
    // clipped hatch lines
    expect(svg).toMatch(/clip-path="url\(#tc-band-0\)"/);
    // the dashed minimum-melt boundary and the solid total-clear one
    expect(svg).toMatch(/stroke-dasharray="6 3"/);
    expect(svg).toContain('data-curve="fuse_100T"');
  });

  it('gives the band a hatched legend swatch and names the fuse', () => {
    const { svg } = parseAndRender(FUSE_STUDY, { theme: 'light' });
    expect(svg).toContain('fuse_100T');
    expect(svg).toContain('Mersen 100T');
    expect(svg).toContain('Fuse');
    expect(svg).toMatch(/clip-path="url\(#tc-swatch-/);
  });

  it('uses only characters a PDF core font can encode', () => {
    /*
     * The PDF standard-14 fonts are WinAnsi-encoded. A U+2192 arrow in
     * the band's legend line came out as mojibake on the printed
     * sheet, so exported text stays inside Latin-1.
     */
    const { svg } = parseAndRender(FUSE_STUDY, { theme: 'light' });
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      for (const ch of text) {
        expect(
          ch.codePointAt(0)!,
          `${JSON.stringify(ch)} in ${JSON.stringify(text)} is outside Latin-1`,
        ).toBeLessThan(0x100);
      }
    }
  });
});

describe('other device kinds', () => {
  it('dashes a damage curve, which is a limit rather than an operating curve', () => {
    const { svg } = parseAndRender(`
      system { voltages { "MV" { kV = 11.0; } } }
      device "cable" { kind = "cable"; flex_points = [(300 A, 100 s), (3000 A, 1 s)]; }
    `, { theme: 'light' });
    expect(svg).toMatch(/stroke-dasharray="9 5"/);
  });

  it('draws a breaker as a flat clearing time', () => {
    const { svg } = parseAndRender(`
      system { voltages { "MV" { kV = 11.0; } } }
      device "cb" { kind = "breaker"; t_delay = 0.06 s; }
    `, { theme: 'light' });
    expect(svg).toContain('data-curve="cb"');
    expect(svg).toContain('Breaker');
  });
});
