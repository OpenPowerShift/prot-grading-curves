#!/usr/bin/env node
/**
 * `tc-curves` command-line interface.
 *
 * Renders a `.tc` study to SVG, PNG, or PDF, and prints the grading
 * margin report. Every format goes through the same library functions
 * the playground and the Asciidoctor extension call, so a study
 * rendered here is byte-identical to one rendered in the browser.
 *
 *   tc-curves render study.tc                  # SVG to study.svg
 *   tc-curves render study.tc --png -o out.png
 *   tc-curves render study.tc --pdf --size A3 --portrait
 *   tc-curves report study.tc                  # margin report only
 *   tc-curves check  study.tc                  # diagnostics only
 *
 * Exit status: 0 clean, 1 diagnostics of `error` severity, 2 usage or
 * I/O failure. `check` is therefore usable as a CI gate.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve as resolvePath } from 'node:path';
import { process as processStudy, renderStudy } from './index.js';
import { exportPng } from './export/export-png.js';
import { exportPdf } from './export/export-pdf.js';
import { toExportableSvg } from './export/exportable-svg.js';
import { formatGradeReports } from './semantics/grades.js';
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
}

const USAGE = `tc-curves -- render protection-relay time-current grading studies

Usage:
  tc-curves render <file.tc> [--svg|--png|--pdf] [options]
  tc-curves report <file.tc>
  tc-curves check  <file.tc>

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
  -q, --quiet           Suppress the margin report on stdout
  -h, --help            Show this message

Exit status: 0 clean, 1 validation errors, 2 usage or I/O failure.`;

function parseArgs(argv: string[]): Options {
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

async function main(argv: string[]): Promise<number> {
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

  if (opts.command === 'check') {
    if (!hasErrors && !opts.quiet) console.log(`${opts.input}: no errors`);
    return hasErrors ? 1 : 0;
  }

  if (opts.command === 'report') {
    console.log(formatGradeReports(result.reports));
    return hasErrors ? 1 : 0;
  }

  /* ---- render ----------------------------------------------------- */

  /*
   * A PDF is printed and filed, so it is always rendered light,
   * whatever the study's `page { theme }` says. SVG and PNG honour the
   * declared theme -- they may be embedded in a dark document.
   */
  const svg = opts.format === 'pdf'
    ? renderStudy(result, { theme: 'light', ...selectedView(result, opts.view) })
    : renderStudy(result, selectedView(result, opts.view));
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

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    console.error(`tc-curves: ${(error as Error).message}`);
    process.exitCode = 2;
  });
