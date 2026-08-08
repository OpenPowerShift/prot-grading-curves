/**
 * Curves that coincide, pulled apart enough to be two lines.
 *
 * Four pairs in the shipped examples drew at exactly the same pixels.
 * The worst is sample 15: `Feeder A` and `Feeder B` are the same plant
 * with the same setting, so the sheet had one line and the legend two
 * entries, and a reader could not tell whether the second curve was
 * hidden, missing, or never drawn.
 *
 * A nudge is deliberate error, so what it must *not* do is most of
 * what is checked here: the report is untouched, a curve alone on the
 * sheet is drawn exactly where it belongs, the group's centre is the
 * truth, and the sheet says it happened.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { nudgeCoincident } from '@tc/renderer/nudge';

/** Two relays with identical settings, and one that differs. */
const TWINS = `
system { voltages { MV { V = 11 kV; } } }
faults { F { I = 6 kA; type = three_phase; voltage = MV; } }
relay R_A { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
relay R_B { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
relay R_C { voltage = MV; ct_ratio = 800/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 900 A; tms = 0.5; } }
view { voltage = MV; current_min = 100 A; current_max = 30 kA;
       time_min = 20 ms; time_max = 100 s; }
`;

const sheet = (source: string, page = ''): string =>
  renderStudy(parse(`${source}\n${page}`), { theme: 'light' });

/** Drawn paths, by legend label. */
const paths = (svg: string): Map<string, string> => new Map(
  [...svg.matchAll(/<path d="([^"]+)"[^>]*class="tc-curve"[^>]*data-curve="([^"]*)"/g)]
    .map((m) => [m[2]!, m[1]!] as const),
);

/** Every point of a path, in order. */
const points = (d: string): Array<{ x: number; y: number }> =>
  [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

describe('two curves at the same pixels', () => {
  it('are drawn as two lines', () => {
    const drawn = paths(sheet(TWINS));
    const a = drawn.get('R_A:51')!;
    const b = drawn.get('R_B:51')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('are separated by about the declared amount', () => {
    /*
     * Enough that the marks do not touch at the default 2 px stroke,
     * and no more: the displacement is error, and a large one would
     * mislead about the operate time.
     */
    const drawn = paths(sheet(TWINS));
    const a = points(drawn.get('R_A:51')!);
    const b = points(drawn.get('R_B:51')!);
    const mid = Math.floor(a.length / 2);
    const gap = Math.hypot(a[mid]!.x - b[mid]!.x, a[mid]!.y - b[mid]!.y);
    expect(gap).toBeGreaterThan(2);
    expect(gap).toBeLessThan(5);
  });

  it('keeps the truth at the centre of the group', () => {
    /*
     * Neither curve carries all the error. The midpoint of the pair is
     * where the characteristic actually is, so a reader measuring
     * between them reads the right time.
     */
    const plain = points(paths(sheet(TWINS, 'page { curves { nudge_px = 0; }; }')).get('R_A:51')!);
    const drawn = paths(sheet(TWINS));
    const a = points(drawn.get('R_A:51')!);
    const b = points(drawn.get('R_B:51')!);
    const mid = Math.floor(a.length / 2);
    expect((a[mid]!.y + b[mid]!.y) / 2).toBeCloseTo(plain[mid]!.y, 1);
    expect((a[mid]!.x + b[mid]!.x) / 2).toBeCloseTo(plain[mid]!.x, 1);
  });

  it('says so on the sheet, naming them', () => {
    const svg = sheet(TWINS);
    expect(svg).toMatch(/coincide/);
    expect(svg).toMatch(/3 px apart/);
    expect(svg).toContain('R_A:51');
  });
});

describe('a curve nothing else is near', () => {
  it('is drawn exactly where it belongs', () => {
    const off = paths(sheet(TWINS, 'page { curves { nudge_px = 0; }; }'));
    const on = paths(sheet(TWINS));
    expect(on.get('R_C:51')).toBe(off.get('R_C:51'));
  });
});

describe('switching it off', () => {
  it('reproduces the drawing exactly', () => {
    /*
     * The opt-out has to be a true opt-out: byte-identical, not
     * merely similar, or a study that turns it off is still getting a
     * different sheet from the one it would have had.
     */
    const a = sheet(TWINS, 'page { curves { nudge_px = 0; }; }');
    const b = sheet(TWINS, 'page { curves { nudge_px = 0; }; }');
    expect(a).toBe(b);
    const drawn = paths(a);
    expect(drawn.get('R_A:51')).toBe(drawn.get('R_B:51'));
    expect(a).not.toMatch(/coincide/);
  });

  it('can be turned off for one sheet', () => {
    const src = TWINS.replace('view { voltage = MV;', 'view { voltage = MV; nudge_px = 0;');
    const drawn = paths(sheet(src));
    expect(drawn.get('R_A:51')).toBe(drawn.get('R_B:51'));
  });

  it('takes a per-sheet figure over the page default', () => {
    const src = TWINS.replace('view { voltage = MV;', 'view { voltage = MV; nudge_px = 9;');
    const svg = sheet(src, 'page { curves { nudge_px = 3; }; }');
    expect(svg).toMatch(/9 px apart/);
  });
});

describe('the pickup tick', () => {
  it('stays at the true current, however the curves are moved', () => {
    /*
     * The one place a displaced riser could mislead: a reader
     * measuring a pickup off the sheet reads the drawn path, which has
     * moved sideways by half the separation.
     *
     * The tick below the axis is a separate mark from a separate
     * figure, and the nudge does not touch it -- so the sheet still
     * carries an exact statement of every pickup even where the risers
     * are drawn apart. Worth pinning: it makes the displacement
     * recoverable rather than merely small.
     */
    const ticks = (svg: string): string[] =>
      [...svg.matchAll(/<line x1="([\d.]+)" y1="[\d.]+" x2="\1" y2="[\d.]+" stroke="[^"]*" stroke-width="1.5"\/>/g)]
        .map((m) => m[1]!)
        .sort();

    const on = ticks(sheet(TWINS));
    const off = ticks(sheet(TWINS, 'page { curves { nudge_px = 0; }; }'));
    expect(on.length, 'the sheet should draw pickup ticks').toBeGreaterThan(0);
    expect(on).toEqual(off);
  });
});

describe('the numbers the study states', () => {
  it('are untouched, the displacement being a drawing device', () => {
    /*
     * The whole design rests on this. The report is computed from the
     * model and the model never moves.
     */
    const off = parse(`${TWINS}\npage { curves { nudge_px = 0; }; }`);
    const on = parse(TWINS);
    expect(JSON.stringify(on.reports)).toBe(JSON.stringify(off.reports));
  });
});

describe('the geometry, directly', () => {
  const line = (y: number): string =>
    `M100 ${y} L200 ${y} L300 ${y}`;

  it('moves a horizontal shelf vertically, which is its perpendicular', () => {
    /*
     * The case the reader meets as "two definite-time stages at the
     * same delay". No special case produces this -- perpendicular to
     * a horizontal run *is* vertical.
     */
    const { paths: out } = nudgeCoincident(
      [{ label: 'a', pathD: line(50) }, { label: 'b', pathD: line(50) }], 4);
    const a = points(out[0]!);
    const b = points(out[1]!);
    expect(a[1]!.x).toBeCloseTo(b[1]!.x, 3);
    expect(Math.abs(a[1]!.y - b[1]!.y)).toBeCloseTo(4, 1);
  });

  it('moves a vertical riser horizontally, likewise', () => {
    /* "two elements with the same pickup". */
    const riser = 'M100 50 L100 150 L100 250';
    const { paths: out } = nudgeCoincident(
      [{ label: 'a', pathD: riser }, { label: 'b', pathD: riser }], 4);
    const a = points(out[0]!);
    const b = points(out[1]!);
    expect(a[1]!.y).toBeCloseTo(b[1]!.y, 3);
    expect(Math.abs(a[1]!.x - b[1]!.x)).toBeCloseTo(4, 1);
  });

  it('spreads three evenly about the true position', () => {
    const { paths: out, notes } = nudgeCoincident(
      [0, 1, 2].map((i) => ({ label: `c${i}`, pathD: line(50) })), 4);
    const ys = out.map((d) => points(d)[1]!.y).sort((p, q) => p - q);
    expect(ys[1]).toBeCloseTo(50, 1);
    expect(ys[0]).toBeCloseTo(46, 1);
    expect(ys[2]).toBeCloseTo(54, 1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/c0, c1 and c2 coincide/);
  });

  it('leaves curves that are genuinely apart alone', () => {
    const { paths: out, notes } = nudgeCoincident(
      [{ label: 'a', pathD: line(50) }, { label: 'b', pathD: line(300) }], 4);
    expect(out[0]).toBe(line(50));
    expect(out[1]).toBe(line(300));
    expect(notes).toEqual([]);
  });

  it('does nothing at all when the separation is zero', () => {
    const { paths: out, notes } = nudgeCoincident(
      [{ label: 'a', pathD: line(50) }, { label: 'b', pathD: line(50) }], 0);
    expect(out).toEqual([line(50), line(50)]);
    expect(notes).toEqual([]);
  });

  it('displaces only where the curves are actually together', () => {
    /*
     * One path follows the other for its first half and departs. The
     * far end is unambiguous and must be drawn true; only the shared
     * stretch is moved, and the offset eases out between the two
     * rather than stepping.
     *
     * Sampled at the density a real curve is -- the ramp spans a few
     * samples, which is nothing on a 160-point characteristic and the
     * whole path if there are five.
     */
    const N = 40;
    const together = Array.from({ length: N },
      (_, i) => `${i === 0 ? 'M' : 'L'}${i * 10} 100`).join(' ');
    const parting = Array.from({ length: N },
      (_, i) => `${i === 0 ? 'M' : 'L'}${i * 10} ${i < N / 2 ? 100 : 100 + (i - N / 2) * 40}`)
      .join(' ');
    const { paths: out } = nudgeCoincident(
      [{ label: 'a', pathD: together }, { label: 'b', pathD: parting }], 6);
    const b = points(out[1]!);

    /* Moved where they lie on top of one another... */
    expect(Math.abs(b[0]!.y - 100)).toBeGreaterThan(0.5);
    /* ...and exactly true well after they have parted. */
    expect(b[N - 1]!.x).toBeCloseTo((N - 1) * 10, 3);
    expect(b[N - 1]!.y).toBeCloseTo(100 + (N - 1 - N / 2) * 40, 3);
  });
});

describe('the shipped examples', () => {
  it('draw no two curves at identical pixels', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const same: string[] = [];
    for (const file of readdirSync('examples').filter((f) => f.endsWith('.ptc'))) {
      const r = parse(readFileSync(`examples/${file}`, 'utf8'));
      const views = r.study?.views.length ? r.study.views : [undefined];
      for (const view of views) {
        const drawn = [...paths(renderStudy(r, { theme: 'light', view: view as never }))];
        for (let i = 0; i < drawn.length; i++) {
          for (let j = i + 1; j < drawn.length; j++) {
            if (drawn[i]![1] === drawn[j]![1]) {
              same.push(`${file}: ${drawn[i]![0]} == ${drawn[j]![0]}`);
            }
          }
        }
      }
    }
    expect(same).toEqual([]);
  });
});
