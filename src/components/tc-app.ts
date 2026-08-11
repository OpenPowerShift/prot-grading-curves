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

import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { parse, type Document, type ParseError } from '../parser/index.js';
import { buildStudy, type Study } from '../semantics/model.js';
import { viewLabel } from '../semantics/condition.js';
import { validate, type Diagnostic } from '../semantics/validate.js';
import { reportGrades, formatGradeReports, verdictOf, type GradeReport } from '../semantics/grades.js';
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
  urlWithoutStudy,
  type SavedStudy,
} from '../editor/share.js';

import './tc-editor.js';
import type { EditorMark } from './tc-editor.js';
import './tc-viewer.js';
import './tc-guide.js';

/**
 * Default width of the Source pane, as a percentage of the window.
 * The plot is the thing being read; the source is mostly short lines.
 */
const DEFAULT_SPLIT_LEFT_PCT = 20;

const STARTER = DEFAULT_EXAMPLE.source;

/**
 * Picker value for a study opened from a link and not yet saved.
 *
 * Distinct from every example id and from the saved-study prefix, so
 * re-selecting it is a no-op rather than a load of something else.
 */
const LINK_OPTION = 'link:current';

@customElement('tc-app')
export class TcApp extends LitElement {
  @state() private src: string = STARTER;
  /**
   * `src` as it stood the moment the open study was loaded or saved.
   *
   * Compared against `src` to ask, before switching away, whether
   * unsaved work would be discarded -- the picker used to switch
   * straight to whatever was chosen, silently dropping edits the
   * engineer had not saved. Updated everywhere a study is loaded, and
   * on every successful save, so "unsaved" means exactly that.
   */
  private loadedSrc: string = STARTER;
  private get hasUnsavedChanges(): boolean {
    return this.src !== this.loadedSrc;
  }
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

  /**
   * Which single pane a narrow window is showing.
   *
   * Kept apart from `pane`, which is the layout chosen when there was
   * room for both, so a trip through a narrow window and back leaves
   * the split as it was found.
   */
  @state() private narrowPane: 'source' | 'plot' = 'plot';
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

  /**
   * How many sheets the study declares.
   *
   * Read from this component's own parsed document rather than asked
   * of the viewer: a getter on a child is not a reactive dependency,
   * so a toolbar built from one renders once with whatever the child
   * happened to hold and never updates. `ast` is state here, so the
   * button appears when the study that needs it is loaded.
   */
  private get sheetCount(): number {
    return (this.ast?.items.filter((i) => i.type === 'view') ?? []).length;
  }

  /** Set for a few seconds after a successful clipboard write. */
  @state() private copiedPng = false;
  private copiedPngTimer?: ReturnType<typeof setTimeout>;

  /**
   * Copy the sheet, and say so.
   *
   * Only on success: a button that reports "Copied!" when the write
   * threw is worse than one that says nothing, because the reader goes
   * away believing they have it.
   */
  private async copyPng(): Promise<void> {
    try {
      await this.viewer()?.copyPngToClipboard();
    } catch {
      this.copiedPng = false;
      return;
    }
    this.copiedPng = true;
    clearTimeout(this.copiedPngTimer);
    this.copiedPngTimer = setTimeout(() => { this.copiedPng = false; }, 5000);
  }

  /** Transient confirmation shown after copying the share link. */
  @state() private copiedLink = false;

  /** Studies the user has saved in this browser, newest first. */
  @state() private saved: SavedStudy[] = [];

  /** Name of the saved study currently open, if any. */
  @state() private savedName: string | null = null;
  /**
   * Name of a study opened from a link and not yet saved.
   *
   * Held separately from {@link savedName} because nothing has been
   * written to this browser's store: adopting the name outright would
   * mean a link could silently overwrite a study of the same name that
   * the engineer had saved themselves. It names the buffer in the
   * picker and seeds the Save prompt; saving is still their decision.
   */
  @state() private linkName: string | null = null;
  /**
   * Which declared `view` is on screen, by index.
   *
   * A study may declare several sheets -- a phase sheet and a
   * negative-sequence sheet, the same grading under two conditions --
   * and the picker beside the plot chooses between them. Reset when
   * the source changes enough to invalidate it.
   */
  @state() private viewIndex = 0;
  /**
   * Help for the token under the caret, shown under the source.
   *
   * Docked rather than floating: a tooltip covers the line being read
   * and has to be dismissed, where a panel simply follows the caret --
   * which is what makes it usable for *reading* an existing file
   * rather than only for writing a new one.
   *
   * A strip along the bottom rather than a right-hand column. As a
   * column it took a third of the editor's width for two lines of
   * text, and because it comes and goes with the caret the source
   * reflowed under the reader every time they moved the cursor.
   */
  @state() private help: {
    name: string; scope?: string; summary: string; example?: string;
  } | null = null;
  /**
   * Whether the reader has shut the strip.
   *
   * Remembered, because someone who does not want it does not want it
   * on every token for the rest of the session either. Cleared by the
   * same toolbar control that opens it.
   */
  @state() private helpHidden = readStoredHelpHidden();
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
  private readonly boundOnHelp = (help: TcApp['help']) => { this.help = help; };
  private readonly hideHelp = (): void => {
    this.helpHidden = true;
    try { localStorage.setItem(HELP_HIDDEN_KEY, '1'); } catch { /* private mode */ }
  };
  private readonly showHelpStrip = (): void => {
    this.helpHidden = false;
    try { localStorage.removeItem(HELP_HIDDEN_KEY); } catch { /* private mode */ }
  };
  private readonly boundOnSelectionMove = (offset: number) => {
    try { localStorage.setItem(this.cursorKey(this.exampleId), String(offset)); } catch { /* */ }
    this.caretOffset = offset;
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
  /** Last caret offset the editor reported, for Format to work from. */
  private caretOffset = 0;
  /** Where Format wants the caret put; consumed by the editor. */
  @state() private caretRequest: number | null = null;

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
        if (!this.isConnected) return;
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

    /*
     * `?example=<id>` picks a built-in study. The README's gallery
     * links use it, so a reader who has just seen a sheet can open the
     * source that drew it rather than hunting the picker for a name.
     *
     * Read before the share link, which is a study in its own right and
     * should win over a mere selection.
     */
    const wanted = new URLSearchParams(window.location.search).get('example');
    const named = wanted ? EXAMPLES.find((e) => e.id === wanted) : undefined;
    if (named) {
      this.exampleId = named.id;
      this.src = named.source;
      this.loadedSrc = named.source;
    }

    const shared = sourceFromLink();
    if (shared) {
      this.src = shared;
      this.loadedSrc = shared;
      this.exampleId = null;
      /*
       * A study arriving by link becomes the working draft, named after
       * itself.
       *
       * The name matters because without one the picker shows whatever
       * option happens to be first while a quite different study is on
       * screen, and the export filename falls back to "grading".
       *
       * The link is then taken out of the address bar. Left there it
       * wins over the draft on every load, so a refresh after an hour's
       * editing silently restores the study as it was sent -- and the
       * source that comes back looks right, which is what makes it
       * dangerous. Writing the draft first means the refresh it is
       * protecting against has something to restore.
       */
      this.linkName = studyName(shared);
      saveDraft(shared, null);
      try {
        window.history.replaceState(null, '', urlWithoutStudy());
      } catch { /* a sandboxed frame may refuse; the study still loaded */ }
    } else if (!named) {
      /*
       * The draft is skipped when a link named an example. Following a
       * link to a particular study and being shown last week's editing
       * instead is the one outcome that link cannot mean -- and the
       * draft is not lost, only not restored: it is still in the
       * browser, and reloading without the parameter brings it back.
       */
      const draft = loadDraft();
      if (draft) {
        this.src = draft.source;
        /*
         * The baseline for "unsaved" is what the draft's own study last
         * looked like, not the draft itself -- a draft *is* the
         * divergence, restored on every reload so a browser refresh
         * mid-edit does not silently discard it. Where that original
         * cannot be found (a shared link, an opened file: nothing
         * named to look back up), there is nothing to compare against,
         * so the draft is its own baseline rather than flagging a
         * change that was never really unconfirmed.
         */
        if (draft.exampleId?.startsWith(SAVED_PREFIX)) {
          this.savedName = draft.exampleId.slice(SAVED_PREFIX.length);
          this.exampleId = draft.exampleId;
          this.loadedSrc = studySource(this.savedName) ?? draft.source;
        } else {
          this.exampleId = draft.exampleId;
          const example = draft.exampleId ? EXAMPLES.find((e) => e.id === draft.exampleId) : undefined;
          this.loadedSrc = example?.source ?? draft.source;
        }
      }
    }

    // Parse the initial source on mount so the Plot tab has data even
    // when the editor is not visible.
    this.parseSource(this.src, 0);
    // Restore cursor for the current example after mount completes.
    requestAnimationFrame(() => { if (this.isConnected) this.restoreCursorForExample(this.exampleId); });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.narrowObserver?.disconnect();
    /*
     * Stop the work that outlives the element.
     *
     * The parse is debounced, so removing the app while a keystroke is
     * still settling left a timer that woke up, re-parsed, and wrote to
     * a component no longer in the document. Harmless in a browser tab
     * that is closing, and not harmless under test, where it lands
     * after the DOM has been torn down and fails the run with a
     * `document is not defined` that names no test.
     *
     * It surfaced when the upstream sweep became the default: grading
     * grew by a sweep per pair, the debounced callback took longer, and
     * a latent race started losing. The race was always there.
     */
    if (this.parseTimer != null) {
      clearTimeout(this.parseTimer);
      this.parseTimer = null;
    }
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
        this.diagnostics = validate(study, result.document);
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

  private handleSourceChange(src: string): void {
    this.src = src;
    this.parseSource(src);
    saveDraft(src, this.exampleId);
  }

  private showPane(which: 'split' | 'source' | 'plot'): void {
    /*
     * A choice made on a narrow screen is not a choice about the wide
     * layout.
     *
     * Both used to write `pane`. So: zoom in until the window goes
     * narrow, tap `Source` to read the study, zoom back out -- and the
     * plot is gone, because tapping a switch that exists only because
     * the window is small had silently rewritten the split you were
     * working in. Getting it back meant finding a button that had also
     * changed its label.
     *
     * The narrow choice lives in `narrowPane` and is not stored. What
     * is stored is what you asked for while there was room for both.
     */
    if (this.narrow) {
      this.narrowPane = which === 'source' ? 'source' : 'plot';
      requestAnimationFrame(() => { if (this.isConnected) this.viewer()?.requestUpdate(); });
      return;
    }
    this.pane = which;
    try { localStorage.setItem(PANE_KEY, which); } catch { /* not essential */ }
    /* The plot sizes itself to its host, so tell it to re-measure
     * once the new layout has been applied. */
    requestAnimationFrame(() => { if (this.isConnected) this.viewer()?.requestUpdate(); });
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
    const narrow = width > 0 && width <= limit;
    /*
     * Arriving at a narrow window, start on whichever pane the wide
     * layout was showing -- someone working source-only should not be
     * handed the plot because the window got smaller. `split` has no
     * single answer, so it opens on the plot, that being what the tool
     * is for.
     */
    if (narrow && !this.narrow) {
      this.narrowPane = this.pane === 'source' ? 'source' : 'plot';
    }
    this.narrow = narrow;
  }

  private loadExample(id: string): void {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    if (id === this.exampleId) return;     // no-op
    this.exampleId = id;
    this.src = ex.source;
    this.loadedSrc = ex.source;
    this.parseSource(ex.source, 0);
    saveDraft(ex.source, id);
    // Schedule a cursor restore once tc-editor is re-mounted for the
    // new doc.
    requestAnimationFrame(() => { if (this.isConnected) this.restoreCursorForExample(id); });
  }

  /** The picker option value that names whatever is currently loaded. */
  private get currentPickValue(): string | null {
    if (this.savedName) return SAVED_PREFIX + this.savedName;
    if (this.linkName) return LINK_OPTION;
    return this.exampleId;
  }

  /**
   * The picker's own `@change`: confirms before discarding unsaved
   * work, then hands off to `pick`.
   *
   * Kept apart from `pick` because the internal callers that also
   * switch studies -- deleting the open one and landing on its
   * neighbour, resetting to the starter example -- must not re-ask
   * about work the user has already told the tool to discard once,
   * in the delete confirmation or by choosing Reset outright.
   */
  private handlePickChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    if (this.hasUnsavedChanges
        && !window.confirm('This study has unsaved changes. Switch and discard them?')) {
      /*
       * The browser has already moved the control's own live selection
       * to the option the user clicked -- a `<select>`'s selectedness,
       * once the user has picked something, tracks its `.value`
       * property, not the `selected` *attribute* Lit's `?selected`
       * writes. Re-rendering the same (unchanged) boolean expressions
       * is therefore a no-op twice over: Lit skips the write because
       * nothing in state changed, and even a forced write would not
       * move a selection the DOM now treats as user-set. Setting
       * `.value` back directly is the only thing that un-does it.
       */
      const current = this.currentPickValue;
      if (current != null) select.value = current;
      return;
    }
    this.pick(value);
  }

  /**
   * Handle a pick from the study list.
   *
   * One control lists both the saved studies and the worked examples,
   * so the value carries which kind it is.
   */
  private pick(value: string): void {
    /* The buffer that is already open; nothing to load. */
    if (value === LINK_OPTION) return;

    if (value.startsWith(SAVED_PREFIX)) {
      const name = value.slice(SAVED_PREFIX.length);
      const source = studySource(name);
      if (source == null) return;
      this.savedName = name;
      this.linkName = null;
      this.exampleId = value;
      this.src = source;
      this.loadedSrc = source;
      this.parseSource(source, 0);
      saveDraft(source, value);
      return;
    }
    this.savedName = null;
    this.linkName = null;
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
    this.linkName = null;
    this.exampleId = SAVED_PREFIX + entry.name;
    this.loadedSrc = this.src;
    this.saved = listStudies();
    saveDraft(this.src, this.exampleId);
  }

  /**
   * A name to offer when saving: the study's own `meta.project`, which
   * is what an engineer would have called it anyway.
   */
  private suggestedName(): string {
    if (this.linkName) return this.linkName;
    const project = this.study?.meta?.project;
    if (typeof project === 'string' && project.trim()) return project.trim();
    return 'Untitled study';
  }

  /**
   * Delete the open saved study, and pick up wherever the list leaves
   * a reader looking next.
   *
   * The picker used to clear to nothing selected -- `savedName` and
   * `exampleId` both null -- with the deleted study's source still in
   * the editor and no visible connection to anything in the list. The
   * study that sat *above* the deleted one is still there and did not
   * move, so it is the one to land on; only when the deleted study was
   * itself the top of the list is there no "above" to fall back to,
   * and the new top -- or, with none left, the starter example -- is
   * used instead.
   */
  private deleteSaved(): void {
    if (!this.savedName) return;
    if (!window.confirm(`Delete the saved study "${this.savedName}"?`)) return;

    const before = this.saved;
    const deletedIndex = before.findIndex((s) => s.name === this.savedName);

    deleteStudy(this.savedName);
    this.saved = listStudies();

    const above = deletedIndex > 0 ? before[deletedIndex - 1] : this.saved[0];
    if (above) {
      this.pick(SAVED_PREFIX + above.name);
    } else {
      this.savedName = null;
      this.exampleId = null;
      this.loadExample(DEFAULT_EXAMPLE.id);
    }
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
    this.linkName = null;
    this.exampleId = null;
    this.loadExample(DEFAULT_EXAMPLE.id);
  }

  /**
   * A filename stem for downloads.
   *
   * The same rule the plot exports use, so a study's `.ptc`, `.svg`,
   * and `.pdf` land in a folder next to each other under one name
   * rather than under three unrelated ones. The saved-study name wins
   * where there is one, since that is what the engineer called it.
   */
  private exportStem(): string {
    const project = this.study?.meta?.project;
    const base = this.savedName
      ?? this.linkName
      ?? (typeof project === 'string' && project.trim() ? project : null)
      ?? EXAMPLES.find((e) => e.id === this.exampleId)?.id
      ?? 'grading';
    return base.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
      || 'grading';
  }

  /** Download the current source text as a .ptc file. */
  private saveSource(): void {
    const ext = '.ptc';
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

  /** Open a saved .ptc file from disk and load it into the editor. */
  private async openSourceViaPicker(): Promise<void> {
    if (this.hasUnsavedChanges
        && !window.confirm('This will replace the current study, which has unsaved changes. Continue?')) {
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ptc,.txt,text/plain';
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
        this.loadedSrc = text;
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

  /**
   * Every finding about the current source, in one list.
   *
   * The list under the editor and the markers in it are two views of
   * the same thing, and they were assembled separately -- the list
   * merged parse errors with semantic findings and dropped `info`,
   * while the editor showed nothing at all. Building the set once means
   * the gutter, the list and the counts cannot disagree about what is
   * wrong with the study, which is the same reason the CLI and the
   * playground now share `verdictOf` and `jsonResult`.
   *
   * `info` is kept. The CLI prints it, so dropping it here made the two
   * surfaces describe the same file differently; the list dims it
   * instead.
   */
  /**
   * Errors from both halves of the front end.
   *
   * The count the sheet is stamped with, and the same number the CLI
   * refuses to draw on. Parse errors and semantic errors are one thing
   * to a reader; only the tool cares which pass found them.
   */
  private errorTotal(): number {
    return this.errors.filter((e) => e.severity === 'error').length
      + this.diagnostics.filter((d) => d.severity === 'error').length;
  }

  private allFindings(): EditorMark[] {
    const rows: EditorMark[] = [
      ...this.visibleErrors().map((e) => ({
        severity: e.severity as EditorMark['severity'],
        line: e.line, column: e.column, length: e.length ?? 1,
        code: e.code, message: e.message,
      })),
      ...this.diagnostics.map((d) => ({
        severity: d.severity as EditorMark['severity'],
        line: d.line, column: d.column, length: d.length ?? 1,
        code: d.code, message: d.message,
      })),
    ];
    return rows.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  private renderDiagnostics() {
    type Row = { severity: string; line: number; column: number; code: string; message: string };
    const rows: Row[] = this.allFindings();

    if (rows.length === 0) return null;

    return html`
      <ul class="diagnostics">
        ${rows.map((r) => html`
          <li class=${r.severity}>
            <span class="diag-icon">${r.severity === 'error' ? '✗' : r.severity === 'warning' ? '⚠' : 'ℹ'}</span>
            <button class="diag-where" title="Go to line ${r.line}"
                    @click=${() => this.gotoLine(r.line, r.column)}>${r.line}:${r.column}</button>
            <span class="diag-msg">${r.message}<span class="diag-code">${r.code}</span></span>
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
    const before = this.latestSrc || this.src;
    const formatted = formatSource(before);
    if (formatted === this.src) return;

    /*
     * Put the caret back on the line it was on.
     *
     * Not on the same *offset*: formatting rewrites indentation and
     * spacing throughout, so the offset held before points somewhere
     * else after -- the reader is dropped mid-token, often several
     * lines from what they were working on, and has to find their
     * place again. Which is enough to stop anyone using Format on a
     * file they are in the middle of.
     *
     * The line is matched by its text where that is unambiguous, since
     * exploding a brace-heavy block changes the line count; by index
     * otherwise. Either way the caret lands at the start of the line,
     * which is what was asked for and is stable under reflow.
     */
    this.caretRequest = caretAfterFormat(before, formatted, this.caretOffset);

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

  /**
   * Which theme the *plot* is drawn in.
   *
   * A study that declares `page { theme }` gets it. The UI toggle used
   * to override the source unconditionally, so setting `theme = "dark"`
   * in a file did nothing on screen and the sheet you were looking at
   * was not the sheet you would export -- with no indication which one
   * you were seeing.
   *
   * The toggle still drives the chrome, and still drives the plot for
   * a study that declares no theme, which is most of them.
   */
  private plotTheme(): 'light' | 'dark' | 'monochrome' | 'print' {
    return this.study?.page?.theme ?? this.theme;
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
    const infos = this.diagnostics.filter((d) => d.severity === 'info').length;
    const errors = parseErrors + semanticErrors;

    /*
     * "No issues" was shown while info findings were listed directly
     * beneath it, because the chip counted errors and warnings only.
     * The panel and its own summary then disagreed on screen, which
     * teaches a reader that the summary is not to be trusted -- and
     * the summary is the part most people read.
     */
    if (errors === 0 && warnings === 0 && infos === 0) return html`No issues`;
    if (errors === 0 && warnings === 0) {
      return html`<span class="info-count">${infos}</span> note${infos === 1 ? '' : 's'}`;
    }
    return html`
      ${errors > 0
        ? html`<span class="err-count">${errors}</span> error${errors === 1 ? '' : 's'}`
        : null}
      ${errors > 0 && warnings > 0 ? html`<span> · </span>` : null}
      ${warnings > 0
        ? html`<span class="warn-count">${warnings}</span> warning${warnings === 1 ? '' : 's'}`
        : null}
      ${(errors > 0 || warnings > 0) && infos > 0 ? html`<span> · </span>` : null}
      ${infos > 0
        ? html`<span class="info-count">${infos}</span> note${infos === 1 ? '' : 's'}`
        : null}
    `;
  }

  /** Pass/fail badge across every grade that declares a constraint. */
  /**
   * The badge on the report button.
   *
   * Through `verdictOf`, so the badge, the report text and the CLI's
   * exit status are one decision. It read `r.pass` directly, which is
   * only set where a `margin` floor is declared -- so a solved study
   * graded against `margin_target` showed no badge at all, and a pair
   * where neither side operates counted as a failure.
   *
   * "Not evaluated" gets its own word. An engineer reads "fail" as
   * *the coordination interval is not met* and goes looking for a
   * margin problem; the actual state is that nothing could be judged,
   * which is a settings or fault-data problem somewhere else entirely.
   */
  private gradeVerdict() {
    const verdicts = this.reports.map((r) => verdictOf(r));
    const failed = verdicts.filter((v) => v === 'fail').length;
    const passed = verdicts.filter((v) => v === 'pass').length;
    const unjudged = verdicts.filter((v) => v === 'unevaluated').length;

    if (failed > 0) return html`<span class="verdict fail">${failed} fail</span>`;
    if (passed > 0) return html`<span class="verdict pass">${passed} pass</span>`;
    if (unjudged > 0) {
      return html`<span class="verdict unevaluated"
                        title="No margin could be computed: at the current asked about, a side does not operate"
                  >${unjudged} not evaluated</span>`;
    }
    return null;
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
    const mode: 'split' | 'source' | 'plot' = this.narrow ? this.narrowPane : this.pane;

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
                    @change=${(e: Event) => this.handlePickChange(e)}>
              ${/*
                 * A study opened from a link is named here so the
                 * control agrees with what is on screen. Without it the
                 * browser shows the first option -- some unrelated
                 * example -- while a quite different study is loaded.
                 * It is not in the saved list because it has not been
                 * saved; picking anything else discards it, which is
                 * why the entry says so.
                 */''}
              ${this.linkName && !this.savedName ? html`
                <optgroup label="Opened from a link">
                  <option value=${LINK_OPTION} selected
                          title="Not saved in this browser yet — use Save to keep it"
                  >${this.linkName}</option>
                </optgroup>` : null}
              ${this.saved.length > 0 ? html`
                <optgroup label="Saved in this browser">
                  ${this.saved.map((st) => html`
                    <option value=${SAVED_PREFIX + st.name}
                            ?selected=${st.name === this.savedName}>${st.name}</option>
                  `)}
                </optgroup>` : null}
              ${/*
                 * The study the app opens on, above the rest.
                 *
                 * Alphabetical order is right *within* the list -- it
                 * is the only order that helps someone looking for a
                 * particular study -- but it buries the one a
                 * first-time visitor has been reading, nineteen
                 * entries deep under a name they have no reason to
                 * remember. It is the one entry a newcomer needs to
                 * find twice.
                 */''}
              <optgroup label="Start here">
                <option value=${DEFAULT_EXAMPLE.id}
                        ?selected=${DEFAULT_EXAMPLE.id === this.exampleId
                          && !this.savedName && !this.linkName}
                >${DEFAULT_EXAMPLE.name}</option>
              </optgroup>
              <optgroup label="Examples">
                ${EXAMPLES.filter((ex) => ex.id !== DEFAULT_EXAMPLE.id).map((ex) => html`
                  <option value=${ex.id}
                          ?selected=${ex.id === this.exampleId && !this.savedName && !this.linkName}
                  >${ex.name}</option>
                `)}
              </optgroup>
            </select>
            <span class="side-title-spacer"></span>
            <span class="counts">${this.issueSummary()}</span>
            <button class="side-btn" title="Reflow the source with standard indentation"
                    @click=${() => this.formatSource()}>Format</button>
            ${this.helpHidden ? html`
              <button class="side-btn"
                      title="Show the help strip under the source again"
                      @click=${this.showHelpStrip}>Help</button>` : null}
            <button class="side-btn" title="Open a .ptc file from disk"
                    @click=${() => { void this.openSourceViaPicker(); }}>Open…</button>
            <button class="side-btn" title="Save this study in the browser, under a name"
                    @click=${() => this.saveToBrowser()}>Save</button>
            ${this.savedName ? html`
              <button class="side-btn" title=${`Delete "${this.savedName}" from this browser`}
                      @click=${() => this.deleteSaved()}>Delete</button>` : null}
            <button class="side-btn" title="Download the current source as a .ptc file"
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
          <div class="source-body">
            <tc-editor
                .source=${this.src}
                .onChange=${this.boundOnChange}
                .onSelectionMove=${this.boundOnSelectionMove}
                .onHelp=${this.boundOnHelp}
                .caretRequest=${this.caretRequest}
                .marks=${this.allFindings()}
                .shortcuts=${this.boundShortcuts}></tc-editor>
            ${this.help && !this.helpHidden ? html`
              <aside class="help-dock" aria-label="What this means">
                <div class="help-dock-name">
                  ${this.help.name}
                  ${this.help.scope ? html`<span class="help-dock-scope">${this.help.scope}</span>` : null}
                </div>
                <div class="help-dock-summary">${this.help.summary}</div>
                ${this.help.example ? html`<pre class="help-dock-example">${this.help.example}</pre>` : null}
                <button class="help-dock-close" title="Hide the help strip"
                        aria-label="Hide the help strip"
                        @click=${this.hideHelp}>&times;</button>
              </aside>` : null}
          </div>
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
            ${/*
               * One sheet per declared `view`. Shown only when there is
               * a choice to make: a study with a single view -- which is
               * most of them -- gets no control it cannot use.
               */''}
            ${this.study && this.study.views.length > 1 ? html`
              <select class="picker sheet-picker"
                      title="Which declared view to draw"
                      @change=${(e: Event) => {
                        this.viewIndex = Number((e.target as HTMLSelectElement).value);
                      }}>
                ${this.study.views.map((v, i) => html`
                  <option value=${i} ?selected=${i === this.viewIndex}>${viewLabel(v, i)}</option>
                `)}
              </select>` : null}
            <span class="side-title-spacer"></span>
            ${this.reports.length > 0
              ? html`<button class="side-btn" title="Show the grading margin report"
                             @click=${() => { this.showReport = !this.showReport; }}>
                       ${this.showReport ? 'Hide' : 'Show'} report ${this.gradeVerdict()}
                     </button>`
              : null}
            <!--
              Two different zooms, kept apart on purpose. "Reset view"
              is about the *axes* -- which currents and times the sheet
              covers. These are about how large the drawing is shown,
              which is what a reader on a small screen actually wants,
              and what no gesture used to offer.
            -->
            <span class="zoom-group">
              <button class="side-btn" title="Show the drawing smaller"
                      aria-label="Zoom out"
                      @click=${() => this.viewer()?.zoomDisplayBy(1 / 1.25)}>&minus;</button>
              <button class="side-btn" title="Fit the whole sheet in the pane"
                      @click=${() => this.viewer()?.fitDisplay()}>Fit</button>
              <button class="side-btn" title="Show the drawing at its full size"
                      @click=${() => this.viewer()?.actualSize()}>1:1</button>
              <button class="side-btn" title="Show the drawing larger"
                      aria-label="Zoom in"
                      @click=${() => this.viewer()?.zoomDisplayBy(1.25)}>+</button>
            </span>
            <button class="side-btn" title="Reset the plot zoom to the view block's bounds"
                    @click=${() => this.viewer()?.resetZoom()}>Reset view</button>
            <!--
              Says it worked. A clipboard write leaves no trace on the
              page, so the only way to find out whether the button did
              anything was to go and paste somewhere.
            -->
            <button class="side-btn"
                    title="Copy the plot to the clipboard as a PNG"
                    @click=${() => { void this.copyPng(); }}>${this.copiedPng ? 'Copied!' : 'Copy PNG'}</button>
            <button class="side-btn" title="Download the plot as an SVG file"
                    @click=${() => this.viewer()?.saveSvg()}>Save SVG</button>
            <button class="side-btn" title="Download the plot as a PNG image"
                    @click=${() => { void this.viewer()?.savePng(); }}>Save PNG</button>
            <button class="side-btn" title="Download the plot as a PDF (always light, for printing)"
                    @click=${() => { void this.viewer()?.savePdf(); }}>Save PDF</button>
            <!--
              Only where there is more than one sheet to bind. On a
              single-sheet study it would be a second button doing what
              the first one does.
            -->
            ${this.sheetCount > 1 ? html`
              <button class="side-btn"
                      title="Download every declared sheet as one PDF, a page each"
                      @click=${() => { void this.viewer()?.saveAllViewsPdf(); }}>PDF (all sheets)</button>`
              : null}
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
                    title=${this.study?.page?.theme
                      ? `This study declares theme = "${this.study.page.theme}", which the plot follows; this switches the editor`
                      : `Switch to the ${this.theme === 'dark' ? 'light' : 'dark'} theme`}
                    @click=${() => this.toggleTheme()}>
              ${this.theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
          </div>
          <tc-viewer
              @tc-open-guide=${() => { this.showGuide = true; }}
              .document=${this.ast}
              .study=${this.study}
              .viewIndex=${this.viewIndex}
              .theme=${this.plotTheme()}
              .errors=${this.errors}
              .errorCount=${this.errorTotal()}></tc-viewer>
        </div>
      </div>
      <tc-guide
          .open=${this.showGuide}
          @tc-guide-close=${() => { this.showGuide = false; }}></tc-guide>
    `;
  }
}

/**
 * What a study calls itself, for naming the buffer it arrived in.
 *
 * `meta.project` is the engineer's own name for the work and is what
 * they would have typed at the Save prompt anyway; `meta.study` is the
 * next best thing. Parsed rather than pattern-matched out of the text,
 * so a name in a comment or inside another string is not mistaken for
 * one -- and a study too broken to parse simply has no name, which is
 * a better answer than a wrong one.
 */
function studyName(source: string): string | null {
  try {
    const doc = parse(source).document;
    if (!doc) return null;
    const study = buildStudy(doc);
    for (const key of ['project', 'study'] as const) {
      const value = study.meta?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch { /* unparseable; it stays unnamed */ }
  return null;
}

/** localStorage key holding the Source/Plot layout choice. */
const PANE_KEY = 'tc.pane';

/** localStorage key holding the user's theme choice. */
const THEME_KEY = 'tc-curves.theme';

/**
 * The theme to start in: the user's remembered choice if there is one,
 * otherwise whatever the operating system asks for.
 */
/**
 * Storage key for the help strip's dismissed state.
 *
 * Separate from the theme so clearing one does not clear the other.
 */
const HELP_HIDDEN_KEY = 'tc.helpHidden';

function readStoredHelpHidden(): boolean {
  try {
    return localStorage.getItem(HELP_HIDDEN_KEY) === '1';
  } catch {
    /* Storage unavailable: show it, which is the useful default. */
    return false;
  }
}

/**
 * Where the caret belongs after a reflow.
 *
 * Formatting rewrites indentation and spacing throughout, so the raw
 * offset is meaningless afterwards. The *line* is not: the formatter
 * is line-based and only ever splits a line, never merges or reorders
 * two.
 *
 * Matched by the line's own text where that text appears exactly once
 * in the result, which survives the line-count change that exploding a
 * brace-heavy block causes. Falls back to the same line index, and
 * then to the start of the document. Always the start of a line --
 * that is what was asked for, and it is the one position in a
 * reflowed line that is stable.
 */
export function caretAfterFormat(
  before: string,
  after: string,
  offset: number,
): number {
  const beforeLines = before.split('\n');
  const idx = Math.min(
    lineAtOffset(before, offset) - 1,
    Math.max(0, beforeLines.length - 1),
  );
  const wanted = (beforeLines[idx] ?? '').trim();

  const afterLines = after.split('\n');
  const startOf = (n: number): number => {
    let at = 0;
    for (let i = 0; i < n && i < afterLines.length; i++) at += afterLines[i].length + 1;
    return Math.min(at, after.length);
  };

  if (wanted !== '') {
    const hits: number[] = [];
    for (const [i, line] of afterLines.entries()) {
      if (line.trim() === wanted) hits.push(i);
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return startOf(hits[0]);
  }

  return startOf(Math.min(idx, Math.max(0, afterLines.length - 1)));
}

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
