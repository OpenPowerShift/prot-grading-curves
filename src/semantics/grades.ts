/**
 * Grading margin report.
 *
 * Turns each `grade { ... }` block into the table an engineer signs
 * off on: operate times for the primary and the backup at the declared
 * fault, the margin between them, and whether that margin satisfies
 * the declared intent.
 *
 * The two intents are distinct and are reported separately (spec:
 * _Margin target vs CTI minimum_):
 *
 *   CTI_min_s  a *constraint* -- at least this much margin at every
 *              current in the fault's range. Pass/fail.
 *   margin_s   a *target* at the one declared fault current. Reported
 *              as a gap; only acted on when a `solve` block says so.
 */

import { tTripFlex } from './curves.js';
import { solveGrade, type SolveResult } from './solver.js';
import { controllingStage, tTripElement } from './stages.js';
import { faultCurrentAt } from './xvoltage.js';
import { resolveRef, type Device, type Element, type Fault, type Grade, type Study } from './model.js';

export interface MarginRow {
  /**
   * Which point this row evaluates: the declared fault current, the
   * ends of its declared range, or a sample from the upstream sweep.
   */
  at: 'I' | 'min' | 'max' | 'upstream';
  /** Fault current as the *primary* measures it, primary amps. */
  I_f_A: number;
  /**
   * Fault current as the *backup* measures it. Differs from `I_f_A`
   * whenever the pair spans a transformer.
   */
  I_backup_A: number;
  t_primary_s: number;
  t_backup_s: number;
  margin_s: number;
  /** Multiple seen by each side, for the report's `(M = ...)` column. */
  M_primary?: number;
  M_backup?: number;
  /** Only set when `CTI_min_s` is declared. */
  pass?: boolean;
}

export interface GradeReport {
  primaryRef: string;
  backupRef: string;
  fault?: string;
  fault_voltage?: string;
  CTI_min_s?: number;
  margin_s?: number;
  tolerance_pct?: number;
  rows: MarginRow[];
  /** Worst margin across the evaluated range. */
  min_margin_s?: number;
  /** Current at which `min_margin_s` occurred. */
  min_margin_at_A?: number;
  /** Overall pass/fail; undefined when no `CTI_min_s` constraint. */
  pass?: boolean;
  /** Margin achieved at the single declared fault current. */
  achieved_margin_s?: number;
  /** Ceiling actually used for the upstream sweep, when one ran. */
  upstream_to_A?: number;
  solve?: SolveResult;
  /** Non-fatal problems that stopped part of the report computing. */
  diagnostics: Array<{ code: string; message: string; severity: 'error' | 'warning' | 'info' }>;
}

/** A gradeable side: a relay element, or a device such as a fuse. */
interface Side {
  ref: string;
  element?: Element;
  device?: Device;
  voltage?: string;
  tAt: (I_A: number) => number;
}

function sideFor(study: Study, ref: Grade['primary'], role: 'primary' | 'backup'): Side | undefined {
  const { element, device } = resolveRef(study, ref);
  if (element) {
    return {
      ref: element.ref,
      element,
      voltage: element.voltage,
      tAt: (I: number) => tTripElement(element, I),
    };
  }
  if (device) {
    /*
     * A fuse grades on its *total clear* time when it is the primary
     * (it must be fully clear before the backup starts), and on its
     * *minimum melt* time when it is the backup (it must not have
     * begun to melt). Spec: _Fuse semantics_.
     */
    const points =
      role === 'primary'
        ? device.total_clear ?? device.flex_points ?? device.min_melt
        : device.min_melt ?? device.flex_points ?? device.total_clear;
    return {
      ref: device.id,
      device,
      tAt: (I: number) =>
        points ? tTripFlex(I, points) : device.t_delay_s ?? Infinity,
    };
  }
  return undefined;
}

/**
 * Ratio that converts a current in the primary's frame to the
 * backup's. 1 when both sit on the same level.
 */
function backupRatio(
  study: Study,
  fault: Fault,
  primaryVoltage: string | undefined,
  backupVoltage: string | undefined,
): number {
  const atPrimary = faultCurrentAt(study, fault, primaryVoltage, 'I').I_A;
  const atBackup = faultCurrentAt(study, fault, backupVoltage, 'I').I_A;
  return atPrimary > 0 ? atBackup / atPrimary : 1;
}

/**
 * How far up the curve the upstream sweep should run.
 *
 * An explicit `upstream_to` wins. Otherwise the ceiling is the largest
 * fault declared anywhere in the study (referred to the primary's
 * frame) -- that is the most severe current the study contemplates --
 * with a floor of 20x the primary's pick-up so a study whose faults
 * are all modest still gets a meaningful sweep.
 */
function upstreamCeiling(
  study: Study,
  grade: Grade,
  primary: Side,
  from: number,
): number {
  if (grade.upstream_to_A != null && Number.isFinite(grade.upstream_to_A)) {
    return grade.upstream_to_A;
  }

  let largest = from;
  for (const f of study.faults.values()) {
    const projected = faultCurrentAt(study, f, primary.voltage, 'max').I_A;
    if (Number.isFinite(projected) && projected > largest) largest = projected;
  }

  const stage = primary.element ? primary.element.stages[0] : undefined;
  const byPickup = stage?.I_pu_A != null ? stage.I_pu_A * 20 : 0;
  return Math.max(largest, byPickup, from * 2);
}

function multipleOf(side: Side, I_A: number): number | undefined {
  if (!side.element) return undefined;
  const stage = controllingStage(side.element, I_A);
  const I_pu = stage?.I_pu_A;
  if (I_pu == null || !(I_pu > 0)) return undefined;
  return (I_A * ((stage?.current_pct ?? 100) / 100)) / I_pu;
}

/** Build the margin report for one `grade` block. */
export function reportGrade(study: Study, grade: Grade): GradeReport {
  const diagnostics: GradeReport['diagnostics'] = [];
  const primary = sideFor(study, grade.primary, 'primary');
  const backup = sideFor(study, grade.backup, 'backup');

  const report: GradeReport = {
    primaryRef: primary?.ref ?? grade.primary?.text ?? '?',
    backupRef: backup?.ref ?? grade.backup?.text ?? '?',
    fault: grade.fault,
    CTI_min_s: grade.CTI_min_s,
    margin_s: grade.margin_s,
    tolerance_pct: grade.tolerance_pct ?? grade.solve?.tolerance_pct,
    rows: [],
    diagnostics,
  };

  if (!primary) {
    diagnostics.push({
      code: 'UNRESOLVED_REFERENCE',
      severity: 'error',
      message: `grade primary "${grade.primary?.text ?? ''}" does not resolve to a relay element or device`,
    });
  }
  if (!backup) {
    diagnostics.push({
      code: 'UNRESOLVED_REFERENCE',
      severity: 'error',
      message: `grade backup "${grade.backup?.text ?? ''}" does not resolve to a relay element or device`,
    });
  }
  if (!primary || !backup) return report;

  if (!grade.fault) {
    diagnostics.push({
      code: 'FAULT_OPTIONAL_NO_GRADE_CHECK',
      severity: 'warning',
      message: 'grade block has no `fault`; the curves render but no margin is computed',
    });
    return report;
  }

  const fault: Fault | undefined = study.faults.get(grade.fault);
  if (!fault) {
    diagnostics.push({
      code: 'UNRESOLVED_REFERENCE',
      severity: 'error',
      message: `grade references fault "${grade.fault}", which is not declared in faults { ... }`,
    });
    return report;
  }
  report.fault_voltage = fault.voltage;

  if (!fault.voltage && study.voltages.size > 1) {
    diagnostics.push({
      code: 'FAULT_VOLTAGE_UNSPECIFIED',
      severity: 'error',
      message: `fault "${fault.name}" has no voltage level, but the study declares several`,
    });
  }

  /*
   * Each side is evaluated at the current *it* measures.
   *
   * One fault, but not one current: across a transformer the two
   * windings carry different currents for the same event, in inverse
   * proportion to their voltages. A 6.4 kA fault on an 11 kV bus puts
   * 2.13 kA through the 33 kV winding, so the incomer's multiple must
   * be computed from 2.13 kA against its own HV pickup. Dividing the
   * LV current by the HV pickup mixes frames and materially
   * *understates* the backup's operate time -- i.e. it reports a
   * margin that does not exist.
   *
   * Times are what get compared, and a time is frame-independent, so
   * the margin itself needs no conversion once each side is evaluated
   * correctly.
   */
  const endpoints: Array<'I' | 'min' | 'max'> =
    fault.min_A === fault.I_A && fault.max_A === fault.I_A ? ['I'] : ['I', 'min', 'max'];

  for (const at of endpoints) {
    const atPrimary = faultCurrentAt(study, fault, primary.voltage, at);
    const atBackup = faultCurrentAt(study, fault, backup.voltage, at);
    for (const projection of [atPrimary, atBackup]) {
      if (projection.warning) {
        diagnostics.push({ code: 'VOLTAGE_RATIO_UNRESOLVED', severity: 'error', message: projection.warning });
      }
    }
    const I_p = atPrimary.I_A;
    const I_b = atBackup.I_A;
    const t_p = primary.tAt(I_p);
    const t_b = backup.tAt(I_b);
    const row: MarginRow = {
      at,
      I_f_A: I_p,
      I_backup_A: I_b,
      t_primary_s: t_p,
      t_backup_s: t_b,
      margin_s: t_b - t_p,
      M_primary: multipleOf(primary, I_p),
      M_backup: multipleOf(backup, I_b),
    };
    if (grade.CTI_min_s != null) row.pass = row.margin_s >= grade.CTI_min_s;
    report.rows.push(row);
  }

  /*
   * Upstream sweep.
   *
   * A pair that grades at the declared fault can still fail above it:
   * the two characteristics converge as the multiple rises, and an
   * instantaneous stage on the backup can undercut the primary
   * entirely. Checking only the declared points hides that, so
   * `upstream = true` sweeps from the fault up to the largest current
   * worth examining and reports the worst point found.
   */
  if (grade.upstream || grade.upstream_to_A != null) {
    const from = faultCurrentAt(study, fault, primary.voltage, 'max').I_A;
    const to = upstreamCeiling(study, grade, primary, from);
    if (to > from) {
      const samples = 48;
      const lo = Math.log(from);
      const hi = Math.log(to);
      /* Skip i = 0: that point is already covered by the declared rows. */
      for (let i = 1; i <= samples; i++) {
        const I_p = Math.exp(lo + (i / samples) * (hi - lo));
        const I_b = I_p * backupRatio(study, fault, primary.voltage, backup.voltage);
        const t_p = primary.tAt(I_p);
        const t_b = backup.tAt(I_b);
        if (!Number.isFinite(t_p) && !Number.isFinite(t_b)) continue;
        const row: MarginRow = {
          at: 'upstream',
          I_f_A: I_p,
          I_backup_A: I_b,
          t_primary_s: t_p,
          t_backup_s: t_b,
          margin_s: t_b - t_p,
          M_primary: multipleOf(primary, I_p),
          M_backup: multipleOf(backup, I_b),
        };
        if (grade.CTI_min_s != null) row.pass = row.margin_s >= grade.CTI_min_s;
        report.rows.push(row);
      }
      report.upstream_to_A = to;
    } else {
      diagnostics.push({
        code: 'UPSTREAM_RANGE_EMPTY',
        severity: 'warning',
        message:
          `upstream sweep ceiling (${to.toFixed(0)} A) is not above the declared fault ` +
          `(${from.toFixed(0)} A); nothing to sweep`,
      });
    }
  }

  const declaredRow = report.rows.find((r) => r.at === 'I');
  report.achieved_margin_s = declaredRow?.margin_s;

  const finite = report.rows.filter((r) => Number.isFinite(r.margin_s));
  if (finite.length > 0) {
    const worst = finite.reduce((a, b) => (b.margin_s < a.margin_s ? b : a));
    report.min_margin_s = worst.margin_s;
    report.min_margin_at_A = worst.I_f_A;
    if (grade.CTI_min_s != null) report.pass = worst.margin_s >= grade.CTI_min_s;
  } else if (grade.CTI_min_s != null) {
    report.pass = false;
    diagnostics.push({
      code: 'NO_OPERATION',
      severity: 'warning',
      message: 'neither side operates at the declared fault current; no margin could be computed',
    });
  }

  /* ---- solver ---------------------------------------------------- */

  if (grade.solve && declaredRow) {
    if (grade.margin_s == null && grade.CTI_min_s == null) {
      diagnostics.push({
        code: 'SOLVE_WITHOUT_TARGET',
        severity: 'error',
        message: 'solve block declared with neither margin_s nor CTI_min_s to aim at',
      });
    } else if (!backup.element) {
      diagnostics.push({
        code: 'SOLVER_READONLY_DEVICE',
        severity: 'warning',
        message: `backup "${backup.ref}" is a device; its published curve is not adjustable`,
      });
    } else if (!Number.isFinite(declaredRow.t_primary_s)) {
      diagnostics.push({
        code: 'SOLVER_NO_PRIMARY_OPERATION',
        severity: 'warning',
        message: `primary ${primary.ref} does not operate at ${declaredRow.I_f_A.toFixed(0)} A; nothing to grade against`,
      });
    } else {
      const primaryStage = primary.element
        ? controllingStage(primary.element, declaredRow.I_f_A)
        : undefined;

      /*
       * The pickup-discrimination floor (IEEE 242 §15.3.2) compares two
       * pickups, so both have to be in one frame before they can be
       * compared. Refer the primary's pickup to the backup's level.
       */
      const ratioToBackup = declaredRow.I_f_A > 0
        ? declaredRow.I_backup_A / declaredRow.I_f_A
        : 1;
      const I_pu_primary_at_backup = primaryStage?.I_pu_A != null
        ? primaryStage.I_pu_A * ratioToBackup
        : undefined;

      const result = solveGrade({
        backup: backup.element,
        t_primary_s: declaredRow.t_primary_s,
        margin_s: grade.margin_s ?? grade.CTI_min_s!,
        /* The solver works in the backup's own frame. */
        I_f_A: declaredRow.I_backup_A,
        strategy: grade.solve.strategy,
        tolerance_pct: grade.solve.tolerance_pct ?? grade.tolerance_pct,
        free: grade.solve.free,
        I_pu_primary_A: I_pu_primary_at_backup,
      });
      report.solve = result;
      if (!result.ok && result.code) {
        diagnostics.push({
          code: result.code,
          severity: result.code === 'SOLVER_NO_IDMT_STAGE' ? 'warning' : 'warning',
          message: result.message ?? 'solver could not meet the declared target',
        });
      }
      if (result.ok && result.tms != null && result.stage) {
        /*
         * The solved value is recorded on the model (not the source
         * text) so the renderer can label the curve `tms=... (auto)`.
         */
        result.stage.tms = result.tms;
        result.stage.tms_auto = true;
        if (result.I_pu_A != null) result.stage.I_pu_A = result.I_pu_A;

        /* Recompute the rows now that the backup has moved, still in
         * the backup's own frame. */
        for (const row of report.rows) {
          row.t_backup_s = backup.tAt(row.I_backup_A);
          row.margin_s = row.t_backup_s - row.t_primary_s;
          row.M_backup = multipleOf(backup, row.I_backup_A);
          if (grade.CTI_min_s != null) row.pass = row.margin_s >= grade.CTI_min_s;
        }
        const after = report.rows.filter((r) => Number.isFinite(r.margin_s));
        if (after.length > 0) {
          const worst = after.reduce((a, b) => (b.margin_s < a.margin_s ? b : a));
          report.min_margin_s = worst.margin_s;
          report.min_margin_at_A = worst.I_f_A;
          if (grade.CTI_min_s != null) report.pass = worst.margin_s >= grade.CTI_min_s;
        }
        report.achieved_margin_s = report.rows.find((r) => r.at === 'I')?.margin_s;
      }
    }
  } else if (grade.margin_s != null && !grade.solve) {
    diagnostics.push({
      code: 'MARGIN_NO_SOLVE',
      severity: 'warning',
      message:
        'margin_s is declared without a solve block; it is reported as a target only. ' +
        'Add solve { ... } to have the tool meet it, or use CTI_min_s for a constraint',
    });
  }

  return report;
}

/** Margin reports for every `grade` block in the study, in source order. */
export function reportGrades(study: Study): GradeReport[] {
  return study.grades.map((g) => reportGrade(study, g));
}

/* ------------------------------------------------------------------ */
/* Text rendering                                                      */
/* ------------------------------------------------------------------ */

const s3 = (n: number | undefined): string =>
  n == null ? '--' : Number.isFinite(n) ? n.toFixed(3) : 'no-op';

/**
 * Render one report in the console form shown in the spec
 * (_Reporting_ / _Unsatisfiable targets_). This is what the CLI's
 * `--report` prints and what the playground shows in its report pane.
 */
export function formatGradeReport(report: GradeReport): string {
  const out: string[] = [];
  const head = `grade ${report.primaryRef} / ${report.backupRef}`;

  if (report.solve && !report.solve.ok && report.solve.unsatisfiable) {
    const u = report.solve.unsatisfiable;
    const row = report.rows.find((r) => r.at === 'I');
    out.push(`${head} unsatisfiable:`);
    out.push(`    target margin ${s3(report.margin_s)} s at I_f = ${row ? row.I_f_A.toFixed(0) : '?'} A`);
    out.push(`    primary t_p = ${s3(row?.t_primary_s)} s`);
    out.push(`    required TMS = ${u.required_tms.toFixed(3)}`);
    out.push(`    -- fallback: increase tms backup to maximum allowed`);
    out.push(
      `       (TMS_max = ${u.tms_max.toFixed(3)} gives t_b = ${s3(u.t_backup_at_max_s)} s, ` +
      `margin = ${s3(u.margin_at_max_s)} s)`,
    );
    out.push('    -- suggested next:');
    u.suggestions.forEach((sug, i) => out.push(`       ${i + 1}. ${sug}`));
    return out.join('\n');
  }

  out.push(`${head}:`);

  const declared = report.rows.find((r) => r.at === 'I');
  if (report.fault && declared) {
    const where = report.fault_voltage ? ` on ${report.fault_voltage}` : '';
    out.push(`    fault           = ${report.fault} (I_f = ${declared.I_f_A.toFixed(0)} A${where})`);
  } else if (!report.fault) {
    out.push('    fault           = (none declared -- no margin computed)');
    return out.join('\n');
  }

  if (report.CTI_min_s != null) out.push(`    CTI_min         = ${s3(report.CTI_min_s)} s`);
  if (report.margin_s != null) out.push(`    target margin   = ${s3(report.margin_s)} s`);

  if (declared) {
    /*
     * When the pair spans a transformer the two sides measure
     * different currents, so both are shown -- otherwise the operate
     * times look inconsistent with the single quoted fault current.
     */
    const crossVoltage = Math.abs(declared.I_backup_A - declared.I_f_A) > 1e-6;
    if (crossVoltage) {
      out.push(
        `    seen by primary = ${declared.I_f_A.toFixed(0)} A` +
        `    seen by backup = ${declared.I_backup_A.toFixed(0)} A`,
      );
    }

    const mP = declared.M_primary != null ? `        (M = ${declared.M_primary.toFixed(2)})` : '';
    const mB = declared.M_backup != null ? `        (M = ${declared.M_backup.toFixed(2)})` : '';
    out.push(`    t_primary       = ${s3(declared.t_primary_s)} s${mP}`);

    const solve = report.solve;
    if (solve?.ok && solve.tms != null) {
      const tol = report.tolerance_pct ?? 0;
      out.push(
        `    t_backup_auto   = ${s3(declared.t_backup_s)} s        ` +
        `(TMS_b = ${solve.tms.toFixed(3)}  auto, tight, tol ${tol}%)`,
      );
    } else {
      out.push(`    t_backup        = ${s3(declared.t_backup_s)} s${mB}`);
    }

    /*
     * This line is about the *declared* point, so it carries that
     * point's own verdict. The study-wide verdict, which also folds in
     * the range and upstream sweeps, is reported separately below --
     * conflating them made a passing point read as a failure.
     */
    const verdict =
      report.solve?.ok
        ? report.solve.within_tolerance
          ? `-- within tolerance (${(report.tolerance_pct ?? 0).toFixed(1)} %)`
          : '-- outside tolerance'
        : declared.pass == null
          ? ''
          : declared.pass ? '-- pass' : '-- FAIL';
    out.push(`    achieved margin = ${s3(declared.margin_s)} s        ${verdict}`.trimEnd());
  }

  /*
   * Upstream sweep: report the *worst* point rather than all 48
   * samples -- the interesting fact is where grading is tightest, and
   * a wall of rows buries it.
   */
  const upstream = report.rows.filter((r) => r.at === 'upstream');
  if (upstream.length > 0) {
    const finite = upstream.filter((r) => Number.isFinite(r.margin_s));
    out.push(
      `    upstream sweep  : to ${report.upstream_to_A?.toFixed(0) ?? '?'} A` +
      ` (${upstream.length} points)`,
    );
    if (finite.length === 0) {
      out.push('        neither side operates across the swept range');
    } else {
      const worst = finite.reduce((a, b) => (b.margin_s < a.margin_s ? b : a));
      const flag = worst.pass == null ? '' : worst.pass ? '  pass' : '  FAIL';
      out.push(
        `        tightest at I_f = ${worst.I_f_A.toFixed(0)} A  ` +
        `t_p = ${s3(worst.t_primary_s)} s  ` +
        `t_b = ${s3(worst.t_backup_s)} s  ` +
        `margin = ${s3(worst.margin_s)} s${flag}`,
      );
      const failures = finite.filter((r) => r.pass === false).length;
      if (failures > 0) {
        out.push(`        ${failures} of ${finite.length} swept points fall below CTI_min`);
      }
    }
  }

  /* Range sweep, when the fault declares one. */
  const sweep = report.rows.filter((r) => r.at === 'min' || r.at === 'max');
  if (sweep.length > 0) {
    out.push('    range check:');
    for (const row of sweep) {
      const flag = row.pass == null ? '' : row.pass ? '  pass' : '  FAIL';
      const backupI = Math.abs(row.I_backup_A - row.I_f_A) > 1e-6
        ? ` (${row.I_backup_A.toFixed(0)} A at backup)`
        : '';
      out.push(
        `        I_f = ${row.I_f_A.toFixed(0).padStart(7)} A  ` +
        `t_p = ${s3(row.t_primary_s).padStart(7)} s  ` +
        `t_b = ${s3(row.t_backup_s).padStart(7)} s  ` +
        `margin = ${s3(row.margin_s).padStart(7)} s${flag}${backupI}`,
      );
    }
  }

  /* Study-wide verdict across every point evaluated. */
  if (report.CTI_min_s != null && report.pass != null) {
    const where = report.min_margin_at_A != null
      ? ` (worst ${s3(report.min_margin_s)} s at ${report.min_margin_at_A.toFixed(0)} A)`
      : '';
    out.push(`    overall         : ${report.pass ? 'PASS' : 'FAIL'}${where}`);
  }

  for (const d of report.diagnostics) {
    out.push(`    [${d.severity}] ${d.code}: ${d.message}`);
  }

  return out.join('\n');
}

/** The whole study's grading report as plain text. */
export function formatGradeReports(reports: GradeReport[]): string {
  if (reports.length === 0) return 'No grade blocks declared.';
  return reports.map(formatGradeReport).join('\n\n');
}
