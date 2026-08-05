/**
 * The visual baseline: every shipped example, every sheet, frozen.
 *
 * This is the regression net the rest of the drawing work hangs from.
 * Each example is rendered for each of its views and reduced to a
 * digest -- one line per drawn element, with position and identity --
 * which is committed under `tests/unit/__baseline__/`. A change to the
 * renderer that moves anything shows up as a diff naming what moved.
 *
 * Refreshing a baseline is deliberate:
 *
 *     npx vitest run tests/unit/visual-baseline.spec.ts -u
 *
 * and the diff is then reviewed like any other change to a drawing. A
 * baseline updated without reading it is worse than no baseline, since
 * it converts a caught regression into a recorded one.
 *
 * Both themes are covered but only for one example: the theme changes
 * colours, and colours are not in the digest, so a second full sweep
 * would freeze the same numbers twice. What it *does* change is the
 * legend's fitting decisions when contrast pushes a different string
 * length -- so one example holds the line.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import { digest } from './svg-digest.js';
import { sheetsOf } from './sheets.js';

const EXAMPLES = readdirSync('examples').filter((f) => f.endsWith('.ptc')).sort();

describe('the shipped examples draw what they drew', () => {
  it('has examples to check', () => {
    expect(EXAMPLES.length).toBeGreaterThan(10);
  });

  for (const file of EXAMPLES) {
    const stem = file.replace(/\.ptc$/, '');
    it(`${stem} matches its baseline`, async () => {
      const result = parse(readFileSync(`examples/${file}`, 'utf8'));
      const parts = sheetsOf(result).map(({ name, view }) => {
        const svg = renderStudy(result, { theme: 'light', view });
        return `=== sheet: ${name} ===\n${digest(svg)}`;
      });
      await expect(parts.join('\n')).toMatchFileSnapshot(
        `__baseline__/${stem}.txt`,
      );
    });
  }
});

describe('themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`the capability tour lays out identically in ${theme}`, async () => {
      const result = parse(readFileSync('examples/09-capability-tour.ptc', 'utf8'));
      const svg = renderStudy(result, { theme });
      await expect(digest(svg)).toMatchFileSnapshot(
        `__baseline__/theme-${theme}.txt`,
      );
    });
  }
});
