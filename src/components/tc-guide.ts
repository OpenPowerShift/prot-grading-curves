/**
 * <tc-guide> — the user guide, in the app.
 *
 * The document is `docs/guide.adoc`, converted by Asciidoctor at build
 * time (see `scripts/guide-plugin.js`). It is the guide, not the
 * specification: example-led, about writing studies, and a single file
 * so it can be handed whole to a language model. The normative spec
 * lives separately under `spec/`.
 *
 * The HTML is loaded on first open, not at start-up: it is a quarter
 * of a megabyte, and most sessions never ask for it.
 */

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { Guide, GuideHeading } from 'virtual:tc-guide';

@customElement('tc-guide')
export class TcGuide extends LitElement {
  /** Whether the overlay is showing. Owned by the host app. */
  @property({ type: Boolean }) open = false;

  /** The document on screen. Tutorial first: it is where a newcomer
   * should start, and a reader who wants the reference will switch. */
  @state() private which: 'tutorial' | 'guide' | 'advanced' = 'tutorial';
  @state() private docs: { tutorial: Guide; guide: Guide; advanced: Guide } | null = null;
  @state() private failed = '';
  @state() private filter = '';
  /** Anchor of the section currently under the reader. */
  @state() private active = '';

  private observer: IntersectionObserver | null = null;

  /** Whichever document is showing. */
  private get guide(): Guide | null {
    return this.docs ? this.docs[this.which] : null;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: none;
      /*
       * The app's own font is monospace, which suits a source editor
       * and is tiring over a specification. Prose gets a proportional
       * stack; code spans and blocks opt back into the mono one.
       */
      font-family: var(--tc-font-ui, ui-sans-serif, system-ui, -apple-system,
                   'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
    }
    :host([open]) { display: block; }

    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
    }

    .panel {
      position: absolute;
      inset: 3vh 4vw;
      display: grid;
      grid-template-rows: auto 1fr;
      grid-template-columns: minmax(190px, 260px) 1fr;
      grid-template-areas: "head head" "nav body";
      background: var(--tc-bg-elevated, #fff);
      color: var(--tc-fg, #1a1a19);
      border: 1px solid var(--tc-border, #d8d7d2);
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
      overflow: hidden;
    }

    header {
      grid-area: head;
      display: flex;
      align-items: baseline;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--tc-border, #d8d7d2);
      background: var(--tc-bg-sunken, #f6f5f2);
    }
    header h2 { margin: 0; font-size: 15px; font-weight: 600; }
    header .which { display: flex; gap: 2px; }
    header .which button {
      font: inherit;
      font-size: 12px;
      padding: 3px 10px;
      border: 1px solid var(--tc-border, #d8d7d2);
      background: var(--tc-bg, #fff);
      color: var(--tc-fg-muted, #6b6a64);
      cursor: pointer;
    }
    header .which button:first-child { border-radius: 4px 0 0 4px; }
    header .which button:last-child { border-radius: 0 4px 4px 0; }
    header .which button.on {
      background: var(--tc-accent, #2a78d6);
      border-color: var(--tc-accent, #2a78d6);
      color: #fff;
    }
    header .rev {
      font-size: 12px;
      color: var(--tc-fg-muted, #6b6a64);
      font-variant-numeric: tabular-nums;
    }
    header .spacer { flex: 1; }

    input.search {
      font: inherit;
      font-size: 12px;
      padding: 4px 8px;
      min-width: 180px;
      color: var(--tc-fg, #1a1a19);
      background: var(--tc-bg-elevated, #fff);
      border: 1px solid var(--tc-border, #d8d7d2);
      border-radius: 4px;
    }

    button.close {
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      padding: 4px 10px;
      color: var(--tc-fg, #1a1a19);
      background: var(--tc-bg-elevated, #fff);
      border: 1px solid var(--tc-border, #d8d7d2);
      border-radius: 4px;
    }
    button.close:hover { border-color: var(--tc-accent, #3b6ea5); }

    nav {
      grid-area: nav;
      overflow-y: auto;
      padding: 10px 6px 24px 12px;
      border-right: 1px solid var(--tc-border, #d8d7d2);
      background: var(--tc-bg-sunken, #f6f5f2);
      font-size: 12px;
      line-height: 1.5;
      overscroll-behavior: contain;
    }
    nav a {
      display: block;
      padding: 2px 6px;
      overflow-wrap: anywhere;
      border-radius: 3px;
      color: var(--tc-fg-muted, #6b6a64);
      text-decoration: none;
    }
    nav a:hover { color: var(--tc-fg, #1a1a19); background: var(--tc-bg-elevated, #fff); }
    nav a.lvl3 { padding-left: 18px; }
    nav a.lvl4 { padding-left: 30px; font-size: 11.5px; }
    nav a.active {
      color: var(--tc-accent, #3b6ea5);
      font-weight: 600;
      background: var(--tc-bg-elevated, #fff);
    }
    nav .empty { color: var(--tc-fg-muted, #6b6a64); padding: 6px; }

    .body {
      grid-area: body;
      overflow-y: auto;
      padding: 18px 28px 64px;
      line-height: 1.6;
      overscroll-behavior: contain;
      font-size: 14px;
      /*
       * Deliberately not smooth-scrolled. The document is
       * some 49,000 px tall, so a jump from the contents animates
       * through dozens of headings; each one the observer reports
       * re-renders the whole contents list, and the scroll janks to a
       * standstill. A contents jump wants to be instant anyway.
       */
    }

    /* --- converted Asciidoc --- */
    .body h1 { font-size: 20px; margin: 0 0 12px; }
    .body h2 {
      font-size: 17px;
      margin: 28px 0 8px;
      padding-top: 10px;
      border-top: 1px solid var(--tc-border, #d8d7d2);
      scroll-margin-top: 12px;
    }
    .body h3 { font-size: 15px; margin: 20px 0 6px; scroll-margin-top: 12px; }
    .body h4 { font-size: 13.5px; margin: 16px 0 4px; scroll-margin-top: 12px; }
    .body p { margin: 8px 0; }
    .body a { color: var(--tc-accent, #3b6ea5); }
    .body ul, .body ol { margin: 8px 0; padding-left: 22px; }
    .body li { margin: 3px 0; }

    .body code {
      font-family: var(--tc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 0.9em;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--tc-bg-sunken, #f6f5f2);
      border: 1px solid var(--tc-border, #d8d7d2);
    }
    .body pre {
      font-family: var(--tc-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 12px;
      line-height: 1.45;
      margin: 10px 0;
      padding: 10px 12px;
      overflow-x: auto;
      background: var(--tc-bg-sunken, #f6f5f2);
      border: 1px solid var(--tc-border, #d8d7d2);
      border-radius: 5px;
    }
    .body pre code { padding: 0; border: 0; background: none; }

    .body table {
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 12.5px;
      display: block;
      overflow-x: auto;
      max-width: 100%;
    }
    .body th, .body td {
      border: 1px solid var(--tc-border, #d8d7d2);
      padding: 4px 8px;
      text-align: left;
      vertical-align: top;
    }
    .body th { background: var(--tc-bg-sunken, #f6f5f2); font-weight: 600; }

    /* Admonitions carry their meaning in the label, not the colour. */
    .body .admonitionblock {
      margin: 12px 0;
      border-left: 3px solid var(--tc-accent, #3b6ea5);
      background: var(--tc-bg-sunken, #f6f5f2);
      border-radius: 0 4px 4px 0;
    }
    .body .admonitionblock table { margin: 0; border: 0; display: table; }
    .body .admonitionblock td { border: 0; padding: 8px 12px; }
    .body .admonitionblock .icon {
      font-weight: 600;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
      color: var(--tc-accent, #3b6ea5);
    }
    .body .title { font-weight: 600; font-size: 12.5px; margin-top: 10px; }
    .body #toc, .body #footer { display: none; }

    .loading, .error { padding: 24px; color: var(--tc-fg-muted, #6b6a64); }
    .error { color: var(--tc-error, #b3403a); }

    @media (max-width: 720px) {
      .panel {
        inset: 0;
        border-radius: 0;
        grid-template-columns: 1fr;
        grid-template-areas: "head" "body";
      }
      nav { display: none; }
    }
  `;

  updated(changed: Map<string, unknown>): void {
    if (!changed.has('open')) return;
    /* Reflect for the :host([open]) rule, which does the showing. */
    this.toggleAttribute('open', this.open);
    if (this.open) {
      void this.ensureLoaded();
      this.focusSearch();
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.onKeyDown = this.onKeyDown.bind(this);
    window.addEventListener('keydown', this.onKeyDown);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.observer?.disconnect();
    super.disconnectedCallback();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.open && event.key === 'Escape') {
      event.stopPropagation();
      this.close();
    }
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('tc-guide-close', { bubbles: true, composed: true }));
  }

  /**
   * Pull in the converted spec.
   *
   * Dynamic so the quarter-megabyte of HTML lands in its own chunk and
   * is fetched only when the reader actually opens the guide.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.docs || this.failed) return;
    try {
      const mod = await import('virtual:tc-guide');
      this.docs = { guide: mod.default, tutorial: mod.tutorial, advanced: mod.advanced };
      await this.updateComplete;
      this.watchHeadings();
    } catch (error) {
      this.failed = (error as Error).message;
    }
  }

  /**
   * Show one of the two documents.
   *
   * The filter and the scroll position belong to the document being
   * left, so both are cleared; carrying a half-typed filter across
   * would hide most of whatever the reader just asked for.
   */
  private show(which: 'tutorial' | 'guide' | 'advanced'): void {
    if (this.which === which) return;
    this.which = which;
    this.filter = '';
    this.active = '';
    void this.updateComplete.then(() => {
      const body = this.renderRoot.querySelector('.body');
      if (body) body.scrollTop = 0;
      this.watchHeadings();
    });
  }

  /**
   * Highlight the contents entry for whatever is on screen.
   *
   * The top band of the viewport is the trigger, so the active entry
   * is the section the reader has scrolled *to*, not one that happens
   * to be visible at the bottom of a long page.
   */
  private watchHeadings(): void {
    this.observer?.disconnect();
    const root = this.renderRoot.querySelector('.body');
    if (!root) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.active = entry.target.id;
        }
      },
      { root, rootMargin: '0px 0px -75% 0px', threshold: 0 },
    );
    for (const h of root.querySelectorAll('h2[id], h3[id], h4[id]')) {
      this.observer.observe(h);
    }
  }

  private focusSearch(): void {
    void this.updateComplete.then(() => {
      (this.renderRoot.querySelector('input.search') as HTMLInputElement | null)?.focus();
    });
  }

  /** Scroll within the panel rather than moving the page's own hash. */
  private goto(event: Event, id: string): void {
    event.preventDefault();
    const target = this.renderRoot.querySelector(`#${CSS.escape(id)}`);
    target?.scrollIntoView({ block: 'start' });
    this.active = id;
  }

  private visibleToc(): GuideHeading[] {
    const toc = this.guide?.toc ?? [];
    const needle = this.filter.trim().toLowerCase();
    if (!needle) return toc;
    return toc.filter((h) => h.text.toLowerCase().includes(needle));
  }

  render() {
    return html`
      <div class="scrim" @click=${() => this.close()}></div>
      <div class="panel" role="dialog" aria-modal="true" aria-label="User guide">
        <header>
          <h2>${this.guide?.title ?? 'Help'}</h2>
          ${this.guide?.revision
            ? html`<span class="rev">${this.guide.revision} · ${this.guide.revdate}</span>`
            : null}
          <div class="which" role="tablist">
            ${(['tutorial', 'guide', 'advanced'] as const).map((id) => html`
              <button role="tab"
                      class=${this.which === id ? 'on' : ''}
                      aria-selected=${this.which === id}
                      @click=${() => this.show(id)}>
                ${id === 'tutorial' ? 'Tutorial' : id === 'guide' ? 'Reference' : 'Advanced'}
              </button>`)}
          </div>
          <span class="spacer"></span>
          <input class="search"
                 type="search"
                 placeholder="Filter contents…"
                 .value=${this.filter}
                 @input=${(e: Event) => { this.filter = (e.target as HTMLInputElement).value; }}>
          <button class="close" @click=${() => this.close()} title="Close (Esc)">Close</button>
        </header>

        <nav>${this.renderToc()}</nav>

        <div class="body">
          ${this.failed
            ? html`<p class="error">The guide could not be loaded: ${this.failed}</p>`
            : this.guide
              ? unsafeHTML(this.guide.html)
              : html`<p class="loading">Loading the guide…</p>`}
        </div>
      </div>
    `;
  }

  private renderToc() {
    if (!this.guide) return null;
    const entries = this.visibleToc();
    if (entries.length === 0) return html`<div class="empty">No section matches.</div>`;
    return entries.map((h) => html`
      <a href="#${h.id}"
         class="lvl${h.level} ${h.id === this.active ? 'active' : ''}"
         @click=${(e: Event) => this.goto(e, h.id)}>${h.text}</a>
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tc-guide': TcGuide;
  }
}
