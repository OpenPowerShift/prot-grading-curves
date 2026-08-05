/**
 * Where the caret-following help sits.
 *
 * It was a right-hand column beside the editor, which took a third of
 * an already narrow pane for two lines of text -- and because it comes
 * and goes with the caret, the source reflowed under the reader every
 * time they moved the cursor. That is the one thing an editor must not
 * do.
 *
 * A strip along the bottom changes height by a line at most, and the
 * plot is untouched either way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@tc/components/tc-app.js';
import type { TcApp } from '@tc/components/tc-app.js';

const HELP = {
  name: 'I_pickup',
  scope: 'element',
  summary: 'Pickup current.',
  example: 'I_pickup = 480 A;',
};

let host: HTMLDivElement;

const mount = async (): Promise<TcApp> => {
  const el = document.createElement('tc-app') as TcApp;
  host.append(el);
  await el.updateComplete;
  return el;
};

const poke = async (el: TcApp, help: unknown): Promise<void> => {
  (el as unknown as Record<string, unknown>).help = help;
  await el.updateComplete;
};

const dock = (el: TcApp): Element | null => el.renderRoot.querySelector('.help-dock');
const buttons = (el: TcApp): string[] =>
  [...el.renderRoot.querySelectorAll('.side-btn')].map((b) => b.textContent?.trim() ?? '');

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => { host.remove(); localStorage.clear(); });

describe('the help strip', () => {
  it('appears when there is something to explain', async () => {
    const el = await mount();
    expect(dock(el)).toBeNull();
    await poke(el, HELP);
    expect(dock(el)).not.toBeNull();
  });

  it('carries the name, the summary and the example', async () => {
    const el = await mount();
    await poke(el, HELP);
    const text = dock(el)!.textContent ?? '';
    expect(text).toContain('I_pickup');
    expect(text).toContain('Pickup current.');
    expect(text).toContain('480 A');
  });

  it('offers a way to shut it without moving the caret', async () => {
    const el = await mount();
    await poke(el, HELP);
    expect(dock(el)!.querySelector('.help-dock-close')).not.toBeNull();
  });
});

describe('shutting the strip', () => {
  it('hides it', async () => {
    const el = await mount();
    await poke(el, HELP);
    (dock(el)!.querySelector('.help-dock-close') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(dock(el)).toBeNull();
  });

  it('keeps it shut for the next token', async () => {
    /* Someone who does not want it does not want it on every token
     * for the rest of the session either. */
    const el = await mount();
    await poke(el, HELP);
    (dock(el)!.querySelector('.help-dock-close') as HTMLButtonElement).click();
    await el.updateComplete;
    await poke(el, { name: 'tms', summary: 'Time multiplier.' });
    expect(dock(el)).toBeNull();
  });

  it('is remembered across a reload', async () => {
    const el = await mount();
    await poke(el, HELP);
    (dock(el)!.querySelector('.help-dock-close') as HTMLButtonElement).click();
    await el.updateComplete;
    el.remove();

    const again = await mount();
    await poke(again, HELP);
    expect(dock(again)).toBeNull();
  });

  it('offers a control to bring it back', async () => {
    const el = await mount();
    await poke(el, HELP);
    expect(buttons(el)).not.toContain('Help');
    (dock(el)!.querySelector('.help-dock-close') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(buttons(el)).toContain('Help');
  });

  it('comes back, and stays back', async () => {
    const el = await mount();
    await poke(el, HELP);
    (dock(el)!.querySelector('.help-dock-close') as HTMLButtonElement).click();
    await el.updateComplete;

    const show = [...el.renderRoot.querySelectorAll('.side-btn')]
      .find((b) => b.textContent?.trim() === 'Help') as HTMLButtonElement;
    show.click();
    await el.updateComplete;
    expect(dock(el)).not.toBeNull();
    expect(localStorage.getItem('tc.helpHidden')).toBeNull();
  });
});
