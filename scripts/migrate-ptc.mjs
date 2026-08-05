/**
 * Rewrite a `.ptc` source into the units-everywhere vocabulary.
 *
 * No key carries its own unit any more, so two things change together:
 * the key is renamed, and where the old key *implied* a unit the value
 * gains one explicitly. `kV = 33.0` becomes `V = 33.0 kV`; `t_s = 0.1`
 * becomes `t = 0.1 s`. Where the value already carried a suffix --
 * `I_A = 6400 A` -- only the key moves.
 *
 * Deliberately line-oriented and deliberately conservative: it edits
 * `key =` at the start of an assignment and nothing else, so a key
 * name occurring inside a string or a comment is left alone. Run it,
 * then read the diff.
 *
 *   node scripts/migrate-ptc.mjs <file>...
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** old key -> [new key, unit to add when the value has none]. */
const RENAMES = {
  I_A: ['I', 'A'],
  I1_A: ['I1', 'A'],
  I2_A: ['I2', 'A'],
  I0_A: ['I0', 'A'],
  earth_A: ['residual', 'A'],
  min_A: ['I_min', 'A'],
  max_A: ['I_max', 'A'],
  kV: ['V', 'kV'],
  t_s: ['t', 's'],
  CTI_min_s: ['margin', 's'],
  margin_s: ['margin_target', 's'],
  I_pu: ['I_pickup', 'A'],
  I_base_A: ['I_base', 'A'],
  base_MVA: ['base_S', 'MVA'],
  current_pct: ['share', '%'],
  at_I_A: ['at_I', 'A'],
  at_I1_A: ['at_I1', 'A'],
  at_I2_A: ['at_I2', 'A'],
  at_I0_A: ['at_I0', 'A'],
  at_earth_A: ['at_residual', 'A'],
  at_t_s: ['at_t', 's'],
  rating_A: ['rating_I', 'A'],
  rating_kV: ['rating_V', 'kV'],
  rating_MVA: ['rating_S', 'MVA'],
};

/** Keys that are gone; the whole assignment goes with them. */
const REMOVED = new Set(['frequency_Hz', 'grounding']);

/** Every unit suffix, so an existing one is recognised and left alone. */
const UNITS = new Set([
  'A', 'kA', 'mA', 'MA', 's', 'ms', 'min', 'ks', 'kV', 'V', 'MV',
  'MVA', 'kVA', 'GVA', 'MW', 'kW', 'deg', 'Hz', 'pu', 'xCT', 'xIn',
  'xct', 'xin', 'A_sec', 'Asec', 'A_secondary', 'A_pri', 'Apri',
  'A_primary', '%', 'pct',
]);

export function migrate(source) {
  const out = [];

  for (const line of source.split('\n')) {
    /* A removed key takes its line, unless the line carries other
     * statements too -- then just the one assignment. */
    const removed = [...REMOVED].find((k) =>
      new RegExp(`(^|[{;\\s])${k}\\s*=`).test(line));
    if (removed) {
      const stripped = line.replace(new RegExp(`\\s*\\b${removed}\\s*=[^;]*;`), '');
      if (stripped.trim() === '' || /^\s*$/.test(stripped)) continue;
      out.push(stripped);
      continue;
    }

    let edited = line;
    for (const [old, [now, unit]] of Object.entries(RENAMES)) {
      /* `key = value ;` at an assignment position only: preceded by a
       * brace, a semicolon or the start of the line. */
      const re = new RegExp(`(^|[{;]\\s*|\\s)(${old})(\\s*=\\s*)([^;}]*)`, 'g');
      edited = edited.replace(re, (whole, before, _k, eq, value) => {
        /*
         * Keep the `=` where it was. These files are hand-aligned into
         * columns, and a key that grows by six characters would shove
         * one row's `=` out of line with its neighbours for no reason.
         */
        const pad = eq.match(/^ */)[0].length;
        const want = Math.max(1, pad - (now.length - old.length));
        const alignedEq = ' '.repeat(want) + eq.trimStart();
        const trimmed = value.trimEnd();
        const trailing = value.slice(trimmed.length);
        /* Already carries a suffix? Then only the key moves. */
        const last = trimmed.split(/\s+/).pop() ?? '';
        const hasUnit = UNITS.has(last);
        const withUnit = hasUnit || trimmed === '' ? trimmed : `${trimmed} ${unit}`;
        return `${before}${now}${alignedEq}${withUnit}${trailing}`;
      });
    }
    out.push(edited);
  }

  return out.join('\n');
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/migrate-ptc.mjs <file>...');
  process.exit(2);
}
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = migrate(before);
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`migrated ${file}`);
  } else {
    console.log(`unchanged ${file}`);
  }
}
