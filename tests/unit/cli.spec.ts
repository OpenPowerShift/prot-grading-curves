/**
 * The command-line interface.
 *
 * The CLI is a shipped entry point -- `tc-curves study.tc -o study.svg`
 * is how the tool is used outside the playground -- and it had no tests
 * at all. Its exit status is the contract: 0 clean, 1 validation
 * errors, 2 usage or I/O failure, and a build script somewhere is
 * branching on that.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '@tc/cli';

const GOOD = `
system { voltages { "MV" { V = 11 kV; } } }
faults { "F" { I = 6 kA; type = three_phase; voltage = "MV"; } }
relay R_FDR { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tms = 0.10; } }
relay R_INC { voltage = "MV"; ct_ratio = 1200/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 960 A; tms = 0.25; } }
grade { primary = R_FDR:51; backup = R_INC:51; fault = "F"; margin = 0.30 s; }
view "Sheet A" { default = true; voltage = "MV"; title = "First sheet"; }
view "Sheet B" { voltage = "MV"; quantity = phase; title = "Second sheet"; }
`;

/** A study the validator rejects, for the exit-status-1 path. */
const BAD_SETTING = `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 480 A; tsm = 0.10; } }
`;

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-cli-'));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe('argument parsing', () => {
  it('reads the output path and format flags', () => {
    const o = parseArgs(['render', 'study.tc', '--pdf', '-o', 'out.pdf', '--size', 'A3', '--portrait']);
    expect(o.input).toBe('study.tc');
    expect(o.format).toBe('pdf');
    expect(o.output).toBe('out.pdf');
    expect(o.size).toBe('A3');
    expect(o.orientation).toBe('portrait');
  });

  it('reads the PNG sizing flags', () => {
    const o = parseArgs(['render', 's.tc', '--png', '--width', '1600', '--scale', '3']);
    expect(o.format).toBe('png');
    expect(o.width).toBe(1600);
    expect(o.scale).toBe(3);
  });

  it('names the subcommand it was given', () => {
    expect(parseArgs(['check', 's.tc']).command).toBe('check');
    expect(parseArgs(['report', 's.tc']).command).toBe('report');
    expect(parseArgs(['render', 's.tc']).command).toBe('render');
  });

  it('takes a view by name, and the quiet flag', () => {
    const o = parseArgs(['render', 's.tc', '--view', 'Sheet B', '-q']);
    expect(o.view).toBe('Sheet B');
    expect(o.quiet).toBe(true);
  });

  it('treats -h as a request for help rather than a file', () => {
    expect(parseArgs(['-h']).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
  });
});

describe('exit status', () => {
  it('is 0 for a study that validates', async () => {
    const file = write('good.tc', GOOD);
    expect(await main(['render', file, '-o', join(dir, 'out.svg')])).toBe(0);
  });

  it('is 1 when the study has validation errors', async () => {
    const file = write('bad.tc', BAD_SETTING);
    expect(await main(['render', file, '-o', join(dir, 'out.svg')])).toBe(1);
    expect(err.join('\n')).toMatch(/UNKNOWN_SETTING/);
  });

  it('prints usage and succeeds when given nothing', async () => {
    /* No subcommand is a request for help, not a mistake. */
    expect(await main([])).toBe(0);
    expect(out.join('\n')).toMatch(/Usage:/);
  });

  it('is 2 for a subcommand it does not know', async () => {
    expect(await main(['frobnicate', 'x.tc'])).toBe(2);
    expect(err.join('\n')).toMatch(/unknown command/);
  });

  it('is 2 for an option it does not know', async () => {
    expect(await main(['render', 'x.tc', '--wat'])).toBe(2);
    expect(err.join('\n')).toMatch(/unknown option/);
  });

  it('is 2 when the input cannot be read', async () => {
    expect(await main(['render', join(dir, 'nothing-here.tc')])).toBe(2);
    expect(err.join('\n')).toMatch(/cannot read/);
  });

  it('is 0 for --help, which goes to stdout', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(out.join('\n')).toMatch(/Usage:/);
  });
});

describe('rendering', () => {
  it('names the output after the study when none is given', async () => {
    /* The default is `<stem>.<format>` in the working directory, so
     * the test runs from the temp directory rather than the repo. */
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      write('good.tc', GOOD);
      expect(await main(['render', 'good.tc'])).toBe(0);
      expect(existsSync(join(dir, 'good.svg'))).toBe(true);
      expect(readFileSync(join(dir, 'good.svg'), 'utf8')).toContain('<svg');
    } finally {
      process.chdir(cwd);
    }
  });

  it('honours an explicit output path', async () => {
    const file = write('good.tc', GOOD);
    const target = join(dir, 'named.svg');
    expect(await main(['render', file, '-o', target])).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it('report prints the margins and writes nothing', async () => {
    const file = write('good.tc', GOOD);
    expect(await main(['report', file])).toBe(0);
    expect(out.join('\n')).toMatch(/achieved margin/);
    expect(existsSync(join(dir, 'good.svg'))).toBe(false);
  });

  it('check says so when a study is clean, and is quiet on request', async () => {
    const file = write('good.tc', GOOD);
    expect(await main(['check', file])).toBe(0);
    expect(out.join('\n')).toMatch(/no errors/);

    out.length = 0;
    expect(await main(['check', file, '--quiet'])).toBe(0);
    expect(out.join('\n')).toBe('');
  });

  it('check reports a broken study without writing a sheet', async () => {
    const file = write('bad.tc', BAD_SETTING);
    expect(await main(['check', file])).toBe(1);
  });

  it('draws the view named on the command line', async () => {
    /*
     * A study with several sheets renders one of them. Getting the
     * wrong sheet is not an error the output announces, so the title
     * is checked rather than merely that something was written.
     */
    const file = write('good.tc', GOOD);
    const target = join(dir, 'b.svg');
    expect(await main(['render', file, '--view', 'Sheet B', '-o', target])).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('Second sheet');
  });

  it('falls back to the default view when none is named', async () => {
    const file = write('good.tc', GOOD);
    const target = join(dir, 'a.svg');
    await main(['render', file, '-o', target]);
    expect(readFileSync(target, 'utf8')).toContain('First sheet');
  });

  it('reports a view name the study does not declare', async () => {
    const file = write('good.tc', GOOD);
    const code = await main(['render', file, '--view', 'Sheet Z', '-o', join(dir, 'z.svg')]);
    expect([1, 2]).toContain(code);
    expect(err.join('\n')).toMatch(/Sheet Z/);
  });
});

describe('a study that parses but says nothing', () => {
  it('still exits cleanly and writes a sheet', async () => {
    /*
     * An empty-but-valid file is a legitimate starting point -- someone
     * has declared their voltages and not yet added a relay -- and it
     * should not be treated as a failure.
     */
    const file = write('bare.tc', 'system { voltages { "MV" { V = 11 kV; } } }\n');
    expect(await main(['render', file, '-o', join(dir, 'bare.svg')])).toBe(0);
    expect(existsSync(join(dir, 'bare.svg'))).toBe(true);
  });
});

describe('a study with errors', () => {
  /*
   * The sheet used to be written anyway: diagnostics to stderr, exit
   * status 1, and a plausible drawing built on whatever the broken
   * settings defaulted to. The exit status is no protection -- nobody
   * reads it, and the file outlives the shell that made it.
   */
  it('is not drawn', async () => {
    const file = write('bad.tc', BAD_SETTING);
    const target = join(dir, 'bad.svg');
    expect(await main(['render', file, '-o', target])).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(err.join('\n')).toMatch(/no sheet written/);
  });

  it('is drawn on request, and stamped when it is', async () => {
    const file = write('bad.tc', BAD_SETTING);
    const target = join(dir, 'forced.svg');
    expect(await main(['render', file, '-o', target, '--force'])).toBe(1);
    expect(existsSync(target)).toBe(true);
    /* Unstamped it would be indistinguishable from a good sheet, which
     * is the only reason refusing to write was worth doing. */
    expect(readFileSync(target, 'utf8')).toMatch(/NOT VALID/);
  });

  it('names how many errors the forced sheet was drawn from', async () => {
    const file = write('bad.tc', BAD_SETTING);
    const target = join(dir, 'forced2.svg');
    await main(['render', file, '-o', target, '--force']);
    expect(readFileSync(target, 'utf8')).toMatch(/WITH \d+ ERROR/);
  });

  it('leaves a clean study unstamped', async () => {
    const file = write('good.tc', GOOD);
    const target = join(dir, 'good.svg');
    await main(['render', file, '-o', target]);
    expect(readFileSync(target, 'utf8')).not.toMatch(/NOT VALID/);
  });
});
