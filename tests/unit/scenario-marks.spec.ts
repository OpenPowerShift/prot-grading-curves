/**
 * Scenarios on the drawing, and markers that name a condition.
 *
 * Before this, a `scenario` drove grading but drew nothing: the margin
 * report cited a condition that appeared nowhere on the sheet, so a
 * reader had no way to see where it stood. A scenario now draws its own
 * vertical rule, and `annotate` and `point` can name one -- or several
 * -- instead of copying a current out of the fault study by hand.
 *
 * The rule that matters throughout: a scenario's figure belongs to the
 * level it was declared at and is *not* referred across a transformer.
 * That is the reason to write one instead of a fault.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender, process } from '@tc/index';

const SYSTEM = `
system {
    voltages { "HV" { V  = 33 kV; } "LV" { V  = 0.48 kV; } }
    zero_sequence { "HV" to "LV" = blocked; }
}

scenario "system normal" {
    type = single_phase_earth;
    description = "Phase-earth at the LV board";
    level "LV" { I   = 460 A; I2   = 153 A; I0   = 153 A; }
    level "HV" { I   = 3.9 A; I2   = 2.2 A;  I0   = 0 A;  }
}

scenario "one tx out" {
    type = single_phase_earth;
    level "LV" { I   = 700 A; I2   = 233 A; I0   = 233 A; }
    level "HV" { I   = 2.6 A; I2   = 1.5 A; I0   = 0 A;   }
}

relay R_ACB {
    voltage = "LV";
    element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 200 A; tms = 0.10; }
}
relay R_HV {
    voltage = "HV"; ct_ratio = 250/1;
    element 51  { function = "phase_oc";    curve = iec.si; I_pickup = 2.0 A; tms = 0.20; }
    element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 0.8 A; tms = 0.15; }
}
`;

const VIEW_LV = 'view { voltage = "LV"; current_min = 50 A; current_max = 5 kA; }';

function render(extra: string, view = VIEW_LV): string {
  return parseAndRender(`${SYSTEM}\n${extra}\n${view}`, { theme: 'light' }).svg;
}

function errors(extra: string, view = VIEW_LV) {
  return process(`${SYSTEM}\n${extra}\n${view}`)
    .diagnostics.filter((d) => d.severity === 'error');
}

/** Every condition rule the sheet drew: name, current, and which form. */
function rules(svg: string): Array<[string, number, string]> {
  return [...svg.matchAll(/data-fault="([^"]+)" data-current="([^"]+)" data-kind="([^"]+)"/g)]
    .map((m) => [m[1], Number(m[2]), m[3]] as [string, number, string]);
}

/** Marked points the sheet drew: label, current, time. */
function points(svg: string): Array<[string, number, number]> {
  return [...svg.matchAll(/data-point="([^"]+)" data-current="([^"]+)" data-time="([^"]+)"/g)]
    .map((m) => [m[1], Number(m[2]), Number(m[3])] as [string, number, number]);
}

/** The italic notes in the legend, where suppressions are stated. */
function notes(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*font-style="italic"[^>]*>([^<]*)</g)].map((m) => m[1]);
}

describe('a scenario on the plot', () => {
  it('draws a rule at the level the sheet is in, unreferred', () => {
    const drawn = rules(render(''));
    expect(drawn).toEqual([
      ['system normal', 460, 'scenario'],
      ['one tx out', 700, 'scenario'],
    ]);
  });

  it('draws it at that level\'s own figure, not another level\'s', () => {
    /* The regression this guards: taking the first declared level and
     * referring it by the turns ratio. 3.9 A at 33 kV would arrive at
     * 268 A on the LV sheet, against the 460 A the study measured. */
    const [[, I]] = rules(render(''));
    expect(I).toBe(460);
  });

  it('draws the HV frame from the HV declaration', () => {
    const drawn = rules(render('', 'view { voltage = "HV"; current_min = 0.5 A; current_max = 50 A; }'));
    expect(drawn).toEqual([
      ['system normal', 3.9, 'scenario'],
      ['one tx out', 2.6, 'scenario'],
    ]);
  });

  it('stands at the axis quantity, not always at phase current', () => {
    const drawn = rules(render('', 'view { voltage = "LV"; quantity = 3I0; current_min = 10 A; current_max = 5 kA; }'));
    /* Residual is three times the declared component. */
    expect(drawn.map(([n, I]) => [n, I])).toEqual([
      ['system normal', 459],
      ['one tx out', 699],
    ]);
  });

  it('names the scenario in the legend, and says it is one', () => {
    const svg = render('');
    expect(svg).toContain('system normal · 460 A · 0.48 kV');
    expect(svg).toContain('>scenario<');
  });

  it('heads the panel "Conditions" once a scenario is among them', () => {
    expect(render('')).toContain('>Conditions<');
    /* Faults alone keep the narrower word. */
    const faultsOnly = parseAndRender(
      'system { voltages { "HV" { V  = 33 kV; } } }\n'
      + 'faults { "F" { I   = 9 kA; voltage = "HV"; } }\n'
      + 'relay R { voltage = "HV"; element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; } }\n'
      + 'view { voltage = "HV"; }',
      { theme: 'light' },
    ).svg;
    expect(faultsOnly).toContain('>Faults<');
    expect(faultsOnly).not.toContain('>Conditions<');
  });

  it('says so when it has nothing to say at this level', () => {
    /*
     * Silence would be the wrong answer: grading still reports a margin
     * for the condition, so a sheet that simply omits it invites the
     * reader to assume it was not relevant.
     */
    const svg = parseAndRender(
      'system { voltages { "HV" { V  = 33 kV; } "MV" { V  = 11 kV; } "LV" { V  = 0.48 kV; } } }\n'
      /* Declared on two levels, neither of them the one drawn. */
      + 'scenario "upstream" { level "HV" { I   = 900 A; } level "MV" { I   = 2.7 kA; } }\n'
      + 'relay R { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 200 A; tms = 0.1; } }\n'
      + 'view { voltage = "LV"; current_min = 50 A; current_max = 5 kA; }',
      { theme: 'light' },
    ).svg;

    expect(rules(svg)).toHaveLength(0);
    expect(notes(svg).join(' ')).toContain('upstream declares no currents at LV');
    /* And it lists where the figures actually are. */
    expect(notes(svg).join(' ')).toContain('HV, MV');
  });

  it('refers a single-level scenario, there being nothing to confuse', () => {
    /*
     * One level is unambiguous: the figure can only mean that bus, so it
     * is carried onto the sheet by ampere-turns like a fault's. A
     * scenario declaring several levels and not this one is the case
     * above -- there the choice would be a guess.
     */
    const svg = parseAndRender(
      'system { voltages { "HV" { V  = 33 kV; } "LV" { V  = 0.48 kV; } } }\n'
      + 'scenario "HV bus" { level "HV" { I   = 12 A; } }\n'
      + 'relay R { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 200 A; tms = 0.1; } }\n'
      + 'view { voltage = "LV"; current_min = 50 A; current_max = 5 kA; }',
      { theme: 'light' },
    ).svg;

    const [[name, I]] = rules(svg);
    expect(name).toBe('HV bus');
    expect(I).toBeCloseTo(12 * 33 / 0.48, 3);
  });

  it('refuses to carry a residual across a delta, and says why', () => {
    const svg = render('', 'view { voltage = "HV"; quantity = 3I0; current_min = 0.1 A; current_max = 500 A; }');
    expect(rules(svg)).toHaveLength(0);
    expect(notes(svg).join(' ')).toContain('carries no residual 3I0 at HV');
  });
});

describe('an element whose current cannot reach the sheet', () => {
  /** Curve labels the sheet actually drew. */
  function curves(svg: string): string[] {
    return [...svg.matchAll(/data-curve="([^"]+)"/g)].map((m) => m[1]);
  }

  const LV_PHASE = 'view { voltage = "LV"; quantity = phase; current_min = 50 A; current_max = 5 kA; }';

  it('is left off, wherever the sheet is drawn', () => {
    /*
     * The `51G` is on the HV side of a delta. Zero sequence does not
     * cross it, so that element measures nothing under an LV earth
     * fault and cannot appear on *any* sheet of this study.
     *
     * The bug this guards: `axisFactorFor` took its ratio from the level
     * the sheet was drawn in rather than the element's own, so on an LV
     * phase sheet the HV `51G` was placed from LV's residual-to-phase
     * ratio -- a level it is not on -- and drawn as a working backup
     * while the grading report for the same condition said NO_OPERATION.
     * The fault rules and the marked points already obeyed the referral
     * rule; curves were the one thing exempt from it.
     */
    const onHv = curves(render('', 'view { voltage = "HV"; quantity = I2; condition = "system normal"; current_min = 0.5 A; current_max = 50 A; }'));
    const onLv = curves(render('', `${LV_PHASE.slice(0, -2)} condition = "system normal"; }`));

    expect(onHv.join(' ')).not.toContain('51G');
    expect(onLv.join(' ')).not.toContain('51G');
  });

  it('names the relay and the reason, rather than counting it', () => {
    /* A reader cannot tell which curve went missing from a count, and
     * the study grades against it. */
    const svg = render('', `${LV_PHASE.slice(0, -2)} condition = "system normal"; }`);
    const said = notes(svg).join(' ');
    expect(said).toContain('51G');
    expect(said).toContain('does not cross HV to LV');
  });

  it('says "carries no ..." when the element is on the sheet\'s own level', () => {
    const svg = render('', 'view { voltage = "HV"; quantity = I2; condition = "system normal"; current_min = 0.5 A; current_max = 50 A; }');
    expect(notes(svg).join(' ')).toContain('carries no residual 3I0 at HV');
  });

  it('still draws everything when the axis is unconstrained', () => {
    /*
     * `quantity = any` is the documented escape hatch: several
     * characteristics on one current axis, the legend stating what each
     * measures. Suppression belongs to the strict sheets only.
     */
    const drawn = curves(render('', 'view { voltage = "LV"; current_min = 50 A; current_max = 5 kA; }'));
    expect(drawn.join(' ')).toContain('51G');
  });

  it('leaves a same-level residual element alone', () => {
    /* Nothing crosses, so nothing is blocked: an LV 51G on an LV
     * residual sheet is exactly where it belongs. */
    const svg = parseAndRender(
      'system { voltages { "LV" { V  = 0.48 kV; } } }\n'
      + 'scenario "earth" { type = single_phase_earth; level "LV" { I   = 460 A; I0   = 153 A; } }\n'
      + 'relay R { voltage = "LV"; element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 100 A; tms = 0.1; } }\n'
      + 'view { voltage = "LV"; quantity = 3I0; condition = "earth"; current_min = 10 A; current_max = 5 kA; }',
      { theme: 'light' },
    ).svg;
    expect(curves(svg).join(' ')).toContain('51G');
  });
});

describe('a point that names a condition', () => {
  it('stands at that condition\'s current', () => {
    const svg = render('point "clears" { scenario = "system normal"; t   = 0.06 s; voltage = "LV"; }');
    expect(points(svg)).toEqual([['clears', 460, 0.06]]);
  });

  it('draws one marker per condition named, at the same time', () => {
    const svg = render(
      'point "withstand" { scenarios = ["system normal", "one tx out"]; t   = 2 s; voltage = "LV"; }',
    );
    expect(points(svg)).toEqual([
      ['withstand · system normal', 460, 2],
      ['withstand · one tx out', 700, 2],
    ]);
  });

  it('takes a fault as readily as a scenario', () => {
    const svg = render(
      'faults { "F_lv" { I   = 1200 A; voltage = "LV"; } }\n'
      + 'point "damage" { fault = "F_lv"; t   = 3 s; voltage = "LV"; }',
    );
    expect(points(svg)).toContainEqual(['damage', 1200, 3]);
  });

  it('refers a fault onto its own level, as a curve is', () => {
    /* An HV fault marked on an LV sheet: 3.9 A at 33 kV is 268 A at
     * 0.48 kV by ampere-turns. */
    const svg = render(
      'faults { "F_hv" { I   = 3.9 A; voltage = "HV"; } }\n'
      + 'point "seen at HV" { fault = "F_hv"; t   = 1 s; voltage = "HV"; }',
    );
    const [, I] = points(svg).find(([n]) => n === 'seen at HV')!;
    expect(I).toBeCloseTo(3.9 * 33 / 0.48, 3);
  });

  it('is withheld where its quantity cannot reach this level', () => {
    /*
     * A residual point on the star side has no position on a delta-side
     * residual sheet. `project` would have scaled it by the turns ratio
     * regardless -- a marker standing at a current that cannot exist
     * there -- so the referral rule the fault rules obey applies here
     * too, and the omission is stated.
     */
    const svg = render(
      /* A residual marker says so, as a fault would: `earth_A` is the
       * residual 3*I0. Declared as a phase current it would not be a
       * residual point at all, and the sheet would decline it for the
       * duller reason that it carries no 3I0. */
      'point "LV residual" { residual = 400 A; t   = 1 s; voltage = "LV"; }',
      'view { voltage = "HV"; quantity = 3I0; current_min = 0.1 A; current_max = 500 A; }',
    );
    expect(points(svg)).toHaveLength(0);
    expect(notes(svg).join(' ')).toContain('does not cross to this level');
  });

  it('rejects declaring both a current and a condition', () => {
    const codes = errors('point "both" { I   = 100 A; scenario = "system normal"; t   = 1 s; }')
      .map((d) => d.code);
    expect(codes).toContain('POINT_CURRENT_AND_CONDITION');
  });

  it('rejects a condition that is neither a fault nor a scenario', () => {
    const found = errors('point "p" { scenario = "system abnormal"; t   = 1 s; }');
    expect(found.map((d) => d.code)).toContain('UNRESOLVED_REFERENCE');
    /* Near-miss spelling gets a suggestion. */
    expect(found.map((d) => d.message).join(' ')).toContain('did you mean');
  });

  it('rejects a scenario silent about the level the marker is on', () => {
    /*
     * The marker asks for a position that was never measured. Two
     * declared levels and neither of them this one, so there is nothing
     * to fall back on that would not be a guess.
     */
    const found = process(
      'system { voltages { "HV" { V  = 33 kV; } "MV" { V  = 11 kV; } "LV" { V  = 0.48 kV; } } }\n'
      + 'scenario "upstream" { level "HV" { I   = 900 A; } level "MV" { I   = 2.7 kA; } }\n'
      + 'relay R { voltage = "LV"; element 51 { curve = iec.si; I_pickup = 200 A; tms = 0.1; } }\n'
      + 'point "p" { scenario = "upstream"; t   = 1 s; voltage = "LV"; }\n'
      + 'view { voltage = "LV"; }',
    ).diagnostics.filter((d) => d.severity === 'error');

    expect(found.map((d) => d.code)).toContain('SCENARIO_LEVEL_MISSING');
    expect(found.map((d) => d.message).join(' ')).toContain('it declares HV, MV');
  });

  it('accepts a scenario that does declare that level', () => {
    expect(errors('point "p" { scenario = "system normal"; t   = 1 s; voltage = "HV"; }'))
      .toHaveLength(0);
  });

  it('still requires a current from one source or the other', () => {
    const codes = errors('point "bare" { t   = 1 s; }').map((d) => d.code);
    expect(codes).toContain('POINT_CURRENT_INVALID');
  });
});

describe('an annotation that names conditions', () => {
  const PAIR = 'primary = R_ACB:51; backup = R_HV:51;';

  it('draws one margin per condition, each at its own current', () => {
    const svg = render(`annotate { ${PAIR} scenarios = ["system normal", "one tx out"]; label = "CTI"; }`);
    const figures = [...svg.matchAll(/>CTI ([^<]+)</g)].map((m) => m[1]);
    expect(figures).toHaveLength(2);
    /* Two different currents, so two different margins. */
    expect(new Set(figures).size).toBe(2);
  });

  it('reads each side in its own frame, taking the scenario\'s own figure', () => {
    /*
     * The margin the report computes for the same pair and condition.
     * A scenario declares both levels, so neither side is referred --
     * which is what makes this agree with `grades.ts` exactly.
     */
    const source = `${SYSTEM}\nannotate { ${PAIR} scenario = "system normal"; label = "CTI"; }\n`
      + `grade { ${PAIR} scenario = "system normal"; margin    = 0.3 s; }\n${VIEW_LV}`;
    const result = process(source);
    const row = result.reports[0].rows.find((r) => r.at === 'I')!;
    const { svg } = parseAndRender(source, { theme: 'light' });

    /* Formatted as the renderer formats seconds. */
    const drawn = svg.match(/>CTI ([\d.]+) (m?s)</)!;
    const seconds = drawn[2] === 'ms' ? Number(drawn[1]) / 1000 : Number(drawn[1]);
    expect(seconds).toBeCloseTo(Math.abs(row.margin_s), 2);
  });

  it('marks a point on a curve at a scenario\'s current', () => {
    const svg = render(
      'annotate { on_curve = R_ACB:51; scenario = "one tx out"; label = "at outage"; style = tag; }',
    );
    expect(svg).toContain('at outage');
  });

  it('rejects an unknown condition', () => {
    const codes = errors(`annotate { ${PAIR} scenario = "nonesuch"; }`).map((d) => d.code);
    expect(codes).toContain('UNRESOLVED_REFERENCE');
  });

  it('draws one annotation for a condition named twice', () => {
    const svg = render(
      `annotate { ${PAIR} scenarios = ["system normal", "system normal"]; label = "CTI"; }`,
    );
    expect([...svg.matchAll(/>CTI ([^<]+)</g)]).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- */

describe('a point declares its current as a fault does', () => {
  /*
   * One vocabulary for every current in the language. A point used to
   * carry a single `I_A` that was plotted against whatever the axis
   * happened to be, so the same number meant phase current on one sheet
   * and negative sequence on the next -- and studies worked around it
   * with a comment ("49 A, which is |I2| on this sheet"), which is the
   * tool asking the reader to keep its books.
   */
  const STUDY = (points: string, quantity: string) => `
system { voltages { "HV" { V  = 33 kV; } } }
relay R {
  voltage = "HV"; ct_ratio = 250/1;
  element 46 { function = "neg_seq"; measures = "I2"; curve = definite; I_pickup = 75 A; t_delay = 0.1 s; }
}
${points}
view { voltage = "HV"; quantity = ${quantity}; current_min = 1 A; current_max = 40 kA; }
`;

  const drawn = (points: string, quantity: string): Array<[string, number]> =>
    [...parseAndRender(STUDY(points, quantity), { theme: 'light' }).svg
      .matchAll(/data-point="([^"]+)" data-current="([\d.]+)"/g)]
      .map((m) => [m[1], Number(m[2])]);

  const P_I2 = 'point "ext" { I2   = 49 A; t   = 0.1 s; voltage = "HV"; label = "ext"; }';
  const P_PHASE = 'point "inrush" { I   = 212 A; t   = 0.12 s; voltage = "HV"; label = "inrush"; }';
  const P_TYPED = 'point "2ph" { I   = 390 A; type = two_phase; t   = 0.2 s; voltage = "HV"; label = "2ph"; }';

  it('takes the component the axis is drawn in', () => {
    expect(drawn(P_I2, 'I2')).toEqual([['ext', 49]]);
  });

  it('derives a component from the point\'s own fault type', () => {
    /* 390 A of phase current at a phase-phase fault is 390/root3 of I2. */
    const [[, I]] = drawn(P_TYPED, 'I2');
    expect(I).toBeCloseTo(390 / Math.sqrt(3), 1);
  });

  it('leaves a phase point on a phase axis exactly where it was', () => {
    /* The unconstrained default is a phase axis, so every existing
     * study with a bare `I_A` is untouched. */
    expect(drawn(P_PHASE, 'any')).toEqual([['inrush', 212]]);
    expect(drawn(P_PHASE, 'phase')).toEqual([['inrush', 212]]);
  });

  it('withholds a marker whose component the sheet is not drawn in', () => {
    expect(drawn(P_PHASE, 'I2')).toHaveLength(0);
    expect(drawn(P_I2, 'phase')).toHaveLength(0);
  });

  it('names the marker it withheld, and what would fix it', () => {
    const svg = parseAndRender(STUDY(P_PHASE, 'I2'), { theme: 'light' }).svg;
    const said = [...svg.matchAll(/font-style="italic"[^>]*>([^<]*)</g)]
      .map((m) => m[1]).join(' ');
    /*
     * Summed into one note, not a bullet apiece: a study with a sheet
     * per quantity has markers belonging to the other sheet by design,
     * and one line each turned the panel into a list of things that
     * are fine. Still named, since a marker the author wrote and
     * cannot see is worth a line.
     */
    expect(said).toContain('1 point declare no I2');
    expect(said).toContain('inrush');
  });

  it('accepts a marker known only in a component, with no phase figure', () => {
    /* `I2_A` alone is a complete declaration; the validator used to
     * insist on a phase current that a negative-sequence marker does
     * not have. */
    const found = process(STUDY(P_I2, 'I2')).diagnostics.filter((d) => d.severity === 'error');
    expect(found).toHaveLength(0);
  });

  it('still requires some current, or a condition to take one from', () => {
    const codes = process(STUDY('point "bare" { t   = 1 s; }', 'phase'))
      .diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
    expect(codes).toContain('POINT_CURRENT_INVALID');
  });
});
