/**
 * Guards on the editor's stylesheet.
 *
 * CodeMirror sizes parts of itself with *inline* styles that it
 * updates as the document changes. A stylesheet rule marked
 * `!important` outranks an inline style that is not, so overriding
 * those properties in `global.css` silently breaks layout in a way no
 * other test can see -- the editor still works, it just stops drawing
 * part of itself.
 *
 * These are asserted against the stylesheet text because that is
 * where the damage is done; jsdom does not lay CodeMirror out.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  join((globalThis as { process?: { cwd(): string } }).process!.cwd(), 'src/styles/global.css'),
  'utf8',
);

/**
 * Selectors in a rule that sets `min-height` with `!important`.
 *
 * Comments are stripped first: the rule below is documented with a
 * comment naming the selectors it deliberately no longer covers, and
 * a scan that treats that prose as part of the selector reports the
 * very fault the comment describes avoiding.
 */
function importantMinHeightSelectors(): string[] {
  const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    if (!/min-height\s*:[^;]*!important/.test(body)) continue;
    for (const sel of m[1].split(',')) out.push(sel.trim());
  }
  return out;
}

describe('CodeMirror layout is not overridden', () => {
  /*
   * `.cm-gutters` carries an inline `min-height` equal to the content
   * height; forcing it to zero collapsed the gutter to one screenful,
   * and `.cm-gutter { overflow: hidden }` then clipped every line
   * number below the first screen. The file looked as though it ended
   * where the first view did.
   */
  it('leaves the gutter free to grow with the document', () => {
    for (const sel of importantMinHeightSelectors()) {
      expect(sel, `${sel} must not force min-height on the gutter`).not.toMatch(/\.cm-gutters?\b/);
    }
  });

  /* `.cm-content` carries `min-height: 100%` for the same reason. */
  it('leaves the content free to grow with the document', () => {
    for (const sel of importantMinHeightSelectors()) {
      expect(sel, `${sel} must not force min-height on the content`).not.toMatch(/\.cm-content\b/);
    }
  });

  it('still relaxes the editor shell, which the flex chain needs', () => {
    expect(importantMinHeightSelectors()).toContain('.cm-editor');
  });

  it('gives the editor a bounded height, so it scrolls rather than growing', () => {
    expect(CSS).toMatch(/tc-editor\s+\.cm-editor\s*\{[^}]*height:\s*100%/);
    expect(CSS).toMatch(/tc-editor\s+\.cm-scroller\s*\{[^}]*overflow:\s*auto/);
  });
});
