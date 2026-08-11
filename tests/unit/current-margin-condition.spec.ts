/**
 * `annotate { primary; at_t; ... }`: the horizontal margin between a
 * curve and a named condition, at a declared time.
 *
 * `primary` with `at_t` and no `backup` files as a *current* margin --
 * the gap in current between a characteristic and whatever the far end
 * names, read at one time. The far end can be another curve
 * (`backup`), a marked point (`point`), or a condition (`fault` /
 * `scenario` / `condition`); this file covers the last of those, which
 * used to go through a plain name match against the sheet's own fault
 * list rather than the shared condition lookup every other reference
 * uses -- so a scenario named with a `NAME.LEVEL` suffix matched
 * nothing there, drew nothing, and said only "could not place".
 */

import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';

const BASE = `
system { voltages { HV { V = 275 kV; } MV { V = 33 kV; } } }
relay R { voltage = MV; ct_ratio = 1200/1;
  element 46 { function = neg_seq; measures = I2; curve = definite; I_pickup = 380 A; t_delay = 250 ms; } }
view { voltage = MV; quantity = I2; current_min = 40 A; current_max = 5 kA;
       time_min = 10 ms; time_max = 2 s; }
scenario S {
  type = two_phase;
  level MV { I = 940 A; I2 = 543 A; }
}
`;

const drawn = (annotate: string): string =>
  parseAndRender(`${BASE}\n${annotate}`, { theme: 'light' });
const codes = (annotate: string): string[] => {
  const r = parse(`${BASE}\n${annotate}`);
  return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
};

function parseAndRender(src: string, opts: { theme: 'light' | 'dark' }): string {
  return renderStudy(parse(src), opts);
}

describe('a current margin against a bare condition name', () => {
  const A = 'annotate { primary = R:46; at_t = 500 ms; scenario = S; label = "margin"; }';

  it('is drawn, not left unplaceable', () => {
    expect(drawn(A)).not.toContain('could not place');
    expect(drawn(A)).toContain('margin');
  });
});

describe('a current margin against a scenario-level reference', () => {
  const A = 'annotate { primary = R:46; at_t = 500 ms; scenario = S.MV; label = "margin"; }';

  it('is drawn, at the level named', () => {
    expect(drawn(A)).not.toContain('could not place');
    expect(drawn(A)).toContain('margin');
  });

  it('draws identically to the bare, unqualified name', () => {
    const bare = drawn('annotate { primary = R:46; at_t = 500 ms; scenario = S; label = "margin"; }');
    const dotted = drawn(A);
    const x = (svg: string): string | undefined =>
      /<line x1="([\d.]+)" y1="[\d.]+" x2="[\d.]+" y2="\d/.exec(svg)?.[1];
    expect(x(dotted)).toBe(x(bare));
  });

  it('refuses a level the scenario does not declare, rather than drawing nothing unexplained', () => {
    expect(codes('annotate { primary = R:46; at_t = 500 ms; scenario = S.HV; label = "margin"; }'))
      .toContain('SCENARIO_LEVEL_MISSING');
  });
});
