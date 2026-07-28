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
  it('indents by brace depth', () => {
    const out = formatSource(`
relay R {
element 51 {
curve = iec.si;
}
}
`);
    expect(out).toBe(
      'relay R {\n' +
      '    element 51 {\n' +
      '        curve = iec.si;\n' +
      '    }\n' +
      '}\n',
    );
  });

  it('aligns assignments within a run', () => {
    const out = formatSource(`
meta {
project = "X";
engineer = "Y";
date = "2026-01-01";
}
`);
    expect(out).toContain('    project  = "X";');
    expect(out).toContain('    engineer = "Y";');
    expect(out).toContain('    date     = "2026-01-01";');
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
    expect(out).toContain('    project  = "a { b } c";');
    expect(out).toContain('    engineer = "Z";');
    expect(out.trimEnd().endsWith('}')).toBe(true);
  });

  it('collapses runs of blank lines to one', () => {
    const out = formatSource('meta {\nproject = "X";\n\n\n\nengineer = "Y";\n}\n');
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toMatch(/\n\n/);
  });

  it('is idempotent', () => {
    for (const file of readdirSync(join(repoRoot(), 'examples')).filter((f) => f.endsWith('.tc'))) {
      const src = readFileSync(join(repoRoot(), 'examples', file), 'utf8');
      const once = formatSource(src);
      expect(formatSource(once), `${file} is not stable under reformatting`).toBe(once);
    }
  });

  it('preserves meaning for every shipped example', () => {
    for (const file of readdirSync(join(repoRoot(), 'examples')).filter((f) => f.endsWith('.tc'))) {
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
