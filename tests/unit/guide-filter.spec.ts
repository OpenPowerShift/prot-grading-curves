/**
 * The guide's filter, matching what a reader would type.
 *
 * It narrowed the table of contents by heading *text* only, so `tms`
 * and `margin` -- two of the likeliest things anyone would search for
 * -- found nothing in any of the four documents, neither being a
 * section title. That reads as a broken search rather than a narrow
 * one, and the reader's next move is to stop using it.
 */

import { describe, expect, it } from 'vitest';
import '@tc/components/tc-guide.js';

type Guide = HTMLElement & {
  updateComplete: Promise<unknown>;
  open: boolean;
};

const call = (el: Guide, method: string, ...args: unknown[]): unknown =>
  (el as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);

const set = (el: Guide, key: string, value: unknown): void => {
  (el as unknown as Record<string, unknown>)[key] = value;
};

const headings = (el: Guide): string[] =>
  (call(el, 'visibleToc') as Array<{ text: string }>).map((h) => h.text);

/** A guide panel with a document whose prose is searchable. */
const panel = async (): Promise<Guide> => {
  const el = document.createElement('tc-guide') as Guide;
  document.body.append(el);
  await el.updateComplete;
  /* `guide` is a getter over `docs[which]`, so the document is
   * supplied the way the component actually receives it. */
  const doc = {
    title: 'T',
    revision: '1',
    revdate: '',
    toc: [
      { level: 2, id: 'elements', text: 'Elements' },
      { level: 3, id: 'curves', text: 'Curves and dials' },
      { level: 2, id: 'grading', text: 'Grading' },
    ],
    html: '<h2 id="elements">Elements</h2><p>An element declares a curve.</p>'
      + '<h3 id="curves">Curves and dials</h3><p>The <code>tms</code> is the dial.</p>'
      + '<h2 id="grading">Grading</h2><p>A margin is a floor.</p>',
  };
  set(el, 'docs', { tutorial: doc, guide: doc, advanced: doc, skill: doc });
  return el;
};

describe('filtering the contents', () => {
  it('finds a word that appears only in the prose', async () => {
    const el = await panel();
    set(el, 'filter', 'tms');
    expect(headings(el)).toContain('Curves and dials');
    el.remove();
  });

  it('finds "margin", which is no section\'s title', async () => {
    const el = await panel();
    set(el, 'filter', 'margin');
    expect(headings(el)).toContain('Grading');
    el.remove();
  });

  it('keeps the parent, so the path to a hit is navigable', async () => {
    /*
     * A match three levels down with its chapter filtered away leaves
     * an orphan the reader cannot place.
     */
    const el = await panel();
    set(el, 'filter', 'tms');
    expect(headings(el)).toContain('Elements');
    el.remove();
  });

  it('still matches a heading by its own text', async () => {
    const el = await panel();
    set(el, 'filter', 'grading');
    expect(headings(el)).toEqual(['Grading']);
    el.remove();
  });

  it('shows everything when nothing is typed', async () => {
    const el = await panel();
    set(el, 'filter', '  ');
    expect(headings(el)).toHaveLength(3);
    el.remove();
  });

  it('shows nothing for a word the document does not have', async () => {
    const el = await panel();
    set(el, 'filter', 'zzzz');
    expect(headings(el)).toEqual([]);
    el.remove();
  });
});
