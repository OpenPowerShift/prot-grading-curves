/**
 * Which sheet an export draws.
 *
 * `currentView()` -- what the SVG, PNG and PDF exports all render
 * against -- took `items.find(i => i.type === 'view')`, the first view
 * *written*, while the screen drew `selectedView()`, the one the
 * picker has open. So exporting a multi-sheet study gave whichever
 * sheet happened to come first in the file.
 *
 * It appeared to work whenever that was also the sheet being looked
 * at, which is why it read as intermittent rather than as always
 * wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { process as processStudy } from '@tc/index';
import '@tc/components/tc-viewer.js';
import type { TcViewer } from '@tc/components/tc-viewer.js';

const TWO_SHEETS = `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view "First"  { voltage = "MV"; current_min = 100 A; current_max = 1 kA; }
view "Second" { voltage = "MV"; current_min = 2 kA;  current_max = 40 kA; }
`;

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); });
afterEach(() => { host.remove(); });

const mount = async (index: number): Promise<TcViewer> => {
  const result = processStudy(TWO_SHEETS);
  const el = document.createElement('tc-viewer') as TcViewer;
  el.document = result.document;
  el.study = result.study;
  el.errors = result.parseErrors;
  el.viewIndex = index;
  host.append(el);
  await el.updateComplete;
  return el;
};

const exportedView = (el: TcViewer): { name?: string } | null =>
  (el as unknown as Record<string, () => { name?: string } | null>).currentView();

describe('the view an export renders', () => {
  it('is the first sheet when the first is open', () => {
    /* The case that made the bug look intermittent. */
    return mount(0).then((el) => {
      expect(exportedView(el)?.name).toBe('First');
    });
  });

  it('is the second sheet when the second is open', async () => {
    const el = await mount(1);
    expect(exportedView(el)?.name).toBe('Second');
  });

  it('follows the picker rather than the file order', async () => {
    const first = await mount(0);
    const second = await mount(1);
    expect(exportedView(first)?.name).not.toBe(exportedView(second)?.name);
  });

  it('matches the sheet actually drawn', async () => {
    /*
     * The two sheets have disjoint current windows, so the drawn
     * domain identifies which one is on screen without depending on
     * anything else.
     */
    const el = await mount(1);
    const svg = el.querySelector('svg')?.outerHTML ?? '';
    const domain = /data-domain-i="([\d.]+),/.exec(svg);
    expect(domain, 'the sheet declares its domain').not.toBeNull();
    expect(Number(domain![1])).toBeGreaterThan(1000);
    expect(exportedView(el)?.name).toBe('Second');
  });

  it('clamps an index past the end rather than exporting nothing', async () => {
    const el = await mount(9);
    expect(exportedView(el)?.name).toBe('Second');
  });
});
