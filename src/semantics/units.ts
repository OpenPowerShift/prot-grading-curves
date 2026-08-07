/**
 * Unit normalisation for scalar values read off the AST.
 *
 * The parser records a number's unit suffix verbatim
 * (`{ kind: 'number', value: 6.4, unit: 'kA' }`) rather than folding
 * it in, so that a round-trip can reproduce the source text. Every
 * consumer that wants a *physical* quantity goes through here, which
 * is the single place the suffix table from
 * `spec/sections/lexical-structure.adoc` -- _Recognised units_ is
 * applied.
 */

import type { ScalarValue } from '../parser/ast.js';

/** Multipliers onto the SI base unit of each category. */
const CURRENT_A: Record<string, number> = { A: 1, kA: 1e3, mA: 1e-3, MA: 1e6 };
const TIME_S: Record<string, number> = { s: 1, ms: 1e-3, min: 60, ks: 1e3 };
const VOLTAGE_KV: Record<string, number> = { kV: 1, V: 1e-3, MV: 1e3 };
/*
 * Power was outside this table entirely, so `base_S = 25;` passed a
 * bare number on. Every shipped example already writes the unit;
 * nothing was enforcing it.
 *
 * `char_angle` was the other, and the only field in the language
 * measured in degrees. It went with the directional keys on
 * 2026-08-08, and the angle quantity went with it rather than being
 * left as a category nothing is in.
 */
const POWER_MVA: Record<string, number> = { MVA: 1, kVA: 1e-3, GVA: 1e3, MW: 1 };

export type Quantity = 'current' | 'time' | 'voltage' | 'power' | 'scalar';

/**
 * A per-unit pickup written as `2.5 xCT` / `1.2 pu` / `3 xIn` is a
 * *multiple*, not an absolute current; the caller has to scale it by
 * the relevant base. `readNumber` reports the suffix back so the
 * caller can decide.
 */
export const PER_UNIT_SUFFIXES = new Set(['pu', 'xCT', 'xIn', 'xct', 'xin']);

/**
 * Suffixes that say which side of the CT a current is measured on.
 *
 * A relay is *set* in secondary amps -- the number on the settings
 * sheet -- while the study is drawn in primary amps. `I_units` says
 * so for a whole element or study; these suffixes say it for one
 * value, which is what a sheet mixing the two needs. `A_pri` exists
 * so a single primary figure can opt out of a block-level
 * `I_units = "secondary"`.
 */
export const SECONDARY_SUFFIXES = new Set(['A_sec', 'Asec', 'A_secondary']);
export const PRIMARY_SUFFIXES = new Set(['A_pri', 'Apri', 'A_primary']);

/**
 * Every suffix the language recognises, in any position.
 *
 * `readNumber` deliberately leaves an unrecognised suffix alone rather
 * than guessing -- but nothing then complained, so `4 KA` was read as
 * 4 A and `60 msec` as 60 seconds: a factor of a thousand, silently,
 * in the fields that decide whether a relay trips. This is the set the
 * validator checks against, which is the "validator is responsible for
 * complaining about it" the reader has always assumed.
 */
export const KNOWN_UNITS: ReadonlySet<string> = new Set([
  ...Object.keys(CURRENT_A),
  ...Object.keys(TIME_S),
  ...Object.keys(VOLTAGE_KV),
  ...Object.keys(POWER_MVA),
  ...PER_UNIT_SUFFIXES,
  ...SECONDARY_SUFFIXES,
  ...PRIMARY_SUFFIXES,
  /* Declared elsewhere in the grammar. */
  'MVA', 'kVA', 'MW', 'kW', 'deg', 'Hz', 'pct', '%',
]);

export interface NumberReading {
  /** Value converted to the category's base unit (A, s, kV). */
  value: number;
  /** The suffix exactly as written, if any. */
  unit?: string;
  /** True when the suffix marks a per-unit multiple rather than an absolute. */
  perUnit: boolean;
  /** Written in secondary amps (`A_sec`); scale by the CT ratio. */
  secondary?: boolean;
  /** Written in primary amps (`A_pri`); never scale, whatever `I_units` says. */
  primary?: boolean;
}

/** Coerce an AST scalar (or a bare number) to a plain JS number. */
export function rawNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.value === 'number') return o.value;
    if (typeof o.numerator === 'number' && typeof o.denominator === 'number' && o.denominator !== 0) {
      return o.numerator / o.denominator;
    }
  }
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/**
 * Read a scalar as a physical quantity, applying the unit suffix.
 * An unrecognised suffix leaves the value untouched -- the validator
 * is responsible for complaining about it, not the reader.
 */
export function readNumber(v: unknown, quantity: Quantity = 'scalar'): NumberReading {
  const value = rawNumber(v);
  const unit = (v && typeof v === 'object' ? (v as { unit?: string }).unit : undefined) || undefined;
  if (unit && PER_UNIT_SUFFIXES.has(unit)) return { value, unit, perUnit: true };
  if (unit && SECONDARY_SUFFIXES.has(unit)) return { value, unit, perUnit: false, secondary: true };
  if (unit && PRIMARY_SUFFIXES.has(unit)) return { value, unit, perUnit: false, primary: true };
  const table =
    quantity === 'current' ? CURRENT_A
    : quantity === 'time' ? TIME_S
    : quantity === 'voltage' ? VOLTAGE_KV
    : quantity === 'power' ? POWER_MVA
    : undefined;
  const factor = unit && table ? table[unit] : undefined;
  return { value: factor != null ? value * factor : value, unit, perUnit: false };
}

/** Shorthand readers for the three categories the study model needs. */
export const amps = (v: unknown): NumberReading => readNumber(v, 'current');
export const seconds = (v: unknown): NumberReading => readNumber(v, 'time');
export const kilovolts = (v: unknown): NumberReading => readNumber(v, 'voltage');

/** Read a scalar as a string, tolerating both `{kind:'string'}` and bare strings. */
export function readString(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (v && typeof v === 'object') {
    const o = v as ScalarValue;
    if (o.kind === 'string') return o.value || undefined;
    if (o.kind === 'number') return String(o.value);
    if (o.kind === 'boolean') return String(o.value);
  }
  return undefined;
}

/** Read a scalar as a boolean, accepting `true` / `"true"` / `1`. */
export function readBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  }
  if (v && typeof v === 'object') {
    const o = v as ScalarValue;
    if (o.kind === 'boolean') return o.value;
    if (o.kind === 'string') return readBoolean(o.value);
    if (o.kind === 'number') return o.value !== 0;
  }
  return undefined;
}

/** Read a `600/5`-style ratio as its numeric value (120). */
export function readRatio(v: unknown): number | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.numerator === 'number' && typeof o.denominator === 'number') {
      return o.denominator === 0 ? undefined : o.numerator / o.denominator;
    }
  }
  const n = rawNumber(v);
  return Number.isFinite(n) ? n : undefined;
}

/* ------------------------------------------------------------------ */
/* What each field is a quantity of                                    */
/* ------------------------------------------------------------------ */

/**
 * The physical quantity each key carries.
 *
 * No key names its own unit any more -- `I`, not `I_A`; `t`, not
 * `t_s` -- so the unit is always the author's to write and always
 * checked against what the field actually is. Checking against the
 * union of every suffix caught a misspelling but not a category error:
 * `I_pickup = 5 ms` was a real suffix in the wrong place and passed.
 *
 * One table, so the parser, the validator and the editor's completion
 * list cannot drift apart about what `t_delay` takes.
 */
export const FIELD_QUANTITY: Readonly<Record<string, Quantity>> = {
  /* Currents. */
  I: 'current', I1: 'current', I2: 'current', I0: 'current',
  residual: 'current', I_min: 'current', I_max: 'current',
  I_pickup: 'current', I_base: 'current',
  at_I: 'current', at_I1: 'current', at_I2: 'current', at_I0: 'current',
  at_residual: 'current', rating_I: 'current',

  /* Times. */
  t: 'time', t_delay: 'time', at_t: 'time',
  margin: 'time', margin_target: 'time',
  time_min: 'time', time_max: 'time',

  /* Voltages. */
  V: 'voltage', rating_V: 'voltage',

  /* Apparent power. */
  base_S: 'power', rating_S: 'power',

  /* Bounds on the current axis. */
  current_min: 'current', current_max: 'current', I_cutoff: 'current',
  upstream_to: 'current',
};

/** Suffixes acceptable for one quantity, for a diagnostic that lists them. */
export function suffixesFor(quantity: Quantity): string[] {
  switch (quantity) {
    case 'current':
      return [...Object.keys(CURRENT_A), ...PER_UNIT_SUFFIXES,
        ...SECONDARY_SUFFIXES, ...PRIMARY_SUFFIXES];
    case 'time': return Object.keys(TIME_S);
    case 'voltage': return Object.keys(VOLTAGE_KV);
    case 'power': return Object.keys(POWER_MVA);
    default: return [];
  }
}

/**
 * Is this suffix acceptable for this field?
 *
 * `null` for a field the table does not cover -- a unitless one like
 * `tms`, or a page cosmetic in pixels -- where there is nothing to
 * check against.
 */
export function suffixFits(field: string, unit: string): boolean | null {
  const quantity = FIELD_QUANTITY[field];
  if (quantity == null) return null;
  return suffixesFor(quantity).includes(unit);
}
