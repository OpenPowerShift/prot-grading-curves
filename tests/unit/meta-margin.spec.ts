/**
 * `meta { margin }` as the study-wide default.
 *
 * Four documents said it was one -- guide, tutorial, skill, and the
 * `meta` reference -- and nothing read it. `parseMeta` drops every key
 * into a free-form map, and a `grade` took `CTI_min_s` from its own
 * block or not at all. So a study that stated its margin once, at the
 * top, graded against no requirement, printed "not evaluated", and
 * exited 0: a study that does not coordinate passing CI in silence,
 * which is the gate the exit-status work was done to close.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

const study = (meta: string, grade: string): string => `
${meta}
system { voltages { HV { V = 33 kV; } } }
faults { F { I = 6 kA; type = three_phase; voltage = HV; } }
relay R_A { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.10; } }
relay R_B { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 500 A; tms = 0.12; } }
grade { primary = R_A:51; backup = R_B:51; fault = F; ${grade} }
view { voltage = HV; }
`;

const report = (src: string) => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  return r.reports[0]!;
};

describe('a margin declared once in meta', () => {
  it('becomes the requirement every grade is judged against', () => {
    const rep = report(study('meta { margin = 0.90 s; }', ''));
    expect(rep.CTI_min_s).toBe(0.9);
  });

  it('turns an unevaluated pair into a verdict', () => {
    /*
     * The symptom as a reader met it: a study achieving 0.078 s
     * against a stated 0.90 s said "no margin could be computed".
     */
    const rep = report(study('meta { margin = 0.90 s; }', ''));
    expect(rep.pass).toBe(false);
  });

  it('does not override a grade that states its own', () => {
    /* A default, not an override. */
    const rep = report(study('meta { margin = 0.90 s; }', 'margin = 0.05 s;'));
    expect(rep.CTI_min_s).toBe(0.05);
    expect(rep.pass).toBe(true);
  });

  it('leaves a study with no margin anywhere unevaluated, as before', () => {
    const rep = report(study('meta { project = "X"; }', ''));
    expect(rep.CTI_min_s).toBeUndefined();
  });

  it('ignores a meta margin that is not a usable number', () => {
    /*
     * `meta` is free-form -- it carries whatever the office puts in a
     * title block -- so a key read for meaning checks what it found
     * rather than assuming.
     */
    expect(report(study('meta { margin = "soon"; }', '')).CTI_min_s).toBeUndefined();
  });
});
