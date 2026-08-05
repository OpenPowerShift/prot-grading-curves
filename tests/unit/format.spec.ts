/**
 * Source formatter.
 *
 * The properties that matter: it must not change what a study *means*,
 * it must not lose comments, and running it twice must be the same as
 * running it once.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSource } from '@tc/format/format';
import { process as processStudy } from '@tc/index';

const repoRoot = (): string =>
  (globalThis as { process?: { cwd(): string } }).process!.cwd();

describe('formatSource', () => {
  it('indents by brace depth, two spaces a level', () => {
    const out = formatSource(`
relay R {
element 51 {
curve = iec.si;
}
}
`);
    expect(out).toBe(
      'relay R {\n' +
      '  element 51 {\n' +
      '    curve = iec.si;\n' +
      '  }\n' +
      '}\n',
    );
  });

  it('puts one space either side of `=` by default', () => {
    /*
     * Aligned columns cost the author every time they add a longer key:
     * one new line reflows a dozen others and the diff stops showing
     * what changed. Padding is available, it is just not the default.
     */
    const out = formatSource('meta {\nproject   = "X";\nengineer      = "Y";\n}\n');
    expect(out).toContain('  project = "X";');
    expect(out).toContain('  engineer = "Y";');
  });

  it('collapses the padding a hand-aligned file already had', () => {
    const out = formatSource('times {\n"A"     {\nt    = 430 ms;\n}\n}\n');
    expect(out).toContain('  "A" {');
    expect(out).toContain('    t = 430 ms;');
  });

  it('trims trailing whitespace', () => {
    const out = formatSource('meta {\n  project = "X";   \n}\n');
    expect(out.split('\n').every((l) => l === l.trimEnd())).toBe(true);
  });

  it('aligns assignments within a run', () => {
    const out = formatSource(`
meta {
project = "X";
engineer = "Y";
date = "2026-01-01";
}
`, { alignAssignments: true });
    expect(out).toContain('  project  = "X";');
    expect(out).toContain('  engineer = "Y";');
    expect(out).toContain('  date     = "2026-01-01";');
  });

  it('keeps comments', () => {
    const src = '# leading note\nmeta {\n  project = "X"; // trailing\n}\n';
    const out = formatSource(src);
    expect(out).toContain('# leading note');
    expect(out).toContain('// trailing');
  });

  it('is not fooled by braces inside strings', () => {
    const out = formatSource('meta {\nproject = "a { b } c";\nengineer = "Z";\n}\n');
    // The string's braces must not change the nesting.
    expect(out).toContain('  project = "a { b } c";');
    expect(out).toContain('  engineer = "Z";');
    expect(out.trimEnd().endsWith('}')).toBe(true);
  });

  it('collapses runs of blank lines to one', () => {
    const out = formatSource('meta {\nproject = "X";\n\n\n\nengineer = "Y";\n}\n');
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toMatch(/\n\n/);
  });

  it('gives each brace and statement its own line', () => {
    /*
     * The case that prompted this: a nested value block written inline
     * reads as one dense run of punctuation, and `=` alignment cannot
     * help because alignment works down a column.
     */
    const out = formatSource(
      'page {\n  title = { text = "Northgate"; subtitle = "cascade"; };\n}\n',
    );
    expect(out).toBe(
      'page {\n'
      + '  title = {\n'
      + '    text = "Northgate";\n'
      + '    subtitle = "cascade";\n'
      + '  };\n'
      + '}\n',
    );
  });

  it('starts a new block on its own line after a closer', () => {
    /* `} "LV" {` must not leave the next block trailing after the brace
     * that closed the last. */
    const out = formatSource('system { voltages { "HV" { V = 33 kV; } "LV" { V = 11 kV; } } }\n');
    expect(out).toContain('    }\n    "LV" {\n');
  });

  it('keeps a closing brace and its semicolon together', () => {
    /* Splitting them would leave a line holding one semicolon. */
    expect(formatSource('page { legend = { title = "E"; }; }\n')).toContain('  };\n');
  });

  it('leaves bracketed values alone', () => {
    /*
     * A `[` list is a value, not a block. `flex_points` tables are read
     * as rows, and exploding them by element would make them unreadable.
     */
    const out = formatSource('device "f" {\n  flex_points = [[100, 5], [200, 1]];\n}\n');
    expect(out).toContain('  flex_points = [[100, 5], [200, 1]];\n');
  });

  it('does not split on punctuation inside a string', () => {
    const out = formatSource('meta {\n  project = "a; b { c } d";\n}\n');
    expect(out).toContain('  project = "a; b { c } d";\n');
  });

  it('keeps a trailing comment with the statement it followed', () => {
    const out = formatSource('meta { project = "X"; # why\n}\n');
    expect(out).toContain('project = "X"; # why');
  });

  it('leaves the source alone when expansion is off', () => {
    const inline = 'page {\n  legend = { title = "E"; };\n}\n';
    expect(formatSource(inline, { expandBlocks: false })).toBe(inline);
  });

  it('is idempotent', () => {
    for (const file of readdirSync(join(repoRoot(), 'examples')).filter((f) => f.endsWith('.ptc'))) {
      const src = readFileSync(join(repoRoot(), 'examples', file), 'utf8');
      const once = formatSource(src);
      expect(formatSource(once), `${file} is not stable under reformatting`).toBe(once);
    }
  });

  it('preserves meaning for every shipped example', () => {
    for (const file of readdirSync(join(repoRoot(), 'examples')).filter((f) => f.endsWith('.ptc'))) {
      const src = readFileSync(join(repoRoot(), 'examples', file), 'utf8');
      const before = processStudy(src);
      const after = processStudy(formatSource(src));

      expect(after.parseErrors.filter((e) => e.severity === 'error'), file).toHaveLength(0);
      expect(after.diagnostics.filter((d) => d.severity === 'error'), file).toHaveLength(0);

      // Same relays, same elements, same pickups and operate times.
      expect([...after.study!.relays.keys()]).toEqual([...before.study!.relays.keys()]);
      expect(after.reports.map((r) => r.rows.map((x) => x.margin_s)))
        .toEqual(before.reports.map((r) => r.rows.map((x) => x.margin_s)));
    }
  });
});
