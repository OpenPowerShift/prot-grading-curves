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
import { KEYWORD_HELP, TOP_BLOCK_KEYWORDS } from '@tc/help/help-data';
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
