#!/usr/bin/env node
/**
 * `current_max` -> `I_cutoff`, on elements and stages only.
 *
 * A `view` keeps `current_max`: there it is an axis bound, paired with
 * `current_min`, and it means something different from where a curve
 * stops. One spelling for two concepts is what this rename undoes, so
 * a blind search-and-replace would put it straight back.
 *
 * Block-aware rather than indentation-aware. The last over-broad `sed`
 * in this repo deleted a `views` line from a `times` block because it
 * happened to share an indent with the elements around it.
 *
 *   node scripts/migrate-cutoff.mjs [--write] <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Which block a line sits in, by walking braces and remembering heads. */
export function migrate(src) {
  /*
   * One scan over the whole text, tracking which block the cursor is
   * in. Not line by line: a study written on one line --
   * `element 51 { curve = iec.si; current_max = 8 kA; }`, which is how
   * most of the tests write them -- puts the key and the brace that
   * scopes it in the same line, so a line-granular walk can only
   * choose to be wrong about one of them.
   */
  const stack = [];
  let out = '';
  let clause = '';
  let changed = 0;

  for (let i = 0; i < src.length; i += 1) {
    /* A comment is text, not code: skip to the newline verbatim. */
    if (src[i] === '#') {
      const nl = src.indexOf('\n', i);
      const to = nl === -1 ? src.length : nl;
      out += src.slice(i, to);
      i = to - 1;
      continue;
    }

    const inside = stack[stack.length - 1];
    if ((inside === 'element' || inside === 'stage')
        && src.startsWith('current_max', i)
        && !/[A-Za-z0-9_]/.test(src[i - 1] ?? '')
        && /^\s*=/.test(src.slice(i + 'current_max'.length))) {
      out += 'I_cutoff';
      i += 'current_max'.length - 1;
      changed += 1;
      continue;
    }

    const ch = src[i];
    out += ch;
    if (ch === '{') { stack.push(headWord(clause)); clause = ''; }
    else if (ch === '}') { stack.pop(); clause = ''; }
    else if (ch === ';' || ch === '\n') clause = '';
    else clause += ch;
  }
  return { text: out, changed };
}

/** The keyword opening a block: the first word of its head clause. */
function headWord(clause) {
  return (clause.match(/[A-Za-z_]\w*/) ?? ['?'])[0];
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((a) => a !== '--write');
if (files.length === 0) {
  console.error('usage: migrate-cutoff.mjs [--write] <file...>');
  process.exit(2);
}
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const { text, changed } = migrate(src);
  if (changed === 0) continue;
  console.log(`${f}: ${changed} renamed`);
  if (write) writeFileSync(f, text);
}
