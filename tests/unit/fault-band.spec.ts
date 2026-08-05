/**
 * The band of fault names under the axis.
 *
 * Three things: the current is printed beside the name because it is
 * the figure the rule is drawn for; the packer measures what it will
 * actually draw, or the rows overlap; and the band sits close under
 * the axis rather than a centimetre below it.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const SYS = 'system { voltages { "MV" { V = 11 kV; } } }\n';
const RELAY = `relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }`;

const sheet = (faults: string, page = ''): string =>
  renderStudy(process(`${SYS}faults { ${faults} }\n${RELAY}\n${page}
    view { voltage = "MV"; current_min = 500 A; current_max = 8 kA; }`), { theme: 'light' });

interface Label { x: number; y: number; text: string }

const labels = (svg: string): Label[] =>
  [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*class="tc-fault-label"[^>]*>([^<]*)</g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));

const rowCount = (svg: string): number => new Set(labels(svg).map((l) => l.y)).size;

/** Bottom edge of the plot, from the sheet's own data. */
const plotBottom = (svg: string): number => {
  const m = /data-plot="[\d.]+,([\d.]+),[\d.]+,([\d.]+)"/.exec(svg)!;
  return Number(m[1]) + Number(m[2]);
};

const TWO = '"Fault A" { I = 2.0 kA; type = three_phase; voltage = "MV"; } '
  + '"Fault B" { I = 2.8 kA; type = three_phase; voltage = "MV"; }';

describe('the current beside the name', () => {
  it('is printed by default', () => {
    expect(labels(sheet(TWO)).map((l) => l.text).join(' ')).toMatch(/Fault A · 2 kA/);
  });

  it('can be turned off', () => {
    const off = sheet(TWO, 'page { faults = { currents = false; }; }');
    expect(labels(off).map((l) => l.text)).toContain('Fault A');
    expect(labels(off).map((l) => l.text).join(' ')).not.toMatch(/·/);
  });

  it('leaves the names alone when it is off', () => {
    const off = sheet(TWO, 'page { faults = { currents = false; }; }');
    expect(labels(off)).toHaveLength(2);
  });

  it('is independent of turning the labels off entirely', () => {
    const none = sheet(TWO, 'page { faults = { labels = false; }; }');
    expect(labels(none)).toHaveLength(0);
  });
});

describe('the packer', () => {
  it('measures the caption it will draw, not the name alone', () => {
    /*
     * The rows are chosen by width. Measuring `name` while drawing
     * `name · current` under-measures every label by the width of its
     * own figure, and the rows overlap.
     *
     * At this spacing the bare names fit one row and the captions do
     * not, so the difference is visible in the row count.
     */
    expect(rowCount(sheet(TWO))).toBe(2);
    expect(rowCount(sheet(TWO, 'page { faults = { currents = false; }; }'))).toBe(1);
  });

  it('leaves no two captions overlapping on a row', () => {
    const CROWDED = '"Board max" { I = 6.2 kA; type = three_phase; voltage = "MV"; } '
      + '"Board min" { I = 5.6 kA; type = two_phase; voltage = "MV"; } '
      + '"Remote"    { I = 5.1 kA; type = three_phase; voltage = "MV"; }';
    const byRow = new Map<number, Label[]>();
    for (const l of labels(sheet(CROWDED))) {
      byRow.set(l.y, [...(byRow.get(l.y) ?? []), l]);
    }
    for (const [y, row] of byRow) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const endOfPrevious = row[i - 1].x + row[i - 1].text.length * 11 * 0.6;
        expect(endOfPrevious, `row ${y}: "${row[i - 1].text}" runs into "${row[i].text}"`)
          .toBeLessThanOrEqual(row[i].x);
      }
    }
  });
});

describe('where the band sits', () => {
  /** Baseline of the lowest x-axis tick label, below the plot. */
  const lowestAxisLabel = (svg: string): number => {
    const bottom = plotBottom(svg);
    const ys = [...svg.matchAll(
      /<text x="[\d.]+" y="([\d.]+)"[^>]*class="tc-current-axis"[^>]*>/g,
    )].map((m) => Number(m[1])).filter((y) => y > bottom);
    expect(ys.length, 'the axis is labelled below the plot').toBeGreaterThan(0);
    return Math.max(...ys);
  };

  it('is close under the axis', () => {
    /* It was 44 px down -- a leader most of a centimetre long to a
     * name that could as easily have touched the rule. */
    const svg = sheet(TWO);
    const first = Math.min(...labels(svg).map((l) => l.y));
    expect(first - plotBottom(svg)).toBeLessThanOrEqual(32);
  });

  it('clears the axis scale rather than printing over it', () => {
    /*
     * Moving the band up to 22 put it two pixels *above* the tick
     * labels, which sit at 20 -- so the fault names printed through
     * the current scale. The offset is derived from that row now
     * rather than guessed against it.
     */
    const svg = sheet(TWO);
    const first = Math.min(...labels(svg).map((l) => l.y));
    expect(first).toBeGreaterThan(lowestAxisLabel(svg));
  });

  it('clears it on every shipped example, on every sheet', async () => {
    /*
     * A sheet in secondary amps draws a second row of axis labels, so
     * a clearance that holds on the default study does not
     * necessarily hold on all of them -- which is how this was missed.
     */
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync('examples').filter((f) => f.endsWith('.ptc'));
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const result = process(readFileSync(`examples/${file}`, 'utf8'));
      const views = result.study?.views.length ? result.study.views : [undefined];
      for (const view of views) {
        const svg = renderStudy(result, { theme: 'light', view });
        const drawn = labels(svg);
        if (drawn.length === 0) continue;
        const first = Math.min(...drawn.map((l) => l.y));
        expect(first, `${file}${view ? ` (${view.name})` : ''}`)
          .toBeGreaterThan(lowestAxisLabel(svg));
      }
    }
  });
});
