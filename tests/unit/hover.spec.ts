/**
 * "What does this mean?" for an existing file.
 *
 * The completion list answers it while *writing*. The help lookup
 * answers it while *reading* someone else's study, which is the harder
 * and more common case -- and the one where a floating tooltip is
 * least use, since it covers the line being read.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { helpAt } from '@tc/editor/hover';

/** Help for the token containing the marker. */
function at(doc: string): ReturnType<typeof helpAt> {
  const pos = doc.indexOf('‸');
  const view = new EditorView({ state: EditorState.create({ doc: doc.replace('‸', '') }) });
  return helpAt(view, pos);
}

describe('a dotted curve identifier', () => {
  /*
   * `wordAt` stops at the dot, so the caret anywhere in `iec.si`
   * returned `iec` -- which has no entry, so the one lookup a reader
   * most wants ("what curve is this?") produced nothing at all.
   */
  it('resolves from before the dot', () => {
    expect(at('element 51 { curve = i‸ec.si; }')?.name).toBe('iec.si');
  });

  it('resolves from the dot itself', () => {
    expect(at('element 51 { curve = iec‸.si; }')?.name).toBe('iec.si');
  });

  it('resolves from after the dot', () => {
    expect(at('element 51 { curve = iec.s‸i; }')?.name).toBe('iec.si');
  });

  it('describes the curve, not the namespace', () => {
    expect(at('element 51 { curve = iec.s‸i; }')?.summary).toMatch(/standard inverse/i);
  });
});

describe('the fields a reader asks about', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['upstream', 'grade { upstr‸eam = true; }', /sweep/i],
    ['upstream_to', 'grade { upstream_‸to = 20 kA; }', /ceiling/i],
    ['quantity', 'view { quant‸ity = I2; }', /abscissa/i],
    ['condition', 'view { condi‸tion = "F"; }', /depicts/i],
    ['measures', 'element 46 { meas‸ures = "I2"; }', /which current/i],
    ['margin', 'grade { mar‸gin = 0.3 s; }', /margin/i],
    ['I_pickup', 'element 51 { I_pic‸kup = 480 A; }', /pickup/i],
    ['zero_sequence', 'system { zero_seq‸uence { } }', /delta/i],
    ['share', 'element 51 { sha‸re = 50 %; }', /parallel|share/i],
  ];

  for (const [name, doc, expected] of cases) {
    it(`explains ${name}`, () => {
      const help = at(doc);
      expect(help, name).not.toBeNull();
      expect(help!.summary, name).toMatch(expected);
    });
  }

  it('says which block a field belongs to', () => {
    expect(at('grade { upstr‸eam = true; }')?.scope).toBe('grade');
  });

  it('carries an example written in the current vocabulary', () => {
    /* The help is what a reader copies, so a stale example teaches a
     * spelling the parser now refuses. */
    for (const [, doc] of cases) {
      const example = at(doc)?.example ?? '';
      expect(example, example).not.toMatch(/\bI_pu\b|\bI_A\b|\bt_s\b|CTI_min_s|current_pct/);
    }
  });

  it('returns nothing for a word it has no entry for', () => {
    expect(at('relay R_FD‸R { }')).toBeNull();
  });
});
