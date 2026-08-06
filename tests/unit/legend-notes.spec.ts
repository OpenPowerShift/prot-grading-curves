/**
 * What gives way when the legend runs out of room.
 *
 * The notes and the curve settings were tied to one dial. Notes were
 * drawn at any density above `minimal`, and the only way to buy space
 * was to drop a density -- which also dropped every relay's settings.
 * So a sheet with a page of notes and eight curves showed no settings
 * at all, and turning the notes *off* brought them back.
 *
 * Worse, it lost the notes as well: the fallback landed on `minimal`,
 * which draws neither, having spent the space that forced it there.
 * The reader paid for the notes twice and got nothing.
 *
 * What a curve is set to is the substance of the sheet. The notes are
 * the tool's account of what it could not draw, and a count of them
 * plus a pointer to the report carries that in one line.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

/**
 * A study with `curves` drawn and `suppressed` sequence elements that
 * the phase axis cannot place -- each of which the sheet accounts for
 * in a note. Names are long on purpose: the legend wraps, and wrapping
 * is what makes it tall enough to matter.
 */
const study = (curves: number, suppressed: number, legend = ''): string => `
system { voltages { HV { V = 33 kV; } } }
${Array.from({ length: curves }, (_, i) => `
relay R_${i} { name = "Distribution feeder number ${i} protection panel";
  maker = "ABB"; model = "Relion REF615 feeder terminal";
  voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = ${300 + i * 20} A; tms = ${(0.1 + i * 0.01).toFixed(2)}; } }`).join('')}
${Array.from({ length: suppressed }, (_, i) => `
relay S_${i} { name = "Negative sequence unit number ${i} on the board";
  voltage = HV; ct_ratio = 400/5;
  element 46 { function = neg_seq; measures = I2; curve = definite;
               I_pickup = ${100 + i} A; t_delay = 0.5 s; } }`).join('')}
${legend ? `page { legend = { ${legend} }; }` : ''}
view { quantity = phase; voltage = HV;
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;

const sheetOf = (src: string): string => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  return renderStudy(r, { theme: 'light' });
};

/** Legend lines that state how an element is set. */
const settingLines = (svg: string): number =>
  [...svg.matchAll(/class="tc-legend-muted"[^>]*>([^<]*)</g)]
    .map((m) => m[1])
    .filter((t) => /IEC |Definite|TMS |delay /.test(t))
    .length;

const hasFullNotes = (svg: string): boolean => svg.includes('>Notes<');
const notesOmitted = (svg: string): number | null => {
  const m = svg.match(/(\d+) notes? omitted/);
  return m ? Number(m[1]) : null;
};

describe('a legend with more notes than room', () => {
  /* Eight curves and twenty notes: comfortably over the column. */
  const TIGHT = study(8, 20);

  it('keeps the settings', () => {
    expect(settingLines(sheetOf(TIGHT))).toBe(8);
  });

  it('keeps them whether or not the notes were asked for', () => {
    /*
     * The reported symptom, and the thing that made it obvious
     * something was inverted: turning the notes *off* was the way to
     * get the settings back.
     */
    expect(settingLines(sheetOf(study(8, 20, 'notes = true;'))))
      .toBe(settingLines(sheetOf(study(8, 20, 'notes = false;'))));
  });

  it('says how many notes it could not fit', () => {
    /*
     * Not silently. These notes exist because a sheet that quietly
     * drops something is the failure the whole feature guards
     * against; dropping the notes quietly would be the same failure
     * one level up.
     */
    expect(notesOmitted(sheetOf(TIGHT))).toBe(20);
  });

  it('does not also lose the notes it made room for', () => {
    /*
     * The old fallback landed on `minimal`, which draws neither the
     * settings nor the notes -- having spent the space that forced it
     * there.
     */
    const svg = sheetOf(TIGHT);
    expect(hasFullNotes(svg) || notesOmitted(svg) !== null).toBe(true);
  });
});

describe('a legend with room for everything', () => {
  const ROOMY = study(2, 3);

  it('writes the notes out in full', () => {
    expect(hasFullNotes(sheetOf(ROOMY))).toBe(true);
    expect(notesOmitted(sheetOf(ROOMY))).toBeNull();
  });

  it('keeps the settings too', () => {
    expect(settingLines(sheetOf(ROOMY))).toBe(2);
  });
});

describe('notes turned off', () => {
  it('leaves no trace at all, which is what the author asked for', () => {
    /*
     * The one case where they vanish without a word. `notes = false`
     * is a reader who does not want the workings on a sheet being
     * issued, and a line saying "20 notes omitted" would be the
     * workings.
     */
    const svg = sheetOf(study(8, 20, 'notes = false;'));
    expect(hasFullNotes(svg)).toBe(false);
    expect(notesOmitted(svg)).toBeNull();
  });
});
