/**
 * Collect V8 coverage from the browser during a Playwright run.
 *
 * The unit suite cannot reach a third of the source: drag handlers,
 * the clipboard, download links, `ResizeObserver`, and the PNG
 * rasteriser all need a real engine. Those paths *are* exercised by
 * the visual suite -- they simply were not counted, so the project's
 * coverage figure described only half of what it tests.
 *
 * Chromium reports coverage per *script URL*. Because the app is served
 * by Vite in dev mode, each module keeps its own URL
 * (`/src/components/tc-app.ts`) and carries an inline source map, so a
 * range in the transformed module maps straight back to the TypeScript
 * a human wrote. That is the whole reason this is run against the dev
 * server rather than a production bundle, where everything would arrive
 * as one minified file.
 *
 * Raw V8 output is written to `coverage-browser/`;
 * `scripts/merge-coverage.mjs` converts and merges it with the unit run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

/*
 * Deliberately outside `coverage/`: vitest wipes that directory before
 * each run, and the browser data is written by a different command --
 * whichever ran last would otherwise delete the other's evidence.
 */
const OUT = join(process.cwd(), 'coverage-browser');

/** Only the app's own modules; not Vite's client, not dependencies. */
function isOurs(url: string): boolean {
  if (!url.includes('/src/')) return false;
  if (url.includes('/node_modules/')) return false;
  if (url.includes('@vite') || url.includes('@react-refresh')) return false;
  return /\.(ts|js)(\?|$)/.test(url);
}

let counter = 0;

export const test = base.extend<{ coverage: void }>({
  coverage: [async ({ page, browserName }, use, testInfo) => {
    /* V8 coverage is a Chromium API; other engines just run the test. */
    const collecting = browserName === 'chromium';

    if (collecting) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    }

    await use();

    if (!collecting) return;

    const entries = await page.coverage.stopJSCoverage();
    const ours = entries.filter((e) => isOurs(e.url));
    if (ours.length === 0) return;

    mkdirSync(OUT, { recursive: true });
    const name = `${testInfo.title.replace(/[^\w-]+/g, '-').slice(0, 60)}-${counter++}.json`;
    writeFileSync(join(OUT, name), JSON.stringify(ours), 'utf8');
  }, { auto: true }],
});

export { expect } from '@playwright/test';
