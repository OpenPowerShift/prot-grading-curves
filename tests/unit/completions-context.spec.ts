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
system { voltages { MV { V = 11 kV; } } }
faults {
  BOARD_MAX { name = "Board max"; I = 6 kA; }
}
scenario LV_EARTH_FAULT { name = "LV earth fault"; type = single_phase_earth; }
relay R { voltage = MV; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; stages {
    stage main { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
    stage inst { curve = definite; I_pickup = 4 kA; t_delay = 50 ms; }
  } } }
`;

  it('is inserted bare, which is what an id is now', () => {
    /*
     * Ids used to be quoted prose, so the completion inserted quotes
     * or produced `fault = Board max;` -- a parse error. They are bare
     * identifiers now, and completing to the old spelling would keep
     * writing new studies in it.
     */
    const r = at(`${STUDY}grade { fault = |`);
    expect(labels(r)).toContain('BOARD_MAX');
    expect(applied(r, 'BOARD_MAX')).toBe('BOARD_MAX');
  });

  it('offers the handle, which is what a reference needs', () => {
    /* The caption is `name`, and is not what resolves anything. */
    const r = at(`${STUDY}grade { fault = |`);
    expect(labels(r)).toContain('BOARD_MAX');
    expect(labels(r)).not.toContain('Board max');
  });

  it('offers a scenario the same way', () => {
    const r = at(`${STUDY}grade { scenario = |`);
    expect(applied(r, 'LV_EARTH_FAULT')).toBe('LV_EARTH_FAULT');
  });

  it('offers a voltage level', () => {
    const r = at(`${STUDY}relay R2 { voltage = |`);
    expect(applied(r, 'MV')).toBe('MV');
  });

  it('offers the declared sheets, which nothing used to', () => {
    /*
     * `views` was the one declared-name key with no completions, so
     * the list a study had to spell exactly was the one with no help
     * spelling it -- and a wrong entry removed the thing from every
     * sheet in silence.
     */
    const withViews = `${STUDY}view PHASE { quantity = phase; }\nview SEQUENCE { quantity = I2; }\n`;
    const r = at(`${withViews}relay R3 { element 51 { views = [|`);
    expect(labels(r)).toContain('PHASE');
    expect(labels(r)).toContain('SEQUENCE');
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

describe('a marked point referenced from an annotate', () => {
  /*
   * A point is referenced by the id in its header, not by its `label`
   * -- and the two are usually near-identical sentences, so the label
   * gets written where the id belongs and the annotation silently has
   * nowhere to go. Offering the ids is the fix for the mistake as well
   * as the convenience.
   */
  const STUDY = `
point "Inrush I2 below 46 pickup" { I2 = 75 A; t = 240 ms;
  label = "Inrush I2 falls below 46 pickup, 240 ms"; }
point "External fault I2" { I2 = 49 A; t = 100 ms; label = "Ext fault"; }
`;

  it('offers the declared ids', () => {
    const found = labels(at(`${STUDY}annotate { point = |`));
    expect(found).toContain('Inrush I2 below 46 pickup');
    expect(found).toContain('External fault I2');
  });

  it('offers the id, not the label', () => {
    const found = labels(at(`${STUDY}annotate { point = |`));
    expect(found).not.toContain('Inrush I2 falls below 46 pickup, 240 ms');
  });

  it('inserts it bare, as ids are written now', () => {
    const r = at(`${STUDY}annotate { point = |`);
    expect(applied(r, 'External fault I2')).toBe('External fault I2');
  });
});
