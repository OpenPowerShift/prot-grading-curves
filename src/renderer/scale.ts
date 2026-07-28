/**
 * Logarithmic scale ~60 LOC.
 *
 * The CC plot works on log10 axes (current and time). Map a domain
 * `[xMin, xMax]` in true units to a pixel range `[pxMin, pxMax]`.
 *
 * The scale is "nice" in the sense that the domain snaps to
 * decades; `niceDomain()` adjusts a free input to its enclosing
 * decade so that the axis labels line up cleanly on integer powers.
 */

export class LogScale {
  readonly pxMin: number;
  readonly pxMax: number;
  readonly xMin: number;
  readonly xMax: number;

  constructor(xMin: number, xMax: number, pxMin: number, pxMax: number) {
    this.xMin = xMin; this.xMax = xMax;
    this.pxMin = pxMin; this.pxMax = pxMax;
  }

  toPx(x: number): number {
    if (x <= 0 || !Number.isFinite(x)) return NaN;
    const a = Math.log10(x) - Math.log10(this.xMin);
    const b = Math.log10(this.xMax) - Math.log10(this.xMin);
    return this.pxMin + (a / b) * (this.pxMax - this.pxMin);
  }

  toVal(px: number): number {
    const a = (px - this.pxMin) / (this.pxMax - this.pxMin);
    const b = Math.log10(this.xMax) - Math.log10(this.xMin);
    return Math.pow(10, Math.log10(this.xMin) + a * b);
  }

  static niceDomain(rawMin: number, rawMax: number): { min: number; max: number } {
    if (rawMin <= 0 || rawMax <= 0) return { min: 1e-2, max: 1e4 };
    const lMin = Math.floor(Math.log10(rawMin));
    const lMax = Math.ceil(Math.log10(rawMax));
    return { min: Math.pow(10, lMin), max: Math.pow(10, lMax) };
  }
}
