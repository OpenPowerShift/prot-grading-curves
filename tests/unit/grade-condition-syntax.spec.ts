/**
 * `grade { fault; scenario; }`: one condition, not a list.
 *
 * `annotate`, `point` and `times` all accept a list, a `~` exclusion or
 * a `NAME.LEVEL` scenario reference in a condition field, because each
 * draws one mark per condition and a list is just several marks. A
 * `grade` is different: it compares one primary against one backup and
 * produces one verdict, so none of that generality applies, and the
 * field only ever took one bare name.
 *
 * Writing the richer syntax there anyway used to read one token and
 * leave the rest -- the `[`, the `.LEVEL`, the `~` -- sitting in the
 * stream, where the block's own field loop silently skipped the
 * punctuation and reported the next bare word as an unrelated unknown
 * key. These tests pin the clearer, specific error instead.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@tc/parser';

const errorsOf = (src: string) => parse(src).errors.map((e) => e.code);

const BASE = `
system { voltages { HV { V = 33 kV; } } }
faults { F1 { I = 4 kA; type = three_phase; voltage = HV; } }
scenario S1 { type = two_phase; level HV { I = 3 kA; I2 = 1.7 kA; } }
relay R1 { voltage = HV; ct_ratio = 400/5; element 51 { curve = iec.si; I_pickup = 300 A; tms = 0.2; } }
relay R2 { voltage = HV; ct_ratio = 400/5; element 51 { curve = iec.si; I_pickup = 200 A; tms = 0.4; } }
`;

const grade = (body: string) => `${BASE}\ngrade { primary = R1:51; backup = R2:51; ${body} }`;

describe('a plain condition name', () => {
  it('still parses cleanly on fault', () => {
    expect(errorsOf(grade('fault = F1;'))).toEqual([]);
  });

  it('still parses cleanly on scenario', () => {
    expect(errorsOf(grade('scenario = S1;'))).toEqual([]);
  });
});

describe('a list, where only one condition is accepted', () => {
  it('names the specific mistake, not a cascade of unrelated errors', () => {
    const codes = errorsOf(grade('fault = [F1];'));
    expect(codes).toEqual(['EXPECTED_TOKEN']);
  });

  it('reads as one condition, not several, in the message', () => {
    const errors = parse(grade('fault = [F1];')).errors;
    expect(errors[0].message).toMatch(/one condition, not a list/);
  });

  it('recovers cleanly enough to parse whatever comes after', () => {
    const doc = parse(grade('fault = [F1]; margin = 0.3 s;')).document!;
    const g = doc.items.find((i) => i.type === 'grade') as { CTI_min_s?: number };
    expect(g.CTI_min_s).toBe(0.3);
  });
});

describe('a scenario-level reference, where only the bare scenario is accepted', () => {
  it('names the specific mistake, not a cascade of unrelated errors', () => {
    const codes = errorsOf(grade('scenario = S1.HV;'));
    expect(codes).toEqual(['EXPECTED_TOKEN']);
  });

  it('explains that a grade is graded at the shared level, not one it picks', () => {
    const errors = parse(grade('scenario = S1.HV;')).errors;
    expect(errors[0].message).toMatch(/not one of its levels/);
  });

  it('recovers cleanly enough to parse whatever comes after', () => {
    const doc = parse(grade('scenario = S1.HV; margin = 0.3 s;')).document!;
    const g = doc.items.find((i) => i.type === 'grade') as { CTI_min_s?: number };
    expect(g.CTI_min_s).toBe(0.3);
  });
});
