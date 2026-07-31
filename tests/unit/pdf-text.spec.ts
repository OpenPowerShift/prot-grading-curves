/**
 * Text an exported PDF can actually print.
 *
 * `jspdf`'s standard-14 fonts are WinAnsi-encoded. A character
 * outside that encoding does not fail loudly -- it comes out as
 * mojibake on the printed sheet, which is only ever noticed by
 * looking at the PDF. A U+2192 arrow has now escaped into the sheet
 * twice, so the check covers the whole rendered document rather than
 * one legend section, and the export transliterates whatever still
 * gets through.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender } from '@tc/index';
import { toPdfSafeText } from '@tc/export/export-pdf';

/** Characters WinAnsi adds above Latin-1, which print correctly. */
const WIN_ANSI_EXTRAS = new Set([
  '€', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž',
  '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', 'ž', 'Ÿ',
]);

/** Every character the SVG would print, with its context. */
function unprintable(svg: string): Array<{ ch: string; text: string }> {
  const bad: Array<{ ch: string; text: string }> = [];
  for (const m of svg.matchAll(/>([^<>]+)</g)) {
    const text = m[1];
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code <= 0xff || WIN_ANSI_EXTRAS.has(ch)) continue;
      bad.push({ ch, text });
    }
  }
  return bad;
}

/** A study exercising every legend section a sheet can carry. */
const STUDY = `
meta { project = "Broadsound Solar Farm & BESS"; }
system { voltages { "HV" { V  = 33.0 kV; } "LV" { V  = 0.48 kV; } } }
faults {
  "F_INV_max" { I   = 0.46 kA; voltage = "LV"; description = "Max 3ph at the inverter"; }
  "F_HV_max"  { I   = 31.4 kA; voltage = "HV"; }
}
device "spur_fuse" {
  kind = fuse; maker = "Mersen"; model = "100T"; rating_I = 100 A;
  min_melt    = [(200 A, 10 s), (2 kA, 0.05 s)];
  total_clear = [(200 A, 20 s), (2 kA, 0.10 s)];
}
relay R {
  voltage = "HV"; ct_ratio = 250/1;
  name = "BESS HV Relay (GE Multilin 850)";
  element 51 { name = "Phase TOC (51)"; curve = iec.si; I_pickup = 105 A; tms = 0.1; }
}
point "P" { I   = 212 A; t   = 0.12 s; voltage = "HV"; label = "Inrush"; coords = true; }
view { voltage = "HV"; }
`;

describe('rendered sheets stay inside the PDF encoding', () => {
  it('prints nothing a core font cannot encode', () => {
    const svg = parseAndRender(STUDY, { theme: 'light' }).svg;
    const bad = unprintable(svg);
    expect(bad, JSON.stringify(bad.slice(0, 5))).toHaveLength(0);
  });

  it('shows the cross-voltage projection without an arrow glyph', () => {
    const svg = parseAndRender(STUDY, { theme: 'light' }).svg;
    /* The projection note is present, written in ASCII. */
    expect(svg).toContain('-&gt;');
    expect(svg).not.toContain('→');
  });
});

describe('the export transliterates whatever still gets through', () => {
  it('turns an arrow into ASCII rather than mojibake', () => {
    expect(toPdfSafeText('<text>a → b</text>')).toBe('<text>a -> b</text>');
  });

  it('handles the comparison signs an engineer might type', () => {
    expect(toPdfSafeText('≤ ≥ ≠')).toBe('<= >= !=');
  });

  it('spells out symbols that have no ASCII shape', () => {
    expect(toPdfSafeText('R = 5 Ω')).toBe('R = 5 ohm');
  });

  it('leaves ordinary prose, and the typography WinAnsi covers, alone', () => {
    const prose = 'Northgate — 11 kV · "quoted" … café ±2%';
    expect(toPdfSafeText(prose)).toBe(prose);
  });

  it('falls back to a question mark for anything unmapped', () => {
    /* A CJK character has no ASCII rendering; better a visible
     * placeholder than a dropped or corrupted glyph. */
    expect(toPdfSafeText('中')).toBe('?');
  });
});
