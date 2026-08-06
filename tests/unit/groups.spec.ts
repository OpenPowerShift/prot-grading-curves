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
