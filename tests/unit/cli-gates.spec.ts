/**
 * The two ways a CI gate was getting past this tool.
 *
 * Both are the same shape as the failure the exit-status work was done
 * to close -- a study that does not coordinate leaving by the same
 * door as success -- arriving by different routes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** Exit status of one CLI invocation. */
const status = async (args: string[]): Promise<number> => {
  try {
    await run('npx', ['tsx', 'src/cli.ts', ...args]);
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? -1;
  }
};

const FAILING = 'examples/07-upstream-miscoordination.ptc';
const CLEAN = 'examples/00-minimal.ptc';

describe('a second input file', () => {
  it('is refused rather than ignored', async () => {
    /*
     * `check a.ptc b.ptc` read only the first and exited 0, so
     * `tc-curves check *.ptc` in CI checked one study and reported
     * green on every other -- including one that fails.
     */
    expect(await status(['check', CLEAN, FAILING])).toBe(2);
  }, 60_000);

  it('still accepts exactly one', async () => {
    expect(await status(['check', CLEAN])).toBe(0);
  }, 60_000);
});

describe('render on a study that does not coordinate', () => {
  it('answers with the same status as check', async () => {
    /*
     * It returned `hasErrors ? 1 : 0` and discarded the 3 it had
     * already computed, so a pipeline that renders before it checks
     * shipped the drawing and saw success.
     */
    const rendered = await status(['render', FAILING, '--svg', '-o', '/dev/null', '-q']);
    const checked = await status(['check', FAILING, '-q']);
    expect(rendered).toBe(3);
    expect(rendered).toBe(checked);
  }, 90_000);

  it('still exits 0 on a study that does', async () => {
    expect(await status(['render', CLEAN, '--svg', '-o', '/dev/null', '-q'])).toBe(0);
  }, 60_000);
});
