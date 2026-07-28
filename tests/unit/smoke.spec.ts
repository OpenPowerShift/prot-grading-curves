/**
 * Smoke test -- parse the playground starter and ensure the renderer
 * produces a non-empty <svg> string. Also check that the doc round-
 * trips without obtaining any *error*-severity diagnostics.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { renderSvg } from '@tc/renderer';

const STARTER = `
meta {
    project  = "Riverside 33/11";
    engineer = "A. Cooper";
}

system {
    voltages {
        "HV" { kV = 33.0; }
        "LV" { kV = 11.0; }
    }
    frequency_Hz = 50;
}

faults {
    "F1_lv_max"  { I_A = 6400 A; voltage = "LV"; }
}

relay R_FDR_110 {
    voltage  = "LV";
    ct_ratio = 600/5;
    element 51 {
        function = "phase_oc";
        curve    = iec.si;
        I_pu     = 480 A;
        tms      = 0.30;
    }
}

page {
    size  = "A4";
    theme = "light";
    title = "Smoke test";
}
`;

describe('parser + renderer smoke', () => {
  it('parses the starter into a document with no errors', () => {
    const r = parse(STARTER);
    expect(r.document).toBeDefined();
    const hardErrors = r.errors.filter((e) => e.severity === 'error');
    if (hardErrors.length > 0) {
      console.log(hardErrors);
    }
    expect(hardErrors).toHaveLength(0);
  });

  it('renders a non-empty SVG', () => {
    const r = parse(STARTER);
    const svg = renderSvg(r.document, {
      page: null, system: null, faults: null,
      width: 800, height: 500,
    });
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('</svg>');
    // at least one curve <path>
    expect(svg).toContain('<path');
  });
});
