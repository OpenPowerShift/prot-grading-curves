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
import { controllingStage, cutoffOf, tTripElement } from './stages.js';
import { faultCurrentAt } from './xvoltage.js';
import {
  resolveCurrent,
  resolveRange,
  elementQuantity,
  quantityField,
  quantityLabel,
  survivesVoltageReferral,
  type MeasuredQuantity,
} from './quantity.js';
import {
  resolveRef,
  type Device, type Element, type Fault, type Grade, type Scenario, type Study,
} from './model.js';

export interface MarginRow {
  /**
   * Which point this row evaluates: the declared fault current, the
   * ends of its declared range, or a sample from the upstream sweep.
   */
  at: 'I' | 'min' | 'max' | 'range' | 'upstream';
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

/**
 * The verdict on one grade, decided once.
 *
 * `pass` is only set where the study declares a `margin` floor, so a
 * pair graded against `margin_target` alone left it undefined while the
 * report printed PASS -- and anything reading the field disagreed with
 * the report beside it. The CLI's exit status did exactly that.
 *
 * `unevaluated` is a third state and not a kind of failure. When
 * neither side operates at the current asked about there is no margin
 * to judge, and calling that "fail" sends the reader looking for a
 * coordination problem when what they have is a settings or fault-data
 * problem somewhere else.
 */
export type Verdict = 'pass' | 'fail' | 'unevaluated';

export function verdictOf(report: GradeReport): Verdict {
  const required = report.CTI_min_s ?? report.margin_s;
  if (required == null) return 'unevaluated';
  if (report.min_margin_s == null || !Number.isFinite(report.min_margin_s)) {
    return 'unevaluated';
  }
  return report.min_margin_s >= required ? 'pass' : 'fail';
}

/** True when any grade in a study was evaluated and did not coordinate. */
export function anyGradeFails(reports: readonly GradeReport[]): boolean {
  return reports.some((r) => verdictOf(r) === 'fail');
}

/** A gradeable side: a relay element, or a device such as a fuse. */
interface Side {
  ref: string;
  element?: Element;
  device?: Device;
  voltage?: string;
  tAt: (I_A: number) => number;
  /**
   * Current this side's pickup is expressed in.
   *
   * `null` for an element whose function requires the quantity to be
   * declared and does not; `'mixed'` when its stages disagree. A
   * device (a fuse, a cable damage curve) is a phase-current device.
   */
  measures: MeasuredQuantity | null | 'mixed';
  /**
   * The largest current at which this side still has a curve.
   *
   * `undefined` for a device and for an element that declared no
   * cutoff. A grade asked for at a current above it is refused rather
   * than answered.
   */
  cutoff_A?: number;
}

function sideFor(study: Study, ref: Grade['primary'], role: 'primary' | 'backup'): Side | undefined {
  const { element, device } = resolveRef(study, ref);
  if (element) {
    return {
      /*
       * A graded stage names itself. `resolveRef` has already narrowed
       * the element to it, so without this the row reads `R_A:51` while
       * the figures beside it are one stage's -- the same answer the
       * composite would give for a different reason, and no way to tell
       * the two apart.
       */
      ref: ref?.stageId ? `${element.ref}/${ref.stageId}` : element.ref,
      element,
      voltage: element.voltage,
      tAt: (I: number) => tTripElement(element, I),
      measures: elementQuantity(element.stages),
      cutoff_A: cutoffOf(element),
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
      /* A device sits on a level like a relay does, so a fuse graded
       * across a transformer is evaluated in its own winding's amps. */
      voltage: device.voltage,
      tAt: (I: number) =>
        points ? tTripFlex(I, points) : device.t_delay_s ?? Infinity,
      measures: 'phase',
    };
  }
  return undefined;
}

interface SideCurrent {
  I_A?: number;
  /**
   * True when the component came from the fault type's ratio table
   * rather than from a declared figure.
   *
   * A margin computed from a ratio is still a margin, but it rests on
   * an assumed fault shape rather than on measured data, and a reader
   * checking the report is entitled to know which they are looking at.
   */
  derived?: boolean;
  error?: { code: string; message: string };
}

/**
 * The current one side of a grade actually measures at a fault.
 *
 * Phase quantities are referred to the side's own level by the voltage
 * ratio, as before. A sequence quantity is taken from the fault's
 * declared components and is *not* invented: if the figure is absent,
 * or if reaching the side's level would mean referring zero sequence
 * across a transformer, the pair is reported rather than computed.
 * Substituting the phase current -- which is what happened before
 * `function` was read at all -- yields a well-formed margin for a
 * comparison that was never made.
 */
function sideCurrentAt(
  study: Study,
  fault: Fault,
  side: Side,
  at: 'I' | 'min' | 'max',
): SideCurrent {
  if (side.measures === null) {
    return {
      error: {
        code: 'MEASURES_REQUIRED',
        message:
          `${side.ref} has function "neg_seq" but does not declare which current its ` +
          'pickup is in; add measures = "I2" or measures = "3I2"',
      },
    };
  }
  if (side.measures === 'mixed') {
    return {
      error: {
        code: 'MEASURES_MIXED',
        message: `${side.ref} has stages measuring different currents, so it cannot be graded as one element`,
      },
    };
  }

  const quantity: MeasuredQuantity = side.measures;

  /* Phase current keeps the established path, ratio and all. */
  if (quantity === 'phase') {
    const projection = faultCurrentAt(study, fault, side.voltage, at);
    /*
     * A referral the windings do not settle is refused, not answered.
     *
     * The turns ratio is exact for a balanced fault and wrong for
     * every other kind across a delta-star, so producing the
     * unadjusted figure here would be the same silent 15.5% error
     * this check exists to remove. `scenario` is the way out: it
     * states the current at each level directly, so nothing has to be
     * carried across at all.
     */
    if (projection.referralIssue) {
      return {
        error: {
          code: 'REFERRAL_NEEDS_CONNECTION',
          message: `${side.ref}: ${projection.referralIssue.reason}; declare `
            + 'system { transformer A to B { vector_group = "Dyn11"; } }, or state the '
            + 'current at each level with a scenario',
        },
      };
    }
    return { I_A: projection.I_A, error: projection.warning
      ? { code: 'VOLTAGE_RATIO_UNRESOLVED', message: projection.warning }
      : undefined };
  }

  /*
   * Declared where the study gives it, otherwise derived from the
   * fault's `type`, exactly as the plot does.
   *
   * This used `currentFor`, which never derives -- so a fault
   * declaring only its phase current and a `type` had its components
   * derived for the *drawing* and refused for the *report*: the sheet
   * placed the rule and both curves while the margin table said
   * SEQUENCE_DATA_MISSING and failed the pair. One condition, two
   * answers.
   */
  const currents = {
    phase: fault.I_A,
    I1: fault.I1_A,
    I2: fault.I2_A,
    I0: fault.I0_A,
    residual: fault.earth_A,
  };
  const resolved = resolveCurrent(quantity, currents, fault.type);

  /*
   * A range endpoint is the *component's* endpoint, not the phase one.
   *
   * This used to substitute the phase minimum into `phase` and leave
   * every declared component at its centre -- so `resolveCurrent`
   * returned the declared figure whatever end was asked for, and both
   * ends of the sweep landed on the middle. The report printed a range
   * check that had checked nothing, which is worse than printing none.
   */
  const declared = at === 'I'
    ? resolved?.value ?? null
    : (() => {
      const range = resolveRange(quantity, currents, fault.range, fault.type);
      if (range) return at === 'min' ? range.min : range.max;
      /* No range for this component: the centre stands for both ends. */
      return resolved?.value ?? null;
    })();

  if (declared == null) {
    return {
      error: {
        code: 'SEQUENCE_DATA_MISSING',
        message:
          `${side.ref} measures ${quantityLabel(quantity)}, but fault "${fault.name}" ` +
          `declares no ${quantityField(quantity)} and has no type to derive it from; ` +
          'this pair cannot be graded until it does',
      },
    };
  }

  /*
   * The declared components belong to the fault's own level. Referring
   * them elsewhere is only sound for the quantities that cross a
   * transformer.
   */
  const faultKv = fault.voltage_kV;
  const sideKv = side.voltage ? study.voltages.get(side.voltage)?.kV : undefined;
  const sameLevel = faultKv == null || sideKv == null || faultKv === sideKv;

  if (sameLevel) return { I_A: declared, derived: resolved?.derived };

  if (!survivesVoltageReferral(quantity, study, fault.voltage, side.voltage)) {
    return {
      error: {
        code: 'SEQUENCE_ACROSS_LEVELS',
        message:
          `${side.ref} measures ${quantityLabel(quantity)} at ${sideKv} kV, but fault ` +
          `"${fault.name}" declares its components at ${faultKv} kV. Whether zero sequence ` +
          'reaches the other level depends on the windings between them, so either declare ' +
          `the figure at ${side.voltage ?? 'the relay\'s own level'}, or state the link with ` +
          'system { zero_sequence { ... = continuous; } }',
      },
    };
  }

  return { I_A: declared * (faultKv / sideKv), derived: resolved?.derived };
}

/**
 * Margin report for a grade pinned to a scenario.
 *
 * A scenario is one point per level, not a range, so there is a single
 * row and no upstream sweep -- the sweep walks a fault's declared
 * range, which a scenario does not have. Everything else reads the
 * same as a fault-based report.
 */
function reportScenarioGrade(
  study: Study,
  grade: Grade,
  report: GradeReport,
  primary: Side,
  backup: Side,
  diagnostics: GradeReport['diagnostics'],
): GradeReport {
  const scenario = study.scenarios.get(grade.scenario!);
  if (!scenario) {
    diagnostics.push({
      code: 'UNRESOLVED_REFERENCE',
      severity: 'error',
      message: `grade references scenario "${grade.scenario}", which is not declared`,
    });
    return report;
  }

  if (typeof primary.measures === 'string' && typeof backup.measures === 'string'
      && primary.measures !== backup.measures
      && primary.measures !== 'mixed' && backup.measures !== 'mixed') {
    diagnostics.push({
      code: 'GRADE_MIXED_QUANTITY',
      severity: 'warning',
      message:
        `${primary.ref} measures ${quantityLabel(primary.measures as MeasuredQuantity)} and ` +
        `${backup.ref} measures ${quantityLabel(backup.measures as MeasuredQuantity)}; the ` +
        'margin compares operate times for two different currents at the same condition',
    });
  }

  const atPrimary = sideCurrentInScenario(scenario, primary);
  const atBackup = sideCurrentInScenario(scenario, backup);

  /*
   * A margin resting on a derived component says so. `resolveCurrent`
   * has carried the flag since the ratio table was added; nothing read
   * it, so a report computed from an assumed fault shape looked exactly
   * like one computed from measured figures.
   */
  if (atPrimary.derived || atBackup.derived) {
    diagnostics.push({
      code: 'MARGIN_FROM_DERIVED_COMPONENT',
      severity: 'warning',
      message:
        `a component was derived from the condition's fault type rather than declared; ` +
        'the margin rests on that assumed fault shape',
    });
  }

  let blocked = false;
  for (const side of [atPrimary, atBackup]) {
    if (!side.error) continue;
    diagnostics.push({ ...side.error, severity: 'error' });
    if (side.I_A == null) blocked = true;
  }
  if (blocked) return report;

  const I_p = atPrimary.I_A!;
  const I_b = atBackup.I_A!;

  if (refuseBeyondCutoff([[primary, I_p], [backup, I_b]], diagnostics)) return report;

  const t_p = primary.tAt(I_p);
  const t_b = backup.tAt(I_b);

  const row: MarginRow = {
    at: 'I',
    I_f_A: I_p,
    I_backup_A: I_b,
    t_primary_s: t_p,
    t_backup_s: t_b,
    margin_s: t_b - t_p,
    M_primary: multipleOf(primary, I_p),
    M_backup: multipleOf(backup, I_b),
  };
  row.pass = verdictFor(row.margin_s, grade.CTI_min_s);
  report.rows.push(row);

  report.achieved_margin_s = row.margin_s;
  if (Number.isFinite(row.margin_s)) {
    report.min_margin_s = row.margin_s;
    report.min_margin_at_A = row.I_f_A;
    if (grade.CTI_min_s != null) report.pass = row.margin_s >= grade.CTI_min_s;
  } else if (grade.CTI_min_s != null) {
    report.pass = false;
    diagnostics.push({
      code: 'NO_OPERATION',
      severity: 'warning',
      message: 'neither side operates under this scenario; no margin could be computed',
    });
  }

  return report;
}

/**
 * The current one side measures under a scenario.
 *
 * Nothing is referred between levels: a scenario declares the
 * condition at every level it is measured, which is the whole reason
 * it exists. The relay's declared share of that level's current is
 * applied here, so parallel paths are handled at the point the current
 * is read rather than inside the curve maths.
 */
function sideCurrentInScenario(
  scenario: Scenario,
  side: Side,
): SideCurrent {
  if (side.measures === null) {
    return { error: { code: 'MEASURES_REQUIRED',
      message: `${side.ref} has function "neg_seq" but does not declare which current its ` +
        'pickup is in; add measures = "I2" or measures = "3I2"' } };
  }
  if (side.measures === 'mixed') {
    return { error: { code: 'MEASURES_MIXED',
      message: `${side.ref} has stages measuring different currents, so it cannot be graded as one element` } };
  }

  const quantity: MeasuredQuantity = side.measures;
  const levelName = side.voltage;
  const level = levelName ? scenario.levels.get(levelName) : undefined;

  if (!level) {
    return { error: { code: 'SCENARIO_LEVEL_MISSING',
      message: `scenario "${scenario.name}" declares no currents at ${levelName ?? 'the level'} ` +
        `where ${side.ref} sits; add a level "${levelName ?? '?'}" { ... } block` } };
  }

  /* As for a fault: declared first, then the type's ratios. */
  const resolved = resolveCurrent(quantity, {
    phase: level.I_A,
    I1: level.I1_A,
    I2: level.I2_A,
    I0: level.I0_A,
    residual: level.earth_A,
  }, scenario.type);
  const declared = resolved?.value ?? null;

  if (declared == null) {
    return { error: { code: 'SEQUENCE_DATA_MISSING',
      message: `${side.ref} measures ${quantityLabel(quantity)}, but scenario ` +
        `"${scenario.name}" declares no ${quantityField(quantity)} at ${level.voltage}` } };
  }

  /* The relay's share of that level's current, where one is declared. */
  const relayId = side.element?.relayId;
  const pct = relayId != null ? scenario.shares.get(relayId) : undefined;
  const share = pct != null && Number.isFinite(pct) ? pct / 100 : 1;

  return { I_A: declared * share, derived: resolved?.derived };
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
 * fault the primary can actually see: that is the study's own statement
 * about the most severe current available, and it is not the tool's
 * place to overrule it.
 *
 * "Can see" means declared at the primary's own voltage level, or
 * declaring no level at all. Referring every fault in the study into
 * the primary's frame is wrong, and wrong in the direction that
 * invents current: a 33 kV bus fault of 18.4 kA becomes 55.2 kA when
 * carried across a 3:1 transformer onto an 11 kV feeder, and the
 * feeder was then judged at a current more than eight times the
 * board maximum its own study declares. A fault somewhere else in the
 * network is not a current that flows through this pair.
 *
 * It used to take the largest of that, twenty times the primary's
 * pick-up, and twice the starting current -- so a study declaring a
 * 9.4 kA board maximum was swept to 18.8 kA and failed at 12 kA, a
 * current its own data says cannot flow. A failure reported at an
 * impossible fault is its own kind of wrong answer, and a louder one
 * than the gap it was meant to close: it is unfalsifiable from inside
 * the study, since no setting the engineer can change will make an
 * impossible current coordinate.
 *
 * The floor survives only where no declared fault projects into the
 * primary's frame at all. There the tool has nothing to respect, so
 * twenty times pick-up is a guess made in the absence of data rather
 * than one made over the top of it.
 */
/**
 * Refuse a margin taken past where a curve stops.
 *
 * `I_cutoff` says the characteristic does not exist above that current
 * -- a high-set blocked above the maximum through-fault, a thermal
 * stage characterised only to a few multiples. Grading there anyway
 * used to return the blocked stage's time regardless, so the sheet
 * drew the curve stopping at its ceiling while the report beside it
 * quoted a margin from well past it: eight times fast, in the case
 * that found this.
 *
 * Refused rather than answered from whatever stage survives, because
 * the study has said two things that cannot both hold -- grade at this
 * current, and this curve ends before it -- and which of them is wrong
 * is the author's to say.
 *
 * Shared because there are two grading paths, one for a `fault` and
 * one for a `scenario`, and a check that lands in only one of them is
 * the same silent answer in a different place.
 */
function refuseBeyondCutoff(
  at: ReadonlyArray<readonly [Side, number]>,
  diagnostics: GradeReport['diagnostics'],
): boolean {
  let refused = false;
  for (const [side, I] of at) {
    if (side.cutoff_A == null || I <= side.cutoff_A) continue;
    refused = true;
    const already = diagnostics.some(
      (d) => d.code === 'GRADE_BEYOND_CUTOFF' && d.message.startsWith(`${side.ref} stops`),
    );
    if (already) continue;
    diagnostics.push({
      code: 'GRADE_BEYOND_CUTOFF',
      severity: 'error',
      message:
        `${side.ref} stops at ${side.cutoff_A} A and this grade is taken at `
        + `${Math.round(I)} A; either raise I_cutoff or grade at a current the `
        + 'curve reaches',
    });
  }
  return refused;
}

function upstreamCeiling(
  study: Study,
  grade: Grade,
  primary: Side,
  from: number,
): number {
  if (grade.upstream_to_A != null && Number.isFinite(grade.upstream_to_A)) {
    return grade.upstream_to_A;
  }

  let declared = 0;
  for (const f of study.faults.values()) {
    /*
     * A fault with no level belongs to whatever is grading it; a fault
     * at another level is somewhere else in the network.
     */
    if (f.voltage && primary.voltage && f.voltage !== primary.voltage) continue;
    const projected = faultCurrentAt(study, f, primary.voltage, 'max').I_A;
    if (Number.isFinite(projected) && projected > declared) declared = projected;
  }
  /*
   * A declared ceiling at or below where the sweep starts is not an
   * error and not a reason to invent headroom: it means the study says
   * there is nothing above the fault being graded, so there is nothing
   * to sweep. The caller reports a sweep of no points rather than a
   * pass earned over currents that cannot occur.
   */
  if (declared > 0) return declared;

  const stage = primary.element ? primary.element.stages[0] : undefined;
  const byPickup = stage?.I_pu_A != null ? stage.I_pu_A * 20 : 0;
  return Math.max(byPickup, from * 2);
}

function multipleOf(side: Side, I_A: number): number | undefined {
  if (!side.element) return undefined;
  const stage = controllingStage(side.element, I_A);
  const I_pu = stage?.I_pu_A;
  if (I_pu == null || !(I_pu > 0)) return undefined;
  return (I_A * ((stage?.current_pct ?? 100) / 100)) / I_pu;
}

/** Build the margin report for one `grade` block. */
/**
 * A row's verdict, or `undefined` where there is none to give.
 *
 * A margin only exists where both sides operate. Where one does not,
 * the difference of the two times is not a small margin or a large one
 * -- there is no margin, and scoring it as a pass produced a report
 * that read `achieved margin = no-op s -- pass` directly above
 * `overall : FAIL`. Two lines of one table contradicting each other is
 * worse than either verdict alone, because it teaches the reader that
 * the column cannot be trusted.
 *
 * `undefined` leaves the row unscored and keeps it out of the overall
 * verdict; the NO_OPERATION diagnostic is what says why.
 */
function verdictFor(margin_s: number, required: number | undefined): boolean | undefined {
  if (required == null) return undefined;
  if (!Number.isFinite(margin_s)) return undefined;
  return margin_s >= required;
}

export function reportGrade(study: Study, grade: Grade): GradeReport {
  const diagnostics: GradeReport['diagnostics'] = [];
  const primary = sideFor(study, grade.primary, 'primary');
  const backup = sideFor(study, grade.backup, 'backup');

  const report: GradeReport = {
    primaryRef: primary?.ref ?? grade.primary?.text ?? '?',
    backupRef: backup?.ref ?? grade.backup?.text ?? '?',
    fault: grade.fault ?? grade.scenario,
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

  if (grade.fault && grade.scenario) {
    diagnostics.push({
      code: 'GRADE_FAULT_AND_SCENARIO',
      severity: 'error',
      message: 'grade declares both `fault` and `scenario`; they are alternatives -- a fault is ' +
        'one current at one level, a scenario the same condition at every level',
    });
    return report;
  }

  if (grade.scenario) {
    return reportScenarioGrade(study, grade, report, primary, backup, diagnostics);
  }

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
  /*
   * Swept when the condition states a range in *any* component, not
   * only in phase. A study whose fault report gives negative-sequence
   * minimum and maximum declares those, and would otherwise get its
   * single point checked and a range it wrote ignored.
   */
  const declaresRange = (fault.min_A !== fault.I_A || fault.max_A !== fault.I_A)
    || Object.entries(fault.range).some(([k, v]) =>
      k !== 'min' && k !== 'max' && v != null && Number.isFinite(v));
  const endpoints: Array<'I' | 'min' | 'max'> =
    declaresRange ? ['I', 'min', 'max'] : ['I'];

  /*
   * A declared range is *swept*, not sampled at its ends.
   *
   * Three points -- the fault and its two endpoints -- say nothing
   * about what happens between them, and between them is where two
   * characteristics cross. A fuse and a relay that grade at 200 A and
   * at 1.2 kA can be five seconds the wrong way round at 300 A, and
   * the report said PASS.
   *
   * Log-spaced, because the axis is: even spacing in amps would put
   * almost every sample in the top decade and none where an inverse
   * curve is steepest.
   */
  const RANGE_SAMPLES = 32;
  const rangeSweep: number[] = [];
  if (fault.min_A !== fault.max_A && fault.min_A > 0 && fault.max_A > fault.min_A) {
    const lo = Math.log(fault.min_A);
    const hi = Math.log(fault.max_A);
    for (let i = 0; i <= RANGE_SAMPLES; i++) {
      rangeSweep.push(Math.exp(lo + (i / RANGE_SAMPLES) * (hi - lo)));
    }
  }

  /* Set where any row's current came from the type's ratios rather
   * than a declared figure; reported once at the end. */
  let derivedAny = false;

  /*
   * A margin between two different measured quantities is not a
   * like-for-like comparison -- an I2 backup against a phase primary
   * is a judgement about two different currents at one fault. It is
   * legitimate practice, and worth saying out loud on the report.
   */
  if (typeof primary.measures === 'string' && typeof backup.measures === 'string'
      && primary.measures !== backup.measures
      && primary.measures !== 'mixed' && backup.measures !== 'mixed') {
    diagnostics.push({
      code: 'GRADE_MIXED_QUANTITY',
      severity: 'warning',
      message:
        `${primary.ref} measures ${quantityLabel(primary.measures as MeasuredQuantity)} and ` +
        `${backup.ref} measures ${quantityLabel(backup.measures as MeasuredQuantity)}; the ` +
        'margin compares operate times for two different currents at the same fault',
    });
  }

  for (const at of endpoints) {
    const atPrimary = sideCurrentAt(study, fault, primary, at);
    const atBackup = sideCurrentAt(study, fault, backup, at);
    if (atPrimary.derived || atBackup.derived) derivedAny = true;

    let blocked = false;
    for (const side of [atPrimary, atBackup]) {
      if (!side.error) continue;
      diagnostics.push({ ...side.error, severity: 'error' });
      if (side.I_A == null) blocked = true;
    }
    /* Without a current for both sides there is no margin to report. */
    if (blocked) continue;

    const I_p = atPrimary.I_A!;
    const I_b = atBackup.I_A!;
    if (refuseBeyondCutoff([[primary, I_p], [backup, I_b]], diagnostics)) continue;

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
    row.pass = verdictFor(row.margin_s, grade.CTI_min_s);
    report.rows.push(row);
  }

  /*
   * The interior of the declared range. Reported as `range` rows so the
   * three declared points stay identifiable in the table.
   */
  for (const I_p of rangeSweep) {
    const I_b = I_p * backupRatio(study, fault, primary.voltage, backup.voltage);
    const t_p = primary.tAt(I_p);
    const t_b = backup.tAt(I_b);
    if (!Number.isFinite(t_p) && !Number.isFinite(t_b)) continue;
    const row: MarginRow = {
      at: 'range',
      I_f_A: I_p,
      I_backup_A: I_b,
      t_primary_s: t_p,
      t_backup_s: t_b,
      margin_s: t_b - t_p,
      M_primary: multipleOf(primary, I_p),
      M_backup: multipleOf(backup, I_b),
    };
    if (grade.CTI_min_s != null && Number.isFinite(row.margin_s)) {
      row.pass = verdictFor(row.margin_s, grade.CTI_min_s);
    }
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
  /*
   * On by default.
   *
   * A pair that grades at the declared fault routinely fails above it,
   * and a check nobody knows to ask for is not much of a check -- the
   * example written to demonstrate the problem said "delete the one
   * line and watch the study go green while remaining wrong".
   *
   * It was opt-in until the ceiling was trustworthy. `upstreamCeiling`
   * used to run to twice the declared fault, so studies failed at
   * currents their own data says cannot flow; that is a wrong answer
   * of its own, and a louder one than the gap it closed. The ceiling is
   * now the largest fault the study declares and nothing above it, so
   * the reason for hiding the check is gone.
   *
   * `upstream = false` turns it off for a pair where it is not wanted.
   */
  const askedForSweep = grade.upstream === true || grade.upstream_to_A != null;
  if (grade.upstream !== false) {
    const from = faultCurrentAt(study, fault, primary.voltage, 'max').I_A;
    /*
     * The sweep stops where the curves do.
     *
     * Clamped rather than refused, unlike the declared fault above: a
     * sweep is the tool's own choice of currents, so running it past a
     * cutoff is the tool overreaching rather than the study
     * contradicting itself. Above the cutoff there is no curve to take
     * a margin from, and a sweep that carried on would be grading
     * against whichever stage happened to survive.
     */
    const ends = [primary.cutoff_A, backup.cutoff_A].filter((x): x is number => x != null);
    const to = Math.min(upstreamCeiling(study, grade, primary, from), ...ends);
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
        row.pass = verdictFor(row.margin_s, grade.CTI_min_s);
        report.rows.push(row);
      }
      report.upstream_to_A = to;
    } else if (askedForSweep) {
      /*
       * Only said to someone who asked for the sweep.
       *
       * Grading at the largest fault a study declares is the normal
       * case, and there is nothing above it to walk -- so with the
       * check on by default this fires on most sound studies, which
       * would turn a useful warning into background noise. Where the
       * author wrote `upstream = true` or named a ceiling, the empty
       * range is genuinely news: they asked a question the study
       * cannot answer.
       */
      diagnostics.push({
        code: 'UPSTREAM_RANGE_EMPTY',
        severity: 'warning',
        message:
          `upstream sweep ceiling (${to.toFixed(0)} A) is not above the declared fault ` +
          `(${from.toFixed(0)} A); nothing to sweep`,
      });
    }
  }

  /*
   * A margin resting on a derived component says so. `resolveCurrent`
   * has carried the flag since the ratio table was added; nothing read
   * it, so a report computed from an assumed fault shape looked exactly
   * like one computed from measured figures.
   */
  if (derivedAny) {
    diagnostics.push({
      code: 'MARGIN_FROM_DERIVED_COMPONENT',
      severity: 'warning',
      message:
        `a component was derived from fault "${fault.name}"'s type rather than declared; ` +
        'the margin rests on that assumed fault shape',
    });
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
        message: 'solve block declared with neither margin_target nor margin to aim at',
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
        /*
         * The declared dial is kept, not overwritten. What is drawn is
         * what is used -- so the solved value governs -- but the figure
         * in the file has to stay visible, or the drawing and the
         * settings sheet disagree with nothing saying which is right.
         */
        if (result.stage.tms != null && result.stage.tms !== result.tms) {
          result.stage.tms_declared = result.stage.tms;
          diagnostics.push({
            code: 'SOLVE_OVERRODE_SETTING',
            severity: 'warning',
            message:
              `solve replaced the declared tms ${result.stage.tms} on ${backup.ref} with `
              + `${result.tms.toFixed(3)}; the sheet is drawn at the solved value, so that `
              + 'is the setting the study asserts',
          });
        }
        result.stage.tms = result.tms;
        result.stage.tms_auto = true;
        if (result.I_pu_A != null) result.stage.I_pu_A = result.I_pu_A;

        /* Recompute the rows now that the backup has moved, still in
         * the backup's own frame. */
        for (const row of report.rows) {
          row.t_backup_s = backup.tAt(row.I_backup_A);
          row.margin_s = row.t_backup_s - row.t_primary_s;
          row.M_backup = multipleOf(backup, row.I_backup_A);
          row.pass = verdictFor(row.margin_s, grade.CTI_min_s);
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
        'margin_target is declared without a solve block; it is reported as a target only. ' +
        'Add solve { ... } to have the tool meet it, or use margin for a constraint',
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

  /*
   * Study-wide verdict across every point evaluated.
   *
   * Judged against `margin` where the study declares one, and against
   * `margin_target` where it only declares that -- a solved pair
   * previously produced no verdict at all, so the one line a reader
   * looks for was missing from exactly the studies that had asked the
   * tool to choose a setting for them.
   */
  const against = report.CTI_min_s != null ? 'margin' : 'margin_target';
  const verdict = verdictOf(report);
  if (verdict !== 'unevaluated') {
    const where = report.min_margin_at_A != null
      ? ` (worst ${s3(report.min_margin_s!)} s at ${report.min_margin_at_A.toFixed(0)} A)`
      : '';
    out.push(
      `    overall         : ${verdict === 'pass' ? 'PASS' : 'FAIL'}${where} vs ${against}`,
    );
  } else if (report.rows.length > 0) {
    /*
     * Said rather than left blank. A pair that could not be judged used
     * to print no verdict line at all, so the one line a reader looks
     * for was simply missing and its absence had to be interpreted.
     */
    out.push('    overall         : not evaluated -- no margin could be computed');
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
