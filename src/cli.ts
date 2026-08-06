#!/usr/bin/env node
/**
 * `tc-curves` command-line interface.
 *
 * Renders a `.ptc` study to SVG, PNG, or PDF, and prints the grading
 * margin report. Every format goes through the same library functions
 * the playground and the Asciidoctor extension call, so a study
 * rendered here is byte-identical to one rendered in the browser.
 *
 *   tc-curves render study.ptc                  # SVG to study.svg
 *   tc-curves render study.ptc --png -o out.png
 *   tc-curves render study.ptc --pdf --size A3 --portrait
 *   tc-curves report study.ptc                  # margin report only
 *   tc-curves check  study.ptc                  # diagnostics only
 *
 * Exit status: 0 clean, 1 diagnostics of `error` severity, 2 usage or
 * I/O failure, 3 a valid study whose grading fails.
 *
 * 3 is separate from 1 on purpose. A study with an error could not be
 * evaluated; a study that fails its margins was evaluated and did not
 * coordinate. Those are different jobs for whoever is reading the exit
 * status -- one is "fix the file", the other is "change the settings"
 * -- and collapsing them into "non-zero" loses the distinction exactly
 * where a CI gate needs it. `check` and `report` are therefore usable
 * as a CI gate for coordination, not merely for syntax.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basename, extname, resolve as resolvePath } from 'node:path';
import { process as processStudy, renderStudy } from './index.js';
import { exportPng } from './export/export-png.js';
import { exportPdf } from './export/export-pdf.js';
import { toExportableSvg } from './export/exportable-svg.js';
import { formatGradeReports, anyGradeFails } from './semantics/grades.js';
import { jsonResult } from './semantics/json-report.js';
import type { Diagnostic } from './semantics/validate.js';

type Format = 'svg' | 'png' | 'pdf';

interface Options {
  command: 'render' | 'report' | 'check' | 'help';
  input?: string;
  output?: string;
  format: Format;
  width?: number;
  scale?: number;
  size?: string;
  orientation?: 'portrait' | 'landscape';
  /** Which declared `view` to draw, by name. */
  view?: string;
  quiet: boolean;
  /** Write the sheet even when the study has errors. */
  force?: boolean;
  /** Emit machine-readable JSON instead of the human report. */
  json?: boolean;
}

const USAGE = `tc-curves -- render protection-relay time-current grading studies

Usage:
  tc-curves render <file.ptc> [--svg|--png|--pdf] [options]
  tc-curves report <file.ptc>
  tc-curves check  <file.ptc>

Options:
  -o, --output <path>   Output file (default: input name with the format's suffix)
      --svg             Render SVG (default)
      --png             Rasterise to PNG
      --pdf             Render to PDF
      --view <name>     which declared view to draw (default: the one
                        marked "default = true", else the first)
      --width <px>      PNG width in pixels
      --scale <n>       PNG scale factor when --width is absent (default 2)
      --size <name>     PDF paper size: A0-A5, Letter, Legal, Tabloid (default A4)
      --portrait        PDF portrait orientation (default landscape)
      --landscape       PDF landscape orientation
      --json            Machine-readable output: diagnostics and the
                        grading result, for CI and downstream tools
  -q, --quiet           Suppress the margin report on stdout
      --force           Write the sheet even when the study has errors
  -h, --help            Show this message

Exit status: 0 clean, 1 validation errors, 2 usage or I/O failure,
             3 valid study, grading fails.`;

export function parseArgs(argv: string[]): Options {
  const opts: Options = { command: 'help', format: 'svg', quiet: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': opts.command = 'help'; return opts;
      case '--svg': opts.format = 'svg'; break;
      case '--png': opts.format = 'png'; break;
      case '--pdf': opts.format = 'pdf'; break;
      case '--portrait': opts.orientation = 'portrait'; break;
      case '--landscape': opts.orientation = 'landscape'; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      case '--force': opts.force = true; break;
      case '--json': opts.json = true; break;
      case '-o': case '--output': opts.output = argv[++i]; break;
      case '--width': opts.width = Number(argv[++i]); break;
      case '--scale': opts.scale = Number(argv[++i]); break;
      case '--size': opts.size = argv[++i]; break;
      case '--view': opts.view = argv[++i]; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        rest.push(arg);
    }
  }

  const [command, input] = rest;
  if (command === 'render' || command === 'report' || command === 'check') {
    opts.command = command;
    opts.input = input;
  } else if (command) {
    throw new Error(`unknown command "${command}"`);
  }
  return opts;
}

/** How many error-severity findings a processed study carries. */
function errorCount(result: ReturnType<typeof processStudy>): number {
  return [...result.parseErrors, ...result.diagnostics]
    .filter((d) => d.severity === 'error').length;
}

function formatDiagnostic(d: Diagnostic, file: string): string {
  return `${file}:${d.line}:${d.column}: ${d.severity}: ${d.code}: ${d.message}`;
}

function defaultOutput(input: string, format: Format): string {
  const stem = basename(input, extname(input));
  return `${stem}.${format}`;
}

/**
 * The `view` a render should draw, as render options.
 *
 * A study may declare several sheets and there is no multi-page output,
 * so the one drawn has to be selectable without the playground:
 * `--view` by name, else the sheet marked `default = true`, else the
 * first declared. An unknown name is an error rather than a silent
 * fall back to the first -- the whole point of asking was to get a
 * particular sheet.
 */
function selectedView(
  result: ReturnType<typeof processStudy>,
  wanted: string | undefined,
): { view?: import('./parser/index.js').ViewBlock } {
  const views = result.study?.views ?? [];
  if (!wanted) return {};

  const found = views.find((v, i) => (v.name ?? `Sheet ${i + 1}`) === wanted);
  if (!found) {
    const names = views.map((v, i) => v.name ?? `Sheet ${i + 1}`);
    throw new Error(
      `no view named "${wanted}"; this study declares ${names.length > 0 ? names.map((n) => `"${n}"`).join(', ') : 'none'}`,
    );
  }
  return { view: found };
}

export async function main(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`tc-curves: ${(error as Error).message}`);
    console.error(USAGE);
    return 2;
  }

  if (opts.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!opts.input) {
    console.error('tc-curves: no input file given');
    console.error(USAGE);
    return 2;
  }

  const inputPath = resolvePath(opts.input);
  let source: string;
  try {
    source = await readFile(inputPath, 'utf8');
  } catch (error) {
    console.error(`tc-curves: cannot read ${opts.input}: ${(error as Error).message}`);
    return 2;
  }

  const result = processStudy(source);

  /* Parse errors first -- nothing downstream is trustworthy without a
   * document, so report and stop. */
  for (const e of result.parseErrors) {
    console.error(`${opts.input}:${e.line}:${e.column}: ${e.severity}: ${e.code}: ${e.message}`);
  }
  if (!result.document) {
    console.error('tc-curves: the source did not parse');
    return 2;
  }

  for (const d of result.diagnostics) {
    const line = formatDiagnostic(d, opts.input);
    if (d.severity === 'error') console.error(line);
    else if (!opts.quiet) console.error(line);
  }

  const hasErrors =
    result.parseErrors.some((e) => e.severity === 'error') ||
    result.diagnostics.some((d) => d.severity === 'error');

  /*
   * A study can be perfectly well-formed and not coordinate. That is
   * the answer the study exists to produce, and until now it left by
   * the same door as success: `check` on a study reporting
   * "overall: FAIL (worst -0.310 s)" exited 0, so a CI job gating on
   * this tool was gating on syntax while believing it gated on grading.
   */
  const gradingFails = anyGradeFails(result.reports);
  const status = hasErrors ? 1 : gradingFails ? 3 : 0;

  if (opts.json && (opts.command === 'check' || opts.command === 'report')) {
    console.log(JSON.stringify(jsonResult(opts.input ?? '', result), null, 2));
    return status;
  }

  if (opts.command === 'check') {
    if (!hasErrors && !opts.quiet) {
      console.log(gradingFails
        ? `${opts.input}: no errors, but grading fails -- run report for the detail`
        : `${opts.input}: no errors`);
    }
    return status;
  }

  if (opts.command === 'report') {
    console.log(formatGradeReports(result.reports));
    return status;
  }

  /* ---- render ----------------------------------------------------- */

  /*
   * A study with errors does not get drawn.
   *
   * It used to: the diagnostics went to stderr, the exit status was 1,
   * and the sheet was written anyway -- built on whatever the broken
   * settings defaulted to. A `tsm` typo left the multiplier at 1.0 and
   * produced a perfectly plausible drawing with nothing on it saying
   * so, and that file is what gets attached to an email. The exit
   * status is no protection: nobody reads it, and the file outlives the
   * shell that produced it.
   *
   * `--force` is there for the case where you want to look at what the
   * broken study draws. It says so on the sheet.
   */
  if (hasErrors && !opts.force) {
    console.error(
      `tc-curves: ${opts.input} has errors; no sheet written. `
      + 'Fix them, or pass --force to draw it anyway.',
    );
    return 1;
  }

  /*
   * A PDF is printed and filed, so it is always rendered light,
   * whatever the study's `page { theme }` says. SVG and PNG honour the
   * declared theme -- they may be embedded in a dark document.
   */
  /*
   * `--view` naming a sheet the study does not declare is a usage
   * error, and `main` answers usage errors with a status rather than
   * an exception -- the usage text promises a status for every path,
   * and an embedder calling `main` should not have to catch.
   */
  let chosen: ReturnType<typeof selectedView>;
  try {
    chosen = selectedView(result, opts.view);
  } catch (error) {
    console.error(`tc-curves: ${(error as Error).message}`);
    return 2;
  }

  let svg = opts.format === 'pdf'
    ? renderStudy(result, { theme: 'light', ...chosen })
    : renderStudy(result, chosen);

  /*
   * A forced sheet says so on its face.
   *
   * `--force` exists to let someone look at what a broken study draws,
   * and the moment it is a file it is indistinguishable from a good
   * one. Stamped, it cannot be issued by accident -- which is the only
   * reason refusing to write was worth doing.
   */
  if (hasErrors && opts.force) {
    const count = errorCount(result);
    svg = svg.replace('</svg>',
      '<g pointer-events="none">'
      + '<rect x="0" y="0" width="100%" height="26" fill="#c0392b"/>'
      + '<text x="12" y="18" font-size="13" font-weight="700" fill="#ffffff">'
      + `DRAWN FROM A STUDY WITH ${count} ERROR${count === 1 ? '' : 'S'} — NOT VALID`
      + '</text></g></svg>');
  }
  const outputPath = resolvePath(opts.output ?? defaultOutput(opts.input, opts.format));

  try {
    if (opts.format === 'svg') {
      await writeFile(outputPath, toExportableSvg(svg, { xmlProlog: true }), 'utf8');
    } else if (opts.format === 'png') {
      const png = await exportPng(svg, { width: opts.width, scale: opts.scale });
      await writeFile(outputPath, png);
    } else {
      const page = result.study?.page;
      const pdf = await exportPdf(svg, {
        size: opts.size ?? (typeof page?.size === 'string' ? page.size : undefined),
        orientation: opts.orientation ?? page?.orientation ?? 'landscape',
        margins_mm: page?.margins_mm,
      });
      await writeFile(outputPath, pdf);
    }
  } catch (error) {
    console.error(`tc-curves: ${opts.format.toUpperCase()} export failed: ${(error as Error).message}`);
    return 2;
  }

  if (!opts.quiet) {
    console.error(`tc-curves: wrote ${outputPath}`);
    if (result.reports.length > 0) console.log(formatGradeReports(result.reports));
  }

  return hasErrors ? 1 : 0;
}

/*
 * Run only when this file *is* the program.
 *
 * Imported -- by a test, or by anything embedding the CLI -- it must
 * not start rendering somebody's arguments as a side effect of the
 * import. `main` and `parseArgs` are exported so both can be exercised
 * directly, which is the only way this file gets tested at all.
 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(`tc-curves: ${(error as Error).message}`);
      process.exitCode = 2;
    });
}
