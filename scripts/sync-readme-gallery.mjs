/**
 * Paste the gallery examples back into the README.
 *
 * `tests/unit/coverage.spec.ts` holds each `.Source — ...` block to be
 * its file verbatim, and tells you to regenerate rather than hand-edit
 * -- but there was nothing to regenerate *with*, so the instruction was
 * followed by hand and the blocks drifted twice.
 *
 *   node scripts/sync-readme-gallery.mjs          # rewrite the README
 *   node scripts/sync-readme-gallery.mjs --check  # fail if it has drifted
 *
 * `--check` is the form for CI: it says which example moved rather than
 * quietly rewriting a file the run was not asked to touch.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const README = join(ROOT, 'README.adoc');

/*
 * Matches one gallery entry: the caption naming the file, the
 * collapsible wrapper, and the fenced source between `----` pairs. The
 * body is captured lazily so the fence that ends it is the first one,
 * not the last in the document.
 */
const BLOCK = /(\.Source — `(examples\/[\w.-]+)`\n\[%collapsible\]\n====\n\[source,\w+\]\n----\n)([\s\S]*?)(\n----\n====)/g;

const before = readFileSync(README, 'utf8');
const drifted = [];

const after = before.replace(BLOCK, (whole, head, path, body, tail) => {
  const source = readFileSync(join(ROOT, path), 'utf8').trim();
  if (source !== body) drifted.push(path);
  return `${head}${source}${tail}`;
});

const check = process.argv.includes('--check');

if (drifted.length === 0) {
  console.log('README gallery matches every example');
  process.exit(0);
}

if (check) {
  console.error(`README gallery has drifted from: ${drifted.join(', ')}`);
  console.error('run `node scripts/sync-readme-gallery.mjs` to update it');
  process.exit(1);
}

writeFileSync(README, after);
console.log(`updated ${drifted.length} block${drifted.length === 1 ? '' : 's'}: ${drifted.join(', ')}`);
