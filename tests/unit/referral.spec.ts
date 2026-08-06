/**
 * Carrying a fault current across a transformer.
 *
 * The tool referred every fault by `I x V_from / V_to`, whatever the
 * fault was and whatever the windings were. That is exact for a
 * balanced fault and wrong for the rest: a delta-star transition
 * rotates the positive- and negative-sequence components in opposite
 * directions, so they recombine differently on the far side.
 *
 * Measured on a 33/11 kV Dyn11 with a 6 kA fault on the 11 kV side:
 *
 * [cols="1,1,1"]
 * |===
 * | Fault | Was | Is
 *
 * | `three_phase`        | 2000 A | 2000 A
 * | `two_phase`          | 2000 A | 2309 A
 * | `single_phase_earth` | 2000 A | 1155 A
 * |===
 *
 * The middle row is the dangerous one. It is the standard
 * minimum-fault check, the backup carries 15.5% more than the ratio
 * gave, so it operates *faster* -- and the margin the report printed
 * was larger than the one that exists.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const study = (type: string, transformer: string): string => `
system {
  voltages { HV { V = 33 kV; } LV { V = 11 kV; } }
  ${transformer}
}
faults { F { type = ${type}; I = 6 kA; voltage = LV; } }
relay R_LV { voltage = LV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
relay R_HV { voltage = HV; ct_ratio = 200/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 200 A; tms = 0.3; } }
grade { primary = R_LV:51; backup = R_HV:51; fault = F; margin = 0.3 s; upstream = false; }
view { voltage = HV; quantity = phase;
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;

const DYN = 'transformer HV to LV { vector_group = "Dyn11"; }';
const YNYN = 'transformer HV to LV { vector_group = "YNyn0"; }';

/** What the HV backup was actually evaluated at, and what went wrong. */
const graded = (src: string): { I_HV: number | null; codes: string[] } => {
  const r = parse(src);
  expect(r.parseErrors).toEqual([]);
  const row = r.reports[0]?.rows.find((x) => x.at === 'I');
  return {
    I_HV: row?.I_backup_A ?? null,
    codes: r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
  };
};

describe('a delta-star transformer', () => {
  it('leaves a balanced fault at the turns ratio', () => {
    expect(graded(study('three_phase', DYN)).I_HV).toBeCloseTo(2000, 0);
  });

  it('carries a phase-phase fault 15.5% higher than the ratio', () => {
    /*
     * The whole point. 2000 A was the old answer and it made the
     * backup look slower than it is.
     */
    expect(graded(study('two_phase', DYN)).I_HV).toBeCloseTo(2309, 0);
  });

  it('reports the smaller margin that follows', () => {
    const wide = parse(study('two_phase', YNYN)).reports[0]!.rows[0]!.margin_s;
    const real = parse(study('two_phase', DYN)).reports[0]!.rows[0]!.margin_s;
    expect(real).toBeLessThan(wide);
  });

  it('carries an earth fault at 1/sqrt(3), the delta having eaten the zero sequence', () => {
    expect(graded(study('single_phase_earth', DYN)).I_HV).toBeCloseTo(1155, 0);
  });
});

describe('a star-star transformer', () => {
  it('transposes nothing, so the ratio stands', () => {
    expect(graded(study('two_phase', YNYN)).I_HV).toBeCloseTo(2000, 0);
  });

  it('still refuses an earth fault, which the turns ratio does not settle', () => {
    /*
     * `YNyn0` does pass zero sequence, but how much each winding
     * carries is set by the zero-sequence impedance network --
     * earthing resistors, a delta tertiary, the source behind each.
     * The study has to say.
     */
    expect(graded(study('single_phase_earth', YNYN)).codes)
      .toContain('REFERRAL_NEEDS_CONNECTION');
  });
});

describe('with no transformer declared', () => {
  it('still refers a balanced fault, the ratio being right for one', () => {
    /*
     * Every single-shape study written before this keeps working. The
     * refusal is narrow on purpose: it applies where the answer
     * actually depends on the windings.
     */
    expect(graded(study('three_phase', '')).I_HV).toBeCloseTo(2000, 0);
    expect(graded(study('three_phase', '')).codes).toEqual([]);
  });

  it('refuses an unbalanced one rather than quoting the ratio', () => {
    for (const type of ['two_phase', 'single_phase_earth']) {
      const g = graded(study(type, ''));
      expect(g.codes, `${type} should be refused`).toContain('REFERRAL_NEEDS_CONNECTION');
      expect(g.I_HV, `${type} should produce no margin row`).toBeNull();
    }
  });

  it('says how to fix it, both ways', () => {
    const d = parse(study('two_phase', '')).diagnostics
      .find((x) => x.code === 'REFERRAL_NEEDS_CONNECTION');
    expect(d?.message).toMatch(/vector_group/);
    expect(d?.message).toMatch(/scenario/);
  });
});

describe('the sheet and the report', () => {
  it('put the fault at the same current', () => {
    /*
     * The recurring failure in this codebase is a drawing and a table
     * that disagree about one condition. The rule is placed from the
     * same factor the margin was computed from, so a reader measuring
     * off the sheet gets the number the report used.
     */
    const src = study('two_phase', DYN);
    const r = parse(src);
    const svg = renderStudy(r, { theme: 'light' });
    const graded_I = r.reports[0]!.rows[0]!.I_backup_A!;

    /* The fault rule's caption carries the current it stands at. */
    const caption = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
      .map((m) => m[1])
      .find((t) => /kA/.test(t) && /F\b/.test(t));
    expect(caption, 'the sheet should caption its fault rule').toBeDefined();
    expect(graded_I).toBeCloseTo(2309, 0);
    expect(caption).toContain('2.31 kA');
  });
});

describe('the vector group also settles zero sequence', () => {
  it('derives it, so a study need not say the same thing twice', () => {
    const r = parse(study('three_phase', DYN));
    expect(r.study!.zeroSequence.size).toBeGreaterThan(0);
    expect([...r.study!.zeroSequence.values()][0]).toBe('blocked');
  });

  it('lets an explicit declaration win, being the narrower statement', () => {
    /*
     * An earthing transformer, or a star-star with one neutral lifted,
     * is a case the group alone does not settle.
     */
    const r = parse(study('three_phase',
      `${DYN}\n  zero_sequence { HV to LV = continuous; }`));
    expect([...r.study!.zeroSequence.values()][0]).toBe('continuous');
  });
});

describe('an unreadable vector group', () => {
  it('is refused rather than half-read', () => {
    /*
     * Taking the first five characters of `Dyn11 (assumed)` and
     * carrying on would be the same silent guess the plain ratio was.
     */
    const g = graded(study('two_phase', 'transformer HV to LV { vector_group = "Dyn11ish"; }'));
    expect(g.codes).toContain('VECTOR_GROUP_UNREADABLE');
  });

  it('is reported where it was written, not as a missing transformer', () => {
    /*
     * The study did declare one. Reporting "no transformer is
     * declared" would send the author looking in the wrong place.
     */
    const d = parse(study('two_phase', 'transformer HV to LV { vector_group = "Dyn11ish"; }'))
      .diagnostics.find((x) => x.code === 'VECTOR_GROUP_UNREADABLE');
    expect(d?.message).toMatch(/Dyn11, YNd1/);
    expect(d?.line).toBeGreaterThan(1);
  });
});
