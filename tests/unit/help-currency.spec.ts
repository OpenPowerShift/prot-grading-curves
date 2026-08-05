/**
 * The help must not teach a spelling the parser refuses.
 *
 * Keys were renamed -- `I_A` to `I`, `t_s` to `t`, `kV` to `V` -- and
 * the parser refuses the old ones with a message naming the new. The
 * help tables did not follow: `?` on `faults` still offered
 * `I_A = 6400 A;` as its example, so the editor was demonstrating a
 * line the same editor would then underline in red.
 *
 * That is worse than an out-of-date example. It teaches a beginner the
 * wrong thing at the exact moment they are looking for the right one,
 * and it makes the tool look as though it disagrees with itself.
 *
 * `RENAMED_KEYS` is the parser's own table, so this cannot drift: rename
 * another key and every stale example fails here.
 */

import { describe, expect, it } from 'vitest';
import { RENAMED_KEYS, REMOVED_KEYS } from '@tc/parser/parser';
import { FIELD_UNITS, KEYWORD_HELP, TOP_BLOCK_KEYWORDS, UNIT_FAMILY } from '@tc/help/help-data';
import { FIELD_QUANTITY } from '@tc/semantics/units';
import { parse } from '@tc/parser';

/** `key =` written anywhere in a fragment of example source. */
const assigns = (text: string, key: string): boolean =>
  new RegExp(`(^|[{;\\s])${key}\\s*=`).test(text);

describe('every help example', () => {
  for (const [name, entry] of Object.entries(KEYWORD_HELP)) {
    it(`for "${name}" uses no renamed key`, () => {
      const stale = Object.keys(RENAMED_KEYS)
        .filter((old) => assigns(entry.example, old))
        .map((old) => `${old} -> ${RENAMED_KEYS[old]}`);
      expect(stale, `${name}: ${entry.example}`).toEqual([]);
    });
  }

  for (const [name, entry] of Object.entries(KEYWORD_HELP)) {
    it(`for "${name}" uses no removed key`, () => {
      const gone = Object.keys(REMOVED_KEYS).filter((k) => assigns(entry.example, k));
      expect(gone, `${name}: ${entry.example}`).toEqual([]);
    });
  }
});

describe('the unit suffixes offered after a number', () => {
  /*
   * `?` after `V = 33 ` offered "V" labelled *kilovolts*, beside a
   * second "V" labelled volts, and never offered `kV` at all -- on a
   * field that is nearly always written in kV. Picking the first
   * suggestion gave a level a thousand times too small, silently,
   * because `V` is a real suffix and nothing downstream could tell it
   * was not the one meant.
   */
  it('offers each suffix once', () => {
    for (const [family, choices] of Object.entries(FIELD_UNITS)) {
      const seen = choices.map((c) => c.value);
      expect(new Set(seen).size, `${family} repeats a suffix: ${seen.join(', ')}`)
        .toBe(seen.length);
    }
  });

  it('offers only suffixes the parser accepts', () => {
    /* Every offered unit must survive being written on a real field
     * of that family, or the completion is a trap. */
    const witness: Record<string, string> = {
      __current: 'faults { "F" { I = 1 <U>; } }',
      __pickup: 'relay R { element 51 { I_pickup = 1 <U>; } }',
      __time: 'relay R { element 51 { t_delay = 1 <U>; } }',
      __voltage: 'system { voltages { "L" { V = 1 <U>; } } }',
    };
    for (const [family, source] of Object.entries(witness)) {
      for (const choice of FIELD_UNITS[family]) {
        const unit = choice.value.replace(/^"|"$/g, '');
        const errors = parse(source.replace('<U>', unit)).errors
          .filter((e) => e.severity === 'error');
        expect(errors.map((e) => e.code), `${family} offers "${unit}"`).toEqual([]);
      }
    }
  });

  it('describes kV as kilovolts and V as volts, not both as one', () => {
    const voltage = FIELD_UNITS.__voltage;
    expect(voltage.find((c) => c.value === 'kV')?.detail).toMatch(/kilovolt/i);
    expect(voltage.find((c) => c.value === 'V')?.detail).toMatch(/^volt/i);
  });
});

describe('the field-to-unit-family table', () => {
  /*
   * Keyed on three spellings the parser had already renamed, so the
   * lookup missed and `?` offered nothing -- indistinguishable, from
   * the editor, from a field that takes no unit at all.
   */
  it('names only fields the parser knows carry a unit', () => {
    const unknown = Object.keys(UNIT_FAMILY)
      .filter((field) => field !== 'voltage')      /* a level *name*, not a number */
      .filter((field) => FIELD_QUANTITY[field] == null);
    expect(unknown, 'offered a unit family but not a united field').toEqual([]);
  });

  it('covers every united field the parser has', () => {
    const missing = Object.keys(FIELD_QUANTITY).filter((field) => UNIT_FAMILY[field] == null);
    expect(missing, 'takes a unit but `?` offers none').toEqual([]);
  });

  it('agrees with the parser about which quantity each field is', () => {
    const family: Record<string, string> = {
      __current: 'current', __pickup: 'current',
      __time: 'time', __voltage: 'voltage',
    };
    for (const [field, offered] of Object.entries(UNIT_FAMILY)) {
      const quantity = FIELD_QUANTITY[field];
      if (quantity == null || family[offered] == null) continue;
      expect(family[offered], `${field} is a ${quantity}`).toBe(quantity);
    }
  });
});

describe('every help summary', () => {
  /*
   * The prose drifted too: `point` described its currents as
   * "I_A, I2_A, I0_A, earth_A", every one of them refused.
   *
   * Two legitimate uses have to survive the check, so they are carved
   * out by name rather than by weakening it:
   *
   *   - `kV` and `MVA` are *units* as well as retired keys, and a
   *     summary saying "voltage in kV" is correct;
   *   - a summary may name an old spelling deliberately to help
   *     someone migrating, which reads "Was CTI_min_s".
   */
  const ALSO_A_UNIT = new Set(['kV']);

  for (const [name, entry] of Object.entries(KEYWORD_HELP)) {
    it(`for "${name}" names no renamed key`, () => {
      const stale = Object.keys(RENAMED_KEYS).filter((old) => {
        if (ALSO_A_UNIT.has(old)) return false;
        if (new RegExp(`Was ${old}\\b`).test(entry.summary)) return false;
        return new RegExp(`\\b${old}\\b`).test(entry.summary);
      });
      expect(stale, `${name}: ${entry.summary}`).toEqual([]);
    });
  }
});

describe('every help example that is a whole document', () => {
  /*
   * Only the examples that stand alone go through the parser. A
   * fragment like `tms = 0.30;` is not a document, nor is a nested
   * block shown on its own -- `voltages { ... }` lives inside
   * `system`, and parsing it at the top level tests the test rather
   * than the example. Examples carrying an elision (`...`) are
   * deliberately incomplete and skipped for the same reason.
   *
   * What is left is what a reader is most likely to paste whole.
   */
  const wholeBlocks = Object.entries(KEYWORD_HELP).filter(([, e]) => {
    if (e.example.includes('...')) return false;
    const head = /^\s*(\w+)/.exec(e.example)?.[1];
    return head != null
      && (TOP_BLOCK_KEYWORDS as readonly string[]).includes(head)
      && e.example.includes('}');
  });

  it('has some to check', () => {
    expect(wholeBlocks.length).toBeGreaterThan(3);
  });

  for (const [name, entry] of wholeBlocks) {
    it(`for "${name}" parses`, () => {
      const errors = parse(entry.example).errors.filter((e) => e.severity === 'error');
      expect(errors.map((e) => `${e.code}: ${e.message}`), entry.example).toEqual([]);
    });
  }
});
