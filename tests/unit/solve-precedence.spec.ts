/**
 * One relay, one dial, several grades that want a say in it.
 *
 * The solver wrote straight onto the shared stage and then recomputed
 * only its own rows, so every report that had already run was left
 * describing a curve the sheet no longer drew. Two solves on one
 * backup:
 *
 * [cols="1,1,1"]
 * |===
 * | Grade | Reported | Drawn
 *
 * | 1 | 0.313 s | 1.436 s
 * | 2 | 0.608 s | 0.608 s
 * |===
 *
 * A factor of 4.6 on one page. It did not need two solves either: a
 * plain grade written *above* a single solve reported at the declared
 * dial while the sheet showed the solved one -- 2.011 s against 1.436 s.
 *
 * Which answer governs is not a matter of source order. `t = TMS x
 * bracket(M)` with `bracket > 0` and independent of `TMS`, so operate
 * time rises with `TMS` at every current; a margin is a *lower* bound,
 * so the largest `TMS` any constraint asks for satisfies all of them.
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { tTripElement } from '@tc/semantics/stages';

const SYS = `
system { voltages { MV { V = 11 kV; } } }
faults { F_A { I = 3 kA; type = three_phase; voltage = MV; }
         F_B { I = 6 kA; type = three_phase; voltage = MV; } }
relay R_P1 { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.10; } }
relay R_P2 { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 500 A; tms = 0.20; } }
relay R_B { voltage = MV; ct_ratio = 800/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 800 A; tms = 0.45; } }
`;

const VIEW = `
view { voltage = MV; current_min = 100 A; current_max = 30 kA;
       time_min = 20 ms; time_max = 20 s; }
`;

/** The lax grade wants tms 0.125; the strict one wants 0.340. */
const LAX = 'grade { primary = R_P1:51; backup = R_B:51; fault = F_A; '
  + 'margin = 0.30 s; upstream = false; solve { strategy = tight; } }';
const STRICT = 'grade { primary = R_P2:51; backup = R_B:51; fault = F_B; '
  + 'margin = 0.60 s; upstream = false; solve { strategy = tight; } }';
const PLAIN = 'grade { primary = R_P1:51; backup = R_B:51; fault = F_A; '
  + 'margin = 0.30 s; upstream = false; }';

const run = (...grades: string[]) => {
  const r = parse(`${SYS}\n${grades.join('\n')}\n${VIEW}`);
  expect(r.parseErrors.filter((e) => e.severity === 'error')).toEqual([]);
  return r;
};

/** Every code raised on a given report. */
const codes = (r: ReturnType<typeof run>, i: number): string[] =>
  r.reports[i]!.diagnostics.map((d) => d.code);

describe('two grades solving one backup', () => {
  it('is settled by the constraint that demands the most, not by source order', () => {
    for (const order of [[LAX, STRICT], [STRICT, LAX]]) {
      const s = run(...order).study!;
      expect(s.relays.get('R_B')!.elements[0]!.stages[0]!.tms).toBeCloseTo(0.340, 3);
    }
  });

  it('reports every grade against the dial that was applied', () => {
    /*
     * The defect itself. Grade 1 printed 0.313 s -- its own solver's
     * answer -- while the sheet was drawn at a dial giving 1.436 s.
     */
    const r = run(LAX, STRICT);
    const s = r.study!;
    const backup = s.relays.get('R_B')!.elements[0]!;
    const primary = s.relays.get('R_P1')!.elements[0]!;
    const drawn = tTripElement(backup, 3000) - tTripElement(primary, 3000);

    expect(drawn).toBeCloseTo(1.436, 2);
    expect(r.reports[0]!.rows[0]!.margin_s).toBeCloseTo(drawn, 6);
  });

  it('says which constraint governed, rather than leaving a silent loser', () => {
    const r = run(LAX, STRICT);
    expect(codes(r, 0)).toContain('SOLVE_SUPERSEDED');
    const d = r.reports[0]!.diagnostics.find((x) => x.code === 'SOLVE_SUPERSEDED');
    expect(d?.message).toMatch(/asked for tms 0\.125/);
    expect(d?.message).toMatch(/R_P2:51 \/ R_B:51/);
    expect(d?.message).toMatch(/1\.340|0\.340/);
  });

  it('reports the override once, against the study\'s own declared dial', () => {
    /*
     * `tms_declared` used to be captured at override time, so the
     * second solve recorded the *first solver's output*: the legend
     * read `(auto, was 0.125)` for a file that says 0.45.
     */
    const r = run(LAX, STRICT);
    const overrides = r.reports.flatMap((rep) => rep.diagnostics)
      .filter((d) => d.code === 'SOLVE_OVERRODE_SETTING');
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.message).toMatch(/declared tms 0\.45\b/);
    expect(r.study!.relays.get('R_B')!.elements[0]!.stages[0]!.tms_declared).toBe(0.45);
  });

  it('does not print a solved time beside a multiplier that did not produce it', () => {
    /*
     * A superseded grade's `tms` is what it asked for, while its
     * `t_backup` has been recomputed at the governing dial. Pairing
     * them on one line would be a third answer belonging to neither,
     * so it prints as a plain margin.
     */
    const r = run(LAX, STRICT);
    expect(r.reports[0]!.solve?.superseded).toBe(true);
    expect(r.reports[1]!.solve?.superseded).toBeFalsy();
  });
});

describe('a grade written above a solve', () => {
  it('is recomputed too, even though it solves nothing itself', () => {
    /*
     * One solve anywhere was enough. The plain grade reported 2.011 s
     * at the declared dial while the sheet was drawn at the solved one.
     */
    const r = run(PLAIN, STRICT);
    const s = r.study!;
    const drawn = tTripElement(s.relays.get('R_B')!.elements[0]!, 3000)
      - tTripElement(s.relays.get('R_P1')!.elements[0]!, 3000);
    expect(drawn).toBeCloseTo(1.436, 2);
    expect(r.reports[0]!.rows[0]!.margin_s).toBeCloseTo(drawn, 6);
  });

  it('is recomputed when the solved element is its own primary', () => {
    /*
     * The staleness was never limited to backups. A solved element is
     * often the *primary* of the pair above it, and that report was
     * left describing one curve at its declared dial and the other at
     * its solved one.
     */
    const r = parse(`${SYS}
relay R_UP { voltage = MV; ct_ratio = 1200/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 1000 A; tms = 0.40; } }
grade { primary = R_B:51; backup = R_UP:51; fault = F_B; margin = 0.30 s; upstream = false; }
${STRICT}
${VIEW}`);
    const s = r.study!;
    const t_primary = tTripElement(s.relays.get('R_B')!.elements[0]!, 6000);
    expect(t_primary).toBeCloseTo(1.158, 2);
    expect(r.reports[0]!.rows[0]!.t_primary_s).toBeCloseTo(t_primary, 6);
  });
});

describe('a dial raised to satisfy one pair and breaking another', () => {
  it('fails, where two contradictory grades both used to pass', () => {
    /*
     * The point of recomputing rather than merely reporting. `check`
     * exited 0 on a study whose own solve destroyed a margin it had
     * already reported as passing.
     */
    const r = parse(`${SYS}
relay R_UP { voltage = MV; ct_ratio = 1200/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 1000 A; tms = 0.35; } }
grade { primary = R_B:51; backup = R_UP:51; fault = F_B; margin = 0.30 s; upstream = false; }
${STRICT}
${VIEW}`);
    expect(r.reports[0]!.pass).toBe(false);
    expect(r.reports[0]!.rows[0]!.margin_s).toBeLessThan(0.30);
  });
});

describe('a scenario grade', () => {
  const SCEN = `
system { voltages { HV { V = 33 kV; } } }
scenario S { type = three_phase;
  level HV { I = 7.2 kA; }
  sees R_F { share = 50; } }
relay R_F { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.20; } }
relay R_S { voltage = HV; ct_ratio = 800/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 900 A; tms = 2.0; } }
grade { primary = R_F:51; backup = R_S:51; scenario = S; margin = 0.40 s;
        solve { strategy = tight; free = [tms]; } }
view { voltage = HV; condition = S; current_min = 100 A; current_max = 30 kA;
       time_min = 20 ms; time_max = 100 s; }
`;

  it('solves at all', () => {
    /*
     * `reportScenarioGrade` returned before `reportGrade` reached the
     * solver, so `grade { scenario = ...; solve { ... } }` parsed,
     * validated and did nothing. Sample 15 shipped a comment saying
     * "`solve` APPLIES the setting it computes" beside a block that
     * computed nothing.
     */
    const r = parse(SCEN);
    expect(r.reports[0]!.solve?.ok).toBe(true);
    const stage = r.study!.relays.get('R_S')!.elements[0]!.stages[0]!;
    expect(stage.tms_auto).toBe(true);
    expect(stage.tms).not.toBe(2.0);
  });

  it('dials for the current the relay carries, not the level current', () => {
    /*
     * The primary takes 50% under this scenario, so the margin is held
     * open at 3.6 kA through it -- and the solver has to divide by the
     * same figure or it dials for twice the fault being graded.
     */
    const r = parse(SCEN);
    const row = r.reports[0]!.rows[0]!;
    expect(row.I_f_A).toBeCloseTo(3600, 0);
    expect(row.margin_s).toBeGreaterThanOrEqual(0.40);
  });

  it('draws the margin arrow at the figure the report computed', () => {
    /*
     * The arrow ignored `sees ... share` and gave the feeder the whole
     * level current, so a sheet captioned its own margin 77% wide of
     * the report printed beside it.
     */
    const r = parse(SCEN.replace('view {', 'annotate { primary = R_F:51; backup = R_S:51; '
      + 'scenario = S; label = "CTI"; }\nview {'));
    const svg = renderStudy(r, { theme: 'light' });
    const margin = r.reports[0]!.rows[0]!.margin_s;
    const caption = [...svg.matchAll(/<text[^>]*>([^<]*CTI[^<]*)<\/text>/g)].map((m) => m[1])[0];
    expect(caption, 'the sheet should caption its margin arrow').toBeDefined();
    expect(caption).toContain(`${Math.round(margin * 1000)} ms`);
  });
});

describe('a single solve', () => {
  it('behaves exactly as it did, having nothing to be governed by', () => {
    const r = run(STRICT);
    expect(codes(r, 0)).toContain('SOLVE_OVERRODE_SETTING');
    expect(codes(r, 0)).not.toContain('SOLVE_SUPERSEDED');
    expect(r.reports[0]!.rows[0]!.margin_s).toBeCloseTo(0.608, 3);
    expect(r.study!.relays.get('R_B')!.elements[0]!.stages[0]!.tms).toBeCloseTo(0.340, 3);
  });

  it('names the strategy it actually ran', () => {
    /*
     * The report line had "tight" written into it, so a study
     * declaring `loose` was told its dial had been snapped by a rule
     * it never asked for.
     */
    const r = run(STRICT.replace('strategy = tight', 'strategy = loose'));
    expect(r.reports[0]!.solve?.strategy).toBe('loose');
  });
});
