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
    /* One level is unambiguous, so a caller with no level still gets it. */
    ?? (scenario.levels.size === 1 ? [...scenario.levels.values()][0] : undefined);

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
  };
}

/** True when a name is declared as either form. */
export function isConditionName(study: Study, name: string): boolean {
  return study.faults.has(name) || study.scenarios.has(name);
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
 */
export function viewLabel(
  view: { name?: string; condition?: string; quantity?: string } | undefined,
  index: number,
): string {
  if (view?.name?.trim()) return view.name.trim();
  if (view?.condition?.trim()) return view.condition.trim();
  if (view?.quantity && view.quantity !== 'any') return `${view.quantity} sheet`;
  return `Sheet ${index + 1}`;
}
