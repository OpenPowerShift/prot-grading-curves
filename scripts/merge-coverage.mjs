/**
 * Merge browser coverage into the unit run's.
 *
 * The project has two suites and they cover different halves of the
 * source. Vitest runs the engine under jsdom; Playwright drives the app
 * in Chromium, which is the only place drag handlers, the clipboard,
 * download links and the PNG rasteriser can run at all. Reporting only
 * the first understates the second by about a third of the code, and
 * invites tests written to raise a number rather than to catch
 * anything.
 *
 * Raw V8 ranges (`coverage-browser/`) are converted to Istanbul with
 * `v8-to-istanbul`, which follows each module's source map back to the
 * TypeScript it came from, then merged with `coverage/coverage-final.json`
 * from vitest.
 *
 *   node scripts/merge-coverage.mjs
 *
 * Exits non-zero if the merged figure misses the thresholds, so it can
 * gate a release the way the unit run alone does.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import { create as createReport } from 'istanbul-reports';
import v8toIstanbul from 'v8-to-istanbul';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const V8_DIR = join(ROOT, 'coverage-browser');
const UNIT_FILE = join(ROOT, 'coverage', 'coverage-final.json');
const OUT_DIR = join(ROOT, 'coverage', 'merged');

/** Same exclusions as the unit run, so the two figures are comparable. */
const EXCLUDE = [/\/src\/main\.ts$/, /\/src\/examples\.ts$/, /\.d\.ts$/];
const THRESHOLDS = { statements: 95, branches: 85, functions: 95, lines: 95 };

/** A served URL back to the file on disk. */
function toLocalPath(url) {
  const withoutQuery = url.split('?')[0];
  const marker = withoutQuery.indexOf('/src/');
  if (marker < 0) return null;
  const path = join(ROOT, withoutQuery.slice(marker + 1));
  return existsSync(path) ? path : null;
}

async function browserCoverage() {
  const map = libCoverage.createCoverageMap({});
  if (!existsSync(V8_DIR)) return map;

  for (const file of readdirSync(V8_DIR).filter((f) => f.endsWith('.json'))) {
    const entries = JSON.parse(readFileSync(join(V8_DIR, file), 'utf8'));
    for (const entry of entries) {
      const local = toLocalPath(entry.url);
      if (!local || EXCLUDE.some((rx) => rx.test(local))) continue;

      /*
       * `source` is what the browser executed -- Vite's transform of
       * the TypeScript -- and the inline source map inside it is what
       * carries the ranges back to the original. Without passing the
       * transformed text the converter would map against the wrong
       * line numbering entirely.
       */
      const converter = v8toIstanbul(local, 0, { source: entry.source ?? '' });
      try {
        await converter.load();
        converter.applyCoverage(entry.functions);
        map.merge(converter.toIstanbul());
      } catch {
        /* A module whose map will not load is skipped rather than
         * failing the merge: a missing sheet of evidence is not a
         * reason to discard the rest. */
      } finally {
        converter.destroy();
      }
    }
  }
  return map;
}

function unitCoverage() {
  if (!existsSync(UNIT_FILE)) {
    console.error('no unit coverage found; run `npm run test:coverage` first');
    process.exit(2);
  }
  return libCoverage.createCoverageMap(JSON.parse(readFileSync(UNIT_FILE, 'utf8')));
}

function summarise(map) {
  const totals = { statements: [0, 0], branches: [0, 0], functions: [0, 0], lines: [0, 0] };
  for (const file of map.files()) {
    const s = map.fileCoverageFor(file).toSummary();
    for (const key of Object.keys(totals)) {
      totals[key][0] += s[key].covered;
      totals[key][1] += s[key].total;
    }
  }
  return totals;
}

/**
 * Lift the browser's coverage onto the unit run's statement map.
 *
 * The two tools disagree about what a statement *is*: vitest's v8
 * provider and `v8-to-istanbul` split the same file differently, so
 * `CoverageMap.merge` unions two incompatible maps and inflates the
 * totals -- 10,674 statements became 18,500, and the percentage that
 * came out was meaningless.
 *
 * The line number is the one thing both agree on, being a property of
 * the source rather than of either tool. So the unit map is kept as the
 * canonical structure, and a statement is marked covered if *either*
 * run reached the line it starts on. That is the honest reading of "the
 * two suites together": totals stay as the unit run measured them, and
 * only the covered set grows.
 *
 * *Branches are deliberately not lifted.* A line having run says the
 * statement on it ran; it does not say both arms of a conditional on
 * that line were taken. Lifting them moved branch coverage from 81% to
 * 97% in one step, which was the merge flattering itself rather than
 * the suites covering more. Branch coverage therefore remains what the
 * unit run measured, and is understated to the extent the browser
 * exercises branches the unit run does not.
 */
function liftOntoUnitMap(unit, browser) {
  const browserLines = new Map();
  for (const file of browser.files()) {
    const fc = browser.fileCoverageFor(file);
    const lines = new Set();
    for (const [id, count] of Object.entries(fc.s)) {
      if (count > 0) lines.add(fc.statementMap[id].start.line);
    }
    /* `f` and `b` carry their own locations; a covered function or
     * branch is evidence about its line too. */
    for (const [id, count] of Object.entries(fc.f ?? {})) {
      if (count > 0) lines.add(fc.fnMap[id]?.decl?.start?.line);
    }
    browserLines.set(file, lines);
  }

  let touched = 0;
  for (const file of unit.files()) {
    const lines = browserLines.get(file);
    if (!lines || lines.size === 0) continue;
    touched++;
    const fc = unit.fileCoverageFor(file);
    for (const [id, count] of Object.entries(fc.s)) {
      if (count === 0 && lines.has(fc.statementMap[id].start.line)) fc.s[id] = 1;
    }
    for (const [id, count] of Object.entries(fc.f ?? {})) {
      if (count === 0 && lines.has(fc.fnMap[id]?.decl?.start?.line)) fc.f[id] = 1;
    }
  }
  return touched;
}

const merged = unitCoverage();
const fromBrowser = await browserCoverage();
const browserFiles = liftOntoUnitMap(merged, fromBrowser);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'coverage-final.json'), JSON.stringify(merged.toJSON()));

const context = createContext({ dir: OUT_DIR, coverageMap: merged });
createReport('text-summary').execute(context);
createReport('lcovonly').execute(context);

const totals = summarise(merged);
console.log(`\nbrowser run contributed to ${browserFiles} files`);

let failed = false;
for (const [key, min] of Object.entries(THRESHOLDS)) {
  const [covered, total] = totals[key];
  const pct = total === 0 ? 100 : (covered / total) * 100;
  const ok = pct >= min;
  if (!ok) failed = true;
  console.log(`  ${key.padEnd(11)} ${pct.toFixed(2).padStart(6)}%  (need ${min}%)  ${ok ? 'ok' : 'SHORT'}`);
}

if (failed) {
  console.error('\nmerged coverage is below threshold');
  process.exit(1);
}
console.log('\nmerged coverage meets every threshold');
