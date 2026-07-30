/**
 * Ratios between phase current and the sequence components.
 *
 * At one fault these are not independent quantities -- they are fixed
 * multiples of one another, decided by what kind of fault it is. That
 * is what lets a component be derived from a declared phase current,
 * and what lets a curve measured in one quantity be drawn on an axis
 * in another.
 *
 * Every ratio is against the condition's *own* declared phase current.
 * Nothing here is referenced to a three-phase figure: a phase-phase
 * fault's phase current is its own value.
 */

import { describe, expect, it } from 'vitest';
import { FAULT_TYPES, isFaultType, quantityIsAbsent, ratioFor } from '@tc/constants/sequence';
import { conversionFactor, resolveCurrent } from '@tc/semantics/quantity';

const ROOT3 = Math.sqrt(3);

describe('the ratio table', () => {
  it('leaves phase current as itself for every type', () => {
    for (const type of FAULT_TYPES) {
      expect(ratioFor(type, 'phase'), type).toBe(1);
    }
  });

  it('gives a balanced fault positive sequence only', () => {
    expect(ratioFor('three_phase', 'I1')).toBe(1);
    expect(ratioFor('three_phase', 'I2')).toBe(0);
    expect(ratioFor('three_phase', 'I0')).toBe(0);
  });

  it('divides a phase-phase fault by root three', () => {
    /* |I1| = |I2|, and the line current is their difference. */
    expect(ratioFor('two_phase', 'I1')).toBeCloseTo(1 / ROOT3, 12);
    expect(ratioFor('two_phase', 'I2')).toBeCloseTo(1 / ROOT3, 12);
    expect(ratioFor('two_phase', 'I0')).toBe(0);
  });

  it('splits a phase-earth fault three ways, residual equal to the phase', () => {
    expect(ratioFor('single_phase_earth', 'I1')).toBeCloseTo(1 / 3, 12);
    expect(ratioFor('single_phase_earth', 'I2')).toBeCloseTo(1 / 3, 12);
    expect(ratioFor('single_phase_earth', 'I0')).toBeCloseTo(1 / 3, 12);
    /* 3 x I0 is the faulted phase current itself. */
    expect(ratioFor('single_phase_earth', '3I0')).toBeCloseTo(1, 12);
  });

  it('derives nothing for two-phase-to-earth', () => {
    /* Its split between the sequence networks depends on Z0, which the
     * language does not carry, so the components must be declared. */
    for (const q of ['I1', 'I2', 'I0', '3I0', '3I2'] as const) {
      expect(ratioFor('two_phase_earth', q), q).toBeUndefined();
    }
  });

  it('scales the residual forms by three', () => {
    expect(ratioFor('two_phase', '3I2')).toBeCloseTo(ROOT3, 12);
    expect(ratioFor('single_phase_earth', '3I2')).toBeCloseTo(1, 12);
  });

  it('knows an absent component from an unknown one', () => {
    /* Zero is an answer: a balanced fault carries no negative sequence.
     * Undefined is a refusal to say. */
    expect(quantityIsAbsent('three_phase', 'I2')).toBe(true);
    expect(quantityIsAbsent('three_phase', '3I0')).toBe(true);
    expect(quantityIsAbsent('two_phase', 'I0')).toBe(true);
    expect(quantityIsAbsent('two_phase', 'I2')).toBe(false);
    expect(quantityIsAbsent('two_phase_earth', 'I2')).toBe(false);
  });

  it('recognises only the four types', () => {
    expect(isFaultType('two_phase')).toBe(true);
    expect(isFaultType('four_phase')).toBe(false);
    expect(isFaultType(undefined)).toBe(false);
  });
});

describe('deriving a component from a declared phase current', () => {
  it('derives, and says it derived', () => {
    const r = resolveCurrent('I2', { phase: 390 }, 'two_phase');
    expect(r!.value).toBeCloseTo(390 / ROOT3, 6);
    expect(r!.derived).toBe(true);
  });

  it('lets a declared component win, and marks it declared', () => {
    /* This is the override: the study's own figure beats the table. */
    const r = resolveCurrent('I2', { phase: 390, I2: 300 }, 'two_phase');
    expect(r!.value).toBe(300);
    expect(r!.derived).toBe(false);
  });

  it('reports absence when neither the study nor the type can say', () => {
    expect(resolveCurrent('I2', { phase: 390 }, 'two_phase_earth')).toBeNull();
    expect(resolveCurrent('I2', { phase: 390 })).toBeNull();
  });

  it('needs no type when the component is declared', () => {
    expect(resolveCurrent('I2', { I2: 225 })!.value).toBe(225);
  });
});

describe('conversion between quantities', () => {
  it('is unity onto itself', () => {
    expect(conversionFactor('I2', 'I2', { phase: 390 }, 'two_phase')).toBe(1);
  });

  it('is root three from phase onto negative sequence for a 2ph fault', () => {
    /* A 100 A phase pickup sits at 57.7 A on an I2 axis. */
    expect(conversionFactor('phase', 'I2', { phase: 390 }, 'two_phase'))
      .toBeCloseTo(ROOT3, 9);
  });

  it('is three from phase onto negative sequence for a phase-earth fault', () => {
    expect(conversionFactor('phase', 'I2', { phase: 2000 }, 'single_phase_earth'))
      .toBeCloseTo(3, 9);
  });

  it('is unity from phase onto residual for a phase-earth fault', () => {
    /* The residual *is* the faulted phase current, so nothing moves. */
    expect(conversionFactor('phase', '3I0', { phase: 2000 }, 'single_phase_earth'))
      .toBeCloseTo(1, 9);
  });

  it('follows a declared component rather than the table', () => {
    expect(conversionFactor('phase', 'I2', { phase: 390, I2: 300 }, 'two_phase'))
      .toBeCloseTo(390 / 300, 9);
  });

  it('refuses when the target quantity is absent', () => {
    /* There is no factor onto an axis of nothing: a balanced fault has
     * no negative sequence to divide by. */
    expect(conversionFactor('phase', 'I2', { phase: 9000 }, 'three_phase')).toBeNull();
  });

  it('refuses when the type cannot supply the ratio', () => {
    expect(conversionFactor('phase', 'I2', { phase: 390 }, 'two_phase_earth')).toBeNull();
  });
});
