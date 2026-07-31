/**
 * Typos that used to cost a study its answer in silence.
 *
 * A protection study that reads as coordinated when it is not can get
 * someone hurt, so a name or a unit the language does not know has to
 * be refused rather than skipped. Both of these were found by review:
 * each parsed clean, and each moved a reported margin by a factor of
 * ten or a thousand without a word.
 */

import { describe, expect, it } from 'vitest';
import { process } from '@tc/index';

const errorsIn = (body: string): string[] => {
  const src = `
system { voltages { "HV" { kV = 33; } } }
relay R { voltage = "HV"; element 51 { curve = iec.si; ${body} } }
view { voltage = "HV"; }
`;
  const r = process(src);
  return [...r.parseErrors, ...r.diagnostics]
    .filter((e) => e.severity === 'error').map((e) => e.code);
};

describe('a misspelt setting', () => {
  it('is refused, not skipped', () => {
    /*
     * `tsm` for `tms` left the element at the default multiplier of 1.0
     * -- a margin out by ten, reported as a clean pass or fail with
     * nothing to show anything had gone wrong.
     */
    expect(errorsIn('I_pu = 400 A; tsm = 0.1;')).toContain('UNKNOWN_SETTING');
  });

  it('catches the wrong case too', () => {
    expect(errorsIn('I_pu = 400 A; TMS = 0.1;')).toContain('UNKNOWN_SETTING');
  });

  it('leaves every real setting alone', () => {
    for (const body of [
      'I_pu = 400 A; tms = 0.1;',
      'I_pu = 400 A; tms = 0.1; comment = "note";',
      'function = "phase_oc"; measures = "phase"; I_pu = 400 A; tms = 0.1;',
      'I_pu = 400 A; tms = 0.1; reset = "instant"; directional = true;',
      'I_pu = 400 A; tms = 0.1; name = "Phase OC"; t_reset = 0.1 s;',
    ]) {
      expect(errorsIn(body), body).toEqual([]);
    }
  });
});

describe('a unit the language does not know', () => {
  it('is refused rather than read as no unit at all', () => {
    /*
     * `4 KA` became 4 A and `60 msec` became 60 seconds -- a thousand
     * either way, in the two fields that decide whether a relay
     * operates. `readNumber` deliberately leaves an unknown suffix
     * alone and its comment always said the validator would complain;
     * nothing did.
     */
    expect(errorsIn('I_pu = 4 KA; tms = 0.1;')).toContain('UNIT_UNKNOWN');
    expect(errorsIn('I_pu = 400 A; tms = 0.1; t_delay = 60 msec;')).toContain('UNIT_UNKNOWN');
  });

  it('names the suffix and says the case matters', () => {
    const src = `system { voltages { "HV" { kV = 33; } } }
relay R { voltage = "HV"; element 51 { curve = definite; I_pu = 4 KA; t_delay = 20 ms; } }
view { voltage = "HV"; }`;
    const found = [...process(src).parseErrors, ...process(src).diagnostics]
      .find((e) => e.code === 'UNIT_UNKNOWN');
    expect(found?.message).toContain('"KA"');
    expect(found?.message).toContain('case-sensitive');
  });

  it('accepts every spelling the language does define', () => {
    for (const body of [
      'I_pu = 4 kA; tms = 0.1;',
      'I_pu = 400 mA; tms = 0.1;',
      'I_pu = 5 A_sec; tms = 0.1;',
      'I_pu = 2 pu; tms = 0.1;',
      'I_pu = 400 A; tms = 0.1; t_delay = 60 ms;',
      'I_pu = 400 A; tms = 0.1; t_delay = 1 min;',
      'I_pu = 400 A; tms = 0.1; char_angle = 60 deg;',
    ]) {
      expect(errorsIn(body), body).not.toContain('UNIT_UNKNOWN');
    }
  });

  it('reports one error per distinct suffix, not one per use', () => {
    const codes = errorsIn('I_pu = 4 KA; tms = 0.1; t_delay = 3 KA;');
    expect(codes.filter((c) => c === 'UNIT_UNKNOWN')).toHaveLength(1);
  });
});
