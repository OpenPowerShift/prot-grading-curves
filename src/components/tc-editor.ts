/**
 * <tc-editor> – CodeMirror 6 host.
 *
 * Wraps a CodeMirror EditorView with the basic styling and a thin
 * change notifier. v1x uses text language only -- syntax highlight
 * is wired but the tab autocompletion / hover tooltips are wired
 * once `src/editor/` files fill in (Phase 5 deliverable).
 */

import { LitElement, css, html, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, hoverTooltip } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';

import { tcCompletionSource } from '../editor/completions.js';
import { tcHoverSource } from '../editor/hover.js';
import { tcLanguage } from '../highlight/tc-language.js';
import { tcEditorAppearance } from '../highlight/tc-highlight-style.js';

/** Keyboard shortcuts that the Source/Plot playground exposes.
 *  These are wired into the editor's keymap so they work even
 *  while typing. */
export interface EditorShortcuts {
  onSave?: () => void;
  onOpen?: () => void;
}

@customElement('tc-editor')
export class TcEditor extends LitElement {
  /** Source text shown in the editor. */
  @property({ type: String }) source = '';
  /** Fires on every change. */
  @property({ attribute: false }) declare onChange: (src: string) => void;
/** Plug-in callbacks for Ctrl+S / Ctrl+O while the editor has
 *  focus. Save a .tc file or open one from disk. */
  @property({ attribute: false }) declare shortcuts: EditorShortcuts | null;
  /** Optional callback fired whenever the user moves the caret or
   *  extends the selection. The argument is the head's character
   *  offset into the editor, suitable for restoring later. */
  @property({ attribute: false }) declare onSelectionMove: ((offset: number) => void) | null;
  /** Internal CM view. */
  private view?: EditorView;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      background: var(--tc-bg-sunken);
      color: var(--tc-fg);
    }
    .cm-editor {
      flex: 1 1 0;
      min-height: 0;
      width: 100%;
      height: auto;
      font-family: var(--tc-font);
      font-size: 13px;
    }
    .cm-scroller {
      font-family: var(--tc-font) !important;
    }
    .cm-gutters {
      background: var(--tc-bg-sunken);
      color: var(--tc-fg-muted);
      border: none;
    }
    .cm-content { caret-color: var(--tc-accent); }
    .cm-line { padding-left: 6px; }
    .cm-cursor { border-left-color: var(--tc-accent); }
    .cm-selectionBackground, ::selection {
      background: var(--tc-bg-elevated) !important;
    }
    /* autocomplete dropdown + tooltip styling tuned for the dark
       toolbar/background palette */
    .cm-tooltip-autocomplete {
      background: var(--tc-bg-elevated);
      color: var(--tc-fg);
      border: 1px solid var(--tc-border);
      border-radius: 4px;
      font-family: var(--tc-font);
      font-size: 12px;
    }
    .cm-tooltip-autocomplete > ul > li[aria-selected] {
      background: var(--tc-accent);
      color: var(--tc-accent-fg);
    }
    .tc-help-tooltip {
      background: var(--tc-bg-elevated);
      color: var(--tc-fg);
      border: 1px solid var(--tc-border);
      border-radius: 4px;
      padding: 6px 10px;
      max-width: 420px;
      font-family: var(--tc-font);
      font-size: 12px;
    }
    .tc-help-tooltip .cm-help-line {
      font-weight: 600;
      color: var(--tc-accent);
    }
    .tc-help-tooltip .cm-help-scope {
      color: var(--tc-fg-muted);
      font-weight: 400;
    }
    .tc-help-tooltip .cm-help-summary {
      margin: 4px 0;
      color: var(--tc-fg);
    }
    .tc-help-tooltip .cm-help-example {
      background: var(--tc-bg-sunken);
      border: 1px solid var(--tc-border);
      border-radius: 3px;
      padding: 4px 6px;
      margin: 4px 0 0;
      white-space: pre-wrap;
      font-family: var(--tc-font);
      font-size: 11px;
      color: var(--tc-accent);
    }
  `;

  protected updated(changed: PropertyValues): void {
    if (!this.view) {
      this.mountEditor();
      return;
    }
    if (!changed.has('source')) return;

    /*
     * Only push text into the editor when it genuinely differs from
     * what the editor already holds.
     *
     * Typing round-trips through the parent: the editor notifies, the
     * app stores the text, and it comes straight back down as
     * `source`. Comparing against the *previous* property value made
     * that round-trip look like an external edit, so every keystroke
     * replaced the whole document -- which discards the selection and
     * sends the caret to the top. Comparing against the live document
     * makes the round-trip a no-op, and still lets a real external
     * change (loading an example, opening a file) through.
     */
    const current = this.view.state.doc.toString();
    if (this.source === current) return;

    /* Keep the caret where it was, clamped to the incoming text. */
    const head = Math.min(this.view.state.selection.main.head, this.source.length);
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: this.source },
      selection: { anchor: head },
    });
  }

  private mountEditor(): void {
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      tcLanguage,
      tcEditorAppearance,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => { this.shortcuts?.onSave?.(); return true; },
        },
        {
          key: 'Mod-o',
          preventDefault: true,
          run: () => { this.shortcuts?.onOpen?.(); return true; },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      autocompletion({
        override: [tcCompletionSource],
        activateOnTyping: true,
        maxRenderedOptions: 50,
      }),
      hoverTooltip((view, pos) => tcHoverSource({ view, pos }), { hoverTime: 250 }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const s = u.state.doc.toString();
          this.onChange?.(s);
        }
        if (u.selectionSet && this.onSelectionMove) {
          const head = u.state.selection.main.head;
          this.onSelectionMove(head);
        }
      }),
    ];
    const state = EditorState.create({ doc: this.source, extensions: exts });
    this.view = new EditorView({ state, parent: this.renderRoot as HTMLElement });
  }

  /** Move the caret to a 1-based line/column and reveal it. */
  gotoPosition(line: number, column: number): void {
    const view = this.view;
    if (!view) return;
    const lineCount = view.state.doc.lines;
    const target = view.state.doc.line(Math.min(Math.max(1, line), lineCount));
    const pos = Math.min(target.from + Math.max(0, column - 1), target.to);
    view.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    });
    view.focus();
  }

  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  render() {
    // CodeMirror is mounted imperatively in updated(). Lit's render
    // output here is empty; the cm-editor lives directly inside the
    // element's light DOM.
    return html``;
  }
}
