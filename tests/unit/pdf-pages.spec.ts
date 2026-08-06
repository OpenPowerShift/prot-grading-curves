/**
 * The combined PDF, end to end.
 *
 * `svg2pdf` calls `getBBox`, which jsdom does not implement, so this
 * cannot be a unit test without stubbing out the very thing under
 * test. It runs the CLI instead and counts pages in the file that
 * lands on disk, which is the artefact anyone actually receives.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** Pages, counted out of the PDF's own object dictionary. */
const pageCount = (pdf: Buffer): number =>
  [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page[^s]/g)].length;

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tc-pdf-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const render = async (args: string[]): Promise<Buffer> => {
  const out = join(dir, `${args.join('_').replace(/\W+/g, '')}.pdf`);
  await run('npx', ['tsx', 'src/cli.ts', 'render', 'examples/18-bess-two-chains.ptc',
    '--pdf', ...args, '-o', out, '--quiet']);
  return readFile(out);
};

describe('rendering every view to one PDF', () => {
  it('binds a page per declared sheet', async () => {
    /*
     * Kestrel Rise declares four: phase and negative sequence for each
     * of two chains. They are one document -- issued, filed and
     * reviewed together -- and four separate files is four chances for
     * one of them to be the old revision.
     */
    expect(pageCount(await render(['--all-views']))).toBe(4);
  }, 60_000);

  it('still writes one page without it', async () => {
    expect(pageCount(await render([]))).toBe(1);
  }, 60_000);

  it('refuses --all-views for a single-image format', async () => {
    /*
     * An SVG or a PNG is one image by definition; there is nothing to
     * bind pages into, so the request is refused rather than silently
     * giving the default sheet.
     */
    await expect(run('npx', ['tsx', 'src/cli.ts', 'render',
      'examples/18-bess-two-chains.ptc', '--png', '--all-views',
      '-o', join(dir, 'x.png')])).rejects.toThrow(/all-views needs --pdf/);
  }, 60_000);
});
