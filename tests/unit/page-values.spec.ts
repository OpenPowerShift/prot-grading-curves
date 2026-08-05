/**
 * A `page` value the tool cannot act on is refused, not defaulted.
 *
 * `legend { style = "insnide" }` parsed, validated, rendered, and
 * silently used the default. A cosmetic key is not a margin, but a
 * study can still be issued looking nothing like the house standard
 * its author thought they had applied, with nothing anywhere saying
 * why -- and unlike a wrong number, nobody re-derives a colour scheme
 * to check it.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';
import { FIELD_VALUES } from '@tc/help/help-data';

const SYS = 'system { voltages { "MV" { V = 11 kV; } } }\n';

const errors = (page: string) => {
  const r = process(`${SYS}page { ${page} }`);
  return [...r.parseErrors, ...r.diagnostics].filter((d) => d.severity === 'error');
};

const codes = (page: string): string[] => errors(page).map((d) => d.code);

describe('a misspelt value', () => {
  const CASES: Array<[string, string, string]> = [
    ['legend style', 'legend = { style = "insnide"; };', 'inside'],
    ['legend position', 'legend = { position = "top_rigth"; };', 'top_right'],
    ['legend swatch', 'legend = { swatch = "lines"; };', 'line'],
    ['curves palette', 'curves = { palette = "okabe_it"; };', 'okabe_ito'],
    ['points shape', 'points = { shape = "circel"; };', 'circle'],
    ['theme', 'theme = "drak";', 'dark'],
    ['orientation', 'orientation = "landscpae";', 'landscape'],
  ];

  for (const [name, page] of CASES) {
    it(`is refused: ${name}`, () => {
      expect(codes(page).length, page).toBeGreaterThan(0);
    });
  }

  for (const [name, page, meant] of CASES) {
    it(`suggests what was meant: ${name}`, () => {
      const message = errors(page).map((d) => d.message).join(' ');
      expect(message, page).toContain(meant);
    });
  }
});

describe('a correct value', () => {
  const GOOD = [
    'legend = { style = "inside"; };',
    'legend = { position = "top_right"; swatch = "circle"; currents = "both"; };',
    'curves = { palette = "okabe_ito"; };',
    'points = { shape = "cross"; };',
    'theme = "dark";',
    'orientation = "portrait";',
    'title = { text = "T"; align = "center"; };',
    'faults = { style = "dashed"; };',
    'times = { style = "dotted"; };',
    'leaders = { style = "arrow"; };',
  ];

  for (const page of GOOD) {
    it(`is accepted: ${page}`, () => {
      expect(codes(page)).toEqual([]);
    });
  }
});

describe('the accepted values and the offered values', () => {
  /*
   * One table with two readers cannot drift; two tables would. The
   * validator reads `FIELD_VALUES`, which is what `?` offers from.
   */
  it('are the same list', () => {
    for (const [key, choices] of Object.entries(FIELD_VALUES)) {
      if (!key.startsWith('legend.') && key !== 'palette' && key !== 'swatch') continue;
      for (const choice of choices) {
        const value = choice.value.replace(/^"|"$/g, '');
        const block = key.includes('.') ? key.split('.')[0] : 'legend';
        const field = key.includes('.') ? key.split('.')[1] : key;
        expect(codes(`${block} = { ${field} = "${value}"; };`), `${key} = ${value}`)
          .toEqual([]);
      }
    }
  });
});
