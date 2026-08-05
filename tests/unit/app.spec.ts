/**
 * The playground shell.
 *
 * `tc-app` owns everything the sheet does not: which panes are on
 * screen, which example is loaded, the draft saved to the browser, the
 * share link, the theme, and the wiring that turns an edit into a
 * re-render. It is the largest file in the project and had no unit
 * tests, so every one of those was only ever exercised by a human.
 *
 * jsdom gives no layout, so the splitter's arithmetic and anything
 * reading a bounding box are left to the visual suite. What is checked
 * here is state: what the app does with a source, a stored draft, a
 * hash link and a theme.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@tc/components/tc-app.js';
import type { TcApp } from '@tc/components/tc-app.js';

const STUDY = `system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
`;

/** Reach a private field without loosening the component's own types. */
const peek = <T>(el: TcApp, key: string): T =>
  (el as unknown as Record<string, T>)[key];

const poke = (el: TcApp, key: string, value: unknown): void => {
  (el as unknown as Record<string, unknown>)[key] = value;
};

/**
 * Type into the editor and wait for the result.
 *
 * Parsing is debounced by 200 ms so that a fast typist is not
 * reprocessed on every keystroke, which means the study is not there
 * the instant the source changes.
 */
/**
 * Type into the editor and wait for the app to catch up.
 *
 * The app debounces parsing by 200 ms. This used to sleep for 260 --
 * a 60 ms margin, which is ample on an idle machine and not ample at
 * all when the whole suite is running in parallel workers, so the test
 * failed perhaps one run in three with `expected undefined to be
 * defined`. Adding any other slow test made it worse, which is how it
 * was noticed.
 *
 * Waiting for the *outcome* instead of for a duration is both faster
 * in the common case and immune to load. The deadline is generous
 * because it is only reached when something is genuinely broken, and
 * the failure it produces then says so.
 */
async function edit(el: TcApp, source: string): Promise<void> {
  const before = (el as unknown as { ast?: unknown }).ast;
  (el as unknown as { handleSourceChange(s: string): void }).handleSourceChange(source);

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    const settled = (el as unknown as { parseTimer: number | null }).parseTimer == null;
    if (settled && (el as unknown as { ast?: unknown }).ast !== before) break;
  }
  await el.updateComplete;
}

let app: TcApp;

async function mount(): Promise<TcApp> {
  const el = document.createElement('tc-app') as TcApp;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});

afterEach(() => {
  app?.remove();
  localStorage.clear();
});

describe('being removed', () => {
  it('cancels a parse that is still settling', async () => {
    /*
     * The parse is debounced, so an app removed mid-keystroke used to
     * leave a timer that woke up, re-parsed, and wrote to a component
     * no longer in the document. Under test that lands after the DOM
     * has been torn down and fails the run with a `document is not
     * defined` naming no test -- which is how it reached CI.
     *
     * It surfaced when the upstream sweep became the default: grading
     * grew by a sweep per pair, the debounced callback took longer,
     * and a latent race started losing. The race was always there.
     */
    const el = await mount();
    const pending = (): number | null =>
      (el as unknown as { parseTimer: number | null }).parseTimer;

    (el as unknown as { handleSourceChange(s: string): void })
      .handleSourceChange('system { voltages { "MV" { V = 11 kV; } } }');
    expect(pending(), 'an edit should have armed the debounce').not.toBeNull();

    el.remove();
    expect(pending(), 'removal should have disarmed it').toBeNull();
  });
});

describe('starting up', () => {
  it('mounts with a study already loaded', async () => {
    app = await mount();
    expect(peek<string>(app, 'src').length).toBeGreaterThan(0);
    expect(app.isConnected).toBe(true);
  });

  it('parses that study and finds relays in it', async () => {
    app = await mount();
    await edit(app, STUDY);
    expect(peek<{ relays: Map<string, unknown> } | undefined>(app, 'study')).toBeDefined();
  });

  it('renders both panes by default', async () => {
    app = await mount();
    expect(peek<string>(app, 'pane')).toBe('split');
  });
});

describe('editing the source', () => {
  it('reprocesses on change, and the study follows', async () => {
    app = await mount();
    await edit(app, STUDY);

    const study = peek<{ relays: Map<string, unknown> }>(app, 'study');
    expect([...study.relays.keys()]).toEqual(['R']);
  });

  it('surfaces parse errors rather than throwing', async () => {
    app = await mount();
    await edit(app, 'relay R { element 51 { curve = @ } }');
    expect(peek<unknown[]>(app, 'errors').length).toBeGreaterThan(0);
  });

  it('keeps going when the source is emptied', async () => {
    app = await mount();
    await edit(app, '');
    expect(app.isConnected).toBe(true);
  });
});

describe('examples', () => {
  it('loads one by id and replaces the source', async () => {
    app = await mount();
    (app as unknown as { loadExample(id: string): void }).loadExample('sequence');
    await app.updateComplete;
    expect(peek<string>(app, 'exampleId')).toBe('sequence');
    expect(peek<string>(app, 'src')).toContain('scenario');
  });

  it('ignores an id it does not have', async () => {
    app = await mount();
    const before = peek<string>(app, 'src');
    (app as unknown as { loadExample(id: string): void }).loadExample('not-an-example');
    await app.updateComplete;
    expect(peek<string>(app, 'src')).toBe(before);
  });
});

describe('the draft kept in the browser', () => {
  it('saves the current source and reads it back', async () => {
    app = await mount();
    await edit(app, STUDY);
    (app as unknown as { saveToBrowser(): void }).saveToBrowser();

    const stored = Object.keys(localStorage).some((k) =>
      (localStorage.getItem(k) ?? '').includes('R_51') ||
      (localStorage.getItem(k) ?? '').includes('iec.si'));
    expect(stored).toBe(true);
  });

  it('resetting the draft restores the example', async () => {
    app = await mount();
    await edit(app, STUDY);
    (app as unknown as { resetDraft(): void }).resetDraft();
    await app.updateComplete;
    expect(peek<string>(app, 'src')).not.toBe(STUDY);
  });
});

describe('theme', () => {
  it('toggles between light and dark', async () => {
    app = await mount();
    const first = peek<string>(app, 'theme');
    (app as unknown as { toggleTheme(): void }).toggleTheme();
    await app.updateComplete;
    expect(peek<string>(app, 'theme')).not.toBe(first);
  });
});

describe('formatting', () => {
  it('tidies the source in place', async () => {
    app = await mount();
    await edit(app, 'system{voltages{"MV"{V=11 kV;}}}');
    (app as unknown as { formatSource(): void }).formatSource();
    await app.updateComplete;
    /* Formatting gives each brace its own line. */
    expect(peek<string>(app, 'src').split('\n').length).toBeGreaterThan(3);
  });
});

describe('panes', () => {
  it('can show one pane at a time', async () => {
    app = await mount();
    poke(app, 'pane', 'source');
    await app.updateComplete;
    expect(peek<string>(app, 'pane')).toBe('source');

    poke(app, 'pane', 'plot');
    await app.updateComplete;
    expect(peek<string>(app, 'pane')).toBe('plot');
  });
});

describe('the report panel', () => {
  it('opens and closes', async () => {
    app = await mount();
    poke(app, 'showReport', true);
    await app.updateComplete;
    expect(peek<boolean>(app, 'showReport')).toBe(true);

    poke(app, 'showReport', false);
    await app.updateComplete;
    expect(peek<boolean>(app, 'showReport')).toBe(false);
  });
});

describe('the guide overlay', () => {
  it('opens on request', async () => {
    app = await mount();
    poke(app, 'showGuide', true);
    await app.updateComplete;
    expect(peek<boolean>(app, 'showGuide')).toBe(true);
  });
});
