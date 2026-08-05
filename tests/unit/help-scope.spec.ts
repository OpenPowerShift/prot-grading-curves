/**
 * The same word means different things in different blocks.
 *
 * `point` is a top-level marked coordinate *and* the field inside an
 * `annotate` that names one. `style` is a legend layout, an
 * annotation's drawing mode, and a curve's stroke. `voltage` is a
 * relay's level, a fault's measuring level, and the level a bare
 * `at_I` was read at.
 *
 * The help table was flat, so it could hold one meaning of each and
 * explained the wrong one everywhere else.
 */

import { describe, expect, it } from 'vitest';
import { KEYWORD_HELP, helpFor } from '@tc/help/help-data';

describe('a word with more than one meaning', () => {
  it('explains the annotate field, not the top-level block', () => {
    const top = helpFor('point');
    const field = helpFor('point', 'annotate');
    expect(top).toBeDefined();
    expect(field).toBeDefined();
    expect(field!.summary).not.toBe(top!.summary);
    expect(field!.summary).toMatch(/margin|names a marked/i);
  });

  it('distinguishes the three styles', () => {
    const annotate = helpFor('style', 'annotate')!.summary;
    const legend = helpFor('style', 'legend')!.summary;
    const curve = helpFor('style')!.summary;
    expect(new Set([annotate, legend, curve]).size).toBe(3);
    expect(annotate).toContain('leader');
    expect(legend).toContain('column');
    expect(curve).toMatch(/dashed|stroke/);
  });

  it('distinguishes the voltages', () => {
    expect(helpFor('voltage', 'annotate')!.summary)
      .not.toBe(helpFor('voltage', 'relay')!.summary);
  });

  it('falls back to the bare entry where the block has none', () => {
    /* `tms` means one thing everywhere. */
    expect(helpFor('tms', 'element')).toBe(helpFor('tms'));
  });

  it('falls back for a block nothing is scoped to', () => {
    expect(helpFor('point', 'grade')).toBe(helpFor('point'));
  });
});

describe('the scoped entries', () => {
  it('are addressed by block, so the lookup can reach them', () => {
    /*
     * These were once written `page_size`, `view_voltage` and so on.
     * Nothing ever read them: the lookup is by the word under the
     * caret, and nobody types `page_size`.
     */
    const dead = Object.keys(KEYWORD_HELP)
      .filter((k) => /^(page|view|relay|fault|element|stage)_/.test(k));
    expect(dead, 'entries no lookup can reach').toEqual([]);
  });

  it('are reachable by the word a reader would put the caret on', () => {
    for (const key of Object.keys(KEYWORD_HELP)) {
      if (!key.includes('.')) continue;
      const [block, word] = key.split('.');
      expect(helpFor(word, block), key).toBe(KEYWORD_HELP[key]);
    }
  });
});
