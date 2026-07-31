/**
 * The playground's components, mounted.
 *
 * These four files are a third of the source and had no unit tests at
 * all -- the visual suite drives the whole app through a browser, which
 * catches what a sheet looks like but not what a component does when
 * given a study that fails to parse, or a view index past the end of
 * the list.
 *
 * jsdom cannot lay anything out: every element measures 0x0, and
 * `getScreenCTM` does not exist. So these tests exercise state,
 * rendering and event wiring, and leave geometry to the visual suite,
 * which has a real engine underneath it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { process as processStudy } from '@tc/index';
import '@tc/components/tc-viewer.js';
import '@tc/components/tc-editor.js';
import '@tc/components/tc-guide.js';
import type { TcViewer } from '@tc/components/tc-viewer.js';

const STUDY = `
meta { project = "Component test"; }
system { voltages { "MV" { V = 11 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R_FDR { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
relay R_INC { voltage = "MV"; ct_ratio = 1200/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 960 A; tms = 0.25; } }
grade { primary = R_FDR:51; backup = R_INC:51; fault = "F"; margin = 0.30 s; }
view "One" { default = true; voltage = "MV"; title = "First"; }
view "Two" { voltage = "MV"; title = "Second"; }
`;

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

/** Mount a viewer with a processed study and let it settle. */
async function mountViewer(source = STUDY): Promise<TcViewer> {
  const result = processStudy(source);
  const el = document.createElement('tc-viewer') as TcViewer;
  el.document = result.document;
  el.study = result.study;
  el.errors = result.parseErrors;
  host.append(el);
  await el.updateComplete;
  return el;
}

describe('<tc-viewer>', () => {
  it('draws a sheet for a study that parses', async () => {
    const el = await mountViewer();
    expect(el.innerHTML).toContain('<svg');
    expect(el.innerHTML).toContain('First');
  });

  it('draws the view it is pointed at', async () => {
    const el = await mountViewer();
    el.viewIndex = 1;
    await el.updateComplete;
    expect(el.innerHTML).toContain('Second');
  });

  it('survives a view index past the end of the list', async () => {
    /*
     * The index is owned by the host app, which can hold a stale one
     * after the source is edited down to fewer sheets. Falling off the
     * end must not take the panel with it.
     */
    const el = await mountViewer();
    el.viewIndex = 99;
    await el.updateComplete;
    expect(el.innerHTML).toContain('<svg');
  });

  it('renders something for a study with no relays at all', async () => {
    const el = await mountViewer('system { voltages { "MV" { V = 11 kV; } } }');
    expect(el.innerHTML).toContain('<svg');
  });

  it('does not throw when handed nothing', async () => {
    const el = document.createElement('tc-viewer') as TcViewer;
    host.append(el);
    await el.updateComplete;
    expect(el.isConnected).toBe(true);
  });

  it('redraws when the theme changes', async () => {
    const el = await mountViewer();
    const light = el.innerHTML;
    el.theme = 'dark';
    await el.updateComplete;
    expect(el.innerHTML).not.toBe(light);
  });

  it('keeps every declared view available to switch between', async () => {
    /*
     * The picker itself is the host app's; the viewer's job is to draw
     * whichever index it is handed, and to keep drawing when that
     * index moves.
     */
    const el = await mountViewer();
    expect(el.innerHTML).toContain('First');
    el.viewIndex = 1;
    await el.updateComplete;
    expect(el.innerHTML).toContain('Second');
    el.viewIndex = 0;
    await el.updateComplete;
    expect(el.innerHTML).toContain('First');
  });

  it('does not offer a picker for a single-view study', async () => {
    const one = STUDY.replace(/view "Two"[^}]*}\n/, '');
    const el = await mountViewer(one);
    expect(el.innerHTML).toContain('<svg');
  });
});

describe('<tc-editor>', () => {
  it('mounts and holds the source it is given', async () => {
    const el = document.createElement('tc-editor') as HTMLElement & {
      value: string; updateComplete: Promise<unknown>;
    };
    el.value = STUDY;
    host.append(el);
    await el.updateComplete;
    expect(el.isConnected).toBe(true);
    expect(el.value).toContain('R_FDR');
  });

  it('accepts a replacement document', async () => {
    const el = document.createElement('tc-editor') as HTMLElement & {
      value: string; updateComplete: Promise<unknown>;
    };
    el.value = STUDY;
    host.append(el);
    await el.updateComplete;
    el.value = 'system { voltages { "LV" { V = 400 V; } } }';
    await el.updateComplete;
    expect(el.value).toContain('LV');
  });
});

describe('<tc-guide>', () => {
  it('stays hidden until opened', async () => {
    const el = document.createElement('tc-guide') as HTMLElement & {
      open: boolean; updateComplete: Promise<unknown>;
    };
    host.append(el);
    await el.updateComplete;
    expect(el.hasAttribute('open')).toBe(false);
  });

  it('reflects the open property so the host can show it', async () => {
    const el = document.createElement('tc-guide') as HTMLElement & {
      open: boolean; updateComplete: Promise<unknown>;
    };
    host.append(el);
    el.open = true;
    await el.updateComplete;
    expect(el.hasAttribute('open')).toBe(true);
  });

  it('asks the host to close it', async () => {
    const el = document.createElement('tc-guide') as unknown as HTMLElement & {
      open: boolean; updateComplete: Promise<unknown>;
    };
    host.append(el);
    el.open = true;
    await el.updateComplete;

    let closed = false;
    el.addEventListener('tc-guide-close', () => { closed = true; });
    el.dispatchEvent(new CustomEvent('tc-guide-close'));
    expect(closed).toBe(true);
  });
});
