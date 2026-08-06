/**
 * A sheet drawn for a protection chain.
 *
 * Every `views` list in a two-chain study says the same thing: which
 * chain a relay is on. Written on the elements, that is one long list
 * per element and every one of them revisited when a sheet is added --
 * and inverting it, so views listed their curves, would transpose the
 * same table without shrinking it.
 *
 * A `group` states membership once, where it is true. The sheet names
 * the chain; the elements say nothing.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { sheetsOf } from './sheets.js';

const CHAINS = `
system { voltages { HV { V = 33 kV; } } }

group CHAIN_A { name = "Chain A"; members = [R_INCOMER, R_A_FEEDER]; }
group CHAIN_B { name = "Chain B"; members = [R_INCOMER, R_B_FEEDER]; }

relay R_INCOMER { voltage = HV; ct_ratio = 2500/1;
  element P51 { function = phase_oc; measures = phase;
                curve = iec.si; I_pickup = 2400 A; tms = 0.2; } }
relay R_A_FEEDER { voltage = HV; ct_ratio = 800/1;
  element P51 { function = phase_oc; measures = phase;
                curve = iec.si; I_pickup = 660 A; tms = 0.17; } }
relay R_B_FEEDER { voltage = HV; ct_ratio = 200/1;
  element P51 { function = phase_oc; measures = phase;
                curve = iec.si; I_pickup = 200 A; tms = 0.25; } }

view SHEET_A { group = CHAIN_A; quantity = phase; voltage = HV;
               current_min = 100 A; current_max = 30 kA;
               time_min = 20 ms; time_max = 20 s; }
view SHEET_B { group = CHAIN_B; quantity = phase; voltage = HV;
               current_min = 100 A; current_max = 30 kA;
               time_min = 20 ms; time_max = 20 s; }
`;

/** The curves a sheet actually draws, by reference. */
const curvesOn = (src: string, sheet: string): string[] => {
  const result = parse(src);
  expect(result.parseErrors, 'the study should parse').toEqual([]);
  const found = sheetsOf(result).find((s) => s.name === sheet);
  expect(found, `no sheet called ${sheet}`).toBeDefined();
  const svg = renderStudy(result, { theme: 'light', view: found!.view });
  return [...new Set([...svg.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]))].sort();
};

describe('a sheet that names a chain', () => {
  it('draws that chain and no other', () => {
    expect(curvesOn(CHAINS, 'SHEET_A')).toEqual(['R_A_FEEDER:P51', 'R_INCOMER:P51']);
    expect(curvesOn(CHAINS, 'SHEET_B')).toEqual(['R_B_FEEDER:P51', 'R_INCOMER:P51']);
  });

  it('draws a relay that is in both chains on both sheets', () => {
    /*
     * An incomer backs up everything, so it belongs to every chain
     * rather than to none -- which is why a group lists devices and a
     * device does not list its groups.
     */
    expect(curvesOn(CHAINS, 'SHEET_A')).toContain('R_INCOMER:P51');
    expect(curvesOn(CHAINS, 'SHEET_B')).toContain('R_INCOMER:P51');
  });

  it('lets an element override with its own views', () => {
    /*
     * The exception the tiers exist for: an element that belongs to a
     * chain but not to all of its sheets. `views` wins over the
     * sheet's group.
     */
    const scoped = CHAINS.replace(
      'element P51 { function = phase_oc; measures = phase;\n                curve = iec.si; I_pickup = 660 A; tms = 0.17; } }',
      'element P51 { function = phase_oc; measures = phase; views = [SHEET_B];\n                curve = iec.si; I_pickup = 660 A; tms = 0.17; } }',
    );
    expect(curvesOn(scoped, 'SHEET_A')).not.toContain('R_A_FEEDER:P51');
    expect(curvesOn(scoped, 'SHEET_B')).toContain('R_A_FEEDER:P51');
  });

  it('draws everything when no group is named', () => {
    /*
     * Every study written before groups existed, and every study with
     * one chain. Saying nothing has to keep meaning "all of it".
     */
    const ungrouped = CHAINS.replace('group = CHAIN_A; ', '');
    expect(curvesOn(ungrouped, 'SHEET_A'))
      .toEqual(['R_A_FEEDER:P51', 'R_B_FEEDER:P51', 'R_INCOMER:P51']);
  });
});

describe('the shipped two-chain study', () => {
  const src = readFileSync('examples/18-bess-two-chains.ptc', 'utf8');

  it('keeps each chain off the other chain\'s sheets', () => {
    for (const sheet of ['BESS transformer - phase', 'BESS transformer - negative sequence']) {
      const refs = curvesOn(src, sheet);
      expect(refs.some((r) => r.startsWith('R_AUX')), `${sheet} drew an auxiliary relay`)
        .toBe(false);
    }
    for (const sheet of ['Auxiliary kiosk - phase', 'Auxiliary kiosk - negative sequence']) {
      const refs = curvesOn(src, sheet);
      expect(refs.some((r) => r.startsWith('R_BESS')), `${sheet} drew a BESS relay`)
        .toBe(false);
    }
  });

  it('says which chain each sheet is, rather than each element saying where it goes', () => {
    /*
     * The measure of whether this was worth doing: no *phase* element
     * names a sheet any more. Those were the lists that said "which
     * chain", one per element and two sheets long, and the group says
     * it once instead.
     *
     * The `views` lines that remain are a different statement -- a 46
     * has nothing to say on a phase sheet, a clearance anchored in
     * negative sequence belongs on the sequence sheets. That is about
     * *quantity*, which is the element's business and not the sheet's,
     * and no group would absorb it.
     */
    const phaseElements = [...src.matchAll(/element P51 \{[\s\S]*?\n  \}/g)]
      .map((m) => m[0]);
    expect(phaseElements.length).toBe(5);
    for (const el of phaseElements) {
      expect(el, 'a phase element still names its sheets').not.toMatch(/^\s*views = /m);
    }
    expect((src.match(/^\s*group = /gm) ?? []).length).toBe(4);
  });
});

describe('what a sheet carries without being told', () => {
  const DERIVED = `
system { voltages { HV { V = 33 kV; } } }
scenario COND { type = two_phase; level HV { I = 2 kA; I1 = 1155 A; I2 = 1155 A; } }
relay R_A { voltage = HV; ct_ratio = 400/5;
  element P51 { function = phase_oc; measures = phase;
                curve = iec.si; I_pickup = 400 A; tms = 0.2; }
  element 46 { function = neg_seq; measures = I2; views = [SEQ];
               curve = definite; I_pickup = 200 A; t_delay = 0.6 s; } }
times {
  T_PHASE { name = "phase limit"; t = 500 ms; at_I = 2 kA; }
  T_SEQ   { name = "sequence limit"; t = 1 s; at_I2 = 400 A; }
  T_ANY   { name = "bare limit"; t = 2 s; }
}
annotate { on_curve = R_A:46; at_I2 = 400 A; label = "on the 46"; }
view PH  { quantity = phase; condition = COND; voltage = HV;
           current_min = 100 A; current_max = 10 kA; time_min = 20 ms; time_max = 20 s; }
view SEQ { quantity = I2; condition = COND; voltage = HV;
           current_min = 100 A; current_max = 10 kA; time_min = 20 ms; time_max = 20 s; }
`;

  const on = (sheet: string): { times: string[]; hasAnnot: boolean } => {
    const r = parse(DERIVED);
    expect(r.parseErrors).toEqual([]);
    const found = sheetsOf(r).find((s) => s.name === sheet)!;
    const svg = renderStudy(r, { theme: 'light', view: found.view });
    return {
      times: [...svg.matchAll(/data-time-name="([^"]*)"/g)].map((m) => m[1]).sort(),
      hasAnnot: svg.includes('on the 46'),
    };
  };

  it('draws every required time on every sheet, whatever its anchor', () => {
    /*
     * I tried deriving this -- `at_I2` looked like a statement that a
     * clearance was about negative sequence -- and backed it out. The
     * anchor says where along the rule to write the caption, beside
     * the curve the requirement bites on; it does not say which sheets
     * the requirement applies to. A second is a second on every axis,
     * and a limit that is true is true on all of them.
     *
     * Which sheets a clearance belongs on is `views`, said outright.
     */
    expect(on('PH').times).toEqual(['bare limit', 'phase limit', 'sequence limit']);
    expect(on('SEQ').times).toEqual(['bare limit', 'phase limit', 'sequence limit']);
  });

  it('follows an annotation to wherever its curve is drawn', () => {
    /*
     * The annotation names `R_A:46`, which is scoped to the sequence
     * sheet. It used to be drawn on both and reported as unplaceable
     * on the one where its curve was absent.
     */
    expect(on('SEQ').hasAnnot).toBe(true);
    expect(on('PH').hasAnnot).toBe(false);
  });
});

describe('a block declared inside a view', () => {
  const NESTED = `
system { voltages { HV { V = 33 kV; } } }
relay R { voltage = HV; ct_ratio = 400/5;
  element 51 { function = phase_oc; measures = phase;
               curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view A {
  quantity = phase; voltage = HV;
  current_min = 100 A; current_max = 10 kA; time_min = 20 ms; time_max = 20 s;

  times { T_LOCAL { name = "only on A"; t = 500 ms; at_I = 2 kA; } }
  point P_LOCAL { label = "local marker"; I = 3 kA; t = 100 ms; }
  annotate { on_curve = R:51; at_I = 5 kA; label = "A only"; }
}
view B {
  quantity = phase; voltage = HV;
  current_min = 100 A; current_max = 10 kA; time_min = 20 ms; time_max = 20 s;
}
`;

  const drew = (sheet: string): string => {
    const r = parse(NESTED);
    expect(r.parseErrors).toEqual([]);
    const found = sheetsOf(r).find((s) => s.name === sheet)!;
    return renderStudy(r, { theme: 'light', view: found.view });
  };

  it('belongs to that sheet and no other', () => {
    /*
     * For something on one sheet, a reference is a name kept in step
     * for no reason. Written inside the view there is nothing to spell
     * and nothing to rename, and being scoped elsewhere is not
     * expressible.
     */
    for (const mark of ['only on A', 'local marker', 'A only']) {
      expect(drew('A'), `A should carry ${mark}`).toContain(mark);
      expect(drew('B'), `B should not carry ${mark}`).not.toContain(mark);
    }
  });

  it('is not listed in another sheet\'s legend as missing', () => {
    /*
     * A point scoped away from a sheet used to appear in that sheet's
     * legend under "Points", as though it were a marker the sheet had
     * failed to draw -- reporting an absence the study had asked for.
     */
    expect(drew('B')).not.toContain('local marker');
  });

  it('refuses to also name a scope', () => {
    /*
     * Already scoped by where it sits, so a `views` beside it is dead
     * text that looks load-bearing. Refused rather than merged: two
     * ways of saying the same thing would need a precedence rule.
     */
    const both = NESTED.replace('label = "A only";', 'label = "A only"; views = [B];');
    const codes = parse(both).diagnostics.map((d) => d.code);
    expect(codes).toContain('NESTED_BLOCK_SCOPED');
  });

  it('is clean when it does not', () => {
    expect(parse(NESTED).diagnostics.map((d) => d.code)).not.toContain('NESTED_BLOCK_SCOPED');
  });
});
