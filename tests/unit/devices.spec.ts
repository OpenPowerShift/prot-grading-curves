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
system { voltages { "MV" { V  = 11.0 kV; } } }
faults { "F_spur" { I   = 900 A; } }

device "fuse_100T" {
    kind        = "fuse";
    maker       = "Mersen";
    model       = "100T";
    rating_I    = 100 A;
    min_melt    = [(200 A, 60 s), (600 A, 0.60 s), (3000 A, 0.016 s)];
    total_clear = [(200 A, 105 s), (600 A, 1.00 s), (3000 A, 0.028 s)];
}

relay R_FEEDER { voltage = "MV"; ct_ratio = 400/5;
  element 51 { curve = iec.vi; I_pickup = 200 A; tms = 0.35; } }

grade { primary = fuse_100T; backup = R_FEEDER:51; fault = "F_spur"; margin    = 0.15 s; }
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
      system { voltages { "MV" { V  = 11.0 kV; } } }
      device "cable" { kind = "cable"; flex_points = [(300 A, 100 s), (3000 A, 1 s)]; }
    `, { theme: 'light' });
    expect(svg).toMatch(/stroke-dasharray="9 5"/);
  });

  it('draws a breaker as a flat clearing time', () => {
    const { svg } = parseAndRender(`
      system { voltages { "MV" { V  = 11.0 kV; } } }
      device "cb" { kind = "breaker"; t_delay = 0.06 s; }
    `, { theme: 'light' });
    expect(svg).toContain('data-curve="cb"');
    expect(svg).toContain('Breaker');
  });
});

describe('a device sits on a voltage level', () => {
  const study = (deviceVoltage: string): string => `
system { voltages { "HV" { V  = 33 kV; } "LV" { V  = 11 kV; } } }
faults { "F_hv" { I   = 6 kA; voltage = "HV"; } }
device "spur_fuse" {
  kind = fuse; ${deviceVoltage} rating_I = 100 A;
  min_melt    = [(200 A, 10 s), (2 kA, 0.05 s)];
  total_clear = [(200 A, 20 s), (2 kA, 0.10 s)];
}
relay R_HV { voltage = "HV"; element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 200 A; tms = 0.3; } }
grade { primary = "spur_fuse"; backup = R_HV:51; fault = "F_hv"; margin    = 0.3 s; }
view { voltage = "HV"; current_min = 10 A; current_max = 30 kA; }
`;

  /** Where the band's first point lands, read back off the axis. */
  function bandStartAmps(svg: string): number {
    const [x0, , w] = svg.match(/data-plot="([^"]+)"/)![1].split(',').map(Number);
    const px = Number(svg.match(/<path d="M([\d.]+) /)![1]);
    return 10 * Math.pow(10, ((px - x0) / w) * Math.log10(30_000 / 10));
  }

  it('refers its characteristic to the view frame', () => {
    /*
     * A published fuse curve is in the amps of the winding it sits on.
     * Without a level its points were taken as already being in the
     * view frame, so a fuse on the low side was drawn at its own amps
     * on a high-side sheet -- out by the turns ratio.
     */
    const onLv = parseAndRender(study('voltage = "LV";'), { theme: 'light' }).svg;
    expect(bandStartAmps(onLv)).toBeCloseTo(200 * (11 / 33), 0);
  });

  it('leaves a device with no level exactly as it was', () => {
    const noLevel = parseAndRender(study(''), { theme: 'light' }).svg;
    expect(bandStartAmps(noLevel)).toBeCloseTo(200, 0);
  });

  it('grades in its own winding\'s amps', () => {
    /* The fault is on HV; a fuse on LV carries the referred current. */
    const onLv = process(study('voltage = "LV";'));
    expect(onLv.reports[0].rows[0].I_f_A).toBeCloseTo(6000 * (33 / 11), 6);

    const noLevel = process(study(''));
    expect(noLevel.reports[0].rows[0].I_f_A).toBe(6000);
  });

  it('rejects a level that is not declared', () => {
    const r = process(study('voltage = "MV";'));
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))
      .toContain('VOLTAGE_UNKNOWN');
  });

  it('is referenced by a quoted id as well as a bare one', () => {
    /*
     * A device is declared with quotes, so quoting the reference is the
     * natural thing to write -- and it used to parse as nothing and
     * report an unresolved reference.
     */
    const quoted = process(study('voltage = "LV";'));
    expect(quoted.reports[0].diagnostics.map((d) => d.code))
      .not.toContain('UNRESOLVED_REFERENCE');

    const bare = process(study('voltage = "LV";').replace('primary = "spur_fuse"', 'primary = spur_fuse'));
    expect(bare.reports[0].diagnostics.map((d) => d.code))
      .not.toContain('UNRESOLVED_REFERENCE');
  });
});
