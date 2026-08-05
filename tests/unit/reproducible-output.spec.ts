/**
 * The same study renders to the same bytes, on any machine.
 *
 * A drawing gets reissued and diffed, so a sheet that differs because
 * of whose laptop produced it makes the diff a liar. This was not
 * hypothetical: ECMAScript does not require `Math.pow`, `Math.log10`
 * or `**` to be correctly rounded, V8 changed `Math.pow` between Node
 * 22 and Node 24, and a decade-aligned axis domain came out as
 * `0.0001` on one and `0.00009999999999999999` on the other. The
 * committed baseline passed locally and failed in CI, which is how it
 * was found -- the suite alone could never have caught it, because a
 * suite only ever runs on one version at a time.
 *
 * Everything geometric already went through `toFixed(1)`. The leak was
 * the machine-readable attributes, which interpolated raw doubles at
 * their full seventeen digits. The rule these check is therefore:
 * no number reaches the output at a precision where the last bit could
 * disagree.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { sheetsOf } from './sheets.js';

const EXAMPLES = readdirSync('examples').filter((f) => f.endsWith('.ptc'));

/** Every numeric attribute value the renderer writes. */
const numericAttributes = (svg: string): Array<{ attr: string; value: string }> => {
  const out: Array<{ attr: string; value: string }> = [];
  for (const m of svg.matchAll(/\b([\w-]+)="([^"]*)"/g)) {
    const [, attr, raw] = m;
    for (const part of raw.split(/[\s,]+/)) {
      if (part === '' || !/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(part)) continue;
      out.push({ attr, value: part });
    }
  }
  return out;
};

/**
 * Digits that actually carry information.
 *
 * A double holds about seventeen; the last one or two are where two
 * implementations of `pow` disagree. Anything written with twelve or
 * more significant digits is carrying that noise into the file.
 */
const significantDigits = (s: string): number =>
  s.replace(/^-/, '').replace(/e[-+]?\d+$/i, '')
    .replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;

describe('every number written into a sheet', () => {
  it('is rounded short enough that two implementations agree', () => {
    const offenders: string[] = [];
    for (const file of EXAMPLES) {
      const result = parse(readFileSync(`examples/${file}`, 'utf8'));
      for (const { name, view } of sheetsOf(result)) {
        const svg = renderStudy(result, { theme: 'light', view });
        for (const { attr, value } of numericAttributes(svg)) {
          if (significantDigits(value) >= 12) {
            offenders.push(`${file} (${name}): ${attr}="${value}"`);
          }
        }
      }
    }
    expect(offenders.slice(0, 10)).toEqual([]);
  });
});

/** The next representable double above `x`, by bit pattern. */
function nextUlp(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

describe('the axis domain', () => {
  /*
   * The first version of this test asserted that `Math.pow(10, -4)`
   * and `0.0001` are different doubles. They are on Node 22 and are
   * not on Node 24 -- so the test failed on exactly the version whose
   * behaviour prompted it, which is a neat demonstration that you
   * cannot portably assert a platform's rounding.
   *
   * What can be asserted is the property the fix actually provides:
   * two doubles one bit apart -- the most any two implementations of
   * `pow` will differ by -- must be written identically. That holds
   * everywhere, and it is the guarantee the baseline depends on.
   */
  const written = (x: number): string => String(Number(x.toPrecision(10)));

  it.each([
    ['a decade boundary', 0.0001],
    ['the other end of the same axis', 31622.776601683792],
    ['a current domain bound', 5.623413251903491],
    ['a round number', 1000],
  ])('writes %s the same as its nearest neighbour', (_what, value) => {
    const neighbour = nextUlp(value);
    expect(neighbour, 'the neighbour must be a genuinely different double')
      .not.toBe(value);
    expect(String(neighbour)).not.toBe(String(value));
    expect(written(neighbour)).toBe(written(value));
  });
});

describe('rendering twice', () => {
  it('produces identical bytes', () => {
    /*
     * Weaker than the cross-version property but it costs nothing, and
     * it would catch a stray `Date.now()`, iteration over a `Set` built
     * from object identity, or anything else that made a sheet depend
     * on more than its source.
     */
    for (const file of EXAMPLES) {
      const result = parse(readFileSync(`examples/${file}`, 'utf8'));
      for (const { name, view } of sheetsOf(result)) {
        const once = renderStudy(result, { theme: 'light', view });
        const twice = renderStudy(result, { theme: 'light', view });
        expect(twice, `${file} (${name})`).toBe(once);
      }
    }
  });
});
