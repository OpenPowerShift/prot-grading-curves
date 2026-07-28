/**
 * Axis tick generation.
 *
 * The regression these guard: ticks outside the plotted domain get
 * mapped to pixels beyond the axes, so their gridlines and labels are
 * drawn outside the plot box. That was visible as a stray vertical
 * line and a stray axis label whenever a zoom left a partial decade.
 */

import { describe, expect, it } from 'vitest';
import { ticks } from '@tc/renderer/ticks';

describe('ticks stay inside the domain', () => {
  it('emits no tick below xMin or above xMax', () => {
    for (const [lo, hi] of [[800, 8000], [10, 100000], [1200, 4500], [0.02, 700]]) {
      for (const density of ['sparse', 'normal', 'dense'] as const) {
        for (const t of ticks(lo, hi, density)) {
          expect(t.value, `${density} tick ${t.value} outside [${lo}, ${hi}]`)
            .toBeGreaterThanOrEqual(lo);
          expect(t.value).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('drops the decades a partial-decade zoom leaves outside', () => {
    // 800..8000 spans decades 1e2, 1e3, 1e4; only 1e3 is inside.
    const majors = ticks(800, 8000, 'normal').filter((t) => t.major).map((t) => t.value);
    expect(majors).toEqual([1000]);
  });

  it('still labels an axis that contains no decade at all', () => {
    // A tight zoom inside one decade would otherwise have no labels.
    const majors = ticks(1200, 4500, 'normal').filter((t) => t.major).map((t) => t.value);
    expect(majors).toEqual([1200, 4500]);
  });

  it('returns ticks in ascending order', () => {
    const values = ticks(10, 100000, 'normal').map((t) => t.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('keeps every decade of a full-decade domain', () => {
    const majors = ticks(10, 10000, 'normal').filter((t) => t.major).map((t) => t.value);
    expect(majors).toEqual([10, 100, 1000, 10000]);
  });
});
