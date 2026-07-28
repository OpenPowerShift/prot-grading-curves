/**
 * CodeMirror 6 hover source for the .tc language.
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
    return { text: view.state.doc.sliceString(range.from, range.to), from: range.from, to: range.to };
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

export function tcHoverSource({ view, pos }: HoverPos): Tooltip | null {
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
