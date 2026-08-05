/**
 * A description must belong to the entry it describes.
 *
 * Proximity is the strongest grouping cue a column of text has, and in
 * the Times and Faults sections it used to point the wrong way: an
 * entry's own note sat 16 px under its name and the *next* entry's name
 * sat 13 px under the note. A reader scanning the column pairs each
 * description with the requirement below it, which is the one it says
 * nothing about.
 *
 * The Curves and Points sections had always closed each entry with a
 * gap. This checks the rule everywhere rather than the numbers
 * anywhere: whatever the spacing is, the space *between* two entries
 * has to beat the space *inside* one.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { labelBoxes, type LabelBox } from './svg-digest.js';
import { sheetsOf } from './sheets.js';

const STUDY = `
system { voltages { "MV" { V = 11 kV; } } }
faults {
  "Board max" { I = 9 kA; type = three_phase; voltage = "MV"; description = "switchboard three-phase"; }
  "Board min" { I = 2 kA; type = two_phase; voltage = "MV"; description = "remote end of the feeder"; }
}
times {
  "Arc flash boundary" { t = 500 ms; description = "Above this, PPE category rises a level"; }
  "Grid code clearance" { t = 800 ms; description = "DNO connection agreement, 11 kV"; }
  "Transformer withstand" { t = 4 s; description = "ONAN 10 MVA, category II through-fault"; }
}
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = "MV"; current_min = 100 A; current_max = 30 kA;
       time_min = 20 ms; time_max = 20 s; }
`;

const render = (src = STUDY): string =>
  renderStudy(parse(src), { theme: 'light' });

/**
 * The legend's labels, top to bottom.
 *
 * Selected by layer. The first attempt at this test picked them out by
 * x-coordinate -- "text past 1000 px is the legend" -- and caught the
 * mirrored right-hand time scale, which is axis furniture that happens
 * to sit in the same column. `data-layer="legend"` is the renderer
 * saying what a thing *is*, which is the whole point of naming the
 * layers.
 */
const legendColumn = (svg: string): LabelBox[] =>
  labelBoxes(svg).filter((b) => b.layer === 'legend').sort((a, b) => a.y - b.y);

describe('the Times section', () => {
  it('puts each description under the name it describes', () => {
    const column = legendColumn(render());
    const index = (needle: string): number =>
      column.findIndex((b) => b.text.includes(needle));

    /* Name, then its own note, then the next name. */
    const name = index('Arc flash boundary');
    expect(name).toBeGreaterThan(-1);
    expect(column[name + 1].text).toContain('PPE category');
  });

  it('separates two entries by more than it separates a name from its note', () => {
    /*
     * Read off the drawn order rather than the declared one: the
     * section is sorted by time, so naming a "next" entry by hand
     * picks the wrong pair and the test measures a negative gap.
     */
    const column = legendColumn(render());
    const first = column.findIndex((b) => b.text.includes('Transformer withstand'));
    expect(first).toBeGreaterThan(-1);

    const name = column[first];
    const note = column[first + 1];
    const next = column[first + 2];
    expect(note.text).toContain('ONAN');
    expect(next.text).toContain('Grid code clearance');

    const withinEntry = note.y - name.y;
    const betweenEntries = next.y - note.y;

    expect(withinEntry).toBeGreaterThan(0);
    expect(betweenEntries).toBeGreaterThan(withinEntry);
  });

  it('does not run the next entry\'s swatch into the note above it', () => {
    const svg = render();
    const column = legendColumn(svg);
    const note = column.find((b) => b.text.includes('ONAN'))!;

    /* Legend swatches are the short rules in the gutter left of the
     * text. The one for the following entry must clear this note. */
    const legend = /<g data-layer="legend">([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? '';
    const swatches = [...legend.matchAll(/<line x1="[\d.]+" y1="([\d.]+)"/g)]
      .map((m) => Number(m[1]));
    const below = swatches.filter((y) => y > note.y).sort((a, b) => a - b)[0];
    expect(below).toBeDefined();
    expect(below - (note.y + note.h)).toBeGreaterThanOrEqual(4);
  });
});

describe('the Faults section', () => {
  it('separates two entries by more than one line', () => {
    const column = legendColumn(render());
    const a = column.find((b) => b.text.startsWith('Board max'))!;
    const b = column.find((x) => x.text.startsWith('Board min'))!;
    expect(Math.abs(b.y - a.y)).toBeGreaterThan(a.h + 4);
  });
});

describe('every legend entry, on every shipped example', () => {
  it('is never closer to its neighbour than its own lines are to each other', () => {
    /*
     * The general form of the same rule. Within a run of legend text
     * the smallest step is a line step and the largest is an entry
     * break, so the *set* of gaps down a column should never have a
     * break smaller than a line -- which is what an ungapped section
     * produces.
     */
    for (const file of readdirSync('examples').filter((f) => f.endsWith('.ptc'))) {
      const result = parse(readFileSync(`examples/${file}`, 'utf8'));
      for (const { name, view } of sheetsOf(result)) {
        const svg = renderStudy(result, { theme: 'light', view });
        const column = legendColumn(svg);
        for (let i = 1; i < column.length; i++) {
          const gap = column[i].y - column[i - 1].y;
          /* A wrapped continuation shares the entry; anything is legal
           * so long as lines never touch. */
          expect(gap, `${file} (${name}): "${column[i - 1].text}" -> "${column[i].text}"`)
            .toBeGreaterThanOrEqual(column[i - 1].h);
        }
      }
    }
  });
});
