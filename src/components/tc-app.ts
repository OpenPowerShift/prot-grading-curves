/**
 * <tc-app> – top-level playground host.
 *
 * Two tabs: *Source* (CodeMirror editor) and *Plot* (SVG viewer).
 * The Source tab re-parses on every keystroke and feeds the AST to
 * the Viewer; switching tabs shows whichever side the user wants.
 *
 * Ships with a starter example so the playground shows a TCC for
 * users that open it cold.
 */

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { parse, type Document, type ParseError } from '../parser/index.js';
import { buildStudy, type Study } from '../semantics/model.js';
import { validate, type Diagnostic } from '../semantics/validate.js';
import { reportGrades, formatGradeReports, type GradeReport } from '../semantics/grades.js';
import { EXAMPLES, DEFAULT_EXAMPLE } from '../examples.js';
import { formatSource } from '../format/format.js';
import {
  SAVED_PREFIX,
  clearDraft,
  deleteStudy,
  listStudies,
  loadDraft,
  saveDraft,
  saveStudy,
  shareLink,
  sourceFromLink,
  studySource,
  type SavedStudy,
} from '../editor/share.js';

import './tc-editor.js';
import './tc-viewer.js';
import './tc-guide.js';

/**
 * Default width of the Source pane, as a percentage of the window.
 * The plot is the thing being read; the source is mostly short lines.
 */
const DEFAULT_SPLIT_LEFT_PCT = 20;

const STARTER = DEFAULT_EXAMPLE.source;

@customElement('tc-app')
export class TcApp extends LitElement {
  @state() private src: string = STARTER;
  /**
   * Which panes are on screen.
   *
   * `split` is the two-pane desktop layout. The single-pane modes are
   * both a narrow-screen necessity and a desktop convenience -- a
   * plot being read wants the whole window, and so does a study being
   * written.
   */
  @state() private pane: 'split' | 'source' | 'plot' = 'split';

  /** True while the window is too narrow to show both panes at once. */
  @state() private narrow = false;
  @state() private exampleId: string | null = DEFAULT_EXAMPLE.id;
  /** Drag-to-resize state for the Source/Plot splitter. */
  private splitter: {
    dragging: boolean;
    paneEl: HTMLElement | null;
    startX: number;
    startLeftPx: number;
    paneWidthPx: number;
  } = { dragging: false, paneEl: null, startX: 0, startLeftPx: 0, paneWidthPx: 0 };

  private handleSplitterStart(ev: MouseEvent): void {
    const pane = this.renderRoot.querySelector('.pane') as HTMLElement | null;
    if (!pane) return;
    this.splitter.dragging = true;
    const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tc-split-left')) || DEFAULT_SPLIT_LEFT_PCT;
    const widthPx = pane.getBoundingClientRect().width;
    this.splitter.paneEl = pane;
    this.splitter.startX = ev.clientX;
    this.splitter.startLeftPx = (left / 100) * widthPx;
    this.splitter.paneWidthPx = widthPx;
    pane.classList.add('resizing');
    ev.preventDefault();
  }
  private handleSplitterMove(ev: MouseEvent): void {
    if (!this.splitter.dragging) return;
    const dx = ev.clientX - this.splitter.startX;
    const paneW = this.splitter.paneWidthPx;
    if (paneW <= 0) return;
    const newPx = Math.max(120, Math.min(paneW - 120, this.splitter.startLeftPx + dx));
    const pct = (newPx / paneW) * 100;
    document.documentElement.style.setProperty('--tc-split-left', pct + '%');
  }
  private handleSplitterEnd(): void {
    if (!this.splitter.dragging) return;
    this.splitter.dragging = false;
    this.splitter.paneEl?.classList.remove('resizing');
    this.splitter.paneEl = null;
    try {
      const pct = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tc-split-left'));
      if (Number.isFinite(pct)) {
        localStorage.setItem('tc.splitLeft', String(pct));
      }
    } catch { /* fall through */ }
  }
  private handleSplitterReset(): void {
    document.documentElement.style.setProperty('--tc-split-left', `${DEFAULT_SPLIT_LEFT_PCT}%`);
    try { localStorage.setItem('tc.splitLeft', '50'); } catch { /* */ }
  }

  @state() private ast?: Document;
  @state() private errors: ParseError[] = [];
  /** Semantic findings from the validator (cross-references, ranges). */
  @state() private diagnostics: Diagnostic[] = [];
  /** One margin report per `grade` block. */
  @state() private reports: GradeReport[] = [];
  /** Resolved study, carrying any solver-computed settings. */
  @state() private study: Study | undefined;
  /** Whether the report drawer is open. */
  @state() private showReport = false;

  /** Language-specification overlay. */
  @state() private showGuide = false;

  /** Transient confirmation shown after copying the share link. */
  @state() private copiedLink = false;

  /** Studies the user has saved in this browser, newest first. */
  @state() private saved: SavedStudy[] = [];

  /** Name of the saved study currently open, if any. */
  @state() private savedName: string | null = null;
  /**
   * UI theme for both panes. Seeded from the OS preference and then
   * remembered, so the choice survives a reload.
   */
  @state() private theme: 'light' | 'dark' = readStoredTheme();

  /* ----- Stable callbacks bound once.
   *  Lit's reactive property setters compare by === for non-traceable
   *  values, so re-creating these on every render would fire
   *  requestUpdate on <tc-editor> -> <tc-editor>.updated() -> doc
   *  replace check -> sometimes spurious cursor reset. Memoising
   *  once keeps property identity stable. */
  private readonly boundOnChange = (s: string) => this.handleSourceChange(s);
  private readonly boundOnSave   = () => this.saveSource();
  private readonly boundOnOpen   = () => { void this.openSourceViaPicker(); };
  private readonly boundOnSelectionMove = (offset: number) => {
    try { localStorage.setItem(this.cursorKey(this.exampleId), String(offset)); } catch { /* */ }
    this.caretLine = lineAtOffset(this.src, offset);
  };

  /**
   * Line the caret is on, 1-based.
   *
   * Used to hold back the "assigned nothing" error while that line is
   * still being written: `I_pu = ` is not a mistake at the moment the
   * `=` is typed, and reporting it there makes the panel flicker an
   * error on every assignment the engineer starts.
   */
  @state() private caretLine = 1;

  /** localStorage key per example id for the cursor we should
   *  restore when that example is loaded. */
  private cursorKey(id: string | null): string {
    return id ? `tc.cursor.${id}` : 'tc.cursor.lastFile';
  }
  private rememberCursor(): void {
    /* no-op: cursor offsets are now saved via CM's updateListener
     * -> <tc-editor>.onSelectionMove -> tc-app.boundOnSelectionMove */
  }

  /** Stable shortcuts object literal -- recreated only when the
   *  callbacks themselves change, which they don't. */
  private get boundShortcuts() {
    return { onSave: this.boundOnSave, onOpen: this.boundOnOpen };
  }

  /** When an example is loaded or a file is opened, jump the editor
   *  caret to a previously-saved offset (per file). */
  private restoreCursorForExample(id: string | null): void {
    try {
      const raw = localStorage.getItem(this.cursorKey(id));
      const offset = raw == null ? null : parseInt(raw, 10);
      if (offset == null || !Number.isFinite(offset)) return;
      // Defer until the cm-editor has finished mounting and any doc
      // replacement has settled.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const tceditor = this.renderRoot.querySelector('tc-editor') as any;
        const view = tceditor?.view;
        if (view && typeof offset === 'number' && offset <= view.state.doc.length) {
          view.dispatch({ selection: { anchor: offset } });
        }
      }));
    } catch { /* */ }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.applyTheme();
    // Restore the user's preferred splitter position from
    // localStorage; default to 50%.
    try {
      const saved = localStorage.getItem('tc.splitLeft');
      if (saved) {
        const pct = parseFloat(saved);
        if (Number.isFinite(pct) && pct >= 5 && pct <= 95) {
          document.documentElement.style.setProperty('--tc-split-left', pct + '%');
        }
      }
    } catch { /* */ }
    /*
     * What to open with, in order of how deliberate it is: a study
     * carried in the link the user followed, then whatever they were
     * last working on, then the starter example.
     */
    this.saved = listStudies();

    this.measureNarrow(this.getBoundingClientRect().width || window.innerWidth);
    if (typeof ResizeObserver !== 'undefined') {
      this.narrowObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width != null) this.measureNarrow(width);
      });
      this.narrowObserver.observe(this);
    }

    try {
      const stored = localStorage.getItem(PANE_KEY);
      if (stored === 'split' || stored === 'source' || stored === 'plot') this.pane = stored;
    } catch { /* default layout is fine */ }

    const shared = sourceFromLink();
    if (shared) {
      this.src = shared;
      this.exampleId = null;
    } else {
      const draft = loadDraft();
      if (draft) {
        this.src = draft.source;
        if (draft.exampleId?.startsWith(SAVED_PREFIX)) {
          this.savedName = draft.exampleId.slice(SAVED_PREFIX.length);
          this.exampleId = draft.exampleId;
        } else {
          this.exampleId = draft.exampleId;
        }
      }
    }

    // Parse the initial source on mount so the Plot tab has data even
    // when the editor is not visible.
    this.parseSource(this.src, 0);
    // Restore cursor for the current example after mount completes.
    requestAnimationFrame(() => this.restoreCursorForExample(this.exampleId));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.narrowObserver?.disconnect();
  }

  /**
   * Parse the source and update the AST + error list. The `ast` and
   * `errors` Lit-managed state fields get updated synchronously;
   * but the editor's `src` is updated eagerly so the user sees their
   * text as they type and the AST only catches up after the
   * debounce window.
   */
  private parseTimer: number | null = null;
  private latestSrc = '';
  private parseSource(src: string, debounce: number = 200): void {
    this.latestSrc = src;
    if (this.parseTimer != null) {
      clearTimeout(this.parseTimer);
      this.parseTimer = null;
    }
    this.parseTimer = window.setTimeout(() => {
      this.parseTimer = null;
      // Snapshot focus before the re-render cascade so we can put it
      // back if something downstream tries to grab it.
      const tceditor = this.renderRoot.querySelector('tc-editor');
      const cmContent = tceditor?.querySelector('.cm-content') as HTMLElement | null;
      const focusBefore = document.activeElement;
      const result = parse(this.latestSrc);
      this.ast = result.document;
      this.errors = result.errors;

      /*
       * Resolve, validate, and grade in the same pass. Grading runs the
       * solver, which records any computed `tms` on the study, so the
       * viewer must be handed *this* study object to draw the solved
       * curves rather than re-resolving the document itself.
       */
      if (result.document) {
        const study = buildStudy(result.document);
        this.reports = reportGrades(study);
        this.diagnostics = validate(study);
        this.study = study;
      } else {
        this.reports = [];
        this.diagnostics = [];
        this.study = undefined;
      }
      if (cmContent && document.activeElement !== cmContent
          && cmContent.contains(focusBefore)) {
        // The user had typing focus inside the editor before the
        // re-render; restore it.
        cmContent.focus({ preventScroll: true });
      }
    }, Math.max(0, debounce));
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }
    /* allow scrolling if the content (tabs + pane) overflows the
     * window vertically; keep the tabs + counts visible at the top */
    .tabs-shell {
      flex: 0 0 auto;
    }
    .tabs {
      display: flex;
      flex: 0 0 auto;
      background: var(--tc-bg-elevated);
      border-bottom: 1px solid var(--tc-border);
      padding: 0 12px;
      align-items: center;
    }
    .tab {
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
      color: var(--tc-fg-muted);
      border: none;
      background: transparent;
      font-family: inherit;
    }
    .tab.active {
      color: var(--tc-accent);
      border-bottom: 2px solid var(--tc-accent);
      margin-bottom: -1px;
    }
    .tab:hover:not(.active) {
      color: var(--tc-fg);
    }
    .picker {
      margin-left: 16px;
      padding: 4px 8px;
      background: var(--tc-bg-sunken);
      color: var(--tc-fg);
      border: 1px solid var(--tc-border);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
    }
    .picker:focus {
      outline: 2px solid var(--tc-accent);
      outline-offset: -2px;
    }
    .spacer { flex: 1 1 auto; }
    .counts {
      padding: 8px 14px;
      font-size: 12px;
      color: var(--tc-fg-muted);
      align-self: center;
    }
    .pane {
      flex: 1 1 0;
      min-height: 0;
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      overflow: hidden;          /* the SVG fills 100% height; pane-host scrolls if needed */
      background: #ffffff;
    }
    .pane > * {
      display: block;
      width: 100%;
      height: 100%;
    }
    .err-count {
      background: var(--tc-error);
      color: var(--tc-bg-sunken);
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 600;
      margin-left: 6px;
      font-size: 11px;
    }
    .warn-count {
      background: var(--tc-warning, #c78a2a);
      color: var(--tc-bg-sunken);
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 600;
      margin-left: 6px;
      font-size: 11px;
    }
    .report-toggle {
      margin-right: 10px;
      white-space: nowrap;
    }
    .verdict {
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 11px;
      color: var(--tc-bg-sunken);
    }
    .verdict.pass { background: var(--tc-ok, #3f9d58); }
    .verdict.fail { background: var(--tc-error); }
    /* The grading report is fixed-width text straight from the
     * library, so the CLI and the playground show the same thing. */
    .report {
      flex: 0 0 auto;
      max-height: 30vh;
      overflow: auto;
      margin: 0;
      padding: 10px 14px;
      background: var(--tc-bg-sunken);
      color: var(--tc-fg);
      border-bottom: 1px solid var(--tc-border);
      font-family: var(--tc-font);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre;
    }
  `;

  private handleSourceChange(src: string): void {
    this.src = src;
    this.parseSource(src);
    saveDraft(src, this.exampleId);
  }

  private showPane(which: 'split' | 'source' | 'plot'): void {
    this.pane = which;
    try { localStorage.setItem(PANE_KEY, which); } catch { /* not essential */ }
    /* The plot sizes itself to its host, so tell it to re-measure
     * once the new layout has been applied. */
    requestAnimationFrame(() => this.viewer()?.requestUpdate());
  }

  /**
   * Widths below which the split view stops being worth having.
   *
   * A split gives each pane half of what is already a small screen --
   * too little for a legend, and too little for source. Touch devices
   * get a higher threshold: a tablet or a landscape phone has the
   * pixels for two panes but not the pointer for a 6px splitter, and
   * a landscape phone reports 844-932 CSS px, comfortably past any
   * threshold set for portrait.
   */
  private static readonly NARROW_PX = 860;
  private static readonly NARROW_TOUCH_PX = 1180;

  /**
   * Measured from the app element rather than from `matchMedia`.
   *
   * A media query answers for the viewport; this answers for the
   * space the layout actually has, which is what the decision is
   * about. It also survives zoom, split-screen, and a window resized
   * without the viewport changing -- cases where a query bound at
   * start-up quietly stops being true.
   */
  private narrowObserver?: ResizeObserver;

  private measureNarrow(width: number): void {
    const coarse = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
    const limit = coarse ? TcApp.NARROW_TOUCH_PX : TcApp.NARROW_PX;
    this.narrow = width > 0 && width <= limit;
  }

  private loadExample(id: string): void {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    if (id === this.exampleId) return;     // no-op
    this.exampleId = id;
    this.src = ex.source;
    this.parseSource(ex.source, 0);
    saveDraft(ex.source, id);
    // Schedule a cursor restore once tc-editor is re-mounted for the
    // new doc.
    requestAnimationFrame(() => this.restoreCursorForExample(id));
  }

  /**
   * Handle a pick from the study list.
   *
   * One control lists both the saved studies and the worked examples,
   * so the value carries which kind it is.
   */
  private pick(value: string): void {
    if (value.startsWith(SAVED_PREFIX)) {
      const name = value.slice(SAVED_PREFIX.length);
      const source = studySource(name);
      if (source == null) return;
      this.savedName = name;
      this.exampleId = value;
      this.src = source;
      this.parseSource(source, 0);
      saveDraft(source, value);
      return;
    }
    this.savedName = null;
    this.loadExample(value);
  }

  /**
   * Save the buffer in the browser under a name, and list it.
   *
   * Named rather than anonymous because the list is the point: a
   * study the engineer can come back to has to be identifiable among
   * the others.
   */
  private saveToBrowser(): void {
    const suggestion = this.savedName ?? this.suggestedName();
    const name = window.prompt('Save this study as:', suggestion);
    if (name == null) return;

    const entry = saveStudy(name, this.src);
    if (!entry) return;

    this.savedName = entry.name;
    this.exampleId = SAVED_PREFIX + entry.name;
    this.saved = listStudies();
    saveDraft(this.src, this.exampleId);
  }

  /**
   * A name to offer when saving: the study's own `meta.project`, which
   * is what an engineer would have called it anyway.
   */
  private suggestedName(): string {
    const project = this.study?.meta?.project;
    if (typeof project === 'string' && project.trim()) return project.trim();
    return 'Untitled study';
  }

  private deleteSaved(): void {
    if (!this.savedName) return;
    if (!window.confirm(`Delete the saved study "${this.savedName}"?`)) return;

    deleteStudy(this.savedName);
    this.savedName = null;
    this.saved = listStudies();
    this.exampleId = null;
  }

  /**
   * Copy a link carrying the whole study.
   *
   * The source rides in the URL fragment, so it never reaches a
   * server, and the link works from wherever the playground is
   * served. Falls back to a prompt when the clipboard is refused,
   * which is what an insecure origin does.
   */
  private async copyShareLink(): Promise<void> {
    const link = shareLink(this.src);
    try {
      await navigator.clipboard.writeText(link);
      this.copiedLink = true;
      window.setTimeout(() => { this.copiedLink = false; }, 1600);
    } catch {
      window.prompt('Copy this link to share the study:', link);
    }
  }

  /** Discard the working draft and return to the starter example. */
  private resetDraft(): void {
    clearDraft();
    this.savedName = null;
    this.exampleId = null;
    this.loadExample(DEFAULT_EXAMPLE.id);
  }

  /**
   * A filename stem for downloads.
   *
   * The same rule the plot exports use, so a study's `.tc`, `.svg`,
   * and `.pdf` land in a folder next to each other under one name
   * rather than under three unrelated ones. The saved-study name wins
   * where there is one, since that is what the engineer called it.
   */
  private exportStem(): string {
    const project = this.study?.meta?.project;
    const base = this.savedName
      ?? (typeof project === 'string' && project.trim() ? project : null)
      ?? EXAMPLES.find((e) => e.id === this.exampleId)?.id
      ?? 'grading';
    return base.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
      || 'grading';
  }

  /** Download the current source text as a .tc file. */
  private saveSource(): void {
    const ext = '.tc';
    const stem = this.exportStem();
    const blob = new Blob([this.src], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Open a saved .tc file from disk and load it into the editor. */
  private async openSourceViaPicker(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tc,.txt,text/plain';
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        input.remove();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        this.src = text;
        this.exampleId = null;
        saveDraft(text, null);
        this.parseSource(text, 0); // immediate
        // Mark it as a "loose" file: untied from any built-in example.
        this.exampleId = null;
        // Restore cursor for "last file" slot if one was saved before.
        requestAnimationFrame(() => this.restoreCursorForExample(null));
        input.remove();
      };
      reader.onerror = () => {
        input.remove();
      };
      reader.readAsText(file);
    }, { once: true });
    input.click();
  }

  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  /**
   * Diagnostics bar, docked beneath the editor.
   *
   * Problems belong next to the text that caused them, not over the
   * plot: the plot is the result, and covering it with the reason the
   * result is wrong helps nobody. Parse errors and semantic findings
   * are merged and ordered by position so the list reads like the
   * file.
   */
  /**
   * Findings worth showing right now.
   *
   * Everything is reported except an incomplete assignment on the
   * line being edited -- see {@link caretLine}. Moving off the line
   * brings it back, so the error is deferred rather than dropped.
   */
  private visibleErrors(): ParseError[] {
    return this.errors.filter(
      (e) => !(e.code === 'MISSING_VALUE' && e.line === this.caretLine),
    );
  }

  private renderDiagnostics() {
    type Row = { severity: string; line: number; column: number; code: string; message: string };
    const rows: Row[] = [
      ...this.visibleErrors().map((e) => ({
        severity: e.severity, line: e.line, column: e.column, code: e.code, message: e.message,
      })),
      ...this.diagnostics.map((d) => ({
        severity: d.severity, line: d.line, column: d.column, code: d.code, message: d.message,
      })),
    ]
      .filter((r) => r.severity === 'error' || r.severity === 'warning')
      .sort((a, b) => a.line - b.line || a.column - b.column);

    if (rows.length === 0) return null;

    return html`
      <ul class="diagnostics">
        ${rows.map((r) => html`
          <li class=${r.severity}>
            <span class="diag-icon">${r.severity === 'error' ? '✗' : '⚠'}</span>
            <button class="diag-where" title="Go to line ${r.line}"
                    @click=${() => this.gotoLine(r.line, r.column)}>${r.line}:${r.column}</button>
            <span class="diag-code">${r.code}</span>
            <span class="diag-msg">${r.message}</span>
          </li>`)}
      </ul>`;
  }

  /** Move the editor caret to a diagnostic's position. */
  private gotoLine(line: number, column: number): void {
    const editor = this.renderRoot.querySelector('tc-editor') as
      (HTMLElement & { gotoPosition?: (l: number, c: number) => void }) | null;
    editor?.gotoPosition?.(line, column);
  }

  /** The plot pane, for driving its actions from the app bar. */
  private viewer(): import('./tc-viewer.js').TcViewer | null {
    return this.renderRoot.querySelector('tc-viewer');
  }

  /**
   * Reflow the source in the editor.
   *
   * Only replaces the text when formatting actually changes something,
   * so pressing Format on an already-tidy document does not push a
   * no-op edit through the editor and disturb the caret.
   */
  private formatSource(): void {
    const formatted = formatSource(this.latestSrc || this.src);
    if (formatted === this.src) return;
    this.src = formatted;
    saveDraft(formatted, this.exampleId);
    this.parseSource(formatted, 0);
  }

  /**
   * Apply the theme to the document root, where the CSS custom
   * properties are defined. Both panes and the plot read from there,
   * so this one attribute drives the whole UI.
   */
  private applyTheme(): void {
    document.documentElement.dataset.theme = this.theme;
  }

  private toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme();
    try {
      localStorage.setItem(THEME_KEY, this.theme);
    } catch {
      /* Private browsing or a blocked store: the toggle still works
       * for this session, it just will not be remembered. */
    }
  }

  /**
   * Count line for the toolbar: parse errors and semantic findings
   * are separate stages, so they are reported separately rather than
   * summed into one opaque number.
   */
  private issueSummary() {
    const parseErrors = this.visibleErrors().filter((e) => e.severity === 'error').length;
    const semanticErrors = this.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = this.diagnostics.filter((d) => d.severity === 'warning').length;
    const errors = parseErrors + semanticErrors;

    if (errors === 0 && warnings === 0) return html`No issues`;
    return html`
      ${errors > 0
        ? html`<span class="err-count">${errors}</span> error${errors === 1 ? '' : 's'}`
        : null}
      ${errors > 0 && warnings > 0 ? html`<span> · </span>` : null}
      ${warnings > 0
        ? html`<span class="warn-count">${warnings}</span> warning${warnings === 1 ? '' : 's'}`
        : null}
    `;
  }

  /** Pass/fail badge across every grade that declares a constraint. */
  private gradeVerdict() {
    const judged = this.reports.filter((r) => r.pass != null);
    if (judged.length === 0) return null;
    const failed = judged.filter((r) => !r.pass).length;
    return failed === 0
      ? html`<span class="verdict pass">${judged.length} pass</span>`
      : html`<span class="verdict fail">${failed} fail</span>`;
  }

  render() {
    /*
     * No app-level bar: each pane owns the controls that act on it.
     * The example selector belongs to the source (it loads text); the
     * view, export, theme, and report controls belong to the plot
     * (they act on the drawing). One bar per pane also gives the
     * diagram back the vertical space a second bar was taking.
     */
    /*
     * Narrow windows have room for one pane only, so a stored `split`
     * is read as whichever single pane was last asked for -- the plot
     * by default, that being what the tool is for.
     */
    const mode: 'split' | 'source' | 'plot' = this.narrow
      ? (this.pane === 'source' ? 'source' : 'plot')
      : this.pane;

    return html`
      ${this.showReport && this.reports.length > 0
        ? html`<pre class="report">${formatGradeReports(this.reports)}</pre>`
        : null}
      ${this.narrow ? html`
        <div class="pane-switch" role="tablist" aria-label="Pane">
          <button role="tab"
                  class=${mode === 'source' ? 'on' : ''}
                  aria-selected=${mode === 'source'}
                  @click=${() => this.showPane('source')}>Source</button>
          <button role="tab"
                  class=${mode === 'plot' ? 'on' : ''}
                  aria-selected=${mode === 'plot'}
                  @click=${() => this.showPane('plot')}>Plot</button>
        </div>` : null}
      <div class="pane ${mode}"
           @mousemove=${this.handleSplitterMove}
           @mouseup=${this.handleSplitterEnd}
           @mouseleave=${this.handleSplitterEnd}>
        <div class="side source"
             ?hidden=${mode === 'plot'}
             style=${mode === 'split'
               ? `flex-basis: var(--tc-split-left); width: var(--tc-split-left);`
               : 'flex-basis: 100%; width: 100%;'}>
          <div class="side-title">
            <span class="side-title-label">Source</span>
            <select class="picker"
                    title="Load a saved study or a worked example"
                    @change=${(e: Event) => { this.pick((e.target as HTMLSelectElement).value); }}>
              ${this.saved.length > 0 ? html`
                <optgroup label="Saved in this browser">
                  ${this.saved.map((st) => html`
                    <option value=${SAVED_PREFIX + st.name}
                            ?selected=${st.name === this.savedName}>${st.name}</option>
                  `)}
                </optgroup>` : null}
              <optgroup label="Examples">
                ${EXAMPLES.map((ex) => html`
                  <option value=${ex.id}
                          ?selected=${ex.id === this.exampleId && !this.savedName}>${ex.name}</option>
                `)}
              </optgroup>
            </select>
            <span class="side-title-spacer"></span>
            <span class="counts">${this.issueSummary()}</span>
            <button class="side-btn" title="Reflow the source with standard indentation"
                    @click=${() => this.formatSource()}>Format</button>
            <button class="side-btn" title="Open a .tc file from disk"
                    @click=${() => { void this.openSourceViaPicker(); }}>Open…</button>
            <button class="side-btn" title="Save this study in the browser, under a name"
                    @click=${() => this.saveToBrowser()}>Save</button>
            ${this.savedName ? html`
              <button class="side-btn" title=${`Delete "${this.savedName}" from this browser`}
                      @click=${() => this.deleteSaved()}>Delete</button>` : null}
            <button class="side-btn" title="Download the current source as a .tc file"
                    @click=${() => this.saveSource()}>Download…</button>
            <button class="side-btn"
                    title="Copy a link containing this whole study (kept in the URL fragment, never sent to a server)"
                    @click=${() => { void this.copyShareLink(); }}>
              ${this.copiedLink ? 'Copied ✓' : 'Copy link'}
            </button>
            <button class="side-btn"
                    title="Discard the working draft and reload the starter example"
                    @click=${() => this.resetDraft()}>Reset</button>
            ${!this.narrow ? html`
              <button class="side-btn pane-btn"
                      title=${mode === 'source' ? 'Show the plot beside the source' : 'Hide the source and show the plot alone'}
                      @click=${() => this.showPane(mode === 'source' ? 'split' : 'plot')}>
                ${mode === 'source' ? '⇱ Split' : '⇤ Hide'}
              </button>` : null}
          </div>
          <tc-editor
              .source=${this.src}
              .onChange=${this.boundOnChange}
              .onSelectionMove=${this.boundOnSelectionMove}
              .shortcuts=${this.boundShortcuts}></tc-editor>
          ${this.renderDiagnostics()}
        </div>
        ${mode === 'split' ? html`
          <div class="splitter"
               role="separator"
               aria-orientation="vertical"
               title="Drag to resize"
               @mousedown=${this.handleSplitterStart}
               @dblclick=${this.handleSplitterReset}>
            <div class="splitter-grip"></div>
          </div>` : null}
        <div class="side plot"
             ?hidden=${mode === 'source'}
             style=${mode === 'split'
               ? `flex-basis: calc(100% - var(--tc-split-left)); width: calc(100% - var(--tc-split-left));`
               : 'flex-basis: 100%; width: 100%;'}>
          <div class="side-title">
            <span class="side-title-label">Plot</span>
            <span class="side-title-spacer"></span>
            ${this.reports.length > 0
              ? html`<button class="side-btn" title="Show the grading margin report"
                             @click=${() => { this.showReport = !this.showReport; }}>
                       ${this.showReport ? 'Hide' : 'Show'} report ${this.gradeVerdict()}
                     </button>`
              : null}
            <button class="side-btn" title="Reset the plot zoom to the view block's bounds"
                    @click=${() => this.viewer()?.resetZoom()}>Reset view</button>
            <button class="side-btn" title="Copy the plot to the clipboard as a PNG"
                    @click=${() => { void this.viewer()?.copyPngToClipboard(); }}>Copy PNG</button>
            <button class="side-btn" title="Download the plot as an SVG file"
                    @click=${() => this.viewer()?.saveSvg()}>Save SVG</button>
            <button class="side-btn" title="Download the plot as a PDF (always light, for printing)"
                    @click=${() => { void this.viewer()?.savePdf(); }}>Save PDF</button>
            <button class="side-btn" title="Show the plot controls"
                    @click=${() => this.viewer()?.toggleHelp()}>?</button>
            <button class="side-btn" title="Open the language specification"
                    @click=${() => { this.showGuide = true; }}>Guide</button>
            ${!this.narrow ? html`
              <button class="side-btn pane-btn"
                      title=${mode === 'plot' ? 'Show the source beside the plot' : 'Hide the plot and show the source alone'}
                      @click=${() => this.showPane(mode === 'plot' ? 'split' : 'source')}>
                ${mode === 'plot' ? '⇲ Split' : '⇥ Hide'}
              </button>` : null}
            <button class="side-btn"
                    title=${`Switch to the ${this.theme === 'dark' ? 'light' : 'dark'} theme`}
                    @click=${() => this.toggleTheme()}>
              ${this.theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
          </div>
          <tc-viewer
              @tc-open-guide=${() => { this.showGuide = true; }}
              .document=${this.ast}
              .study=${this.study}
              .theme=${this.theme}
              .errors=${this.errors}></tc-viewer>
        </div>
      </div>
      <tc-guide
          .open=${this.showGuide}
          @tc-guide-close=${() => { this.showGuide = false; }}></tc-guide>
    `;
  }
}

/** localStorage key holding the Source/Plot layout choice. */
const PANE_KEY = 'tc.pane';

/** localStorage key holding the user's theme choice. */
const THEME_KEY = 'tc-curves.theme';

/**
 * The theme to start in: the user's remembered choice if there is one,
 * otherwise whatever the operating system asks for.
 */
function readStoredTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* Storage unavailable; fall through to the OS preference. */
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/**
 * 1-based line number containing a character offset.
 *
 * Counted rather than tracked, because the offset arrives from the
 * editor and the text may have changed under it; clamping keeps a
 * stale offset from reporting a line that no longer exists.
 */
function lineAtOffset(src: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, src.length));
  let line = 1;
  for (let i = 0; i < at; i++) if (src[i] === '\n') line++;
  return line;
}
