/**
 * The layout you chose, and the one the window forced on you.
 *
 * A narrow window shows one pane and offers a Source/Plot switch. Both
 * that switch and the wide layout's Hide/Split buttons wrote the same
 * field, so tapping `Source` on a narrow screen silently rewrote the
 * split you had been working in: zoom in far enough to go narrow, tap
 * Source to read the study, zoom back out, and the plot was gone.
 *
 * They are two different questions -- "which single pane, since there
 * is only room for one" and "how do I want the two arranged" -- and
 * only the second is worth remembering.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@tc/components/tc-app.js';

type App = HTMLElement & {
  updateComplete: Promise<unknown>;
  narrow: boolean;
  pane: 'split' | 'source' | 'plot';
  narrowPane: 'source' | 'plot';
};

let host: HTMLDivElement;
let app: App;

/** Reach past `private` the way the other component tests do. */
const call = (el: App, method: string, ...args: unknown[]): unknown =>
  (el as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  app = document.createElement('tc-app') as App;
  host.append(app);
  await app.updateComplete;
});

afterEach(() => { host.remove(); });

/** The pane actually being shown, as `render` computes it. */
const shown = (): 'split' | 'source' | 'plot' =>
  (app.narrow ? app.narrowPane : app.pane);

describe('a pane chosen while the window is narrow', () => {
  it('does not disturb the split you had', async () => {
    app.pane = 'split';
    call(app, 'measureNarrow', 600);
    expect(app.narrow).toBe(true);

    call(app, 'showPane', 'source');
    expect(shown()).toBe('source');

    /* Back to a wide window: the split is as it was left. */
    call(app, 'measureNarrow', 1400);
    expect(app.narrow).toBe(false);
    expect(shown()).toBe('split');
  });

  it('is not stored, because it was not a preference', () => {
    call(app, 'measureNarrow', 600);
    call(app, 'showPane', 'source');
    expect(localStorage.getItem('tc.pane')).not.toBe('source');
  });
});

describe('arriving at a narrow window', () => {
  it('keeps showing the pane the wide layout was showing', () => {
    /*
     * Someone working source-only should not be handed the plot
     * because the window got smaller.
     */
    app.pane = 'source';
    call(app, 'measureNarrow', 600);
    expect(shown()).toBe('source');
  });

  it('opens on the plot from a split, that being what the tool is for', () => {
    app.pane = 'split';
    call(app, 'measureNarrow', 600);
    expect(shown()).toBe('plot');
  });

  it('does not re-seed on every measurement while already narrow', () => {
    /*
     * Otherwise a resize -- a phone rotating, a keyboard opening --
     * would throw away the pane the reader had just chosen.
     */
    app.pane = 'split';
    call(app, 'measureNarrow', 600);
    call(app, 'showPane', 'source');
    call(app, 'measureNarrow', 580);
    expect(shown()).toBe('source');
  });
});

describe('a pane chosen while the window is wide', () => {
  it('is remembered', () => {
    call(app, 'measureNarrow', 1400);
    call(app, 'showPane', 'plot');
    expect(app.pane).toBe('plot');
    expect(localStorage.getItem('tc.pane')).toBe('plot');
  });
});
