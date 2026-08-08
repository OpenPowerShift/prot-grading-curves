/**
 * The playground findings that are testable without a browser.
 *
 * A browser review on 2026-08-07 listed nine usability defects. Most
 * are CSS or gesture behaviour and are only checkable by looking;
 * these are the ones with logic behind them, so they are pinned here
 * rather than left to be re-found.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { process as parse, renderStudy } from '@tc/index';
import '@tc/components/tc-app.js';
import '@tc/components/tc-viewer.js';

describe('a study whose settings the tool would have to invent', () => {
  /*
   * `--force` exists to let someone look at what a broken study draws,
   * and the NOT VALID banner says the study is broken. An inverse-time
   * stage with no `tms` was still drawn, at the 1.0 the evaluator
   * falls back to -- so under a banner warning that the study is wrong
   * sat a confident characteristic about ten times slow, which is
   * exactly what `TMS_MISSING` says would happen.
   */
  const NO_TMS = `
system { voltages { MV { V = 11 kV; } } }
relay R { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; } }
view { voltage = MV; current_min = 100 A; current_max = 30 kA;
       time_min = 20 ms; time_max = 100 s; }
`;

  it('still refuses the study', () => {
    expect(parse(NO_TMS).diagnostics.map((d) => d.code)).toContain('TMS_MISSING');
  });

  it('draws no curve for it', () => {
    const svg = renderStudy(parse(NO_TMS), { theme: 'light' });
    expect(svg).not.toMatch(/class="tc-curve"/);
  });

  it('says which curve is missing and why, rather than leaving a blank sheet', () => {
    const svg = renderStudy(parse(NO_TMS), { theme: 'light' });
    expect(svg).toMatch(/no tms/);
    expect(svg).toContain('R:51');
  });

  it('draws it once the multiplier is given', () => {
    const svg = renderStudy(parse(NO_TMS.replace('I_pickup = 400 A;', 'I_pickup = 400 A; tms = 0.2;')),
      { theme: 'light' });
    expect(svg).toMatch(/class="tc-curve"/);
  });
});

describe('a misspelt key inside faults', () => {
  const codes = (body: string): string[] => {
    const r = parse(`system { voltages { MV { V = 11 kV; } } }
faults { F { ${body} } }
relay R { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }
view { voltage = MV; }`);
    return [...r.parseErrors, ...r.diagnostics].map((d) => d.code);
  };

  it('is refused, as it is in every other block of numbers', () => {
    /*
     * It was a warning, and the value was dropped: `typ = two_phase`
     * left the fault with no type at all, so its components were never
     * derived and every margin resting on them changed -- reported as
     * advice, at exit 0.
     */
    expect(codes('I = 6 kA; typ = two_phase; voltage = MV;'))
      .toContain('UNKNOWN_SETTING');
  });

  it('leaves the correctly spelt key alone', () => {
    expect(codes('I = 6 kA; type = two_phase; voltage = MV;'))
      .not.toContain('UNKNOWN_SETTING');
  });
});

describe('the file an export is written to', () => {
  let host: HTMLDivElement;
  type Viewer = HTMLElement & { updateComplete: Promise<unknown> };

  const stem = (el: Viewer): string =>
    (el as unknown as Record<string, () => string>).exportStem();

  const withStudy = async (source: string, viewIndex = 0): Promise<Viewer> => {
    const el = document.createElement('tc-viewer') as Viewer;
    host.append(el);
    const r = parse(source);
    (el as unknown as Record<string, unknown>).study = r.study;
    (el as unknown as Record<string, unknown>).document = r.document;
    (el as unknown as Record<string, unknown>).viewIndex = viewIndex;
    await el.updateComplete;
    return el;
  };

  beforeEach(() => { host = document.createElement('div'); document.body.append(host); });
  afterEach(() => { host.remove(); });

  it('is named from the project', async () => {
    const el = await withStudy(`meta { project = "Northgate 33/11 kV"; }
system { voltages { MV { V = 11 kV; } } }
view { voltage = MV; }`);
    expect(stem(el)).toBe('northgate-33-11-kv');
  });

  it('falls back to the study name before "tcc"', async () => {
    /*
     * A study with no `meta.project` -- the starter among them, which
     * is what an exploring reader exports first -- fell straight to
     * `tcc`, so a folder of issued sheets read `tcc.pdf`, `tcc (1).pdf`.
     */
    const el = await withStudy(`meta { study = "Phase overcurrent cascade"; }
system { voltages { MV { V = 11 kV; } } }
view { voltage = MV; }`);
    expect(stem(el)).toBe('phase-overcurrent-cascade');
  });

  it('names the sheet where a study has more than one', async () => {
    /*
     * The other half of the same complaint: one stem for every sheet,
     * so exporting a phase sheet and an earth sheet from one file gave
     * two files the browser had to number.
     */
    const src = `meta { project = "Cardross"; }
system { voltages { MV { V = 11 kV; } } }
view PHASE { name = "Phase"; voltage = MV; }
view EARTH { name = "Earth fault"; voltage = MV; }`;
    expect(stem(await withStudy(src, 0))).toBe('cardross-phase');
    expect(stem(await withStudy(src, 1))).toBe('cardross-earth-fault');
  });

  it('leaves a single-sheet study unsuffixed', async () => {
    const el = await withStudy(`meta { project = "Cardross"; }
system { voltages { MV { V = 11 kV; } } }
view { voltage = MV; }`);
    expect(stem(el)).toBe('cardross');
  });
});

describe('the shipped examples', () => {
  it('all produce a filename of their own', async () => {
    /*
     * The guard on the whole complaint: no two exports from the
     * library land on the same name, and none falls back to `tcc`.
     */
    const { readdirSync } = await import('node:fs');
    const stems = new Map<string, string>();
    for (const file of readdirSync('examples').filter((f) => f.endsWith('.ptc'))) {
      const study = parse(readFileSync(`examples/${file}`, 'utf8')).study!;
      const meta = study.meta;
      const text = (v: unknown): string | undefined =>
        typeof v === 'string' && v.trim() ? v.trim() : undefined;
      const stem = (text(meta?.project) ?? text(meta?.study) ?? 'tcc')
        .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
      const clash = stems.get(stem);
      expect(clash, `${file} and ${clash} would both export as ${stem}`).toBeUndefined();
      stems.set(stem, file);
    }

    /*
     * `tcc` is the right answer for a study that names itself nothing,
     * and the minimal example deliberately declares no `meta` at all
     * -- that is what makes it minimal. What was wrong was reaching it
     * while `meta.study` sat unread, which is now checked above.
     */
    expect(stems.get('tcc') ?? '00-minimal.ptc').toBe('00-minimal.ptc');
  });
});
