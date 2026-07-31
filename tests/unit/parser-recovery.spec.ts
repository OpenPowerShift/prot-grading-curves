/**
 * What the parser does with a file that is being typed.
 *
 * Most of `parser.ts` that had no tests was recovery: the code that
 * runs when a brace is missing, a value is half-written or a keyword is
 * misspelled. The playground reparses on every keystroke, so those
 * paths run constantly and are the ones a user meets most -- and a
 * parser that throws or loops on a half-typed file takes the editor
 * with it.
 *
 * The property under test throughout is the same: it returns, it says
 * something, and it keeps whatever it could still understand.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';
import { process } from '@tc/index';

const errorsOf = (src: string) => parse(src).errors.filter((e) => e.severity === 'error');

/** Every prefix of a source, as a typist would produce it. */
function prefixes(source: string, step = 7): string[] {
  const out: string[] = [];
  for (let i = 1; i <= source.length; i += step) out.push(source.slice(0, i));
  return out;
}

const FULL = `meta { project = "Half typed"; }
system { voltages { "MV" { V = 11 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R_FDR {
  voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.1; }
  element 50 { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
}
grade { primary = R_FDR:51; backup = R_FDR:50; fault = "F"; margin = 0.3 s; }
view { voltage = "MV"; }
page { size = "A4"; legend = { style = "column"; }; }
`;

describe('a file being typed', () => {
  it('never throws, however far through it is', () => {
    for (const partial of prefixes(FULL)) {
      expect(() => parse(partial), JSON.stringify(partial.slice(-24))).not.toThrow();
    }
  });

  it('never throws when processed, either', () => {
    for (const partial of prefixes(FULL, 23)) {
      expect(() => process(partial), JSON.stringify(partial.slice(-24))).not.toThrow();
    }
  });

  it('keeps the blocks it managed to finish', () => {
    const upToRelay = FULL.slice(0, FULL.indexOf('grade {'));
    const doc = parse(upToRelay).document;
    expect(doc?.items.some((i) => i.type === 'relay')).toBe(true);
  });
});

describe('unbalanced braces', () => {
  it('reports a block that is never closed', () => {
    expect(errorsOf('relay R { element 51 { curve = iec.si;').length).toBeGreaterThan(0);
  });

  it('ignores a stray closing brace rather than derailing', () => {
    /* Tolerated: it arrives constantly while a block is being moved
     * about, and refusing the whole file for one would make the editor
     * unusable. The blocks around it still parse. */
    const doc = parse('meta { project = "x"; } }\nsystem { voltages { "MV" { V = 11 kV; } } }').document;
    expect(doc?.items.some((i) => i.type === 'system')).toBe(true);
  });

  it('recovers far enough to see the next block', () => {
    /*
     * The point of recovery: one broken block must not cost the reader
     * every diagnostic after it.
     */
    const doc = parse(`relay R_BROKEN { element 51 { curve = ;
      relay R_GOOD { voltage = "MV"; ct_ratio = 400/5;
        element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.1; } }`).document;
    expect(doc?.items.length).toBeGreaterThan(0);
  });
});

describe('values that are not finished', () => {
  const cases: Array<[string, string]> = [
    ['a bare equals', 'meta { project = }'],
    ['an unterminated string', 'meta { project = "no closing quote'],
    ['a list left open', 'combine { sources = [R:51, ; }'],
    ['a flex table left open', 'device "d" { flex_points = [(100 A, 1 s), ; }'],
  ];

  for (const [name, src] of cases) {
    it(`says something about ${name}`, () => {
      const result = parse(src);
      expect(result.errors.length, name).toBeGreaterThan(0);
      expect(() => process(src)).not.toThrow();
    });
  }

  /*
   * These parse cleanly by design -- the grammar accepts them and the
   * meaning is judged afterwards, which is where the complaint belongs.
   */
  const semantic: Array<[string, string, RegExp]> = [
    ['a curve name with a trailing dot',
      'relay R { element 51 { curve = iec.; } }', /CURVE_UNKNOWN/],
    ['a ratio missing its denominator',
      'system { voltages { "MV" { V = 11 kV; } } }\nrelay R { voltage = "MV"; ct_ratio = 400/;\n  element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.1; } }',
      /CT_RATIO_INVALID/],
  ];

  for (const [name, src, code] of semantic) {
    it(`complains later about ${name}`, () => {
      const codes = process(src).diagnostics.map((d) => d.code).join(',');
      expect(codes, name).toMatch(code);
    });
  }

  it('takes a bare number as the base unit', () => {
    /* `I = 6` is six amps: a number with no suffix is in the base unit
     * for its field, which is what lets a study be written in one. */
    const r = process('system { voltages { "MV" { V = 11 kV; } } }\n'
      + 'faults { "F" { I = 6; voltage = "MV"; } }');
    expect(r.study?.faults.get('F')?.I_A).toBe(6);
  });
});

describe('characters the language has no use for', () => {
  it('reports them without stopping', () => {
    const errs = errorsOf('meta { project = "x"; } @ £ ~ ');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('does not lose a good block that follows one', () => {
    const doc = parse('@@@\nsystem { voltages { "MV" { V = 11 kV; } } }').document;
    expect(doc?.items.some((i) => i.type === 'system')).toBe(true);
  });
});

describe('empty and near-empty input', () => {
  it('accepts an empty file', () => {
    expect(errorsOf('')).toEqual([]);
  });

  it('accepts a file of only comments', () => {
    expect(errorsOf('# nothing here\n// nor here\n/* nor here */\n')).toEqual([]);
  });

  it('accepts a file of only whitespace', () => {
    expect(errorsOf('\n\n   \t\n')).toEqual([]);
  });
});

describe('positions', () => {
  it('points at the line the mistake is on', () => {
    const errs = errorsOf('meta { project = "x"; }\n\nrelay R { element 51 { tsm = 1; } }\n');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].line).toBe(3);
  });

  it('gives every error a non-negative offset and a length', () => {
    for (const e of parse('relay R { element 51 { curve = ; tsm = 2; } }').errors) {
      expect(e.offset).toBeGreaterThanOrEqual(0);
      expect(e.length).toBeGreaterThanOrEqual(0);
      expect(e.line).toBeGreaterThan(0);
      expect(e.column).toBeGreaterThan(0);
    }
  });
});

describe('deeply nested and repeated structures', () => {
  it('handles a study with many relays', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      `relay R${i} { voltage = "MV"; ct_ratio = 400/5;
         element 51 { function = "phase_oc"; curve = iec.si; I_pickup = ${100 + i} A; tms = 0.1; } }`,
    ).join('\n');
    const r = process(`system { voltages { "MV" { V = 11 kV; } } }\n${many}`);
    expect(r.study?.relays.size).toBe(40);
  });

  it('handles an element with many stages', () => {
    const stages = Array.from({ length: 12 }, (_, i) =>
      `stage s${i} { curve = definite; I_pickup = ${1000 + i * 100} A; t_delay = ${i * 10 + 20} ms; }`,
    ).join('\n');
    const r = process(`system { voltages { "MV" { V = 11 kV; } } }
      relay R { voltage = "MV"; ct_ratio = 400/5;
        element 51 { function = "phase_oc"; stages { ${stages} } } }`);
    expect(r.study?.relays.get('R')?.elements[0].stages.length).toBe(12);
  });
});
