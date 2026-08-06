/**
 * The machine-readable form of a processed study.
 *
 * Everything the tool knows was reachable only as formatted text: a
 * settings-management system, an asset register or a CI annotation had
 * to scrape a monospace report whose alignment is a presentation
 * decision. `GradeReport` was already a clean structured type; this
 * gives it a door.
 *
 * It lives in the library rather than in the CLI because the shape is
 * a contract other tools will hold us to, and because the playground
 * needs the same one -- the two surfaces must agree about what a study
 * says, and the way to guarantee that is for them to call the same
 * function rather than to describe the same thing twice.
 *
 * Two rules for anything added here:
 *
 *   - Name the units in the key, as the language does: `margin_s`,
 *     `at_A`. A bare number in an interchange format is an invitation
 *     to guess.
 *   - Emit the verdict from `verdictOf`, never a bare `pass` boolean.
 *     "Not evaluated" is a real state and it is not a kind of failure.
 */

import type { Diagnostic } from './validate.js';
import type { ParseError } from '../parser/index.js';
import { verdictOf, type GradeReport, type Verdict } from './grades.js';
import type { Study } from './model.js';

/** Schema version, bumped when a consumer would need to care. */
export const JSON_REPORT_VERSION = 1;

export interface JsonDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column: number;
}

export interface JsonGrade {
  primary: string;
  backup: string;
  condition?: string;
  verdict: Verdict;
  required_margin_s?: number;
  worst_margin_s?: number;
  worst_margin_at_A?: number;
  swept_to_A?: number;
  solved?: { tms?: number; I_pickup_A?: number; ok: boolean };
  diagnostics: Array<{ code: string; severity: string; message: string }>;
}

export interface JsonResult {
  version: number;
  source?: string;
  study?: { project?: string; title?: string; revision?: string };
  ok: boolean;
  /** `pass` when every grade that could be judged coordinated. */
  grading: Verdict;
  counts: { errors: number; warnings: number; infos: number };
  diagnostics: JsonDiagnostic[];
  grades: JsonGrade[];
}

export interface ProcessedLike {
  study?: Study | null;
  parseErrors: ParseError[];
  diagnostics: Diagnostic[];
  reports: GradeReport[];
}

/**
 * Rounded, for the same reason the SVG's numbers are.
 *
 * These are the results of `pow` and `log`, whose last bit is
 * implementation-defined -- so a study compared between two machines,
 * or before and after a Node upgrade, would show differences in the
 * sixteenth digit of a margin. A CI artefact that is diffed has to be
 * stable, and a margin quoted to the nanosecond was never meaningful.
 */
const round = (v: number | undefined, dp: number): number | undefined =>
  v == null || !Number.isFinite(v) ? undefined : Number(v.toFixed(dp));

/** Times to the microsecond. */
const seconds = (v: number | undefined): number | undefined => round(v, 6);
/** Currents to the milliamp. */
const amps = (v: number | undefined): number | undefined => round(v, 3);

const severityOf = (d: { severity?: string }): 'error' | 'warning' | 'info' =>
  d.severity === 'warning' ? 'warning' : d.severity === 'info' ? 'info' : 'error';

/**
 * The overall grading verdict.
 *
 * `fail` if any grade failed; otherwise `pass` if at least one was
 * actually judged; otherwise `unevaluated`. A study with no gradeable
 * pair has not passed anything, and saying it did would be the same
 * over-claim as calling an unevaluated pair a failure.
 */
function overallVerdict(reports: readonly GradeReport[]): Verdict {
  let judged = false;
  for (const r of reports) {
    const v = verdictOf(r);
    if (v === 'fail') return 'fail';
    if (v === 'pass') judged = true;
  }
  return judged ? 'pass' : 'unevaluated';
}

export function jsonResult(
  source: string,
  result: ProcessedLike,
  extra: { study?: Study | null } = {},
): JsonResult {
  const all: JsonDiagnostic[] = [
    ...result.parseErrors.map((e) => ({
      code: (e as unknown as { code?: string }).code ?? 'PARSE_ERROR',
      severity: severityOf(e as unknown as { severity?: string }),
      message: e.message,
      line: e.line,
      column: e.column,
    })),
    ...result.diagnostics.map((d) => ({
      code: d.code,
      severity: severityOf(d),
      message: d.message,
      line: d.line,
      column: d.column,
    })),
  ];

  const counts = {
    errors: all.filter((d) => d.severity === 'error').length,
    warnings: all.filter((d) => d.severity === 'warning').length,
    infos: all.filter((d) => d.severity === 'info').length,
  };

  const study = extra.study ?? result.study ?? undefined;
  const meta = study?.meta ?? {};

  return {
    version: JSON_REPORT_VERSION,
    source: source || undefined,
    study: {
      project: typeof meta.project === 'string' ? meta.project : undefined,
      title: typeof meta.study === 'string' ? meta.study : undefined,
      revision: typeof meta.revision === 'string' ? meta.revision : undefined,
    },
    ok: counts.errors === 0,
    grading: overallVerdict(result.reports),
    counts,
    diagnostics: all,
    grades: result.reports.map((r) => ({
      primary: r.primaryRef,
      backup: r.backupRef,
      condition: r.fault,
      verdict: verdictOf(r),
      required_margin_s: seconds(r.CTI_min_s ?? r.margin_s),
      worst_margin_s: seconds(r.min_margin_s),
      worst_margin_at_A: amps(r.min_margin_at_A),
      swept_to_A: amps(r.upstream_to_A),
      solved: r.solve
        ? { tms: round(r.solve.tms, 6), I_pickup_A: amps(r.solve.I_pu_A), ok: r.solve.ok }
        : undefined,
      diagnostics: r.diagnostics.map((d) => ({
        code: d.code, severity: d.severity, message: d.message,
      })),
    })),
  };
}
