/**
 * Visual regression over the built-in examples.
 *
 * Run with `npm run test:visual`. This is deliberately *not* part of
 * the CI workflow: screenshot baselines are a judgement about what the
 * plot should look like, so they are refreshed by a human running
 *
 *     npx playwright test --update-snapshots
 *
 * after reviewing the change. The unit suite (`npm test`) is what CI
 * gates on, and it covers the numerical behaviour.
 *
 * No baselines are committed yet: the renderer's geometry is still
 * settling, and freezing a baseline against an unreviewed render would
 * lock in whatever is currently wrong. The first deliberate run
 * establishes them.
 */

import { expect, test } from '@playwright/test';

/** Matches the `EXAMPLES` list in `src/components/tc-app.ts`. */
const EXAMPLES = [
  { id: 'riverside', label: 'Riverside 33/11 kV' },
  { id: 'single', label: 'Plant 480 V (single relay)' },
  { id: 'mixed', label: 'Cross-vendor (ANSI MI + IEC VI)' },
  { id: 'multistage', label: 'Multi-stage (composite)' },
];

test.describe('playground renders every example', () => {
  for (const example of EXAMPLES) {
    test(`${example.id} plots without diagnostics`, async ({ page }) => {
      await page.goto('/');

      await page.selectOption('tc-app select.picker', example.id);
      // The parse is debounced by 200 ms; wait for the redraw to settle.
      await page.waitForTimeout(600);

      const svg = page.locator('tc-viewer svg').first();
      await expect(svg).toBeVisible();

      // Every example must draw at least one curve.
      await expect(page.locator('tc-viewer path.tc-curve').first()).toBeVisible();

      // …and none of them may report an error-severity finding.
      await expect(page.locator('tc-app .counts')).not.toContainText('error');

      await expect(svg).toHaveScreenshot(`${example.id}.png`, {
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});

test.describe('themes', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`plot renders in the ${theme} theme`, async ({ page }) => {
      await page.goto('/');
      await page.evaluate((t) => {
        localStorage.setItem('tc-curves.theme', t);
      }, theme);
      await page.reload();
      await page.waitForTimeout(600);

      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('tc-viewer svg').first()).toHaveScreenshot(
        `theme-${theme}.png`,
        { maxDiffPixelRatio: 0.01 },
      );
    });
  }
});
