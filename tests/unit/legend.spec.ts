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
system { voltages { hv { kV = 33; } lv { kV = 11; } } }
faults {
  "F_lv" { I_A = 6 kA; voltage = lv; }
  "F_hv" { I_A = 18 kA; voltage = hv; }
}
relay R_INC {
  voltage = hv;
  element 51 { curve = iec.si; I_pu = 720 A; tms = 0.3; }
}
relay R_FDR {
  voltage = lv;
  element 51 { curve = iec.vi; I_pu = 480 A; tms = 0.25; }
  element 50 { curve = definite; I_pu = 3.2 kA; t_delay = 50 ms; }
}
point "P" { I_A = 5 kA; t_s = 0.1 s; voltage = hv; label = "inrush"; }
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
system { voltages { hv { kV = 11; } } }
faults {
  "F_bus" { I_A = 9 kA; voltage = hv; description = "switchboard bus fault, three phase"; }
  "F_spur" { I_A = 2 kA; voltage = hv; }
}
relay R { voltage = hv; element 51 { curve = iec.si; I_pu = 400 A; tms = 0.2; } }
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
system { voltages { "HV" { kV = 33.0; } "LV" { kV = 0.48; } } }
faults {
  "RMU 33 kV 3ph max" { I_A = 31.37 kA; voltage = "HV"; description = "Max 3ph at 33 kV RMU-BESS"; }
  "RMU 33 kV 3ph min" { I_A = 16.33 kA; voltage = "HV"; description = "Min 3ph at 33 kV RMU-BESS"; }
  "RMU 33 kV 1ph max" { I_A = 2.95 kA; voltage = "HV"; description = "Max 1ph-earth at 33 kV RMU-BESS"; }
  "F_2ph_min_HV" { I_A = 390 A; voltage = "HV"; description = "Min 2ph fault seen by the relay"; }
  "F_ACB_inst_HV" { I_A = 65.5 A; voltage = "HV"; description = "ACB inst threshold referred to 33 kV"; }
  "F_INV_max" { I_A = 0.46 kA; voltage = "LV"; description = "Max 3ph at 0.48 kV inverter"; }
  "F_INV_min" { I_A = 0.45 kA; voltage = "LV"; description = "Min 3ph at 0.48 kV inverter"; }
}
relay R_RMU_850 {
  name = "BESS HV Relay (GE Multilin 850)"; maker = "GE Multilin"; model = "850";
  voltage = "HV"; ct_ratio = 250/1;
  element 51  { name = "Phase TOC (51)"; curve = iec.si; I_pu = 105 A; tms = 0.10; }
  element 51G { name = "Ground TOC (51G)"; curve = iec.si; I_pu = 20 A; tms = 0.15; }
  element 50G { name = "Ground IOC (50G)"; curve = definite; I_pu = 100 A; t_delay = 0 s; }
  element 50 {
    name = "Phase IOC (50)";
    stages {
      stage main  { curve = definite; I_pu = 147 A; t_delay = 0 s; }
      stage energ { curve = definite; I_pu = 255 A; t_delay = 0 s; }
    }
  }
  element 46 {
    name = "Negative Sequence IOC (46)";
    stages {
      stage main  { curve = definite; I_pu = 75 A; t_delay = 0.10 s; }
      stage energ { curve = definite; I_pu = 75 A; t_delay = 0.35 s; }
    }
  }
}
relay R_FDR {
  name = "33 kV BESS Feeder (SEL-751)"; voltage = "HV"; ct_ratio = 250/1;
  element 46 { name = "Neg Seq backup (46)"; curve = definite; I_pu = 75 A; t_delay = 0.45 s; }
}
point "TX_inrush" { I_A = 212 A; t_s = 0.12 s; voltage = "HV"; label = "BESS Tx inrush"; }
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
system { voltages { "HV" { kV = 33.0; } "LV" { kV = 0.48; } } }
faults {
  "F_INV_max" { I_A = 0.46 kA; voltage = "LV"; }
  "F_HV_max"  { I_A = 31.4 kA; voltage = "HV"; }
}
relay R { voltage = "HV"; element 51 { curve = iec.si; I_pu = 105 A; tms = 0.1; } }
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
system { voltages { hv { kV = 11; } } }
relay R { voltage = hv; element 50 { curve = definite; I_pu = 3 kA; t_delay = 0 s; } }
`, { theme: 'light' });

    const warning = result.diagnostics.find((d) => d.code === 'ZERO_DELAY_NOT_PLOTTABLE');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });
});
