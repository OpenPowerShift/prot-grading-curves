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

import './tc-editor.js';
import './tc-viewer.js';

/**
 * Default width of the Source pane, as a percentage of the window.
 * The plot is the thing being read; the source is mostly short lines.
 */
const DEFAULT_SPLIT_LEFT_PCT = 20;

const STARTER = DEFAULT_EXAMPLE.source;

@customElement('tc-app')
export class TcApp extends LitElement {
  @state() private src: string = STARTER;
  @state() private tab: 'source' | 'plot' = 'plot';
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
  };

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
    // Parse the initial source on mount so the Plot tab has data even
    // when the editor is not visible.
    this.parseSource(this.src, 0);
    // Restore cursor for the current example after mount completes.
    requestAnimationFrame(() => this.restoreCursorForExample(this.exampleId));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
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
  }

  private switchTab(t: 'source' | 'plot'): void {
    this.tab = t;
  }

  private loadExample(id: string): void {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    if (id === this.exampleId) return;     // no-op
    this.exampleId = id;
    this.src = ex.source;
    this.parseSource(ex.source, 0);
    // Schedule a cursor restore once tc-editor is re-mounted for the
    // new doc.
    requestAnimationFrame(() => this.restoreCursorForExample(id));
  }

  /** Download the current source text as a .tc file. */
  private saveSource(): void {
    const ext = '.tc';
    const stem = EXAMPLES.find((e) => e.id === this.exampleId)?.id ?? 'grading';
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
  private renderDiagnostics() {
    type Row = { severity: string; line: number; column: number; code: string; message: string };
    const rows: Row[] = [
      ...this.errors.map((e) => ({
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
    const parseErrors = this.errors.filter((e) => e.severity === 'error').length;
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
    return html`
      ${this.showReport && this.reports.length > 0
        ? html`<pre class="report">${formatGradeReports(this.reports)}</pre>`
        : null}
      <div class="pane"
           @mousemove=${this.handleSplitterMove}
           @mouseup=${this.handleSplitterEnd}
           @mouseleave=${this.handleSplitterEnd}>
        <div class="side source"
             style=${`flex-basis: var(--tc-split-left); width: var(--tc-split-left);`}>
          <div class="side-title">
            <span class="side-title-label">Source</span>
            <select class="picker"
                    title="Load an example .tc study"
                    @change=${(e: Event) => { this.loadExample((e.target as HTMLSelectElement).value); }}>
              ${EXAMPLES.map((ex) => html`
                <option value=${ex.id} ?selected=${ex.id === this.exampleId}>${ex.name}</option>
              `)}
            </select>
            <span class="side-title-spacer"></span>
            <span class="counts">${this.issueSummary()}</span>
            <button class="side-btn" title="Reflow the source with standard indentation"
                    @click=${() => this.formatSource()}>Format</button>
            <button class="side-btn" title="Open a .tc file from disk"
                    @click=${() => { void this.openSourceViaPicker(); }}>Open…</button>
            <button class="side-btn" title="Download the current source as a .tc file"
                    @click=${() => this.saveSource()}>Save…</button>
          </div>
          <tc-editor
              .source=${this.src}
              .onChange=${this.boundOnChange}
              .onSelectionMove=${this.boundOnSelectionMove}
              .shortcuts=${this.boundShortcuts}></tc-editor>
          ${this.renderDiagnostics()}
        </div>
        <div class="splitter"
             role="separator"
             aria-orientation="vertical"
             title="Drag to resize"
             @mousedown=${this.handleSplitterStart}
             @dblclick=${this.handleSplitterReset}>
          <div class="splitter-grip"></div>
        </div>
        <div class="side plot"
             style=${`flex-basis: calc(100% - var(--tc-split-left)); width: calc(100% - var(--tc-split-left));`}>
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
            <button class="side-btn"
                    title=${`Switch to the ${this.theme === 'dark' ? 'light' : 'dark'} theme`}
                    @click=${() => this.toggleTheme()}>
              ${this.theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
          </div>
          <tc-viewer
              .document=${this.ast}
              .study=${this.study}
              .theme=${this.theme}
              .errors=${this.errors}></tc-viewer>
        </div>
      </div>
    `;
  }
}

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
