/**
 * What the editor offers, and where.
 *
 * The playground's answer to "what can I write here?" is the
 * completion list, so a block whose fields it cannot find is a block
 * the engineer has to look up in the guide instead. These tests pin
 * the two questions separately: which *block* the cursor is in, and
 * which *values* a field accepts.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { tcCompletionSource } from '@tc/editor/completions';

/**
 * Labels offered with the cursor at the marker.
 *
 * `explicit` is what pressing `?` or Ctrl-Space sets, as opposed to
 * the list that appears while typing.
 */
function offer(doc: string, explicit = true): string[] {
  const pos = doc.indexOf('‸');
  if (pos < 0) throw new Error('no cursor marker in the fixture');
  const state = EditorState.create({ doc: doc.replace('‸', '') });
  const result = tcCompletionSource(new CompletionContext(state, pos, explicit));
  return result ? result.options.map((o) => String(o.label)) : [];
}

describe('asking inside a block', () => {
  /*
   * The regression: `matchBefore` finds nothing on an empty line, and
   * the source used to give up there -- so `?` on the blank line of a
   * fresh `view { }` offered nothing at all, and the only way to see a
   * block's fields was to guess a first letter.
   */
  it('lists the fields with nothing typed yet', () => {
    expect(offer('view {\n    ‸\n}\n')).toContain('quantity');
  });

  it('lists the same fields once a letter is typed', () => {
    expect(offer('view {\n    q‸\n}\n')).toContain('quantity');
  });

  it('offers nothing unasked on an empty line', () => {
    /* Typing ahead still needs a word to filter on; an empty line
     * popping a menu open on its own would fight the typist. */
    expect(offer('view {\n    ‸\n}\n', false)).toEqual([]);
  });

  it('lists the top-level blocks outside any of them', () => {
    expect(offer('‸\n')).toContain('scenario');
  });
});

describe('finding the block the cursor is in', () => {
  /*
   * These all failed or succeeded by accident before: the old scan
   * looked back a fixed twelve characters for a keyword, so whether a
   * block was recognised depended on how long the name in front of its
   * brace happened to be. `element 51 {` fitted the window and
   * `relay R {` did not, so a relay offered the top-level keywords.
   */
  const cases: Array<[string, string, string]> = [
    ['relay', 'relay R_FDR {\n  ‸\n}\n', 'ct_ratio'],
    ['relay with a long id', 'relay R_TRANSFORMER_INCOMER_1 {\n  ‸\n}\n', 'ct_ratio'],
    ['element', 'relay R {\n element 51 {\n  ‸\n }\n}\n', 'curve'],
    ['stage', 'relay R {\n element 51 {\n  stages {\n   stage main {\n    ‸\n   }\n  }\n }\n}\n', 'tms'],
    ['device', 'device "spur_fuse_50T" {\n  ‸\n}\n', 'min_melt'],
    ['scenario', 'scenario "system normal" {\n  ‸\n}\n', 'level'],
    ['scenario level', 'scenario "s" {\n level "HV" {\n  ‸\n }\n}\n', 'I2'],
    ['point', 'point "inrush" {\n  ‸\n}\n', 'scenario'],
    ['annotate', 'annotate {\n  ‸\n}\n', 'on_curve'],
    ['fault entry', 'faults {\n "F" {\n  ‸\n }\n}\n', 'I'],
    ['voltage level', 'system {\n voltages {\n  "HV" {\n   ‸\n  }\n }\n}\n', 'V'],
    ['grade', 'grade {\n  ‸\n}\n', 'scenario'],
    ['solve', 'grade {\n solve {\n  ‸\n }\n}\n', 'strategy'],
    ['page', 'page {\n  ‸\n}\n', 'orientation'],
    ['page legend', 'page {\n legend = {\n  ‸\n };\n}\n', 'currents'],
    ['page axes', 'page {\n axes = {\n  ‸\n };\n}\n', 'mirror'],
  ];

  for (const [name, doc, expected] of cases) {
    it(`offers ${name} fields`, () => {
      expect(offer(doc)).toContain(expected);
    });
  }

  it('leaves a block when its brace closes', () => {
    const inView = offer('relay R { element 51 { } }\nview {\n  ‸\n}\n');
    expect(inView).toContain('current_min');
    expect(inView).not.toContain('ct_ratio');
  });

  it('does not mistake a nested block for its parent', () => {
    /* Inside `solve`, the grade's own fields are the wrong answer. */
    const inSolve = offer('grade {\n solve {\n  ‸\n }\n}\n');
    expect(inSolve).toContain('strategy');
    expect(inSolve).not.toContain('margin');
  });
});

describe('offering the values a field accepts', () => {
  it('lists the axis quantities after `quantity =`', () => {
    const values = offer('view {\n  quantity = ‸\n}\n');
    expect(values).toEqual(expect.arrayContaining(['any', 'phase', 'I2', '3I0']));
  });

  it('lists the measured quantities after `measures =`', () => {
    const values = offer('relay R {\n element 46 {\n  measures = ‸\n }\n}\n');
    expect(values).toEqual(expect.arrayContaining(['I2', '3I2']));
    /* An element measures something definite; `any` is an axis idea. */
    expect(values).not.toContain('any');
  });

  it('lists the fault types after `type =`', () => {
    expect(offer('faults {\n "F" {\n  type = ‸\n }\n}\n'))
      .toEqual(expect.arrayContaining(['two_phase', 'single_phase_earth']));
  });

  it('lists the legend current modes', () => {
    expect(offer('page {\n legend = {\n  currents = ‸\n };\n}\n'))
      .toEqual(expect.arrayContaining(['"secondary"', '"both"']));
  });

  const WITH_CONDITIONS = `system {
  voltages { "HV" { V  = 33 kV; } }
}
faults {
  "F_max" { I   = 6 kA; voltage = "HV"; }
}
scenario "system normal" { level "HV" { I   = 900 A; } }
`;

  it('names the declared conditions, faults and scenarios alike', () => {
    /*
     * Everything that references a condition takes either, so offering
     * only the faults hides half the answer.
     */
    for (const key of ['condition', 'scenario', 'fault']) {
      const doc = `${WITH_CONDITIONS}view {\n  ${key} = ‸\n}\n`;
      expect(offer(doc), key).toEqual(expect.arrayContaining(['F_max', 'system normal']));
    }
  });

  it('names the declared voltage levels after `voltage =`', () => {
    expect(offer(`${WITH_CONDITIONS}view {\n  voltage = ‸\n}\n`)).toContain('HV');
  });

  it('names the declared voltage levels after `second_axis =`', () => {
    /*
     * `second_axis` names a level exactly as `voltage` does -- the one
     * the top scale is drawn in -- but was not wired to the same
     * completion, so it offered nothing at all.
     */
    const TWO_LEVELS = `system {
  voltages { "HV" { V = 33 kV; } "LV" { V = 11 kV; } }
}
`;
    expect(offer(`${TWO_LEVELS}view {\n  voltage = LV;\n  second_axis = ‸\n}\n`)).toContain('HV');
  });

  const WITH_RELAYS = `relay R_INCOMER { voltage = "HV"; ct_ratio = 400/5; }
relay R_FEEDER { voltage = "HV"; ct_ratio = 400/5; }
group FEEDER_1 { members = [R_INCOMER, R_FEEDER]; }
`;

  it('names declared relays after `members =`', () => {
    /* `group.members` takes bare relay ids, not `relay:element` refs,
     * so `refCompletions` (built for the latter) cannot answer it. */
    expect(offer(`${WITH_RELAYS}group FEEDER_2 {\n  members = [‸\n}\n`))
      .toEqual(expect.arrayContaining(['R_INCOMER', 'R_FEEDER']));
  });

  it('names declared groups after `group =`', () => {
    expect(offer(`${WITH_RELAYS}view {\n  group = ‸\n}\n`)).toContain('FEEDER_1');
  });

  it('offers group and combine their own fields, not nothing', () => {
    /*
     * `BLOCK_FIELDS` keyed `combine`'s fields under `combined` -- a
     * typo `detectActiveBlock` (which reads the block name from the
     * keyword that opened it, always `combine`) could never match --
     * and had no entry for `group` at all. Both bodies offered nothing
     * but the cross-cutting `comment`.
     */
    expect(offer('combine {\n  ‸\n}\n')).toContain('sources');
    expect(offer('group G {\n  ‸\n}\n')).toContain('members');
  });
});
