/**
 * Structural errors: repeated keys and empty assignments.
 *
 * Both used to pass silently. A key assigned twice let the later
 * value win with nothing said, and an assignment with no value left
 * the field unset, so a half-written line disappeared from the study
 * rather than being reported.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';

function errors(src: string, code?: string) {
  return parse(src).errors.filter(
    (e) => e.severity === 'error' && (!code || e.code === code),
  );
}

describe('repeated keys', () => {
  it('rejects a key assigned twice in one block', () => {
    const found = errors('view { current_min = 3 kA; current_max = 40 kA; current_min = 5 kA; }');
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe('DUPLICATE_KEY');
    expect(found[0].message).toContain('current_min');
  });

  it('points at the repeat and names where the first one was', () => {
    const found = errors('view {\n  current_min = 3 kA;\n  current_max = 40 kA;\n  current_min = 5 kA;\n}');
    expect(found[0].line).toBe(4);
    expect(found[0].message).toContain('line 2');
  });

  it('allows the same key in sibling blocks', () => {
    expect(errors('relay A { voltage = "hv"; }\nrelay B { voltage = "hv"; }')).toHaveLength(0);
  });

  it('allows the same key in nested blocks', () => {
    expect(errors(`
      element 50 {
        stages {
          stage a { I_pu = 1 A; }
          stage b { I_pu = 2 A; }
        }
      }
    `)).toHaveLength(0);
  });

  it('allows a key repeated across faults', () => {
    expect(errors(`
      faults {
        "A" { I_A = 1 kA; voltage = "hv"; }
        "B" { I_A = 2 kA; voltage = "hv"; }
      }
    `)).toHaveLength(0);
  });
});

describe('empty assignments', () => {
  it('rejects a value left off before the semicolon', () => {
    const found = errors('point P { I_A = 100 A; shape = ; }', 'MISSING_VALUE');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('shape');
  });

  it('rejects one left off at the end of a block', () => {
    expect(errors('point P { I_A = 100 A; shape = }', 'MISSING_VALUE')).toHaveLength(1);
  });

  it('rejects one left off at the end of the file', () => {
    expect(errors('meta { project =', 'MISSING_VALUE')).toHaveLength(1);
  });

  it('reports the position of the assignment, for the caret filter', () => {
    const found = errors('meta {\n  project = "x";\n  study =\n}', 'MISSING_VALUE');
    expect(found[0].line).toBe(3);
  });

  it('leaves complete assignments alone', () => {
    expect(errors('point P { I_A = 100 A; t_s = 1 s; shape = "cross"; }')).toHaveLength(0);
  });
});

describe('the shipped examples', () => {
  it('are free of both', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(
      (globalThis as { process?: { cwd(): string } }).process!.cwd(),
      'examples',
    );

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.tc'))) {
      const found = errors(readFileSync(join(dir, file), 'utf8'));
      expect(found, `${file}: ${JSON.stringify(found)}`).toHaveLength(0);
    }
  });
});
