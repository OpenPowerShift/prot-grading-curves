/**
 * Every sheet a study draws.
 *
 * A study with no `view` draws one sheet; a study with several draws
 * one each, and a check that only ever renders the default misses
 * whatever the other sheets do differently -- which is how a fault band
 * overlapping the axis on a secondary-amps sheet survived a test that
 * covered every example.
 */

import type { ProcessResult, ViewBlock } from '@tc/index';

export interface Sheet {
  /** The view's own name where it has one, for naming a failure. */
  name: string;
  /** Passed straight to `renderStudy`; `undefined` means the default. */
  view: ViewBlock | undefined;
}

export function sheetsOf(result: ProcessResult): Sheet[] {
  const views = result.study?.views ?? [];
  if (views.length === 0) return [{ name: 'default', view: undefined }];
  return views.map((v, i) => ({ name: v.name ?? `view-${i + 1}`, view: v }));
}
