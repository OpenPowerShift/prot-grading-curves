/**
 * How the legend's blocks are stacked.
 *
 * The conditions block used to be pinned to the foot of the plot,
 * which left a hand's width of empty gutter between the last curve and
 * it -- on a two-relay study, most of the column. The reader has to
 * look down an inch of nothing to find out what the vertical rules
 * mean, and a sheet with a short legend reads as though something
 * failed to draw.
 *
 * Anchoring bought alignment with nothing: the fault *rules* are
 * vertical and their names sit under the axis, so the block was not
 * lining up with anything it described.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const STUDY = `
system { voltages { "MV" { V = 11 kV; } } }
faults { "Board max" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
times { "Arc flash" { t = 500 ms; at_I = 3 kA; } }
page { legend = { comment = "Checked against issue D."; }; }
view { voltage = "MV"; }
`;

/** Each legend heading and the y it was drawn at, in document order. */
const headings = (svg: string): Array<{ text: string; y: number }> =>
  [...svg.matchAll(
    /<text x="[\d.]+" y="([\d.]+)"[^>]*font-weight="600"[^>]*>(Curves|Faults|Conditions|Times|Notes|Comment)</g,
  )].map((m) => ({ text: m[2], y: Number(m[1]) }));

const sheet = (source = STUDY): string =>
  renderStudy(process(source), { theme: 'light' });

describe('the legend blocks', () => {
  it('are all present', () => {
    const found = headings(sheet()).map((h) => h.text);
    expect(found).toContain('Curves');
    expect(found).toContain('Faults');
    expect(found).toContain('Times');
    expect(found).toContain('Comment');
  });

  it('follow one another down the column', () => {
    const found = headings(sheet());
    for (let i = 1; i < found.length; i++) {
      expect(found[i].y, `${found[i].text} follows ${found[i - 1].text}`)
        .toBeGreaterThan(found[i - 1].y);
    }
  });

  it('leave no chasm between the curves and the conditions', () => {
    /*
     * The reported symptom, as a number. Anchored, the gap on this
     * study was over five hundred pixels; flowing, it is the height of
     * the one curve entry above it.
     */
    const found = headings(sheet());
    const curves = found.find((h) => h.text === 'Curves')!;
    const faults = found.find((h) => h.text === 'Faults')!;
    expect(faults.y - curves.y).toBeLessThan(200);
  });

  it('keep Times below Faults, as the sheet reads', () => {
    const found = headings(sheet());
    const faults = found.find((h) => h.text === 'Faults')!;
    const times = found.find((h) => h.text === 'Times')!;
    expect(times.y).toBeGreaterThan(faults.y);
  });
});

describe('every shipped example', () => {
  it('keeps its legend on the sheet', async () => {
    /*
     * Flowing the blocks makes the legend taller at the top of the
     * column rather than reaching to the foot, so the check that
     * matters is that nothing now runs off the bottom.
     */
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync('examples').filter((f) => f.endsWith('.ptc'));
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const svg = renderStudy(
        process(readFileSync(`examples/${file}`, 'utf8')), { theme: 'light' });
      const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)![1]);
      const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*class="tc-legend[^"]*"/g)]
        .map((m) => Number(m[1]));
      const over = ys.filter((y) => y > height);
      expect(over, `${file} draws legend text below the sheet`).toEqual([]);
    }
  });
});
