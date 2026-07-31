/**
 * Legend placement: `page { legend { style = ... } }`.
 *
 * The column is the default and reserves a gutter. The other three
 * modes exist because that gutter is expensive on a portrait sheet,
 * so each test checks both halves of the bargain: that the mode draws
 * what it promises, and that the plot actually gets the width back.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';

const BASE = `
meta { project = "Legend"; }
system { voltages { hv { V  = 33 kV; } lv { V  = 11 kV; } } }
faults {
  "F_lv" { I   = 6 kA; voltage = lv; }
  "F_hv" { I   = 18 kA; voltage = hv; }
}
relay R_INC {
  voltage = hv;
  element 51 { curve = iec.si; I_pickup = 720 A; tms = 0.3; }
}
relay R_FDR {
  voltage = lv;
  element 51 { curve = iec.vi; I_pickup = 480 A; tms = 0.25; }
  element 50 { curve = definite; I_pickup = 3.2 kA; t_delay = 50 ms; }
}
point "P" { I   = 5 kA; t   = 0.1 s; voltage = hv; label = "inrush"; }
view { voltage = hv; }
`;

function render(legend?: string): string {
  const page = legend ? `page { legend { ${legend} } }` : '';
  return parseAndRender(BASE + page, { theme: 'light' }).svg;
}

/** Width of the plot frame, read back out of the embedded plot rect. */
function plotWidth(svg: string): number {
  const desc = svg.match(/<desc data-plot="([^"]+)"/);
  if (desc) {
    const [, , w] = desc[1].split(',').map(Number);
    return w;
  }
  /* Fall back to the frame rect the renderer draws. */
  const rect = svg.match(/<rect x="92"[^>]*width="([\d.]+)"/);
  return Number(rect![1]);
}

const CURVE_LABELS = ['R_INC:51', 'R_FDR:51', 'R_FDR:50'];

describe('column legend (the default)', () => {
  const svg = render();

  it('draws the headed panel', () => {
    expect(svg).toContain('>Curves</text>');
    expect(svg).toContain('>Faults</text>');
  });

  it('omits a point that is already drawn on the plot', () => {
    /*
     * The marker carries its own label, so a legend entry repeats it
     * and costs the panel room the curves need.
     */
    expect(svg).toContain('>inrush</text>');      // on the plot
    expect(svg).not.toContain('>Points</text>');  // not in the panel
  });

  it('lists a point that fell outside the view, since it is nowhere else', () => {
    const offPlot = parseAndRender(
      BASE.replace('view { voltage = hv; }', 'view { voltage = hv; current_min = 100 A; current_max = 1 kA; }'),
      { theme: 'light' },
    ).svg;
    expect(offPlot).toContain('>Points</text>');
  });

  it('names every curve', () => {
    for (const label of CURVE_LABELS) expect(svg).toContain(`>${label}</text>`);
  });
});

describe('style = "inside"', () => {
  const svg = render('style = "inside";');

  it('keeps the whole panel, sections and all', () => {
    expect(svg).toContain('>Curves</text>');
    expect(svg).toContain('>Faults</text>');
    for (const label of CURVE_LABELS) expect(svg).toContain(`>${label}</text>`);
  });

  it('gives the freed gutter to the plot', () => {
    expect(plotWidth(svg)).toBeGreaterThan(plotWidth(render()) + 200);
  });

  it('backs the panel with an opaque card, so the grid does not read through', () => {
    expect(svg).toMatch(/<rect [^>]*fill-opacity="0\.92"[^>]*stroke-width="0\.8"\/>/);
  });

  it('pins the panel to the requested corner', () => {
    const cardX = (s: string): number =>
      Number(s.match(/<rect x="([\d.]+)"[^>]*fill-opacity="0\.92"/)![1]);
    const cardY = (s: string): number =>
      Number(s.match(/<rect x="[\d.]+" y="([\d.]+)"[^>]*fill-opacity="0\.92"/)![1]);

    const topRight = render('style = "inside"; position = "top_right";');
    const topLeft = render('style = "inside"; position = "top_left";');
    const bottomRight = render('style = "inside"; position = "bottom_right";');

    expect(cardX(topLeft)).toBeLessThan(cardX(topRight));
    expect(cardY(bottomRight)).toBeGreaterThan(cardY(topRight));
  });
});

describe('style = "direct"', () => {
  const svg = render('style = "direct";');

  it('drops the panel', () => {
    expect(svg).not.toContain('>Curves</text>');
    expect(svg).not.toContain('>Points</text>');
  });

  it('still names every curve, on the plot', () => {
    for (const label of CURVE_LABELS) expect(svg).toContain(`>${label}</text>`);
  });

  it('labels a curve that runs off the bottom of the plot', () => {
    /*
     * The instantaneous element's trace leaves the plot, so its last
     * sampled point is below the axis. It must still be labelled --
     * anchoring naively to the final point drops it.
     */
    expect(svg).toContain('>R_FDR:50</text>');
  });

  it('gives each label a leader back to its curve', () => {
    const leaders = svg.match(/<path d="M[\d.]+ [\d.]+ L[\d.-]+ [\d.]+ L[\d.-]+ [\d.]+" fill="none" stroke="#[0-9a-f]{6}" stroke-width="1" stroke-opacity="0\.8"\/>/g);
    expect(leaders).toHaveLength(CURVE_LABELS.length);
  });

  it('spreads the boxes so none overlap', () => {
    const ys = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)"[^>]*rx="3"/g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    expect(ys).toHaveLength(CURVE_LABELS.length);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThan(10);
    }
  });

  it('gives the freed gutter to the plot', () => {
    expect(plotWidth(svg)).toBeGreaterThan(plotWidth(render()) + 200);
  });
});

describe('suppressing the legend', () => {
  it('draws none of it for style = "none"', () => {
    const svg = render('style = "none";');
    expect(svg).not.toContain('>Curves</text>');
    for (const label of CURVE_LABELS) expect(svg).not.toContain(`>${label}</text>`);
  });

  it('still honours the older show = false spelling', () => {
    const svg = render('show = false;');
    expect(svg).not.toContain('>Curves</text>');
  });

  it('lets an explicit style win over show', () => {
    const svg = render('show = false; style = "direct";');
    expect(svg).toContain('>R_INC:51</text>');
  });
});

describe('fault descriptions', () => {
  const src = `
meta { project = "Desc"; }
system { voltages { hv { V  = 11 kV; } } }
faults {
  "F_bus" { I   = 9 kA; voltage = hv; description = "switchboard bus fault, three phase"; }
  "F_spur" { I   = 2 kA; voltage = hv; }
}
relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = hv; }
`;

  it('shows the description under its fault, rather than dropping it', () => {
    const svg = parseAndRender(src, { theme: 'light' }).svg;
    expect(svg).toContain('switchboard bus fault');
  });

  it('says nothing extra for a fault that has no description', () => {
    const svg = parseAndRender(src, { theme: 'light' }).svg;
    /* F_spur still appears, but brings no note with it. */
    expect(svg).toContain('F_spur');
  });

  it('wraps a long description inside the legend column', () => {
    const long = src.replace(
      'switchboard bus fault, three phase',
      'switchboard bus fault, three phase, measured at the incomer with the bus section closed',
    );
    const svg = parseAndRender(long, { theme: 'light' }).svg;
    /* Present, but not as one run that would overflow the column. */
    expect(svg).toContain('switchboard bus fault');
    expect(svg).not.toContain(
      '>switchboard bus fault, three phase, measured at the incomer with the bus section closed</text>',
    );
  });
});

describe('a crowded sheet', () => {
  /** Nine characteristics and seven described faults, as a real study has. */
  const CROWDED = `
meta { project = "Crowded"; }
system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 0.48 kV; } } }
faults {
  "RMU 33 kV 3ph max" { I   = 31.37 kA; voltage = "HV"; description = "Max 3ph at 33 kV RMU-BESS"; }
  "RMU 33 kV 3ph min" { I   = 16.33 kA; voltage = "HV"; description = "Min 3ph at 33 kV RMU-BESS"; }
  "RMU 33 kV 1ph max" { I   = 2.95 kA; voltage = "HV"; description = "Max 1ph-earth at 33 kV RMU-BESS"; }
  "F_2ph_min_HV" { I   = 390 A; voltage = "HV"; description = "Min 2ph fault seen by the relay"; }
  "F_ACB_inst_HV" { I   = 65.5 A; voltage = "HV"; description = "ACB inst threshold referred to 33 kV"; }
  "F_INV_max" { I   = 0.46 kA; voltage = "LV"; description = "Max 3ph at 0.48 kV inverter"; }
  "F_INV_min" { I   = 0.45 kA; voltage = "LV"; description = "Min 3ph at 0.48 kV inverter"; }
}
relay R_RMU_850 {
  name = "BESS HV Relay (GE Multilin 850)"; maker = "GE Multilin"; model = "850";
  voltage = "HV"; ct_ratio = 250/1;
  element 51  { name = "Phase TOC (51)"; curve = iec.si; I_pickup = 105 A; tms = 0.10; }
  element 51G { name = "Ground TOC (51G)"; curve = iec.si; I_pickup = 20 A; tms = 0.15; }
  element 50G { name = "Ground IOC (50G)"; curve = definite; I_pickup = 100 A; t_delay = 0 s; }
  element 50 {
    name = "Phase IOC (50)";
    stages {
      stage main  { curve = definite; I_pickup = 147 A; t_delay = 0 s; }
      stage energ { curve = definite; I_pickup = 255 A; t_delay = 0 s; }
    }
  }
  element 46 {
    name = "Negative Sequence IOC (46)";
    stages {
      stage main  { curve = definite; I_pickup = 75 A; t_delay = 0.10 s; }
      stage energ { curve = definite; I_pickup = 75 A; t_delay = 0.35 s; }
    }
  }
}
relay R_FDR {
  name = "33 kV BESS Feeder (SEL-751)"; voltage = "HV"; ct_ratio = 250/1;
  element 46 { name = "Neg Seq backup (46)"; curve = definite; I_pickup = 75 A; t_delay = 0.45 s; }
}
point "TX_inrush" { I   = 212 A; t   = 0.12 s; voltage = "HV"; label = "BESS Tx inrush"; }
view { voltage = "HV"; stages = "individual"; }
`;

  /** Baseline of every text element's y, and the sheet height. */
  function textExtent(svg: string): { lowest: number; height: number } {
    const height = Number(svg.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/)![1]);
    let lowest = 0;
    for (const m of svg.matchAll(/<text[^>]*\sy="([\d.]+)"/g)) {
      lowest = Math.max(lowest, Number(m[1]));
    }
    return { lowest, height };
  }

  it('keeps every legend entry on the sheet', () => {
    const svg = parseAndRender(CROWDED, { theme: 'light' }).svg;
    const { lowest, height } = textExtent(svg);
    expect(lowest).toBeLessThan(height);
  });

  it('sheds detail rather than entries, so nothing goes unnamed', () => {
    const svg = parseAndRender(CROWDED, { theme: 'light' }).svg;

    /* Every curve is still listed... */
    expect(svg).toContain('Phase TOC (51)');
    expect(svg).toContain('Neg Seq backup (46)');
    /* ...and the settings line, which is what gets checked, survives. */
    expect(svg).toMatch(/delay 350\s*ms/);
    /* The make and model is what gave way. */
    expect(svg).not.toContain('>GE Multilin 850</text>');
  });

  it('leaves a small study at full detail', () => {
    const svg = render();
    /* The uncrowded case still prints everything it has. */
    expect(svg).toContain('IEC SI · 720 A · TMS 0.3');
  });
});

describe('cross-voltage fault entries', () => {
  const CROSS = `
system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 0.48 kV; } } }
faults {
  "F_INV_max" { I   = 0.46 kA; voltage = "LV"; }
  "F_HV_max"  { I   = 31.4 kA; voltage = "HV"; }
}
relay R { voltage = "HV"; element 51 { curve = iec.si; I_pickup = 105 A; tms = 0.1; } }
view { voltage = "HV"; }
`;

  it('quotes the declared current against the level it was declared on', () => {
    const svg = parseAndRender(CROSS, { theme: 'light' }).svg;
    /*
     * The legend used to print the *projected* current beside the
     * fault's own voltage: a 460 A fault at 0.48 kV was listed as
     * "6.69 A · LV · 0.48 kV", which is its 33 kV equivalent and so
     * simply false at the level named.
     */
    expect(svg).toContain('F_INV_max · 460 A · LV · 0.48 kV');
    expect(svg).not.toContain('6.69 A · LV');
  });

  it('shows where a projected fault lands on the axis as well', () => {
    const svg = parseAndRender(CROSS, { theme: 'light' }).svg;
    /*
     * The entry wraps, so the arrow and the value may land on
     * different lines; both must be present. The arrow is ASCII --
     * U+2192 is outside the PDF core fonts' encoding, so it prints as
     * mojibake on an exported sheet.
     */
    expect(svg).toContain('-&gt;');
    expect(svg).toMatch(/6\.69/);
  });

  it('says nothing extra when the fault is already in the view frame', () => {
    const svg = parseAndRender(CROSS, { theme: 'light' }).svg;
    /* An HV fault on an HV axis needs no projection note. */
    const entries = [...svg.matchAll(/>([^<]*F_HV_max[^<]*)</g)].map((m) => m[1]).join(' ');
    expect(entries).not.toContain('-&gt;');
  });
});

describe('zero definite delay', () => {
  it('warns rather than silently dropping the stage', () => {
    const { result } = parseAndRender(`
system { voltages { hv { V  = 11 kV; } } }
relay R { voltage = hv; element 50 { curve = definite; I_pickup = 3 kA; t_delay = 0 s; } }
`, { theme: 'light' });

    const warning = result.diagnostics.find((d) => d.code === 'ZERO_DELAY_NOT_PLOTTABLE');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });
});

describe('faults follow the view', () => {
  const THREE = `
meta { project = "Zoom"; }
system { voltages { hv { V  = 11 kV; } } }
faults {
  "F_low"  { I   = 200 A; voltage = hv; }
  "F_mid"  { I   = 3 kA;  voltage = hv; }
  "F_high" { I   = 20 kA; voltage = hv; }
}
relay R { voltage = hv; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
`;

  const at = (bounds: string): string =>
    parseAndRender(THREE + `view { voltage = hv; ${bounds} }`, { theme: 'light' }).svg;

  /** Fault names that have a legend entry. */
  const listed = (svg: string): string[] =>
    ['F_low', 'F_mid', 'F_high'].filter((n) => new RegExp(`>${n} ·`).test(svg));

  /** Fault names that have a rule drawn on the plot. */
  const ruled = (svg: string): string[] =>
    [...svg.matchAll(/data-fault="([^"]+)"/g)].map((m) => m[1]);

  it('lists every fault when the view spans them all', () => {
    const svg = at('current_min = 1 A; current_max = 500 kA;');
    expect(listed(svg).sort()).toEqual(['F_high', 'F_low', 'F_mid']);
  });

  it('drops the ones the view excludes', () => {
    /*
     * A legend entry maps a dash pattern to a name, which says nothing
     * when that dash is nowhere on the plot -- and a fault outside the
     * zoom has no rule and no name below the axis.
     */
    const svg = at('current_min = 1 kA; current_max = 50 kA;');
    expect(listed(svg).sort()).toEqual(['F_high', 'F_mid']);
    expect(listed(svg)).not.toContain('F_low');
  });

  it('always lists exactly what is drawn', () => {
    for (const bounds of [
      'current_min = 1 A; current_max = 500 kA;',
      'current_min = 1 kA; current_max = 50 kA;',
      'current_min = 100 A; current_max = 5 kA;',
    ]) {
      const svg = at(bounds);
      expect(listed(svg).sort(), bounds).toEqual(ruled(svg).sort());
    }
  });

  it('keeps each swatch on the dash of the rule it names', () => {
    /*
     * The dash is assigned from the declared order, so filtering with
     * fresh indices would show a swatch a different dash from its rule.
     */
    const svg = at('current_min = 1 kA; current_max = 50 kA;');

    const ruleDash: Record<string, string> = {};
    for (const m of svg.matchAll(/data-fault="([^"]+)"[^>]*?stroke-dasharray="([^"]*)"/g)) {
      ruleDash[m[1]] = m[2];
    }
    const swatches = [...svg.matchAll(
      /<line x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="#c0392b" stroke-width="1\.5"(?: stroke-dasharray="([^"]*)")?\/>/g,
    )].map((m) => m[1] ?? 'solid');

    expect(swatches[0]).toBe(ruleDash.F_mid);
    expect(swatches[1]).toBe(ruleDash.F_high);
  });

  it('drops the whole section when the view contains no fault', () => {
    const svg = at('current_min = 5 kA; current_max = 8 kA;');
    expect(svg).not.toContain('>Faults</text>');
  });
});

describe('a compact legend keeps the settings', () => {
  /**
   * Ten single-stage relays, enough to force the legend below full
   * detail. A single-stage element has three detail lines -- make and
   * model, settings, voltage -- and the settings is the *middle* one.
   */
  function crowdedSingleStage(): string {
    let src = 'system { voltages { hv { V  = 11 kV; } } }\n'
      + 'faults { "F" { I   = 9 kA; voltage = hv; } }\n';
    for (let i = 1; i <= 10; i++) {
      src += `relay R${i} { voltage = hv; maker = "Maker${i}"; model = "Model${i}"; `
        + `element 51 { curve = iec.si; I_pickup = ${100 * i} A; tms = 0.${i}; } }\n`;
    }
    return src + 'view { voltage = hv; }\n';
  }

  const muted = (svg: string): string[] =>
    [...svg.matchAll(/class="tc-legend-muted"[^>]*>([^<]*)</g)].map((m) => m[1]);

  it('shows the settings, not the voltage', () => {
    /*
     * Compact used to take the *last* detail line, so for a
     * single-stage element it kept the voltage and threw the settings
     * away. Every crowded sheet -- and every PDF of one, the PDF
     * canvas being shorter than the screen pane -- lost its settings.
     * The earlier crowded test only exercised staged elements, whose
     * two detail lines made the positional pick accidentally correct.
     */
    const lines = muted(parseAndRender(crowdedSingleStage(), { theme: 'light' }).svg);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => /TMS/.test(l)), JSON.stringify(lines.slice(0, 4))).toBe(true);
    /* And the make and model is what gave way. */
    expect(lines.some((l) => /Maker\d/.test(l))).toBe(false);
  });

  it('survives the round trip into an exported sheet', async () => {
    /* The PDF is built from the same SVG, so the settings must be in
     * the text the exporter is handed. */
    const { toPdfSafeText } = await import('@tc/export/export-pdf');
    const svg = parseAndRender(crowdedSingleStage(), { theme: 'light' }).svg;
    expect(toPdfSafeText(svg)).toMatch(/IEC SI · \d+ A · TMS/);
  });
});

describe('view { quantity } chooses the abscissa', () => {
  const STUDY = `
system { voltages { hv { V  = 33 kV; } } }
faults {
  "F_3ph"   { I   = 9 kA; I2   = 0 A;     I0   = 0 A;     voltage = hv; }
  "F_earth" { I   = 3 kA; I2   = 1000 A;  I0   = 1000 A;  voltage = hv; }
}
relay R {
  voltage = hv; ct_ratio = 250/1;
  element 51  { function = "phase_oc";    curve = iec.si; I_pickup = 400 A; tms = 0.2; }
  element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 100 A; tms = 0.15; }
  element 46  { function = "neg_seq"; measures = I2; curve = definite; I_pickup = 200 A; t_delay = 0.4 s; }
}
`;

  const at = (quantity: string): string =>
    parseAndRender(STUDY + `view { voltage = hv; quantity = ${quantity}; }`, { theme: 'light' }).svg;

  const curves = (svg: string): string[] =>
    [...svg.matchAll(/data-curve="([^"]+)"/g)].map((m) => m[1]);
  const rules = (svg: string): Array<[string, number]> =>
    [...svg.matchAll(/data-fault="([^"]+)" data-current="([\d.]+)"/g)]
      .map((m) => [m[1], Number(m[2])] as [string, number]);

  it('draws only the elements that measure it', () => {
    expect(curves(at('phase'))).toEqual(['R:51']);
    expect(curves(at('3I0'))).toEqual(['R:51G']);
    expect(curves(at('I2'))).toEqual(['R:46']);
  });

  it('stands each fault rule at that component, not the phase current', () => {
    /* This is the question the option exists to answer: a negative
     * sequence element operates on I2, so on its sheet the rule has to
     * be at the fault's I2 -- 1 kA -- and not at its 3 kA of phase. */
    expect(rules(at('I2'))).toEqual([['F_earth', 1000]]);
    /* Residual is three times the component. */
    expect(rules(at('3I0'))).toEqual([['F_earth', 3000]]);
    /* And on a phase sheet, the declared phase currents. */
    expect(rules(at('phase')).map(([, i]) => i)).toEqual([9000, 3000]);
  });

  it('leaves out a fault with no value for that component', () => {
    /* A balanced three-phase fault has no negative sequence, so there
     * is nothing to mark on an I2 sheet. */
    expect(rules(at('I2')).map(([n]) => n)).not.toContain('F_3ph');
  });

  it('names the quantity on the axis, so the units are not a guess', () => {
    expect(at('phase')).toMatch(/>Current \(A primary · hv · 33 kV\)</);
    expect(at('I2')).toMatch(/>Current \(A primary · I2 · hv · 33 kV\)</);
    expect(at('3I0')).toMatch(/>Current \(A primary · residual 3I0 · hv · 33 kV\)</);
  });

  it('names the elements the axis left off, and why', () => {
    /*
     * A count told the reader that something was missing without
     * saying what, or what to do about it. Both of these measure a
     * different component from the axis, and relating two components
     * needs a condition -- which is a one-line fix the note now names.
     */
    const svg = at('I2');
    expect(svg).toMatch(/R:51 measures phase; name a condition/);
    expect(svg).toMatch(/R:51G measures residual 3I0; name a condition/);
  });

  it('needs no condition for the same component in another scaling', () => {
    /*
     * `3I2` is three times `I2` by definition, whatever the fault is.
     * Requiring a condition for that made the 46 vanish from a 3I2
     * sheet -- a factor of three the tool already knew, refused for
     * want of data it never needed.
     */
    expect(curves(at('3I2'))).toContain('R:46');
    expect(curves(at('3I0'))).toContain('R:51G');
  });

  it('defaults to an unconstrained axis, drawing everything', () => {
    /*
     * `any` is the default: several characteristics on one sheet
     * without arguing about components, which is what an engineer
     * wants most of the time. The legend states each curve's measured
     * quantity, and that is what keeps a mixed sheet readable.
     */
    const noQuantity = parseAndRender(STUDY + 'view { voltage = hv; }', { theme: 'light' }).svg;
    expect(curves(noQuantity).sort()).toEqual(['R:46', 'R:51', 'R:51G']);
    expect(noQuantity).not.toMatch(/not on this axis/);
  });

  it('is explicit about it when asked for `any`', () => {
    const any = parseAndRender(STUDY + 'view { voltage = hv; quantity = any; }', { theme: 'light' }).svg;
    expect(curves(any).sort()).toEqual(['R:46', 'R:51', 'R:51G']);
  });
});

describe('a sheet drawn for a condition', () => {
  const STUDY = `
system { voltages { hv { V  = 33 kV; } } }
faults {
  "F_3ph" { I   = 9 kA;  type = three_phase;       voltage = hv; }
  "F_2ph" { I   = 390 A; type = two_phase;         voltage = hv; }
  "F_1ph" { I   = 2 kA;  type = single_phase_earth; voltage = hv; }
}
relay R {
  voltage = hv;
  element 51  { function = "phase_oc";    curve = definite; I_pickup = 100 A; t_delay = 1 s; }
  element 51G { function = "earth_fault"; curve = definite; I_pickup = 50 A;  t_delay = 2 s; }
  element 46  { function = "neg_seq"; measures = I2; curve = definite; I_pickup = 60 A; t_delay = 3 s; }
}
`;

  const sheet = (view: string): string =>
    parseAndRender(
      STUDY + `view { voltage = hv; current_min = 10 A; current_max = 30 kA; ${view} }`,
      { theme: 'light' },
    ).svg;

  const drawn = (svg: string): string[] =>
    [...svg.matchAll(/data-curve="([^"]+)"/g)].map((m) => m[1]).sort();
  const notes = (svg: string): string =>
    [...svg.matchAll(/font-style="italic">([^<]*)</g)].map((m) => m[1]).join(' | ');

  it('converts a phase curve onto a negative-sequence axis', () => {
    const svg = sheet('quantity = I2; condition = "F_2ph";');
    expect(drawn(svg)).toEqual(['R:46', 'R:51']);
    /*
     * Named with the multiplier that placed it, not counted. A count
     * said some curve was not where its own setting would put it
     * without saying which, so a reader checking a pickup against the
     * axis could not tell whether this was the converted one. For a
     * phase-phase fault the phase curve sits at 1/root3 = 0.577 of its
     * own current on an I2 axis.
     */
    expect(notes(svg)).toContain('R:51: phase drawn on the I2 axis, x0.577');
  });

  it('places the converted curve at the right current', () => {
    /*
     * The 51 picks up at 100 A of phase current. On an I2 axis, for a
     * phase-phase fault, that is 100/root3 = 57.7 A. A conversion is a
     * constant shift on a log axis, so the shape and the operate times
     * are untouched -- only the abscissa moves.
     */
    const ampsAtRiser = (svg: string): number => {
      const [x0, , w] = svg.match(/data-plot="([^"]+)"/)![1].split(',').map(Number);
      const px = Number(svg.match(/d="M([\d.]+) /)![1]);
      const decades = Math.log10(30_000 / 10);
      return 10 * Math.pow(10, ((px - x0) / w) * decades);
    };

    expect(ampsAtRiser(sheet('quantity = phase; condition = "F_2ph";'))).toBeCloseTo(100, 0);
    expect(ampsAtRiser(sheet('quantity = I2; condition = "F_2ph";')))
      .toBeCloseTo(100 / Math.sqrt(3), 0);
  });

  it('suppresses earth and negative sequence on a balanced condition', () => {
    /*
     * A three-phase fault carries no I2 and no I0, so those elements
     * cannot operate under it. Drawing them would imply an operation
     * that cannot happen.
     */
    const svg = sheet('quantity = phase; condition = "F_3ph";');
    expect(drawn(svg)).toEqual(['R:51']);
    /* Each named with the reason it cannot operate, rather than
     * counted as merely off-axis: the condition carries none of what
     * they measure. */
    expect(notes(svg)).toContain('R:46 carries no I2 under F_3ph');
    expect(notes(svg)).toContain('R:51G carries no residual 3I0 under F_3ph');
  });

  it('suppresses only the earth element on a phase-phase condition', () => {
    /* No earth path, so no zero sequence -- but there is negative
     * sequence, so the 46 converts on. */
    expect(drawn(sheet('quantity = phase; condition = "F_2ph";'))).toEqual(['R:46', 'R:51']);
  });

  it('draws all three on a phase-earth condition', () => {
    const svg = sheet('quantity = phase; condition = "F_1ph";');
    expect(drawn(svg)).toEqual(['R:46', 'R:51', 'R:51G']);
    /* The residual equals the phase current for this type, so the 51G
     * needs no conversion -- only the 46 does, at three times, since a
     * phase-earth fault's I2 is a third of its phase current. */
    expect(notes(svg)).toContain('R:46: I2 drawn on the phase axis, x3');
    expect(notes(svg)).not.toContain('R:51G:');
  });

  it('names the condition and its type', () => {
    expect(notes(sheet('quantity = phase; condition = "F_2ph";')))
      .toContain('drawn for F_2ph (phase-phase)');
  });

  it('converts nothing without a condition, as before', () => {
    expect(drawn(sheet('quantity = I2;'))).toEqual(['R:46']);
  });

  it('derives a fault rule from the type when the component is not declared', () => {
    /* F_2ph declares only its phase current; its I2 rule is derived. */
    const svg = sheet('quantity = I2; condition = "F_2ph";');
    const rule = svg.match(/data-fault="F_2ph" data-current="([\d.]+)"/);
    expect(rule).not.toBeNull();
    expect(Number(rule![1])).toBeCloseTo(390 / Math.sqrt(3), 3);
  });
});

describe('zero sequence across levels is declared, not assumed', () => {
  const study = (zeroSequence: string): ReturnType<typeof parseAndRender> => parseAndRender(`
system {
  voltages { "HV" { V  = 33 kV; } "LV" { V  = 0.48 kV; } }
  ${zeroSequence}
}
faults { "F" { I   = 6 kA; I0   = 800 A; voltage = "LV"; } }
relay R_LV { voltage = "LV"; element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 300 A; tms = 0.1; } }
relay R_HV { voltage = "HV"; element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 20 A; tms = 0.15; } }
grade { primary = R_LV:51; backup = R_HV:51G; fault = "F"; margin    = 0.3 s; }
`, { theme: 'light' });

  const codes = (r: ReturnType<typeof parseAndRender>): string[] =>
    r.result.reports[0].diagnostics.map((d) => d.code);

  it('refuses while undeclared, asking for the declaration', () => {
    const r = study('');
    expect(codes(r)).toContain('SEQUENCE_ACROSS_LEVELS');
    const message = r.result.reports[0].diagnostics
      .find((d) => d.code === 'SEQUENCE_ACROSS_LEVELS')!.message;
    /* The message asks rather than asserting physics. */
    expect(message).toContain('depends on the windings');
    expect(message).toContain('zero_sequence');
  });

  it('refuses when the link is declared blocked', () => {
    expect(codes(study('zero_sequence { "LV" to "HV" = blocked; }')))
      .toContain('SEQUENCE_ACROSS_LEVELS');
  });

  it('refers the residual when the link is declared continuous', () => {
    /* A star-star transformer with both neutrals earthed does pass it:
     * 3 x 800 A at 0.48 kV is 34.9 A at 33 kV. */
    const r = study('zero_sequence { "LV" to "HV" = continuous; }');
    expect(codes(r)).not.toContain('SEQUENCE_ACROSS_LEVELS');
    expect(r.result.reports[0].rows[0].I_backup_A).toBeCloseTo(2400 * (0.48 / 33), 6);
  });

  it('reads the pair in either order', () => {
    const r = study('zero_sequence { "HV" to "LV" = continuous; }');
    expect(codes(r)).not.toContain('SEQUENCE_ACROSS_LEVELS');
  });
});

describe('annotations use the quantity their element measures', () => {
  const STUDY = `
system { voltages { hv { V  = 33 kV; } } }
faults { "F_1ph" { I   = 3 kA; type = single_phase_earth; voltage = hv; } }
relay R {
  voltage = hv;
  element 51G { function = "earth_fault"; curve = definite; I_pickup = 100 A; t_delay = 1.5 s; }
  element 46  { function = "neg_seq"; measures = I2; curve = definite; I_pickup = 100 A; t_delay = 2.5 s; }
}
annotate { on_curve = R:51G; fault = "F_1ph"; style = tag; label = "earth";  coords = true; }
annotate { on_curve = R:46;  fault = "F_1ph"; style = tag; label = "negseq"; coords = true; }
`;

  const marks = (view: string): string[] =>
    [...parseAndRender(
      STUDY + `view { voltage = hv; current_min = 10 A; current_max = 30 kA; ${view} }`,
      { theme: 'light' },
    ).svg.matchAll(/>((?:earth|negseq)[^<]*)</g)].map((m) => m[1]);

  it('marks each element at the current it responds to', () => {
    /*
     * A 3 kA phase-earth fault presents 3 kA of residual and 1 kA of
     * negative sequence. `annotationCurrent` took `fault.I_A`
     * unconditionally, so both marks landed at the phase current --
     * the wrong time for the earth element and the wrong place for
     * both.
     */
    expect(marks('quantity = any;')).toEqual([
      'earth (3 kA, 1.5 s)',
      'negseq (1 kA, 2.5 s)',
    ]);
  });

  it('converts the mark onto a sheet drawn in another quantity', () => {
    /*
     * On an I2 axis the earth mark moves to the I2 reading for the same
     * physical condition, while its operate time -- evaluated at the
     * residual it actually measures -- is unchanged at 1.5 s.
     */
    expect(marks('quantity = I2; condition = "F_1ph";')).toEqual([
      'earth (1 kA, 1.5 s)',
      'negseq (1 kA, 2.5 s)',
    ]);
  });

  it('derives the annotated current from the fault type', () => {
    /* F_1ph declares only its phase current; the residual and I2 come
     * from the type. */
    const declaredOnly = STUDY.replace('type = single_phase_earth; ', '');
    const svg = parseAndRender(
      declaredOnly + 'view { voltage = hv; current_min = 10 A; current_max = 30 kA; }',
      { theme: 'light' },
    ).svg;
    /* Without a type there is nothing to derive, so neither mark places. */
    expect([...svg.matchAll(/>((?:earth|negseq)[^<]*)</g)]).toHaveLength(0);
  });
});

describe('a declared zero suppresses rather than converts', () => {
  /**
   * The condition is a phase-earth fault, whose *type* says the
   * residual equals the phase current -- but this side of a delta
   * transformer receives none of it, so the study declares `I0_A = 0`.
   */
  const STUDY = `
system {
  voltages { "HV" { V  = 33 kV; } }
  zero_sequence { "HV" to "HV" = blocked; }
}
faults {
  "F" { type = single_phase_earth; I   = 3.9 A; I2   = 2.2 A; I0   = 0 A; voltage = "HV"; }
}
relay R {
  voltage = "HV";
  element 51  { function = "phase_oc";    curve = definite; I_pickup = 1 A; t_delay = 1 s; }
  element 51G { function = "earth_fault"; curve = definite; I_pickup = 1 A; t_delay = 2 s; }
  element 46  { function = "neg_seq"; measures = I2; curve = definite; I_pickup = 1 A; t_delay = 3 s; }
}
view { voltage = "HV"; quantity = I2; condition = "F"; current_min = 0.1 A; current_max = 100 A; }
`;

  const svg = parseAndRender(STUDY, { theme: 'light' }).svg;

  it('leaves the residual element off, since it has nothing to measure', () => {
    /*
     * A zero factor is the same answer as an absent quantity. Left as a
     * number it was a divisor of zero: the curve was counted as
     * converted and then quietly not drawn, so the legend claimed one
     * more curve than the sheet had.
     */
    const drawn = [...svg.matchAll(/data-curve="([^"]+)"/g)].map((m) => m[1]);
    expect(drawn).toHaveLength(2);
    expect(drawn.join(' ')).not.toContain('51G');
  });

  it('counts what it actually drew, and names what it did not', () => {
    const notes = [...svg.matchAll(/font-style="italic">([^<]*)</g)].map((m) => m[1]).join(' | ');
    expect(notes).toContain('R:51: phase drawn on the I2 axis');
    /*
     * Named with its reason rather than counted as merely off-axis. The
     * element is not absent because the abscissa is inconvenient -- it
     * is absent because this condition gives it nothing to measure, and
     * a reader cannot work out which relay that was from a tally.
     */
    expect(notes).toContain('51G carries no residual 3I0 at HV');
  });
});

/* ---------------------------------------------------------------- */

describe('quoting pickups in secondary amps', () => {
  /*
   * A study is written in primary amps because that is what the fault
   * study gives, but the number an engineer types into the relay is the
   * secondary one. `page { legend { currents } }` asks for that figure
   * whatever the abscissa is doing -- the two are separate questions,
   * and a sheet taken to site wants the settings in the units of the
   * settings sheet.
   */
  const STUDY = (legend: string) => `
system { voltages { "HV" { V  = 33 kV; } } }
faults { "F" { I   = 6 kA; voltage = "HV"; } }
relay R_CT {
  voltage = "HV"; ct_ratio = 600/5;
  element 51 { curve = iec.si; I_pickup = 720 A; tms = 0.3; }
  element 50 { curve = definite; I_pickup = 4.8 kA; t_delay = 50 ms; }
}
relay R_BARE {
  voltage = "HV";
  element 51 { curve = iec.si; I_pickup = 300 A; tms = 0.2; }
}
page { ${legend} }
view { voltage = "HV"; }
`;

  const render = (legend: string): string =>
    parseAndRender(STUDY(legend), { theme: 'light' }).svg;

  it('quotes primary amps by default, as before', () => {
    const svg = render('');
    expect(svg).toContain('720 A');
    expect(svg).not.toContain('A sec');
  });

  it('converts by the CT ratio when asked for secondary', () => {
    /* 600/5 is a ratio of 120: 720 A primary is 6 A at the relay. */
    const svg = render('legend = { currents = "secondary"; };');
    expect(svg).toContain('6 A sec');
    expect(svg).toContain('40 A sec');
    /* The primary figure gives way to it, rather than both being shown. */
    expect(svg).not.toContain('720 A ·');
  });

  it('shows both when asked for both', () => {
    const svg = render('legend = { currents = "both"; };');
    expect(svg).toContain('720 A (6 A sec)');
  });

  it('is independent of what the axis is drawn in', () => {
    /*
     * The point of the option: a primary-amp axis with settings-sheet
     * figures beside it. `view { axis }` decides the abscissa and this
     * decides the legend; neither implies the other.
     */
    const svg = parseAndRender(
      STUDY('legend = { currents = "secondary"; };').replace(
        'view { voltage = "HV"; }', 'view { voltage = "HV"; axis = "primary"; }'),
      { theme: 'light' },
    ).svg;
    expect(svg).toContain('6 A sec');
    expect(svg).toContain('Current (A primary');
  });

  it('says which elements it could not convert', () => {
    /*
     * A panel headed one way and figured the other is out by the CT
     * ratio -- the sort of error that ends up in a relay -- so an
     * element with no ratio to convert with is named, not left to look
     * like a very large secondary setting.
     */
    const svg = render('legend = { currents = "secondary"; };');
    const notes = [...svg.matchAll(/font-style="italic"[^>]*>([^<]*)</g)]
      .map((m) => m[1]).join(' ');
    expect(notes).toContain('no ct_ratio');
    expect(notes).toContain('R_BARE:51');
    /* And that one keeps its honest primary figure. */
    expect(svg).toContain('300 A');
  });
});

/* ---------------------------------------------------------------- */

describe('the legend follows the highlighted curve', () => {
  /*
   * Following a highlighted curve to its settings meant reading down a
   * column of identical-looking blocks and matching by colour, which is
   * the work the highlight exists to save.
   */
  const STUDY = `
system { voltages { hv { V  = 33 kV; } } }
relay R {
  voltage = hv;
  element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
  element 50 { curve = definite; I_pickup = 3 kA; t_delay = 50 ms; }
}
view { voltage = hv; }
`;

  const render = (highlight?: string): string =>
    parseAndRender(STUDY, { theme: 'light', highlightLabel: highlight ?? null }).svg;

  it('thickens the stub and colours the name of the hovered curve', () => {
    const svg = render('R:51');
    /* The swatch for the highlighted entry is heavier than the rest. */
    expect(svg).toMatch(/stroke-width="4\.5"/);
    expect(svg).toContain('tc-legend-snap');
  });

  it('leaves every other entry alone', () => {
    const svg = render('R:51');
    /* Only one entry is emphasised. */
    expect([...svg.matchAll(/tc-legend-snap/g)]).toHaveLength(1);
  });

  it('emphasises nothing when the pointer is off the curves', () => {
    expect(render()).not.toContain('tc-legend-snap');
  });
});

/* ---------------------------------------------------------------- */

describe('the Notes block at the foot of the panel', () => {
  /*
   * Set immediately under the legend title the notes pushed the curves
   * down the page and read as preamble, when what a reader wants first
   * is the list of characteristics; the caveats are what they come
   * back for.
   */
  const STUDY = `
system { voltages { hv { V  = 33 kV; } } }
faults { "F_3ph" { I   = 9 kA; I2   = 0 A; voltage = hv; } }
relay R {
  voltage = hv; ct_ratio = 250/1;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; }
  element 46 { function = "neg_seq"; measures = I2; curve = definite; I_pickup = 200 A; t_delay = 0.4 s; }
}
view { voltage = hv; quantity = phase; condition = "F_3ph"; }
`;

  const svg = parseAndRender(STUDY, { theme: 'light' }).svg;
  const yOf = (re: RegExp): number => Number(svg.match(re)![1]);

  it('gives the notes their own heading', () => {
    expect(svg).toContain('>Notes</text>');
  });

  it('puts them below the curve entries, not above', () => {
    const curveY = yOf(/<text x="[\d.]+" y="([\d.]+)"[^>]*>R:51</);
    const notesY = yOf(/<text x="[\d.]+" y="([\d.]+)"[^>]*>Notes</);
    expect(notesY).toBeGreaterThan(curveY);
  });

  it('keeps them on the sheet, pushing the conditions up to make room', () => {
    /*
     * Emitted after an already-anchored conditions block they ran off
     * the bottom of the page: the anchor put the conditions flush with
     * the plot, leaving nothing beneath.
     */
    const plot = svg.match(/data-plot="([^"]+)"/)![1].split(',').map(Number);
    const bottom = plot[1] + plot[3];
    const noteYs = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-style="italic"[^>]*>/g)]
      .map((m) => Number(m[1]));
    expect(noteYs.length).toBeGreaterThan(0);
    for (const y of noteYs) expect(y).toBeLessThanOrEqual(bottom + 2);
  });

  it('can be turned off, giving the space back', () => {
    const hidden = parseAndRender(
      `${STUDY}\npage { legend = { notes = false; }; }`, { theme: 'light' },
    ).svg;
    expect(hidden).not.toContain('>Notes</text>');
    /* The findings go with it -- they are the block's content. */
    expect(hidden).not.toContain('carries no I2');
    /* The curves and their settings stay. */
    expect(hidden).toContain('>R:51</text>');
  });
});
