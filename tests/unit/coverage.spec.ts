/**
 * Every advertised key and value is demonstrated somewhere.
 *
 * The playground offers a vocabulary through `?`; the spec and guide
 * describe it. Nothing kept those three in step with each other, and an
 * audit found the drift: keys named in the spec that the parser had
 * renamed, values offered in a block where they were hard errors, a
 * field completions still suggested a release after it was removed, and
 * three `page` sub-blocks that were parsed, validated, documented and
 * read by nothing at all.
 *
 * An example is the only one of the four that cannot lie. It is
 * processed on every run, so a key that stops working stops the build.
 * These tests keep the offered vocabulary and the worked examples
 * pinned together: add a key to the completion tables without using it
 * anywhere, and this fails until you show what it is for.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_FIELDS, FIELD_VALUES, TOP_BLOCK_KEYWORDS } from '@tc/help/help-data';
import { process } from '@tc/index';

const repoRoot = (): string =>
  (globalThis as { process?: { cwd(): string } }).process!.cwd();

const exampleDir = () => join(repoRoot(), 'examples');
const exampleFiles = () => readdirSync(exampleDir()).filter((f) => f.endsWith('.tc'));

/**
 * Example sources with comments stripped.
 *
 * A key named in a comment is documentation, not use; counting it would
 * let this test pass on a file that only *talks* about a feature.
 */
const exampleCode = (): string =>
  exampleFiles()
    .map((f) => readFileSync(join(exampleDir(), f), 'utf8'))
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');

describe('the offered vocabulary is demonstrated', () => {
  const code = exampleCode();

  /** Used as a key: `k =`, `k {`, or `k <name> {` for a named block. */
  const usesKey = (k: string): boolean =>
    new RegExp(`(^|[{;\\s])${k}\\s*=`, 'm').test(code)
    || new RegExp(`(^|[{;\\s])${k}\\s*\\{`, 'm').test(code)
    || new RegExp(`(^|[{;\\s])${k}\\s+["\\w][^;{]*\\{`, 'm').test(code);

  it('uses every field offered inside a block', () => {
    const missing: string[] = [];
    for (const [block, fields] of Object.entries(BLOCK_FIELDS)) {
      for (const f of fields) if (!usesKey(f)) missing.push(`${block}.${f}`);
    }
    expect(missing, 'offered by `?` but in no example').toEqual([]);
  });

  it('uses every top-level block', () => {
    const missing = TOP_BLOCK_KEYWORDS.filter((b) => !usesKey(b));
    expect(missing, 'a whole block with nothing to read').toEqual([]);
  });

  it('uses every enumerated value', () => {
    /*
     * Several of these cannot share a sheet -- a page has one theme,
     * one size, one palette -- so they are spread across the examples
     * rather than crammed into one. That is the only way to show them
     * at all, and it makes the library look like a drawing office's
     * rather than one sheet repeated.
     */
    const missing: string[] = [];
    for (const [field, choices] of Object.entries(FIELD_VALUES)) {
      for (const c of choices) {
        const v = c.value.replace(/^"|"$/g, '');
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${esc}\\b`).test(code)) missing.push(`${field} = ${v}`);
      }
    }
    expect(missing, 'offered as a value but in no example').toEqual([]);
  });
});

describe('the offered vocabulary is documented', () => {
  /*
   * The example proves a key works; the guide and the spec say what it
   * is *for*. A key with neither is a key only its author can use, and
   * every one of these three drifted from the others at some point --
   * the spec named keys the parser had renamed, the guide described a
   * `page` block half of which did nothing, and completions offered a
   * field that had been removed a release earlier.
   */
  const guide = readFileSync(join(repoRoot(), 'docs', 'guide.adoc'), 'utf8');
  const specDir = join(repoRoot(), 'spec', 'sections');
  const spec = readdirSync(specDir).filter((f) => f.endsWith('.adoc'))
    .map((f) => readFileSync(join(specDir, f), 'utf8')).join('\n');

  const mentions = (text: string, k: string): boolean =>
    new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);

  const everyField = (): string[] =>
    [...new Set(Object.values(BLOCK_FIELDS).flat()), ...TOP_BLOCK_KEYWORDS];

  const everyValue = (): string[] =>
    Object.values(FIELD_VALUES).flat().map((c) => c.value.replace(/^"|"$/g, ''));

  for (const [name, text] of [['guide', guide], ['spec', spec]] as const) {
    it(`names every offered key in the ${name}`, () => {
      expect(everyField().filter((k) => !mentions(text, k))).toEqual([]);
    });

    it(`names every offered value in the ${name}`, () => {
      expect(everyValue().filter((v) => !mentions(text, v))).toEqual([]);
    });
  }
});

describe('the playground offers every example', () => {
  /*
   * `src/examples.ts` imports each `.tc` file by name, so a new example
   * is not in the picker until someone adds a line. Five were written,
   * validated, tested and documented before anyone noticed they could
   * not be opened from the app.
   *
   * Read as text rather than imported: the module uses Vite's `?raw`
   * suffix, which only resolves inside a Vite build.
   */
  it('imports every file in examples/', () => {
    const registry = readFileSync(join(repoRoot(), 'src', 'examples.ts'), 'utf8');
    const missing = readdirSync(join(repoRoot(), 'examples'))
      .filter((f) => f.endsWith('.tc'))
      .filter((f) => !registry.includes(f));
    expect(missing, 'written but not offered in the playground').toEqual([]);
  });
});

describe('every example still means something', () => {
  /*
   * Coverage is worthless if the file that provides it does not parse.
   * A key could be "demonstrated" by a line the processor rejects.
   */
  for (const file of readdirSync(join(repoRoot(), 'examples')).filter((f) => f.endsWith('.tc'))) {
    it(`${file} processes without an error`, () => {
      const result = process(readFileSync(join(repoRoot(), 'examples', file), 'utf8'));
      const errors = [...result.parseErrors, ...result.diagnostics]
        .filter((d) => d.severity === 'error');
      expect(errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
      expect(result.study).toBeDefined();
    });
  }
});
