/**
 * Looking up a named system condition.
 *
 * The language has two ways of naming one: a `fault`, which is a single
 * current at a single level, and a `scenario`, which is the same
 * condition written down at every level it was measured. They are
 * alternatives, and everything that refers to a condition -- `grade`,
 * `annotate`, `point`, `view { condition }`, and the vertical rules on
 * the plot -- should accept either without caring which it got.
 *
 * Before this module each of those did its own lookup, and they did not
 * agree: the renderer's `view.condition` took a scenario's *first*
 * declared level whatever frame the sheet was drawn in, while
 * `annotationCurrent` did not look at scenarios at all. One place, so
 * they cannot drift apart again.
 *
 * The important asymmetry is the level. A fault's current belongs to
 * the level it was declared on, and reaching another level means
 * referring it by ampere-turns -- which the caller does, because only
 * the caller knows whether the quantity survives the transformer. A
 * scenario needs no referral at all: it already holds a figure for the
 * level being asked about, and *that is the point of it*. So the level
 * a caller wants is an input here, and the level the figures actually
 * came from is an output.
 */

import type { FaultType } from '../constants/sequence.js';
import type { Study } from './model.js';
import type { SequenceCurrents } from './quantity.js';

/** Which of the two forms a name resolved to. */
export type ConditionKind = 'fault' | 'scenario';

export interface ResolvedCondition {
  kind: ConditionKind;
  name: string;
  /** Fault type, where declared; supplies the ratios between quantities. */
  type?: FaultType;
  description?: string;
  /**
   * Level the returned figures were declared at.
   *
   * `undefined` for a scenario that declares nothing at the level asked
   * for -- the condition exists, but not here. Callers state that
   * rather than substituting another level's numbers, which would be a
   * silent turns-ratio error.
   */
  voltage?: string;
  voltage_kV?: number;
  /** Components at `voltage`; empty when no level matched. */
  currents: SequenceCurrents;
  /** Every level a scenario declares, for a diagnostic that lists them. */
  levels: readonly string[];
  /**
   * The level actually consulted, once a `NAME.LEVEL` suffix has been
   * split out -- which may differ from the `level` a caller passed in,
   * since the reference's own suffix wins. A diagnostic naming *why* a
   * scenario had nothing to say needs this one, not the caller's
   * guess: reporting the guess reads as "declares no currents at MV"
   * for a reference that named `.HV`, which contradicts itself the
   * moment the scenario turns out to declare MV after all.
   */
  requestedLevel?: string;
}

/**
 * Resolve a condition name to its figures at one level.
 *
 * `null` means no fault and no scenario carries that name -- a broken
 * reference, which the validator reports. A resolved condition whose
 * `voltage` is `undefined` is a live scenario with nothing to say at
 * `level`, which is a different thing and reads differently.
 *
 * For a scenario, `level` is honoured exactly where it is declared. A
 * scenario that declares just one level answers for that level whatever
 * was asked, since there is no ambiguity about which figures are meant;
 * one declaring several answers only for the level named.
 */
export function resolveCondition(
  study: Study,
  name: string,
  level?: string,
): ResolvedCondition | null {
  /*
   * `"S.HV"` names one of a scenario's own levels directly, in the
   * list a `fault`/`scenario` field already takes -- so `fault = [S.HV,
   * S.LV]` draws one mark per level without two separate blocks, and
   * without depending on a marker's `voltage` or its `on_curve` to
   * infer which level was meant.
   *
   * Only split where the whole name does not already resolve: a fault
   * or scenario is never declared with a literal `.` in its id, but
   * checking first means one never could be shadowed by this. The
   * explicit level then wins over whatever the caller passed in --
   * naming it in the reference is more specific than inferring it from
   * context.
   */
  /*
   * Whether `level` was named in the reference itself, as opposed to
   * inferred by a caller from its own context (a marker's `voltage`,
   * the element an annotation points at). The distinction matters
   * below: a scenario with one level answers a context guess with
   * that level regardless of what the guess was, since there was
   * never a choice to get wrong -- but a level spelled out in the
   * reference is a specific claim, and one a single-level scenario
   * does not happen to declare should refuse rather than quietly
   * answer with the level that *is* there.
   */
  let levelWasNamed = false;
  if (!study.faults.has(name) && !study.scenarios.has(name)) {
    const dot = name.indexOf('.');
    if (dot > 0) {
      const base = name.slice(0, dot);
      const explicitLevel = name.slice(dot + 1);
      if (explicitLevel && study.scenarios.has(base)) {
        name = base;
        level = explicitLevel;
        levelWasNamed = true;
      }
    }
  }

  const fault = study.faults.get(name);
  if (fault) {
    return {
      kind: 'fault',
      name,
      type: fault.type,
      description: fault.description,
      voltage: fault.voltage,
      voltage_kV: fault.voltage_kV,
      currents: {
        phase: fault.I_A,
        I1: fault.I1_A,
        I2: fault.I2_A,
        I0: fault.I0_A,
        residual: fault.earth_A,
      },
      levels: fault.voltage ? [fault.voltage] : [],
    };
  }

  const scenario = study.scenarios.get(name);
  if (!scenario) return null;

  const levels = [...scenario.levels.keys()];
  const chosen =
    (level != null ? scenario.levels.get(level) : undefined)
    /*
     * One level is unambiguous, so a caller with no level still gets
     * it -- but only where nothing more specific was actually named.
     * `S.MV` naming a level a single-level scenario does not declare
     * is a claim that turned out wrong, not an absent one, and
     * substituting the level that *is* there would draw `.MV`'s
     * figures under an `.MV` label that are actually `.LV`'s.
     */
    ?? (!levelWasNamed && scenario.levels.size === 1 ? [...scenario.levels.values()][0] : undefined);

  return {
    kind: 'scenario',
    name,
    type: scenario.type,
    description: scenario.description,
    voltage: chosen?.voltage,
    voltage_kV: chosen?.voltage_kV,
    currents: chosen
      ? {
        phase: chosen.I_A,
        I1: chosen.I1_A,
        I2: chosen.I2_A,
        I0: chosen.I0_A,
        residual: chosen.earth_A,
      }
      : {},
    levels,
    requestedLevel: level,
  };
}


/** Every declared condition name, faults first, for `did you mean`. */
export function conditionNames(study: Study): string[] {
  return [...study.faults.keys(), ...study.scenarios.keys()];
}

/**
 * What a sheet is called in a picker.
 *
 * The declared name, else the condition it depicts, else its position.
 * A study with several sheets and no names still gets a list a reader
 * can choose from rather than three entries reading "view".
 *
 * A view whose caption differs from its own handle gets the handle
 * appended in brackets -- `Phase grading (PHASE)` -- since that
 * handle, not the caption, is what a `views = [...]` entry elsewhere
 * in the study has to match. Where the two are the same (the common
 * case: no `name` was declared, so the handle stands in for it) the
 * bracket would only repeat the label.
 */
export function viewLabel(
  view: { id?: string; name?: string; condition?: string; quantity?: string } | undefined,
  index: number,
): string {
  const label = view?.name?.trim() ? view.name.trim()
    : view?.condition?.trim() ? view.condition.trim()
      : view?.quantity && view.quantity !== 'any' ? `${view.quantity} sheet`
        : `Sheet ${index + 1}`;
  const id = view?.id?.trim();
  return id && id !== label ? `${label} (${id})` : label;
}
