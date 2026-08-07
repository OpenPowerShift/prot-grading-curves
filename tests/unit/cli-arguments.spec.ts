/**
 * A bad argument is refused, not quietly turned into a plausible one.
 *
 * Every case here was the same shape: the CLI accepted a value it
 * could not act on and produced something reasonable-looking at exit
 * 0.
 *
 * [cols="1,3"]
 * |===
 * | Argument | What it used to do
 *
 * | `--size ZZ9`   | drew A4
 * | `--width abc`  | `Number()` gave NaN, which passed a `!= null`
 *                    test and fell through to 1200x750 -- half the
 *                    documented scale-2 default
 * | `--scale 1e9`  | asked the rasteriser for ~10^19 pixels and
 *                    aborted the process with rc=134 and a Rust
 *                    panic, outside the documented status set
 * | `-o --png`     | wrote a file literally named `--png`, still SVG
 * | `--view ""`    | drew the default sheet -- the exact silent
 *                    fall-back the *unknown*-name path refuses
 * | `render --json`| ignored the flag and printed prose
 * |===
 *
 * The study path already refuses an unknown paper size
 * (`PAGE_SIZE_UNKNOWN`). A tool that refuses one on the page block and
 * accepts it on the command line is giving two answers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** Status and stderr of one invocation. */
const cli = async (args: string[]): Promise<{ code: number; err: string }> => {
  try {
    const { stderr } = await run('npx', ['tsx', 'src/cli.ts', ...args]);
    return { code: 0, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stderr?: string };
    return { code: x.code ?? -1, err: x.stderr ?? '' };
  }
};

const CLEAN = 'examples/00-minimal.ptc';
const OUT = ['-o', '/tmp/tc-arg-test.svg'];

describe('a value the flag cannot act on', () => {
  const CASES: Array<[string, string[], RegExp]> = [
    ['an unknown paper size', ['--size', 'ZZ9'], /valid sizes are/],
    ['an empty paper size', ['--size', ''], /needs a value|empty/],
    ['a width that is not a number', ['--width', 'abc'], /not a number/],
    ['a width below anything drawable', ['--width', '-100'], /between 200 and 20000/],
    ['a scale that would abort the rasteriser', ['--scale', '1e9'], /between 0\.1 and 20/],
    ['a scale of zero', ['--scale', '0'], /between 0\.1 and 20/],
    ['an empty view name', ['--view', ''], /needs a value|empty/],
  ];

  for (const [what, args, message] of CASES) {
    it(`refuses ${what}`, async () => {
      const { code, err } = await cli(['render', CLEAN, ...args, ...OUT]);
      expect(code, `${args.join(' ')} should be a usage error`).toBe(2);
      expect(err).toMatch(message);
    }, 60_000);
  }
});

describe('a flag where a value should be', () => {
  it('is not taken as the value', async () => {
    /*
     * `-o --png` wrote a file called `--png` and left the format at
     * SVG -- two mistakes from one typo, neither reported.
     */
    const { code, err } = await cli(['render', CLEAN, '-o', '--png']);
    expect(code).toBe(2);
    expect(err).toMatch(/another option/);
  }, 60_000);

  it('says so for a missing value at the end of the line', async () => {
    const { code, err } = await cli(['render', CLEAN, '--view']);
    expect(code).toBe(2);
    expect(err).toMatch(/needs a value|another option/);
  }, 60_000);

  it('still takes a negative number as a number', async () => {
    /*
     * A negative number begins with `-` and is not a misplaced flag,
     * so it should be told its value is out of range rather than that
     * it looks like an option.
     */
    const { err } = await cli(['render', CLEAN, '--width', '-100', ...OUT]);
    expect(err).toMatch(/between 200 and 20000/);
    expect(err).not.toMatch(/another option/);
  }, 60_000);
});

describe('a flag on a command it does not apply to', () => {
  it('refuses --json on render, as --all-views already refuses on svg', async () => {
    const { code, err } = await cli(['render', CLEAN, '--json', ...OUT]);
    expect(code).toBe(2);
    expect(err).toMatch(/check or report/);
  }, 60_000);

  it('still takes --json on check', async () => {
    const { code } = await cli(['check', CLEAN, '--json']);
    expect(code).toBe(0);
  }, 60_000);
});

describe('a value the flag can act on', () => {
  it('is accepted, so the refusals above are not simply refusing everything', async () => {
    for (const args of [
      ['--size', 'A3'], ['--size', 'a3'], ['--width', '900'], ['--scale', '2'],
    ]) {
      const { code } = await cli(['render', CLEAN, ...args, ...OUT]);
      expect(code, args.join(' ')).toBe(0);
    }
  }, 120_000);
});

describe('--quiet', () => {
  it('suppresses the margin report, as the usage says', async () => {
    /*
     * It was documented as suppressing the report and did not:
     * `report -q` printed it in full while `check -q` went silent
     * about its warnings. One meaning now, obeyed by both.
     */
    const { stdout } = await run('npx',
      ['tsx', 'src/cli.ts', 'report', 'examples/01-riverside.ptc', '-q']);
    expect(stdout.trim()).toBe('');
  }, 60_000);

  it('leaves the status alone, which is what a gate reads', async () => {
    const { code } = await cli(['report', 'examples/07-upstream-miscoordination.ptc', '-q']);
    expect(code).toBe(3);
  }, 60_000);

  it('still prints the report without it', async () => {
    const { stdout } = await run('npx',
      ['tsx', 'src/cli.ts', 'report', 'examples/01-riverside.ptc']);
    expect(stdout).toMatch(/achieved margin/);
  }, 60_000);
});
