/**
 * Parser conformance.
 *
 * The headline case is the spec's canonical example
 * (spec/sections/example-file.adoc), which states: "All language
 * constructs in this specification appear at least once in this file."
 * If it parses, the grammar covers the language.
 *
 * Every file under `examples/` is parsed too, so a shipped sample can
 * never silently stop working.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { process } from '@tc/index';

/**
 * The canonical example, read *out of the spec* rather than copied.
 *
 * The spec says of this file: "All language constructs in this
 * specification appear at least once in this file." Extracting it at
 * test time means the grammar is checked against the document itself,
 * so an edit to either side that breaks the other fails here.
 */
function canonicalExample(): string {
  const adoc = readFileSync(
    join(repoRoot(), 'spec', 'sections', 'example-file.adoc'),
    'utf8',
  );
  const block = adoc.match(/\[source,tc\]\n----\n([\s\S]*?)\n----/);
  if (!block) throw new Error('no [source,tc] block found in example-file.adoc');
  return block[1];
}

const CANONICAL = canonicalExample();

describe('canonical example from the spec', () => {
  const result = parse(CANONICAL);

  it('parses with no errors', () => {
    const errors = result.errors.filter((e) => e.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  it('validates with no semantic errors either', () => {
    // The spec's own example must satisfy the spec's own rules.
    const errors = process(CANONICAL).diagnostics.filter((d) => d.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });

  it('recognises every top-level block it uses', () => {
    const kinds = new Set(result.document!.items.map((i) => i.type));
    for (const expected of ['meta', 'system', 'faults', 'relay', 'grade', 'annotate', 'notes']) {
      expect(kinds, `missing ${expected}`).toContain(expected);
    }
  });

  it('resolves all five element forms on the incomer', () => {
    const study = process(CANONICAL).study!;
    const relay = study.relays.get('R_TRF_INC')!;
    expect(relay.elements.map((e) => e.id)).toEqual(['51', '67N', '50', '51X', '51F']);

    const producers = relay.elements.map((e) => e.stages[0].producer?.kind);
    expect(producers).toEqual(['standard', 'standard', 'definite', 'formula', 'flex']);
  });

  it('folds the kA suffixes in the fault table', () => {
    const study = process(CANONICAL).study!;
    expect(study.faults.get('F_INC_max')!.I_A).toBeCloseTo(18430, 6);
    expect(study.faults.get('F_FDR1_max')!.I_A).toBeCloseTo(6400, 6);
  });

  it('reads the CT ratio as a number', () => {
    const study = process(CANONICAL).study!;
    expect(study.relays.get('R_TRF_INC')!.ct_ratio).toBeCloseTo(120, 9);
    expect(study.relays.get('R_FDR_1')!.ct_ratio).toBeCloseTo(80, 9);
  });

  it('keeps the flex table sorted and unit-folded', () => {
    const study = process(CANONICAL).study!;
    const flex = study.relays.get('R_TRF_INC')!.elements[4].stages[0].producer;
    expect(flex?.kind).toBe('flex');
    if (flex?.kind === 'flex') {
      expect(flex.points.map((p) => p.I_A)).toEqual([240, 600, 1200, 5000]);
      expect(flex.points.map((p) => p.t_s)).toEqual([50.0, 5.0, 1.0, 0.20]);
    }
  });

  it('parses the formula block', () => {
    const study = process(CANONICAL).study!;
    const formula = study.relays.get('R_TRF_INC')!.elements[3].stages[0].producer;
    expect(formula).toEqual({ kind: 'formula', k: 4.0, c: 0.10, alpha: 0.50 });
  });

  it('parses the grade and annotate references', () => {
    const doc = result.document!;
    const grade = doc.items.find((i) => i.type === 'grade')!;
    expect(grade.primary?.text).toBe('R_FDR_1:51');
    expect(grade.backup?.text).toBe('R_TRF_INC:51');

    const annotate = doc.items.find((i) => i.type === 'annotate')!;
    expect(annotate.on_curve!.text).toBe('R_TRF_INC:51');
    expect(annotate.at_I_A).toBe(18430);
  });
});

describe('comment syntax', () => {
  it('accepts #, // and /* */ forms', () => {
    const r = parse(`
      # hash comment
      // slash comment
      /* block
         comment */
      meta { project = "X"; }   # trailing
    `);
    expect(r.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(r.document!.items).toHaveLength(1);
  });

  it('reports an unterminated block comment', () => {
    const r = parse('meta { project = "X"; }\n/* never closed');
    expect(r.errors.some((e) => e.code === 'UNTERMINATED_BLOCK_COMMENT')).toBe(true);
  });

  it('reports an unterminated string', () => {
    const r = parse('meta { project = "X; }');
    expect(r.errors.some((e) => e.code === 'UNTERMINATED_STRING')).toBe(true);
  });
});

describe('number literals', () => {
  it('accepts the group separator', () => {
    // spec _Numbers_: 18_430 is identical to 18430
    const study = process('faults { "F" { I   = 18_430 A; } }').study!;
    expect(study.faults.get('F')!.I_A).toBe(18430);
  });

  it('folds every current suffix', () => {
    const study = process(`
      faults {
        "a" { I   = 6.4 kA; }
        "b" { I   = 6400 A; }
        "c" { I   = 6400000 mA; }
      }
    `).study!;
    expect(study.faults.get('a')!.I_A).toBeCloseTo(6400, 6);
    expect(study.faults.get('b')!.I_A).toBeCloseTo(6400, 6);
    expect(study.faults.get('c')!.I_A).toBeCloseTo(6400, 6);
  });

  it('folds every time suffix', () => {
    const study = process(`
      relay R {
        element 50 { curve = definite; I_pickup = 100 A; t_delay = 250 ms; }
        element 51 { curve = definite; I_pickup = 100 A; t_delay = 0.25 s; }
      }
    `).study!;
    const [a, b] = study.relays.get('R')!.elements;
    expect(a.stages[0].t_delay_s).toBeCloseTo(0.25, 9);
    expect(b.stages[0].t_delay_s).toBeCloseTo(0.25, 9);
  });
});

describe('shipped examples', () => {
  const dir = join(repoRoot(), 'examples');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ptc'));

  it('finds example files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`parses and validates ${file}`, () => {
      const src = readFileSync(join(dir, file), 'utf8');
      const result = process(src);

      const parseErrors = result.parseErrors.filter((e) => e.severity === 'error');
      expect(parseErrors, JSON.stringify(parseErrors, null, 2)).toHaveLength(0);

      const semantic = result.diagnostics.filter((d) => d.severity === 'error');
      expect(semantic, JSON.stringify(semantic, null, 2)).toHaveLength(0);
    });
  }
});

/**
 * Repo root. `process` here is the library's own export, which shadows
 * Node's global, so the real one is reached through `globalThis`.
 */
function repoRoot(): string {
  return (globalThis as { process?: { cwd(): string } }).process!.cwd();
}

describe('reporting each error once', () => {
  /*
   * `Parser` used to be handed the lexer's own error array and assign
   * it straight to `this.errors`, so the two names referred to one
   * object; `parse` then spread both. Every lexical error appeared
   * twice, and a reader has no way to tell a genuinely repeated
   * complaint from a doubled one.
   */
  const duplicates = (src: string): string[] => {
    const counts = new Map<string, number>();
    for (const e of parse(src).errors) {
      const key = `${e.code}@${e.offset}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  };

  it('does not double a lexical error', () => {
    /* An unterminated string: two errors, each once. */
    expect(duplicates('meta { project = "x ;')).toEqual([]);
  });

  it('does not double errors in a file with several kinds at once', () => {
    expect(duplicates('meta { project = "x ; }\nrelay R { element 51 { curve = @ } }\n'))
      .toEqual([]);
  });
});
