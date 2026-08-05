/**
 * Every word the editor offers has something to say about itself.
 *
 * Completions and hover read the same tables, but only completions was
 * held to them. Sixty-two keys were being offered by `?` and listed in
 * the spec with no hover entry at all -- including `legend` and
 * `footer`, the two blocks on the `page` most likely to be reached for.
 * Putting the caret on one explained nothing, which reads as the tool
 * not knowing rather than the table having a hole in it.
 */

import { describe, expect, it } from 'vitest';
import { BLOCK_FIELDS, KEYWORD_HELP, TOP_BLOCK_KEYWORDS } from '@tc/help/help-data';

/**
 * Keys in `BLOCK_FIELDS` that name a *scope* rather than a word an
 * engineer types. `scenario.level` is how the table addresses the
 * fields of a `level` block; the word typed is `level`.
 */
const isScopeKey = (name: string): boolean => name.includes('.');

/**
 * `combined` is the table's name for the `combine` block's fields.
 * The keyword is `combine`, which carries the help.
 */
const ALIASES: Record<string, string> = { combined: 'combine' };

describe('hover help', () => {
  it('covers every top-level block', () => {
    const missing = TOP_BLOCK_KEYWORDS.filter((k) => !KEYWORD_HELP[k]);
    expect(missing, 'offered as a block but nothing explains it').toEqual([]);
  });

  it('covers every block that has fields', () => {
    const missing = Object.keys(BLOCK_FIELDS)
      .filter((b) => !isScopeKey(b))
      .filter((b) => !KEYWORD_HELP[ALIASES[b] ?? b]);
    expect(missing, 'a block with fields but no explanation').toEqual([]);
  });

  it('covers every field offered inside a block', () => {
    const missing = new Set<string>();
    for (const fields of Object.values(BLOCK_FIELDS)) {
      for (const f of fields) if (!KEYWORD_HELP[f]) missing.add(f);
    }
    expect([...missing].sort(), 'offered by `?` but nothing explains it').toEqual([]);
  });

  it('explains the page sub-blocks by name', () => {
    /* The reported case: `legend` and `footer` said nothing. */
    for (const block of ['legend', 'footer', 'axes', 'curves', 'points', 'leaders',
                         'scale', 'title', 'margins_mm']) {
      expect(KEYWORD_HELP[block], block).toBeDefined();
      expect(KEYWORD_HELP[block].summary.length, block).toBeGreaterThan(20);
    }
  });

  it('gives every entry a summary and an example', () => {
    for (const [name, entry] of Object.entries(KEYWORD_HELP)) {
      expect(entry.summary.trim(), `${name} has a summary`).not.toBe('');
      expect(typeof entry.example, `${name} has an example`).toBe('string');
    }
  });
});
