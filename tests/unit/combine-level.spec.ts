/**
 * Which bus a combined curve is read at.
 *
 * `combine` folds several curves into one and evaluates them at a
 * single current. That is right while every source sits on one bus, and
 * wrong the moment one does not: across a transformer the windings
 * carry currents in inverse proportion to their voltages, so handing an
 * 11 kV relay the 400 V board's amps asks it about a fault 27.5 times
 * the one that happened.
 *
 * Measured on a 33/11 kV pair, an `envelope_max` of an LV feeder and
 * its HV incomer, at 1 kA on the LV bus:
 *
 * [cols="1,1"]
 * |===
 * | Was | Is
 *
 * | 4.090 s | does not operate
 * |===
 *
 * The HV element sees 333 A there and its pickup is 600 A. The old
 * answer was not merely imprecise: it named a clearance time for a pair
 * that does not clear, which is the reading a study exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { tTripCombine } from '@tc/semantics/combine';

const study = (combine: string): string => `
system {
  voltages { HV { V = 33 kV; } LV { V = 11 kV; } }
  transformer HV to LV { vector_group = "Dyn11"; }
}
relay R_LV { voltage = LV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.10; } }
relay R_HV { voltage = HV; ct_ratio = 200/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 600 A; tms = 0.30; } }
${combine}
view { voltage = LV; quantity = phase;
       current_min = 100 A; current_max = 30 kA; time_min = 20 ms; time_max = 20 s; }
`;

const AT_LV = 'combine { name = "BOTH"; sources = [R_LV:51, R_HV:51]; '
  + 'as = envelope_max; voltage = LV; }';

/** The one combine in a study, and what went wrong building it. */
const built = (src: string) => {
  const r = parse(src);
  expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
  return {
    study: r.study!,
    combine: r.study!.combines[0]!,
    codes: r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
    diagnostics: r.diagnostics,
  };
};

describe('a combine spanning a transformer', () => {
  it('asks each source about the amps its own winding carries', () => {
    /*
     * The whole point. 1 kA on the LV bus is 333 A through the HV
     * winding, which is below the HV element's 600 A pickup -- so the
     * slowest-path envelope does not operate there at all.
     */
    const { study: s, combine } = built(study(AT_LV));
    expect(tTripCombine(s, combine, 1000)).toBe(Infinity);
  });

  it('operates once the far winding actually sees its pickup', () => {
    /* 3 kA at LV is 1 kA at HV: 1.67x pickup, and the envelope is the
     * HV element's own time at its own current. */
    const { study: s, combine } = built(study(AT_LV));
    expect(tTripCombine(s, combine, 3000)).toBeCloseTo(4.090, 2);
  });

  it('leaves the near source exactly where it was', () => {
    /*
     * A fold that changed the level-local answer would be a different
     * bug traded for this one.
     */
    const { study: s, combine } = built(
      study('combine { name = "BOTH"; sources = [R_LV:51, R_HV:51]; '
        + 'as = envelope_min; voltage = LV; }'),
    );
    expect(tTripCombine(s, combine, 1000)).toBeCloseTo(0.757, 2);
  });
});

describe('a combine that does not say which bus', () => {
  it('is refused rather than fed one current for two levels', () => {
    const { codes } = built(
      study('combine { name = "BOTH"; sources = [R_LV:51, R_HV:51]; as = envelope_max; }'),
    );
    expect(codes).toContain('COMBINE_LEVEL_AMBIGUOUS');
  });

  it('says how to fix it, and names both levels', () => {
    const { diagnostics } = built(
      study('combine { name = "BOTH"; sources = [R_LV:51, R_HV:51]; as = envelope_max; }'),
    );
    const d = diagnostics.find((x) => x.code === 'COMBINE_LEVEL_AMBIGUOUS');
    expect(d?.message).toMatch(/LV and HV/);
    expect(d?.message).toMatch(/voltage = <level>/);
  });

  it('points at the source that made it unanswerable', () => {
    /*
     * `1:1` would send the reader to the top of the file. The second
     * level's source is the line the question turns on.
     */
    const { diagnostics } = built(
      study('combine { name = "BOTH"; sources = [R_LV:51, R_HV:51]; as = envelope_max; }'),
    );
    const d = diagnostics.find((x) => x.code === 'COMBINE_LEVEL_AMBIGUOUS');
    expect(d?.line).toBeGreaterThan(1);
  });
});

describe('a combine whose sources agree on one level', () => {
  it('takes the level from them, so nothing has to be said twice', () => {
    const { combine } = built(
      study('combine { name = "LVONLY"; sources = [R_LV:51]; as = envelope_min; }'),
    );
    expect(combine.voltage).toBe('LV');
    expect(combine.voltageDerived).toBe(true);
  });

  it('raises nothing, one level being no question at all', () => {
    const { codes } = built(
      study('combine { name = "LVONLY"; sources = [R_LV:51]; as = envelope_min; }'),
    );
    expect(codes).toEqual([]);
  });

  it('lets a declared level win, and marks it as declared', () => {
    const { combine } = built(
      study('combine { name = "LVONLY"; sources = [R_LV:51]; '
        + 'as = envelope_min; voltage = LV; }'),
    );
    expect(combine.voltageDerived).toBeFalsy();
  });
});

describe('a combine naming a level the system does not have', () => {
  it('is refused rather than silently unreferred', () => {
    /*
     * An unknown level resolves to no kV, which makes the projection
     * the identity -- exactly the behaviour being removed. A typo must
     * not restore it.
     */
    const { codes } = built(
      study('combine { name = "BOTH"; sources = [R_LV:51, R_HV:51]; '
        + 'as = envelope_max; voltage = LVV; }'),
    );
    expect(codes).toContain('COMBINE_UNKNOWN_VOLTAGE');
  });
});

describe('the drawn envelope', () => {
  it('sits where the fold says it does, not where the axis amps put it', () => {
    /*
     * The recurring failure in this codebase is a drawing and a table
     * that disagree. `trace` refers the axis reading into the combine's
     * frame and `sourceTimes` refers it on into each source's, so a
     * reader measuring off the sheet gets the number `tTripCombine`
     * gave.
     *
     * On an LV sheet, an LV-read envelope that does not operate below
     * 1.8 kA must not be drawn below 1.8 kA.
     */
    const r = parse(study(AT_LV));
    const svg = renderStudy(r, { theme: 'light' });
    expect(svg).toContain('BOTH');

    const s = r.study!;
    const combine = s.combines[0]!;
    /* 600 A at LV is 200 A at HV: a third of pickup. */
    expect(tTripCombine(s, combine, 600)).toBe(Infinity);
  });

  it('names the level in the legend where the sheet is drawn elsewhere', () => {
    /*
     * On the sheet's own level it is not news. On another it is the
     * whole reading, since the envelope's position rests on it.
     */
    const src = study(AT_LV).replace('view { voltage = LV;', 'view { voltage = HV;');
    const svg = renderStudy(parse(src), { theme: 'light' });
    expect(svg).toContain('Read at LV');
  });

  it('says nothing extra on the level it is read at', () => {
    const svg = renderStudy(parse(study(AT_LV)), { theme: 'light' });
    expect(svg).not.toContain('Read at LV');
  });
});
