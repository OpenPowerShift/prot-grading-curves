/**
 * Where the completion source should and should not speak.
 *
 * Three reported faults, all of them the list appearing -- or
 * inserting -- somewhere it does not belong.
 */

import { describe, expect, it } from 'vitest';
import { tcCompletionSource } from '@tc/editor/completions';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';

/** Run the source at the offset marked by `|` in the text. */
const at = (marked: string, explicit = true) => {
  const pos = marked.indexOf('|');
  expect(pos, 'the test marks a cursor with |').toBeGreaterThan(-1);
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  const state = EditorState.create({ doc });
  return tcCompletionSource(new CompletionContext(state, pos, explicit));
};

const labels = (r: ReturnType<typeof at>): string[] =>
  (r?.options ?? []).map((o) => o.label);

const applied = (r: ReturnType<typeof at>, label: string): string | undefined => {
  const found = (r?.options ?? []).find((o) => o.label === label);
  return typeof found?.apply === 'string' ? found.apply : undefined;
};

describe('inside a comment', () => {
  it('offers nothing on a # line', () => {
    expect(at('relay R {\n  # this element is the fee|\n}')).toBeNull();
  });

  it('offers nothing on a // line', () => {
    expect(at('relay R {\n  // note about vol|\n}')).toBeNull();
  });

  it('offers nothing inside a block comment, which spans lines', () => {
    expect(at('/* a note\n   about the cur|ve\n*/\nrelay R { }')).toBeNull();
  });

  it('speaks again after the comment ends', () => {
    const r = at('relay R {\n  # a note\n  |\n}');
    expect(labels(r).length).toBeGreaterThan(0);
  });

  it('speaks again after a block comment closes', () => {
    const r = at('/* note */\nrelay R {\n  |\n}');
    expect(labels(r).length).toBeGreaterThan(0);
  });
});

describe('inside free text', () => {
  it('offers nothing in a label', () => {
    expect(at('annotate { label = "the feeder cle|"; }')).toBeNull();
  });

  it('still offers declared levels after an opening quote', () => {
    /* A value position, not free text: the quote was just opened on an
     * assignment whose field names a level. */
    const src = 'system { voltages { "MV" { V = 11 kV; } } }\nrelay R { voltage = "|';
    expect(labels(at(src))).toContain('MV');
  });
});

describe('a declared name', () => {
  const STUDY = `
system { voltages { "MV" { V = 11 kV; } } }
faults {
  "Board max" { I = 6 kA; }
}
scenario "LV earth fault" { type = single_phase_earth; }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; stages {
    stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
    stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
  } } }
`;

  it('is inserted quoted, so it parses', () => {
    /*
     * The bare word was inserted, giving `fault = Board max;` -- a
     * parse error for any name with a space, and a bare identifier for
     * the rest.
     */
    const r = at(`${STUDY}grade { fault = |`);
    expect(labels(r)).toContain('Board max');
    expect(applied(r, 'Board max')).toBe('"Board max"');
  });

  it('reads cleanly in the list, without its quotes', () => {
    const r = at(`${STUDY}grade { fault = |`);
    expect(labels(r)).toContain('Board max');
    expect(labels(r)).not.toContain('"Board max"');
  });

  it('quotes a scenario the same way', () => {
    const r = at(`${STUDY}grade { scenario = |`);
    expect(applied(r, 'LV earth fault')).toBe('"LV earth fault"');
  });

  it('quotes a voltage level', () => {
    const r = at(`${STUDY}relay R2 { voltage = |`);
    expect(applied(r, 'MV')).toBe('"MV"');
  });
});

describe('a reference', () => {
  const STAGED = `
relay R_FDR { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; stages {
    stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
    stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
  } } }
`;

  it('offers the element', () => {
    expect(labels(at(`${STAGED}grade { primary = |`))).toContain('R_FDR:51');
  });

  it('offers its stages too', () => {
    /*
     * `R:51/inst` is accepted everywhere `R:51` is -- a grade against
     * one stage, an annotation to the stage armed under the condition
     * being drawn -- and was offered nowhere, so it had to be known
     * already to be used.
     */
    const found = labels(at(`${STAGED}grade { primary = |`));
    expect(found).toContain('R_FDR:51/main');
    expect(found).toContain('R_FDR:51/inst');
  });

  it('ranks the element above its stages', () => {
    const r = at(`${STAGED}grade { primary = |`);
    const boost = (label: string): number =>
      (r?.options ?? []).find((o) => o.label === label)?.boost ?? 0;
    expect(boost('R_FDR:51')).toBeGreaterThan(boost('R_FDR:51/main'));
  });
});
