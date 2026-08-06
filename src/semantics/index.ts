/**
 * Semantics layer -- everything between "the source parsed" and
 * "the plot is drawn".
 *
 * Pipeline: `buildStudy` resolves the AST into a study model, the
 * curve evaluators turn stages into `t(I)`, `stages` / `combine` fold
 * those into per-element and synthetic curves, `xvoltage` moves
 * currents between voltage levels, `solver` computes free settings,
 * and `grades` produces the margin report.
 */

export * from './units.js';
export * from './model.js';
export * from './curves.js';
export * from './stages.js';
export * from './combine.js';
export * from './xvoltage.js';
export * from './solver.js';
export * from './grades.js';
export * from './validate.js';
export * from './json-report.js';
