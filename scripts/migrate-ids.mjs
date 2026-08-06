#!/usr/bin/env node
/**
 * Turn quoted declaration ids into bare identifiers.
 *
 * A study used to write `faults { "Bus fault" { ... } }`, where the id
 * was also the caption. That left no way to write a caption that was
 * not also a handle, and the study that prompted this had put line
 * breaks inside identifiers for want of anywhere else to put them.
 *
 * The transformation is deterministic and loses nothing:
 *
 *     faults { "Bus fault" { ... } }   ->  faults { BUS_FAULT { name = "Bus fault"; ... } }
 *     grade  { fault = "Bus fault"; }  ->  grade  { fault = BUS_FAULT; }
 *
 * The prose becomes a `name`, so nothing a reader sees changes -- which
 * the visual baseline checks sheet by sheet. Ids that are already
 * identifier-shaped keep their spelling and gain no `name`, because
 * there is no caption to preserve.
 *
 * Collisions are reported and nothing is written. Two different
 * captions can normalise to one identifier ("LV min" and "LV  min"),
 * and quietly merging two faults would change every margin that
 * references either.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Blocks whose id is written after the keyword. */
const KEYWORD_DECL = ['scenario', 'view', 'point', 'device', 'relay', 'level'];

/** Blocks whose entries are `"id" { ... }` inside a container. */
const CONTAINER_DECL = ['faults', 'times', 'voltages'];

/** Keys whose value is a reference to a declared id. */
const REF_KEYS = [
  'fault', 'faults', 'scenario', 'scenarios', 'condition',
  'point', 'view', 'views', 'primary', 'backup', 'on_curve', 'sources',
  'voltage',
];

/** `Bus fault` -> `BUS_FAULT`. Deterministic, and reversible by eye. */
export function toIdentifier(text) {
  /*
   * Already a handle: leave it exactly as written.
   *
   * Device ids like `fuse_100T` and level names like `HV` are
   * identifier-shaped already and are referenced *bare* -- so
   * upper-casing them renamed the declaration and left every reference
   * pointing at nothing. There is also no caption to preserve, since
   * the id was never prose.
   */
  if (/^[A-Za-z_]\w*$/.test(text)) return text;

  const cleaned = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
  /* An identifier may not lead with a digit; the language reads that
   * as a device number. */
  return /^\d/.test(cleaned) ? `N${cleaned}` : cleaned || 'UNNAMED';
}

/**
 * Every quoted id declared in the source, with what it becomes.
 *
 * Scans rather than parses, because the file being migrated is by
 * definition written in the old spelling and the parser is moving to
 * the new one.
 */
export function planFor(src) {
  const mapping = new Map();
  const add = (raw) => {
    if (!mapping.has(raw)) mapping.set(raw, toIdentifier(raw));
  };

  for (const kw of KEYWORD_DECL) {
    for (const m of src.matchAll(new RegExp(`\\b${kw}\\s+"([^"]+)"\\s*\\{`, 'g'))) {
      add(m[1]);
    }
  }
  for (const kw of CONTAINER_DECL) {
    const block = new RegExp(`\\b${kw}\\s*\\{`, 'g');
    for (const open of src.matchAll(block)) {
      /* Walk to the matching brace so a `"x" {` elsewhere is not read
       * as a declaration in this container. */
      let depth = 0;
      let i = open.index + open[0].length - 1;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
      }
      for (const m of src.slice(start, i).matchAll(/"([^"]+)"\s*\{/g)) add(m[1]);
    }
  }

  const collisions = new Map();
  for (const [raw, id] of mapping) {
    if (!collisions.has(id)) collisions.set(id, []);
    collisions.get(id).push(raw);
  }
  const clashes = [...collisions.entries()].filter(([, raws]) => raws.length > 1);

  return { mapping, clashes };
}

/** Rewrite one source. Returns the new text, or throws on a collision. */
export function migrate(src) {
  const { mapping, clashes } = planFor(src);
  if (clashes.length > 0) {
    const detail = clashes
      .map(([id, raws]) => `  ${id} <- ${raws.map((r) => JSON.stringify(r)).join(', ')}`)
      .join('\n');
    throw new Error(`ids collide after normalising:\n${detail}`);
  }

  let out = src;

  /* Declarations: `kw "Prose" {` -> `kw PROSE { name = "Prose";` */
  for (const kw of KEYWORD_DECL) {
    out = out.replace(new RegExp(`(\\b${kw}\\s+)"([^"]+)"(\\s*\\{)`, 'g'), (all, head, raw, brace) => {
      const id = mapping.get(raw);
      if (!id) return all;
      return id === raw ? `${head}${id}${brace}` : `${head}${id}${brace}\n  name = ${JSON.stringify(raw)};`;
    });
  }

  /* Container entries: `"Prose" {` -> `PROSE { name = "Prose";` */
  out = out.replace(/^(\s*)"([^"]+)"(\s*\{)/gm, (all, indent, raw, brace) => {
    const id = mapping.get(raw);
    if (!id) return all;
    return id === raw
      ? `${indent}${id}${brace}`
      : `${indent}${id}${brace}\n${indent}  name = ${JSON.stringify(raw)};`;
  });

  /* References: `fault = "Prose"` -> `fault = PROSE`, in lists too. */
  for (const key of REF_KEYS) {
    out = out.replace(new RegExp(`(\\b${key}\\s*=\\s*)([^;\\n]+)`, 'g'), (all, head, value) =>
      head + value.replace(/"([^"]+)"/g, (q, raw) => mapping.get(raw) ?? q));
  }

  return out;
}

/* ---- CLI --------------------------------------------------------- */

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const check = process.argv.includes('--check');

if (files.length === 0) {
  console.error('usage: migrate-ids.mjs [--check] <file.ptc>...');
  process.exit(2);
}

let changed = 0;
let failed = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let out;
  try {
    out = migrate(src);
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    failed++;
    continue;
  }
  if (out === src) continue;
  changed++;
  if (check) console.log(`${file}: would rewrite`);
  else { writeFileSync(file, out, 'utf8'); console.log(`${file}: rewritten`); }
}
console.log(`${changed} file(s) ${check ? 'would change' : 'changed'}, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
