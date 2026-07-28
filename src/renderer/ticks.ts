/**
 * Sub-decade tick generator.
 *
 * At "normal" density, emit `1, 2, ..., 9` per decade between
 * `xMin` and `xMax`. At "sparse" density emit only the decade
 * boundaries. At "dense" density extra minor ticks per decade
 * (2, 5) are placed.
 */

export type TickDensity = 'sparse' | 'normal' | 'dense';

export interface Tick {
  value: number;
  major: boolean;
  label: string;
}

/**
 * Format a tick value to its SI-friendly axis label.
 *
 * Examples:
 *   time:   0.01 s, 0.1 s, 1 s, 10 s, 100 s
 *   current: 10 A, 100 A, 1 kA, 10 kA
 *
 * The unit IS included in the label (with a single space separator) so
 * the axis is unambiguous. Sub-decade ticks are not formatted here --
 * only decade boundary values are.
 */
export function formatSi(value: number, unit: 'A' | 's'): string {
  if (!Number.isFinite(value) || value <= 0) return '';

  const abs = Math.abs(value);

  if (unit === 's') {
    if (abs < 1e-3) return `${sig(value * 1e6)} \u00b5s`;
    if (abs < 1)    return `${sig(value * 1000)} ms`;
    /*
     * Seconds run to 1000 without a prefix. Protection charts are
     * conventionally drawn to 1000 s and engineers say "1000 s"; "1 ks"
     * is technically correct and reads as a typo on a TCC.
     */
    return `${sig(value)} s`;
  }

  // Amps
  if (abs < 1)    return `${sig(value * 1000)} mA`;
  if (abs < 1000) return `${sig(value)} A`;
  if (abs < 1e6)  return `${sig(value / 1000)} kA`;
  return `${sig(value / 1e6)} MA`;
}

/**
 * Three significant figures, without trailing noise.
 *
 * Fault currents arrive from unit conversion and voltage projection,
 * so a value like `833.3333333` is routine. Quoting it in full implies
 * a precision the short-circuit study does not have, and it clutters
 * an axis; three figures is what a protection engineer writes.
 */
function sig(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return trimZeros(Number(value.toFixed(decimals)));
}

/**
 * Format a sub-decade tick value (1, 2, ..., 9 of a decade). We avoid
 * a SI prefix here; just show the numeric multiplier.
 */
export function formatMinor(value: number, _unit: 'A' | 's'): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  // Show `2, 3, ...` style. Keep at most 1 fractional digit.
  const exp = Math.floor(Math.log10(value));
  const mantissa = value / Math.pow(10, exp);
  return trimZeros(mantissa);
}

function trimZeros(n: number): string {
  if (!Number.isFinite(n)) return '';
  let s = n.toFixed(3);
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

export function ticks(xMin: number, xMax: number, density: TickDensity): Tick[] {
  if (xMin <= 0 || xMax <= 0 || xMax <= xMin) return [];
  const lMin = Math.floor(Math.log10(xMin));
  const lMax = Math.ceil(Math.log10(xMax));
  const out: Tick[] = [];

  /*
   * A tick outside the domain has nowhere to go: the renderer maps it
   * to a pixel beyond the plot rectangle, so its gridline and label
   * land outside the axes. The decade loop deliberately starts below
   * `xMin` and ends above `xMax` (to catch the sub-decade ticks inside
   * the first and last partial decades), so each emitted tick has to
   * be range-checked rather than assumed in-range.
   */
  const inRange = (v: number): boolean => v >= xMin && v <= xMax;

  for (let d = lMin; d <= lMax; d++) {
    const decade = Math.pow(10, d);
    if (inRange(decade)) {
      out.push({
        value: decade,
        major: true,
        label: '',
        // unused: formatDecadeLabel replaced by axis-tick labels in svg.ts
      });
    }
    if (density === 'sparse') continue;
    for (const m of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const v = decade * m;
      if (v < xMin || v > xMax) continue;
      out.push({ value: v, major: false, label: '' });
      if (density === 'dense') {
        for (const sub of [1.5, 2.5, 3.5, 5, 7.5]) {
          const sv = decade * sub;
          if (sv < xMin || sv > xMax) continue;
          out.push({ value: sv, major: false, label: '' });
        }
      }
    }
  }

  /*
   * A tight zoom can sit entirely inside one decade, leaving no major
   * tick and so no axis label at all. Promote the domain endpoints so
   * the reader can always tell what they are looking at.
   */
  if (!out.some((t) => t.major)) {
    out.push({ value: xMin, major: true, label: '' });
    out.push({ value: xMax, major: true, label: '' });
  }

  return out.sort((a, b) => a.value - b.value);
}
