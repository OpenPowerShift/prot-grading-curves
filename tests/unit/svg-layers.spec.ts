/**
 * The sheet is a drawing, and says so.
 *
 * Every drawn element sits inside a `<g data-layer="...">` naming what
 * it is. Before this the output was one flat run of shapes whose only
 * structure was the order they were written in, which meant anything
 * downstream -- a viewer wanting to dim the furniture, an export
 * dropping the annotations, a test counting what a sheet contains --
 * had to pattern-match on class names and hope.
 *
 * The checks here are about structure, not position. What guards
 * position is `visual-baseline.spec.ts`, whose digest deliberately
 * ignores grouping so that adding a layer shows up as a changed layer
 * name and not as every element moving.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy, SVG_LAYERS } from '@tc/index';
import { digestEntries } from './svg-digest.js';
import { sheetsOf } from './sheets.js';

const EXAMPLES = readdirSync('examples').filter((f) => f.endsWith('.ptc'));

/** Every sheet of every shipped example, rendered once. */
const allSheets = (): Array<{ name: string; svg: string }> => {
  const out: Array<{ name: string; svg: string }> = [];
  for (const file of EXAMPLES) {
    const result = parse(readFileSync(`examples/${file}`, 'utf8'));
    for (const { name, view } of sheetsOf(result)) {
      out.push({ name: `${file} (${name})`, svg: renderStudy(result, { theme: 'light', view }) });
    }
  }
  return out;
};

const SHEETS = allSheets();

/** A sheet drawn from a study with errors, which the CLI stamps. */
const stamped = (): string => renderStudy(
  parse(readFileSync('examples/00-minimal.ptc', 'utf8')),
  { theme: 'light', invalidErrors: 3 },
);

describe('the groups', () => {
  it('open and close in balance', () => {
    for (const { name, svg } of SHEETS) {
      const opens = (svg.match(/<g\b(?![^>]*\/>)/g) ?? []).length;
      const closes = (svg.match(/<\/g>/g) ?? []).length;
      expect(opens, name).toBe(closes);
    }
  });

  it('never leaves an empty layer in the output', () => {
    /*
     * A phase that drew nothing emits no group at all, so a study with
     * no faults has no `faults` layer rather than an empty one. That
     * is what lets `[data-layer]` be counted to find out what a sheet
     * actually contains.
     */
    for (const { name, svg } of SHEETS) {
      expect(svg, name).not.toMatch(/<g data-layer="[^"]*"><\/g>/);
      expect(svg, name).not.toMatch(/<g data-layer="[^"]*">\s*<\/g>/);
    }
  });

  it('uses only names from the declared set', () => {
    const declared = new Set<string>(SVG_LAYERS);
    for (const { name, svg } of SHEETS) {
      for (const m of svg.matchAll(/<g data-layer="([^"]*)"/g)) {
        expect(declared, `${name}: unknown layer "${m[1]}"`).toContain(m[1]);
      }
    }
  });

  it('declares no name the renderer never emits', () => {
    /*
     * The other direction. A layer listed in the contract but never
     * drawn is a control a viewer would offer for something that does
     * not exist.
     *
     * The shipped examples are all valid, so none of them stamps a
     * sheet. Rather than exempt `invalid` -- which would leave the one
     * layer that matters most unchecked -- a broken study is rendered
     * here on purpose.
     */
    const seen = new Set<string>();
    for (const { svg } of SHEETS) {
      for (const m of svg.matchAll(/<g data-layer="([^"]*)"/g)) seen.add(m[1]);
    }
    for (const m of stamped().matchAll(/<g data-layer="([^"]*)"/g)) seen.add(m[1]);
    expect([...SVG_LAYERS].filter((l) => !seen.has(l))).toEqual([]);
  });
});

describe('the specification', () => {
  it('lists exactly the layers the renderer draws', () => {
    /*
     * The spec carries the table a consumer reads to know what it can
     * select. A layer added to the code and not to the table is a
     * feature nobody can find; one in the table and not the code is a
     * promise nothing keeps.
     */
    const spec = readFileSync('spec/sections/semantics.adoc', 'utf8');
    const section = /=== Semantic layers in the SVG([\s\S]*?)\n== /.exec(spec)?.[1] ?? '';
    expect(section).not.toBe('');

    const tabled = [...section.matchAll(/^\| `([a-z-]+)`\s+\|/gm)]
      .map((m) => m[1])
      /* The header row names the attribute, not a layer. */
      .filter((n) => n !== 'data-layer');
    expect(tabled.sort()).toEqual([...SVG_LAYERS].sort());
  });
});

describe('every drawn element', () => {
  it('belongs to a layer', () => {
    /*
     * The one exception is the clip-path definition, which is a `<defs>`
     * entry rather than a mark on the paper.
     */
    for (const { name, svg } of SHEETS) {
      const defs = /<defs>.*?<\/defs>/gs;
      const drawn = digestEntries(svg.replace(defs, ''));
      const orphans = drawn.filter((e) => e.layer === '-');
      expect(orphans.map((o) => o.line), name).toEqual([]);
    }
  });
});

describe('a layer', () => {
  const svg = renderStudy(
    parse(readFileSync('examples/13-clearance-times.ptc', 'utf8')),
    { theme: 'light' },
  );

  it('holds what its name says', () => {
    const inLayer = (want: string): string[] =>
      digestEntries(svg).filter((e) => e.layer === want).map((e) => e.line);

    expect(inLayer('curves').every((l) => l.startsWith('path'))).toBe(true);
    expect(inLayer('times').every((l) => l.includes('class=tc-time'))).toBe(true);
    expect(inLayer('grid').every((l) => l.includes('tc-grid'))).toBe(true);
    expect(inLayer('fault-band').some((l) => l.includes('tc-fault-label'))).toBe(true);
  });

  it('can be hidden by a single selector', () => {
    /*
     * The point of the exercise. Removing one group takes the whole
     * phase with it and leaves everything else where it was.
     */
    const withoutGrid = svg.replace(/<g data-layer="grid">[\s\S]*?<\/g>/g, '');
    /*
     * The *elements*, not the stylesheet: `.tc-grid-major` keeps its
     * rule in `<style>` whether or not anything wears the class, and
     * asserting on the bare string passes for the wrong reason.
     */
    expect(withoutGrid).not.toMatch(/class="tc-grid-major"/);
    expect(withoutGrid).toMatch(/class="tc-curve"/);
    expect(withoutGrid).toMatch(/class="tc-time"/);
  });
});
