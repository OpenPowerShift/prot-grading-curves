/**
 * CodeMirror 6 hover source for the .ptc language.
 *
 * When the user hovers over a token, we look it up in `help-data`:
 *   - If the token is a top-level keyword, surface its summary.
 *   - If the token is "iec.si"/"ansi.mi"/..., surface the curve
 *     description.
 *   - If the token is a field name, surface its summary + a small
 *     example.
 */

import type { EditorView, Tooltip } from '@codemirror/view';

import { KEYWORD_HELP, CURVE_HELP } from '../help/help-data.js';

type HoverPos = { view: EditorView; pos: number };

/** Lightweight CM6 tooltip-view returned to `hoverTooltip.create()`.
 *  The shape matches what CM6 expects: a `dom` (and optional
 *  `update`/`destory` methods). */
class HelpTooltipView {
  dom: HTMLElement;
  pos: number;
  constructor(pos: number) {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-tooltip-hover tc-help-tooltip';
    this.pos = pos;
  }
  update(update: { pos: number }) {
    this.pos = update.pos;
  }
}

function wordAt(view: EditorView, pos: number): { text: string; from: number; to: number } | null {
  const range = view.state.wordAt(pos);
  if (range && range.from !== range.to) {
    /*
     * A dotted identifier is one name, not two.
     *
     * `wordAt` stops at the dot, so the caret anywhere in `iec.si`
     * returned `iec` -- which has no entry, so the one lookup a reader
     * most wants ("what curve is this?") produced nothing at all. The
     * plain word is extended over an adjacent dot in either direction
     * before it is used.
     */
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    let from = range.from;
    let to = range.to;
    const relFrom = () => from - line.from;
    const relTo = () => to - line.from;
    if (text[relTo()] === '.') {
      const after = /^\.[A-Za-z_]\w*/.exec(text.slice(relTo()));
      if (after) to += after[0].length;
    }
    if (relFrom() > 0 && text[relFrom() - 1] === '.') {
      const before = /[A-Za-z_]\w*\.$/.exec(text.slice(0, relFrom()));
      if (before) from -= before[0].length;
    }
    return { text: view.state.doc.sliceString(from, to), from, to };
  }
  // dotted identifier like `iec.si`
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const col = pos - line.from;
  // match [A-Za-z_]\w*(\.[A-Za-z_]\w*)? around col
  const before = text.slice(0, col);
  const after = text.slice(col);
  const m1 = /[A-Za-z_]\w*\.?$/.exec(before);
  const m2 = /^[A-Za-z_]\w*\.?[A-Za-z_]\w*/.exec(after);
  if (!m1 || !m2) return null;
  return {
    text: m1[0] + m2[0],
    from: line.from + (col - m1[0].length),
    to: line.from + col + m2[0].length,
  };
}

/**
 * The help for whatever token sits at `pos`, as data.
 *
 * The same lookup the hover tooltip does, without building any DOM, so
 * a docked panel can show it beside the source instead of a card
 * floating over the line being read. A tooltip has to be dismissed and
 * covers the code; a panel can simply follow the caret.
 */
export function helpAt(view: EditorView, pos: number): {
  name: string;
  scope?: string;
  summary: string;
  example?: string;
} | null {
  /* Asked about a position the document does not have -- a stale
   * hover after an edit shortened it -- there is nothing to explain. */
  if (pos < 0 || pos > view.state.doc.length) return null;
  const w = wordAt(view, pos);
  if (!w) return null;
  const e = KEYWORD_HELP[w.text] ?? CURVE_HELP[w.text];
  if (!e) return null;
  return typeof e === 'string'
    ? { name: w.text, summary: e }
    : { name: w.text, scope: e.scope, summary: e.summary, example: e.example };
}

export function tcHoverSource({ view, pos }: HoverPos): Tooltip | null {
  /* Asked about a position the document does not have -- a stale
   * hover after an edit shortened it -- there is nothing to explain. */
  if (pos < 0 || pos > view.state.doc.length) return null;
  const w = wordAt(view, pos);
  if (!w) return null;
  const e = KEYWORD_HELP[w.text] ?? CURVE_HELP[w.text];
  if (!e) return null;

  const dom = new HelpTooltipView(w.from).dom;
  if (typeof e === 'string') {
    dom.innerHTML = `<div class="cm-help-line"><b>${escapeHtml(w.text)}</b></div>` +
                    `<div class="cm-help-detail">${escapeHtml(CURVE_HELP[w.text])}</div>`;
  } else {
    dom.innerHTML = `<div class="cm-help-line"><b>${escapeHtml(w.text)}</b>` +
                    `<span class="cm-help-scope"> · ${escapeHtml(e.scope)}</span></div>` +
                    `<div class="cm-help-summary">${escapeHtml(e.summary)}</div>` +
                    `<pre class="cm-help-example">${escapeHtml(e.example)}</pre>`;
  }
  return { pos: w.from, end: w.to, above: true, create: () => ({ dom }) };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c] as string));
}
