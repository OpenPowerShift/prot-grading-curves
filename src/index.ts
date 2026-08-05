/**
 * Library entry for `@openpowershift/time-current-grading-language`.
 *
 * Exposes the parser, AST, constants, semantics, renderer, and export
 * functions so that the npm package, the Node CLI, the Asciidoctor
 * extension, and the browser playground all share one code path --
 * a study renders identically wherever it is processed.
 */

export * from './parser/index.js';
export * from './constants/index.js';
export * from './semantics/index.js';
export * from './renderer/index.js';
export * from './export/index.js';

import { parse } from './parser/index.js';
import { buildStudy, type Study } from './semantics/model.js';
import { validate, type Diagnostic } from './semantics/validate.js';
import { reportGrades, type GradeReport } from './semantics/grades.js';
import { renderSvg, type RenderOptions } from './renderer/svg.js';
import type { Document, ParseError } from './parser/ast.js';
import { sheetSize } from './renderer/sheet.js';

export { sheetSize } from './renderer/sheet.js';

export interface ProcessResult {
  document?: Document;
  study?: Study;
  /** Parse errors, in source order. */
  parseErrors: ParseError[];
  /** Semantic findings from the validator. */
  diagnostics: Diagnostic[];
  /** One margin report per `grade` block. */
  reports: GradeReport[];
}

/**
 * Parse, resolve, validate, and grade a `.ptc` source in one call.
 *
 * The solver runs as part of grading, so any `tms` it computes is
 * already recorded on the returned study by the time this returns --
 * which is why `renderStudy` below must be given the *same* study
 * object to draw the auto-solved curves.
 */
export function process(source: string): ProcessResult {
  const parsed = parse(source);
  if (!parsed.document) {
    return { parseErrors: parsed.errors, diagnostics: [], reports: [] };
  }
  const study = buildStudy(parsed.document);
  const reports = reportGrades(study);
  return {
    document: parsed.document,
    study,
    parseErrors: parsed.errors,
    diagnostics: validate(study, parsed.document),
    reports,
  };
}

/**
 * Parse and render in one call -- the entry point the Asciidoctor
 * extension and the CLI both wrap.
 */
export function parseAndRender(
  source: string,
  options?: Partial<RenderOptions>,
): { svg: string; result: ProcessResult } {
  const result = process(source);
  const svg = renderStudy(result, options);
  return { svg, result };
}

/** Render an already-processed study to SVG. */
export function renderStudy(
  result: ProcessResult,
  options?: Partial<RenderOptions>,
): string {
  const study = result.study;
  const faultsBlock = result.document?.items.find((i) => i.type === 'faults') ?? null;
  const systemBlock = result.document?.items.find((i) => i.type === 'system') ?? null;

  /*
   * A declared `page` gives the sheet its aspect ratio.
   *
   * Without this a portrait study still rendered on a landscape
   * canvas and was letterboxed into the page on export -- the plot
   * used a fraction of the paper it asked for. The caller can still
   * override by passing explicit dimensions, which is what the
   * playground does to fill its pane.
   */
  const { width, height } = sheetSize(study?.page ?? null);

  return renderSvg(result.document, {
    page: study?.page ?? null,
    system: (systemBlock as RenderOptions['system']) ?? null,
    faults: (faultsBlock as RenderOptions['faults']) ?? null,
    view: study?.view ?? null,
    /* The graded study carries any solver-computed settings. */
    study: study ?? null,
    width,
    height,
    ...options,
  });
}
