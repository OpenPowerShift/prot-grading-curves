/**
 * `~NAME`: "every declared name except NAME", wherever a list of
 * views or conditions is written.
 *
 * The alternative to spelling out every sheet but one, or every
 * condition but one -- which used to be the only way, and grew one
 * more name to maintain every time a new view or fault joined the
 * study. A list is read as an include list or an exclude list, never
 * both: mixing `~` with a plain name has no single meaning, so it is
 * refused rather than guessed at.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const BASE = `
system { voltages { HV { V = 33 kV; } } }
faults { F1 { I = 1 kA; type = three_phase; voltage = HV; }
         F2 { I = 2 kA; type = three_phase; voltage = HV; } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view PHASE { voltage = HV; }
view NEGATIVE { voltage = HV; }
`;

describe('~NAME in a views list', () => {
  it('draws on every sheet except the one named', () => {
    const src = `${BASE}\nfaults { F3 { I = 3 kA; type = three_phase; voltage = HV; views = [~NEGATIVE]; } }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).not.toContain('UNRESOLVED_VIEW');

    const phase = r.study!.views.find((v) => v.id === 'PHASE');
    const negative = r.study!.views.find((v) => v.id === 'NEGATIVE');
    const onPhase = renderStudy(r, { theme: 'light', view: phase });
    const onNegative = renderStudy(r, { theme: 'light', view: negative });
    expect(onPhase).toMatch(/data-fault="F3"/);
    expect(onNegative).not.toMatch(/data-fault="F3"/);
  });

  it('still checks the excluded name exists', () => {
    const src = `${BASE}\nfaults { F3 { I = 3 kA; type = three_phase; voltage = HV; views = [~NOPE]; } }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('UNRESOLVED_VIEW');
  });

  it('refuses mixing a plain name with an exclusion', () => {
    const src = `${BASE}\nfaults { F3 { I = 3 kA; type = three_phase; voltage = HV; views = [PHASE, ~NEGATIVE]; } }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('MIXED_INCLUSION_EXCLUSION');
  });

  it('warns when every declared view is excluded', () => {
    const src = `${BASE}\nfaults { F3 { I = 3 kA; type = three_phase; voltage = HV; views = [~PHASE, ~NEGATIVE]; } }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('EXCLUSION_EMPTIES_SCOPE');
  });
});

describe('~NAME in a condition list', () => {
  it('draws one mark per condition except the one named', () => {
    const src = `${BASE}\nannotate { on_curve = R:51; fault = [~F1]; label = "reach"; }`;
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect([...svg.matchAll(/reach/g)]).toHaveLength(1);
  });

  it('still checks the excluded condition exists', () => {
    const src = `${BASE}\nannotate { on_curve = R:51; fault = [~NOPE]; label = "x"; }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('UNRESOLVED_REFERENCE');
  });

  it('refuses mixing a plain condition with an exclusion, for a point too', () => {
    const src = `${BASE}\npoint "p" { fault = [F1, ~F2]; t = 500 ms; label = "x"; }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('MIXED_INCLUSION_EXCLUSION');
  });

  it('warns when a point excludes every declared condition', () => {
    const src = `${BASE}\npoint "p" { fault = [~F1, ~F2]; t = 500 ms; label = "x"; }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('EXCLUSION_EMPTIES_SCOPE');
  });
});

describe('group.members', () => {
  it('does not accept a `~` exclusion', () => {
    /* A group defines the chain itself; there is no universe of
     * "every relay" to exclude from. `~` is read as a plain, unknown
     * relay name, which the group-member check refuses on its own
     * terms. */
    const src = `${BASE}\nrelay R2 { voltage = HV; ct_ratio = 400/5; }
group G { members = [R, ~R2]; }
view { voltage = HV; group = G; }`;
    const r = parse(src);
    expect(r.diagnostics.map((d) => d.code)).toContain('UNRESOLVED_GROUP_MEMBER');
  });
});
