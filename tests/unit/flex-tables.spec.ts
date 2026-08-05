/**
 * Hand-entered time-current tables.
 *
 * A review reported that an unsorted `flex_points` table was accepted
 * and silently mis-evaluated -- `Infinity` where the table says 32 s.
 * That was wrong, and the first test here is the disproof: `buildStudy`
 * sorts every table by current before anything sees it, so a datasheet
 * printed highest-current-first can be typed in as it is read. The
 * report had reached `tTripFlex` directly with an unsorted array, which
 * is a state the pipeline never produces.
 *
 * Chasing it did turn up a real gap next door: a device carries up to
 * three tables and *none* of them was validated, so a fuse -- the thing
 * most likely to be copied off a datasheet -- could declare a repeated
 * current or a one-row band and validate clean.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';
import { tTripStage } from '../../src/semantics/curves.js';

const element = (points: string): string => `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; flex_points = [ ${points} ]; } }
view { voltage = "MV"; }
`;

const device = (body: string): string => `
system { voltages { "MV" { V = 11 kV; } } }
device "D" { ${body} }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = "MV"; }
`;

const codes = (src: string): string[] => parse(src).diagnostics.map((d) => d.code);

describe('row order', () => {
  const DESCENDING = '(5248, 0.5), (2624, 2), (1312, 8), (656, 32)';
  const ASCENDING = '(656, 32), (1312, 8), (2624, 2), (5248, 0.5)';

  it('is normalised, so a datasheet can be typed as it is printed', () => {
    expect(codes(element(DESCENDING))).not.toContain('FLEX_NOT_MONOTONE');
  });

  it('does not change a single operate time', () => {
    const stageOf = (src: string) =>
      parse(src).study!.relays.get('R')!.elements[0].stages[0];
    const down = stageOf(element(DESCENDING));
    const up = stageOf(element(ASCENDING));

    for (const I of [700, 1500, 3000, 5000]) {
      const t = tTripStage(down, I);
      expect(Number.isFinite(t), `descending table at ${I} A gave ${t}`).toBe(true);
      expect(t).toBeCloseTo(tTripStage(up, I), 9);
    }
  });
});

describe('a repeated current', () => {
  it('is refused on an element, being multi-valued', () => {
    expect(codes(element('(656, 32), (656, 8), (2624, 2)')))
      .toContain('FLEX_NOT_MONOTONE');
  });

  it('is refused on a fuse band, which used to go unchecked', () => {
    expect(codes(device('kind = "fuse"; '
      + 'min_melt = [(200, 10), (200, 4), (800, 0.14)]; '
      + 'total_clear = [(200, 16), (400, 2), (800, 0.26)];')))
      .toContain('FLEX_NOT_MONOTONE');
  });

  it('is allowed on a motor start, which is a vertical envelope', () => {
    /*
     * A direct-on-line start is a vertical line at the starting
     * current, held from the accelerating time down to nothing. It is
     * drawn for the relay to sit above, not read for a time, so it is
     * not multi-valued in any sense that matters. `examples/14` says
     * so deliberately, and an earlier cut of this check broke it.
     */
    expect(codes(device('kind = "motor_startup"; rating_I = 180 A; '
      + 'flex_points = [(1120, 9.0), (1120, 0.05)];')))
      .not.toContain('FLEX_NOT_MONOTONE');
  });
});

describe('a device table', () => {
  it('needs at least two rows, like an element\'s', () => {
    expect(codes(device('kind = "fuse"; '
      + 'min_melt = [(200, 10), (800, 0.14)]; '
      + 'total_clear = [(200, 16)];')))
      .toContain('FLEX_TOO_FEW_POINTS');
  });

  it('warns on a non-positive time', () => {
    expect(codes(device('kind = "cable"; flex_points = [(200, 10), (800, 0)];')))
      .toContain('FLEX_TIME_NOT_POSITIVE');
  });

  it('is clean when it is well formed', () => {
    expect(codes(device('kind = "fuse"; '
      + 'min_melt = [(200, 10), (400, 1.2), (800, 0.14)]; '
      + 'total_clear = [(200, 16), (400, 2), (800, 0.26)];')))
      .not.toContain('FLEX_NOT_MONOTONE');
  });
});

describe('every shipped example', () => {
  it('declares well-formed tables', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    for (const file of readdirSync('examples').filter((f) => f.endsWith('.ptc'))) {
      const found = codes(readFileSync(`examples/${file}`, 'utf8'))
        .filter((c) => c.startsWith('FLEX_'));
      expect(found, file).toEqual([]);
    }
  });
});
