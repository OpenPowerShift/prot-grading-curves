/**
 * <tc-editor> – CodeMirror 6 host.
 *
 * Wraps a CodeMirror EditorView with the basic styling and a thin
 * change notifier. v1x uses text language only -- syntax highlight
 * is wired but the tab autocompletion / hover tooltips are wired
 * once `src/editor/` files fill in (Phase 5 deliverable).
 */

import { LitElement, html, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorView, keymap, lineNumbers, highlightActiveLine, hoverTooltip } from '@codemirror/view';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import {
  autocompletion,
  acceptCompletion,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete';

import { tcCompletionSource } from '../editor/completions.js';
import { helpAt, tcHoverSource } from '../editor/hover.js';
import { tcLanguage } from '../highlight/tc-language.js';
import { tcEditorAppearance } from '../highlight/tc-highlight-style.js';

/**
 * One finding, in the shape the editor needs.
 *
 * Deliberately not the semantic `Diagnostic`: the editor works in
 * character offsets and knows nothing about codes or study structure,
 * and the app already has to merge parse errors with semantic findings
 * before either can be shown.
 */
export interface EditorMark {
  line: number;
  column: number;
  length: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code: string;
}

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
 *  focus. Save a .ptc file or open one from disk. */
  @property({ attribute: false }) declare shortcuts: EditorShortcuts | null;
  /**
   * Where the caret should be put, when the app has an opinion.
   *
   * Ordinary edits keep the caret themselves. Formatting is the case
   * that cannot: it rewrites indentation and spacing throughout, so
   * the offset the caret held before points somewhere else after, and
   * the reader is dropped mid-token several lines from where they were
   * working. The app resolves the line it wants and asks for it here.
   *
   * Consumed once, so a later edit is not dragged back to it.
   */
  @property({ attribute: false }) declare caretRequest: number | null;

  /** Optional callback fired whenever the user moves the caret or
   *  extends the selection. The argument is the head's character
   *  offset into the editor, suitable for restoring later. */
  @property({ attribute: false }) declare onSelectionMove: ((offset: number) => void) | null;
  /**
   * Help for the token under the caret, for the panel beside the
   * source. A floating tooltip covers the line being read and has to
   * be dismissed; a panel simply follows the caret.
   */
  @property({ attribute: false }) declare onHelp:
    ((help: ReturnType<typeof helpAt>) => void) | null;
  /**
   * Findings to mark in the text.
   *
   * The list below the editor was the only place a diagnostic appeared,
   * and its line numbers are only as good as the location the finding
   * carries -- so a reader was told there was a problem and left to
   * find it. Marking the text is what makes a diagnostic point at
   * something. `validate.ts` has said all along that codes are stable
   * "so the editor's lint gutter can key off them"; this is that
   * gutter, six months late.
   */
  @property({ attribute: false }) declare marks: readonly EditorMark[];

  /** Internal CM view. */
  private view?: EditorView;

  /*
   * No `static styles` here, deliberately.
   *
   * `createRenderRoot()` returns `this`, so this component renders
   * into the *light* DOM and Lit never adopts a `static styles`
   * block. One sat here for months looking like the place to edit and
   * doing nothing; two of the three carried rules that existed nowhere
   * else, so what a reader could see was missing they could not find.
   *
   * The live sheet is `src/styles/global.css`, where every rule is
   * scoped by the element tag.
   */

  protected updated(changed: PropertyValues): void {
    if (!this.view) {
      this.mountEditor();
      this.pushMarks();
      return;
    }
    if (changed.has('marks')) this.pushMarks();
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

    /* An explicit request wins; otherwise keep the caret where it was,
     * clamped to the incoming text. */
    const asked = this.caretRequest;
    const head = asked != null
      ? Math.max(0, Math.min(asked, this.source.length))
      : Math.min(this.view.state.selection.main.head, this.source.length);
    this.caretRequest = null;
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: this.source },
      selection: { anchor: head },
      scrollIntoView: true,
    });
  }

  private mountEditor(): void {
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      /*
       * Find and replace on Ctrl-F, where every other editor puts it.
       *
       * A study runs to hundreds of lines and its identifiers repeat --
       * `R_FDR_1:51` appears in a relay, a grade, and three
       * annotations -- so finding the one you meant by eye is the slow
       * part of editing one. `highlightSelectionMatches` also marks the
       * other occurrences of whatever is selected, which answers "where
       * else is this named" without a search at all.
       */
      search({ top: true }),
      lintGutter(),
      highlightSelectionMatches(),
      bracketMatching(),
      tcLanguage,
      tcEditorAppearance,
      keymap.of([
        /* Ctrl-F / Cmd-F and the rest of the search bindings. Ahead of
         * the default keymap, which does not carry them. */
        ...searchKeymap,
        /*
         * Tab takes the highlighted completion, and indents when no
         * list is open. Bound ahead of the default keymap so it wins
         * either way -- unbound, Tab moves focus out of the editor,
         * which is what made it look as though completion was doing
         * nothing.
         */
        { key: 'Tab', run: acceptCompletion },
        { key: 'Tab', run: indentMore, shift: indentLess },
        {
          /*
           * `?` asks "what can go here?". It opens the completion
           * list, which carries the field names and their one-line
           * descriptions -- except inside a string or a comment,
           * where a question mark is just a character the author is
           * typing.
           */
          key: '?',
          run: (view) => {
            if (inStringOrComment(view.state.doc.toString(), view.state.selection.main.head)) {
              return false;
            }
            if (completionStatus(view.state) === null) startCompletion(view);
            return true;
          },
        },
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
      /*
       * Middle-click paste is refused.
       *
       * On X11 a middle click over a contenteditable inserts the
       * primary selection, so a stray middle button -- the same one
       * that pans the plot -- silently duplicated whatever text was
       * selected into the study. Nothing in this editor wants that
       * gesture, and the paste is unattributable when it happens.
       */
      EditorView.domEventHandlers({
        mousedown: (event) => {
          if (event.button === 1) { event.preventDefault(); return true; }
          return false;
        },
        auxclick: (event) => {
          if (event.button === 1) { event.preventDefault(); return true; }
          return false;
        },
      }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const s = u.state.doc.toString();
          this.onChange?.(s);
        }
        if (u.selectionSet && this.onHelp) {
          this.onHelp(helpAt(u.view, u.state.selection.main.head));
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

  /**
   * Hand the current findings to CodeMirror.
   *
   * Positions arrive as 1-based line and column, which is what every
   * other surface quotes, and have to become character offsets. A
   * finding whose line is past the end of the document is dropped
   * rather than clamped: during a re-parse the text and the findings
   * are momentarily out of step, and a marker pinned to the last line
   * would blink there on every keystroke.
   */
  private pushMarks(): void {
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;

    const marks: CmDiagnostic[] = [];
    for (const m of this.marks ?? []) {
      if (m.line < 1 || m.line > doc.lines) continue;
      const line = doc.line(m.line);
      const from = Math.min(line.from + Math.max(0, m.column - 1), line.to);
      const to = Math.min(from + Math.max(1, m.length), line.to);
      marks.push({
        from,
        /* A zero-width marker is invisible; give it the character. */
        to: to > from ? to : Math.min(from + 1, doc.length),
        severity: m.severity,
        message: m.code ? `${m.code}: ${m.message}` : m.message,
      });
    }
    view.dispatch(setDiagnostics(view.state, marks));
  }

  /**
   * Move the caret to a 1-based line/column and reveal it, centred.
   *
   * `scrollIntoView: true` scrolls the *minimum* amount, so a line
   * below the viewport arrives at the very bottom edge with nothing
   * after it on screen. A diagnostic is read in its surroundings --
   * the block it is in, the line before it -- and landing on the last
   * visible row hides all of that. `y: 'center'` puts it in the middle
   * of the pane, which is where a reader looks.
   */
  gotoPosition(line: number, column: number): void {
    const view = this.view;
    if (!view) return;
    const lineCount = view.state.doc.lines;
    const target = view.state.doc.line(Math.min(Math.max(1, line), lineCount));
    const pos = Math.min(target.from + Math.max(0, column - 1), target.to);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
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

/**
 * Is the offset inside a string literal or a comment?
 *
 * Used to decide whether `?` means "show me what can go here" or is
 * simply a character being typed into prose. Scans from the start of
 * the document, which is cheap enough at the size a study runs to and
 * avoids depending on the parse succeeding mid-edit.
 */
function inStringOrComment(src: string, pos: number): boolean {
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < pos && i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === '#') inLine = true;
    else if (c === '/' && next === '/') { inLine = true; i++; }
    else if (c === '/' && next === '*') { inBlock = true; i++; }
  }

  return inString || inLine || inBlock;
}
