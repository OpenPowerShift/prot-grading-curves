/**
 * Vite plugin: render the user guide to HTML with Asciidoctor.js.
 *
 * The playground's help is `docs/guide.adoc` -- a single, self-contained,
 * example-led document about *writing* studies. The normative
 * specification (`spec/spec.adoc`, assembled from `spec/sections/`) is
 * deliberately separate: it answers what the language *is*, in grammar
 * productions and constant tables, which is the wrong thing to put in
 * front of someone trying to author a file.
 *
 * One file, no includes, so the guide can also be handed whole to a
 * language model asked to produce a `.tc` study.
 *
 * Conversion happens at *build* time rather than in the browser, so
 * Asciidoctor itself (about 2 MB) never reaches the bundle -- only the
 * HTML it produced. Editing the guide invalidates the module, so the
 * dev server hot-reloads it as it is written.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(HERE, '..', 'docs');
const GUIDE_FILE = join(DOCS_DIR, 'guide.adoc');
const TUTORIAL_FILE = join(DOCS_DIR, 'tutorial.adoc');
const ADVANCED_FILE = join(DOCS_DIR, 'advanced.adoc');

const VIRTUAL_ID = 'virtual:tc-guide';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/**
 * Convert the guide.
 *
 * `safe: 'safe'` permits `include::` without letting a document read
 * arbitrary files. The guide uses no includes, but the setting costs
 * nothing and keeps the plugin usable for the spec too.
 */
async function renderGuide(file = GUIDE_FILE, fallbackTitle = 'tc-curves user guide') {
  /*
   * Two export shapes in the wild: v2 default-exports a factory that
   * returns the API, v3 exports `loadFile` and friends directly.
   * Accepting either keeps the plugin working across an upgrade.
   */
  const mod = await import('@asciidoctor/core');
  const asciidoctor = typeof mod.loadFile === 'function'
    ? mod
    : (mod.default ?? mod)();

  /* v3's API is asynchronous; v2's returns the document directly, and
   * awaiting a non-promise is harmless. */
  const doc = await asciidoctor.loadFile(file, {
    safe: 'safe',
    base_dir: DOCS_DIR,
    attributes: {
      /* Section anchors so the in-app table of contents can link.
       * `toc` is left off: the app renders its own navigation. */
      sectanchors: '',
      sectlinks: '',
      icons: 'font',
      'source-highlighter': null,
      showtitle: '',
    },
  });

  const html = await doc.convert();

  return {
    title: doc.getDocumentTitle() ?? fallbackTitle,
    revision: String(doc.getAttribute('version') ?? ''),
    revdate: String(doc.getAttribute('revdate') ?? ''),
    html,
    toc: tableOfContents(html),
  };
}

/**
 * Contents list, read back out of the converted HTML.
 *
 * Taking it from the output rather than walking the document tree
 * means the ids are exactly the ones the anchors use, so every entry
 * is guaranteed to resolve.
 */
function tableOfContents(html) {
  const entries = [];
  const heading = /<h([234]) id="([^"]+)">([\s\S]*?)<\/h\1>/g;
  for (const match of html.matchAll(heading)) {
    entries.push({
      level: Number(match[1]),
      id: match[2],
      text: decodeEntities(match[3].replace(/<[^>]+>/g, '')).trim(),
    });
  }
  return entries;
}

/**
 * Turn the character references Asciidoctor emits back into text.
 *
 * The contents list is rendered as text content, not as markup, so a
 * heading containing an em dash would otherwise read literally as
 * `&#8212;`.
 */
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => named[name] ?? whole);
}

/** Every `.adoc` under `docs/`, so any edit invalidates the module. */
function specFiles(dir = DOCS_DIR, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) specFiles(path, found);
    else if (entry.endsWith('.adoc')) found.push(path);
  }
  return found;
}

export function guidePlugin() {
  return {
    name: 'tc-guide',

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },

    async load(id) {
      if (id !== RESOLVED_ID) return null;

      /* Watched so `vite dev` reloads when the spec is edited. */
      for (const file of specFiles()) this.addWatchFile(file);

      try {
        const [guide, tutorial, advanced] = await Promise.all([
          renderGuide(),
          renderGuide(TUTORIAL_FILE, 'tc-curves tutorial'),
          renderGuide(ADVANCED_FILE, 'tc-curves advanced guide'),
        ]);
        return `export default ${JSON.stringify(guide)};\n`
          + `export const tutorial = ${JSON.stringify(tutorial)};\n`
          + `export const advanced = ${JSON.stringify(advanced)};`;
      } catch (error) {
        /*
         * A spec that fails to convert must not take the whole app
         * down with it -- the guide degrades to a message and the
         * playground still runs.
         */
        this.warn(`tc-guide: ${error.message}`);
        return `export default ${JSON.stringify({
          title: 'User guide',
          revision: '',
          revdate: '',
          html: `<p>The guide could not be rendered: ${String(error.message)}</p>`,
        })};`;
      }
    },

    /** Re-serve the module when any spec file changes. */
    handleHotUpdate({ file, server }) {
      if (!file.endsWith('.adoc')) return;
      const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
      if (mod) server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: 'full-reload' });
    },
  };
}
