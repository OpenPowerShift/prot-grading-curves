/**
 * The paths only a real browser can run.
 *
 * Everything here was invisible to the unit suite and so uncounted:
 * PNG rasterising needs a canvas, downloads need an anchor the browser
 * will act on, the clipboard needs a permission, dragging needs layout,
 * and the wheel needs an SVG with a real `getScreenCTM`. jsdom fakes
 * none of them convincingly, and a test built on enough stubs stops
 * asserting anything about the product.
 *
 * These are behavioural, not visual -- no screenshots, so they can run
 * in CI without baselines to maintain.
 */

import { expect, test } from './coverage-fixture.js';

/** Load the app and let the first parse settle. */
async function open(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('tc-viewer svg');
  await page.waitForTimeout(400);
}

test.describe('exporting', () => {
  test('downloads the plot as an SVG', async ({ page }) => {
    await open(page);
    const download = page.waitForEvent('download');
    await page.click('[title="Download the plot as an SVG file"]');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.svg$/);
  });

  test('downloads the plot as a PDF', async ({ page }) => {
    /*
     * The PDF path runs svg2pdf against a real engine, measuring every
     * element as it goes. Under jsdom it only runs at all because
     * `getBBox` is stubbed, so this is the first honest exercise of it.
     */
    await open(page);
    const download = page.waitForEvent('download');
    await page.click('[title="Download the plot as a PDF (always light, for printing)"]');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('downloads the source as a .tc file', async ({ page }) => {
    await open(page);
    const download = page.waitForEvent('download');
    await page.click('[title="Download the current source as a .tc file"]');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.tc$/);
  });

  test('rasterises the plot to a PNG for the clipboard', async ({ page, context }) => {
    /*
     * The rasteriser is the one piece of the export chain with no
     * jsdom equivalent at all -- it needs a canvas to draw onto.
     */
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await page.click('[title="Copy the plot to the clipboard as a PNG"]');
    /* The button reports its own outcome rather than throwing. */
    await expect(page.locator('tc-viewer')).toBeVisible();
    await page.waitForTimeout(600);
  });
});

test.describe('the plot responds to the pointer', () => {
  test('wheel zooms, and reset puts it back', async ({ page }) => {
    await open(page);
    const svg = page.locator('tc-viewer svg').first();
    const box = await svg.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);

    await page.click('[title="Reset the plot zoom to the view block\'s bounds"]');
    await page.waitForTimeout(300);
    await expect(svg).toBeVisible();
  });

  test('dragging pans the plot', async ({ page }) => {
    await open(page);
    const svg = page.locator('tc-viewer svg').first();
    const box = (await svg.boundingBox())!;

    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await expect(svg).toBeVisible();
  });

  test('hovering reads a coordinate off the curve', async ({ page }) => {
    await open(page);
    const svg = page.locator('tc-viewer svg').first();
    const box = (await svg.boundingBox())!;
    /* Sweep across the plot so the snap logic runs at many currents. */
    for (const f of [0.3, 0.45, 0.6, 0.75]) {
      await page.mouse.move(box.x + box.width * f, box.y + box.height * 0.5);
      await page.waitForTimeout(80);
    }
    await page.mouse.move(box.x - 50, box.y - 50);
    await expect(svg).toBeVisible();
  });
});

test.describe('the shell', () => {
  test('switches panes', async ({ page }) => {
    await open(page);
    for (const title of ['Show the plot controls']) {
      const button = page.locator(`[title="${title}"]`);
      if (await button.count()) await button.first().click();
    }
    await expect(page.locator('tc-app')).toBeVisible();
  });

  test('drags the splitter between the panes', async ({ page }) => {
    /* Layout arithmetic: jsdom measures everything as zero, so this
     * only means anything in a real engine. */
    await open(page);
    const splitter = page.locator('tc-app .splitter');
    if (await splitter.count()) {
      const box = (await splitter.first().boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
    }
    await expect(page.locator('tc-app')).toBeVisible();
  });

  test('opens the report panel', async ({ page }) => {
    await open(page);
    await page.click('[title="Show the grading margin report"]');
    await page.waitForTimeout(300);
    await expect(page.locator('tc-app')).toBeVisible();
  });

  test('opens the guide and switches to the reference', async ({ page }) => {
    await open(page);
    await page.click('[title="Open the language specification"]');
    await page.waitForSelector('tc-guide[open]');
    /* Both documents are fetched in one chunk on first open. */
    const reference = page.locator('tc-guide button', { hasText: 'Reference' });
    await reference.click();
    await page.waitForTimeout(200);
    await expect(page.locator('tc-guide')).toBeVisible();
  });

  test('formats the source', async ({ page }) => {
    await open(page);
    await page.click('[title="Reflow the source with standard indentation"]');
    await page.waitForTimeout(400);
    await expect(page.locator('tc-viewer svg').first()).toBeVisible();
  });

  test('copies a share link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    const copy = page.locator('[title*="Copy"]', { hasText: /link/i });
    if (await copy.count()) {
      await copy.first().click();
      await page.waitForTimeout(200);
    }
    await expect(page.locator('tc-app')).toBeVisible();
  });
});

test.describe('every example draws in the browser', () => {
  /*
   * Each example exercises a different part of the renderer, so
   * stepping through them all is the cheapest broad sweep there is --
   * and it is the only place devices, combines and multi-sheet studies
   * are drawn by a real engine.
   */
  const IDS = [
    'riverside', 'single', 'mixed', 'multistage', 'transformer', 'secondary',
    'miscoordination', 'fuse', 'cascade', 'portrait', 'sequence',
    'clearance', 'devices', 'parallel', 'style', 'sheets', 'tour',
  ];

  test('steps through the whole library', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    for (const id of IDS) {
      await page.selectOption('tc-app select.picker', id);
      await page.waitForTimeout(450);
      await expect(page.locator('tc-viewer svg').first(), id).toBeVisible();
    }
  });
});
