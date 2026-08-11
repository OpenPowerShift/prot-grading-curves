/**
 * `currents`: `times`'s answer in the other direction.
 *
 * A `times` block draws a horizontal rule -- a required time the
 * curves are judged against. A `currents` block draws the vertical
 * counterpart -- a plant or equipment rating (a cable withstand, a
 * busbar short-time rating) rather than a condition curves are
 * evaluated at. It shares a fault's component vocabulary and a
 * time's caption-anchor idea (`at_t` here, `at_I` there), but is
 * never usable where a `grade` or `scenario` takes a condition, since
 * it names no condition at all.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const BASE = `
system { voltages { HV { V = 33 kV; } } }
faults { F1 { I = 6 kA; type = three_phase; voltage = HV; } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = HV; }
`;

describe('declaring a currents rating', () => {
  it('parses and validates cleanly', () => {
    const src = `${BASE}\ncurrents { CABLE { I = 8.5 kA; at_t = 1 s; description = "1s withstand"; } }`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('UNKNOWN_SETTING');
  });

  it('refuses a misspelt key, strictly, like a fault', () => {
    const src = `${BASE}\ncurrents { CABLE { I = 8.5 kA; tpe = three_phase; } }`;
    const r = parse(src);
    expect([...r.parseErrors, ...r.diagnostics].map((d) => d.code)).toContain('UNKNOWN_SETTING');
  });

  it('draws a vertical rule at the declared current', () => {
    const src = `${BASE}\ncurrents { CABLE { I = 8.5 kA; } }`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect(svg).toContain('class="tc-current-rating"');
    expect(svg).toMatch(/data-fault="CABLE" data-current="8500" data-kind="rating"/);
  });

  it('requires a positive I, like a fault does', () => {
    const src = `${BASE}\ncurrents { RATING { I2 = 2 kA; type = two_phase; } }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('RATING_CURRENT_INVALID');
  });

  it('takes the component vocabulary a fault does', () => {
    const src = `
system { voltages { HV { V = 33 kV; } } }
currents { RATING { I = 1 kA; I2 = 2 kA; type = two_phase; } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 46 { function = neg_seq; measures = I2; curve = iec.si; I_pickup = 500 A; tms = 0.2; } }
view { voltage = HV; quantity = I2; }
`;
    const r = parse(src);
    expect([...r.parseErrors, ...r.diagnostics].map((d) => d.code)).not.toContain('UNKNOWN_SETTING');
    const svg = renderStudy(r, { theme: 'light' });
    expect(svg).toContain('class="tc-current-rating"');
    /* Declared I2 wins over the phase figure derived by `type`. */
    expect(svg).toMatch(/data-current="2000"/);
  });

  it('is never resolvable as a fault or scenario condition', () => {
    /* Lives in its own map, never study.faults / study.scenarios, so
     * a grade or scenario naming it is refused as an unresolved
     * reference -- the same as naming anything else undeclared. */
    const src = `${BASE}\ncurrents { CABLE { I = 8.5 kA; } }
grade { primary = R:51; fault = CABLE; margin = 0.3 s; }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('UNRESOLVED_REFERENCE');
  });
});

describe('a currents rating on the legend', () => {
  it('is headed "Ratings" apart from the fault rules', () => {
    const src = `
system { voltages { HV { V = 33 kV; } } }
currents { CABLE { I = 8.5 kA; description = "1s withstand"; } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = HV; }
`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect(svg).toContain('>Ratings<');
    expect(svg).toContain('CABLE');
  });

  it('shares the panel, headed "Faults and ratings", once both are shown', () => {
    const src = `${BASE}\ncurrents { CABLE { I = 8.5 kA; } }`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect(svg).toContain('>Faults and ratings<');
  });

  it('is styled with the times ink, not the fault ink', () => {
    const src = `${BASE}\ncurrents { CABLE { I = 8.5 kA; } }`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    const faultLine = /<line[^>]*class="tc-fault"[^>]*stroke="([^"]+)"/.exec(svg);
    const ratingLine = /<line[^>]*class="tc-current-rating"[^>]*stroke="([^"]+)"/.exec(svg);
    expect(faultLine, 'a fault line was drawn').not.toBeNull();
    expect(ratingLine, 'a rating line was drawn').not.toBeNull();
    expect(ratingLine![1]).not.toBe(faultLine![1]);
  });
});

describe('a rating with nothing to say on this sheet\'s axis', () => {
  it('is counted in the notes rather than drawn silently wrong', () => {
    const src = `
system { voltages { HV { V = 33 kV; } } }
currents { RATING { I = 8.5 kA; } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 46 { function = neg_seq; measures = I2; curve = iec.si; I_pickup = 500 A; tms = 0.2; } }
view { voltage = HV; quantity = I2; }
`;
    /* Declares only phase, no type to derive I2 from -- unplaceable
     * on an I2 axis, exactly as the same fault position would be. */
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect(svg).not.toContain('class="tc-current-rating"');
    expect(svg).toMatch(/RATING declares no/);
  });
});
