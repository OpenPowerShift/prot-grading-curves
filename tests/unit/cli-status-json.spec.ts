/**
 * Telling a caller what happened, in a form it can act on.
 *
 * `check` exited 0 on a study whose report said
 * `overall : FAIL (worst -0.310 s)`, so a CI job gating on this tool
 * was gating on syntax while believing it gated on coordination -- the
 * one thing a coordination study exists to establish. And the only way
 * out of the tool was formatted text, so anything downstream had to
 * scrape a monospace report whose alignment is a presentation choice.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';
import { anyGradeFails, verdictOf } from '../../src/semantics/grades.js';
import { jsonResult, JSON_REPORT_VERSION } from '../../src/semantics/json-report.js';

const example = (name: string) => parse(readFileSync(`examples/${name}.ptc`, 'utf8'));

describe('the verdict', () => {
  it('is decided in one place, and the report agrees with it', () => {
    /*
     * `pass` was only set where a `margin` floor was declared, so a
     * pair graded against `margin_target` alone left it undefined while
     * the report printed PASS. Anything reading the field disagreed
     * with the text beside it -- which is how the first cut of the exit
     * status called Riverside a failure.
     */
    const riverside = example('01-riverside');
    expect(riverside.reports.length).toBeGreaterThan(0);
    for (const r of riverside.reports) expect(verdictOf(r)).toBe('pass');
    expect(anyGradeFails(riverside.reports)).toBe(false);
  });

  it('calls a genuine miscoordination a failure', () => {
    const bad = example('07-upstream-miscoordination');
    expect(anyGradeFails(bad.reports)).toBe(true);
  });

  it('distinguishes "not evaluated" from "failed"', () => {
    /*
     * Neither side operates at the current asked about, so there is no
     * margin to judge. Calling that a failure sends the reader looking
     * for a coordination problem when what they have is a settings or
     * fault-data problem somewhere else.
     */
    const result = parse(`
system { voltages { "MV" { V = 11 kV; } } }
faults { "Tiny" { I = 10 A; type = three_phase; voltage = "MV"; } }
relay R_DN { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
relay R_UP { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 600 A; tms = 0.3; } }
grade { primary = R_DN:51; backup = R_UP:51; fault = "Tiny"; margin = 0.3 s; }
view { voltage = "MV"; }
`);
    expect(verdictOf(result.reports[0])).toBe('unevaluated');
    expect(anyGradeFails(result.reports)).toBe(false);
  });
});

describe('the JSON result', () => {
  const json = jsonResult('examples/07-upstream-miscoordination.ptc',
    example('07-upstream-miscoordination'));

  it('is a versioned document', () => {
    expect(json.version).toBe(JSON_REPORT_VERSION);
  });

  it('separates "the file is sound" from "the study coordinates"', () => {
    /*
     * The distinction the exit status turns on. This study is
     * well-formed and does not coordinate, and a consumer has to be
     * able to see both facts at once.
     */
    expect(json.ok).toBe(true);
    expect(json.grading).toBe('fail');
  });

  it('carries each grade with the figures a reader would quote', () => {
    const grade = json.grades[0];
    expect(grade.primary).toBe('R_FEEDER:51');
    expect(grade.backup).toBe('R_INCOMER:51');
    expect(grade.verdict).toBe('fail');
    expect(grade.required_margin_s).toBeCloseTo(0.3, 6);
    expect(grade.worst_margin_s!).toBeLessThan(0);
    expect(grade.worst_margin_at_A!).toBeGreaterThan(10000);
  });

  it('names units in its keys', () => {
    /*
     * A bare number in an interchange format is an invitation to
     * guess, and the language itself refuses to carry an unmarked
     * quantity.
     */
    const numeric = Object.keys(json.grades[0])
      .filter((k) => typeof (json.grades[0] as Record<string, unknown>)[k] === 'number');
    for (const key of numeric) expect(key, key).toMatch(/_(s|A|pct)$/);
  });

  it('rounds, so two machines produce the same bytes', () => {
    /*
     * Margins come out of `pow` and `log`, whose last bit is
     * implementation-defined. A CI artefact that is diffed has to be
     * stable, and a margin quoted to the nanosecond was never
     * meaningful anyway.
     */
    const digits = (v: number): number => (String(v).split('.')[1] ?? '').length;
    expect(digits(json.grades[0].worst_margin_s!)).toBeLessThanOrEqual(6);
    expect(digits(json.grades[0].worst_margin_at_A!)).toBeLessThanOrEqual(3);
  });

  it('reports diagnostics with their positions', () => {
    for (const d of json.diagnostics) {
      expect(d.code).toBeTruthy();
      expect(['error', 'warning', 'info']).toContain(d.severity);
      expect(d.line).toBeGreaterThan(0);
    }
  });

  it('counts what it lists', () => {
    const bySeverity = (s: string) => json.diagnostics.filter((d) => d.severity === s).length;
    expect(json.counts.errors).toBe(bySeverity('error'));
    expect(json.counts.warnings).toBe(bySeverity('warning'));
    expect(json.counts.infos).toBe(bySeverity('info'));
  });

  it('does not claim a pass for a study with nothing to grade', () => {
    const bare = parse(`
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = "MV"; }
`);
    expect(jsonResult('bare', bare).grading).toBe('unevaluated');
  });
});
