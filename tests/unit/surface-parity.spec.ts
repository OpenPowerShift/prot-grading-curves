/**
 * The CLI and the playground must say the same thing about a study.
 *
 * They did not. The CLI refused to write a sheet from a study with
 * errors, and stamped a forced one `NOT VALID` -- its own comment
 * saying, rightly, that the moment it is a file it is
 * indistinguishable from a good one and that file is what gets
 * attached to an email. The playground drew the same study cleanly,
 * with every export button live: a study with nine errors produced a
 * professional-looking sheet at a thousand times and a thousandth of
 * the intended settings.
 *
 * The way to keep two surfaces agreeing is not to describe the policy
 * twice. The stamp is drawn by the renderer, the verdict comes from
 * `verdictOf`, and the machine-readable form comes from `jsonResult` --
 * so what is checked here is that there is one implementation to
 * disagree with.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { process as parse, renderStudy, SVG_LAYERS } from '@tc/index';

const BROKEN = `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 4 KA; } }
view { voltage = "MV"; }
`;

const errorsIn = (src: string): number => {
  const r = parse(src);
  return r.parseErrors.filter((e) => e.severity === 'error').length
    + r.diagnostics.filter((d) => d.severity === 'error').length;
};

describe('a sheet drawn from a study with errors', () => {
  it('says so on its face', () => {
    const count = errorsIn(BROKEN);
    expect(count).toBeGreaterThan(0);
    const svg = renderStudy(parse(BROKEN), { theme: 'light', invalidErrors: count });
    expect(svg).toContain('NOT VALID');
    expect(svg).toContain(`WITH ${count} ERROR`);
  });

  it('carries the stamp as a layer, not as an afterthought', () => {
    /*
     * The CLI used to append it by string surgery on `</svg>`, which
     * put the one mark saying the drawing is wrong outside the layer
     * model -- so a consumer recomposing the sheet from its layers
     * dropped exactly that mark.
     */
    const svg = renderStudy(parse(BROKEN), { theme: 'light', invalidErrors: 2 });
    expect(svg).toMatch(/<g data-layer="invalid">/);
    expect([...SVG_LAYERS]).toContain('invalid');
  });

  it('is not stamped when the study is sound', () => {
    const clean = parse(readFileSync('examples/01-riverside.ptc', 'utf8'));
    expect(errorsIn(readFileSync('examples/01-riverside.ptc', 'utf8'))).toBe(0);
    const svg = renderStudy(clean, { theme: 'light', invalidErrors: 0 });
    expect(svg).not.toContain('NOT VALID');
    expect(svg).not.toMatch(/data-layer="invalid"/);
  });

  it('draws the stamp over everything, so it cannot be missed', () => {
    const svg = renderStudy(parse(BROKEN), { theme: 'light', invalidErrors: 1 });
    const invalid = svg.indexOf('data-layer="invalid"');
    const curves = svg.indexOf('data-layer="curves"');
    expect(invalid).toBeGreaterThan(curves);
  });
});

describe('the diagnostics both surfaces show', () => {
  it('include info, which the GUI used to drop', () => {
    /*
     * The CLI printed `FAULT_SINGLE_POINT` and the playground filtered
     * it out, so the two described the same file differently. Whether
     * it is worth saying is a separate question -- but it cannot be
     * worth saying in one place and not the other.
     */
    const r = parse(readFileSync('examples/01-riverside.ptc', 'utf8'));
    const infos = r.diagnostics.filter((d) => d.severity === 'info');
    expect(infos.length).toBeGreaterThan(0);
  });

  it('carry a real position, not 1:1', () => {
    /*
     * 1:1 is a clickable go-to-line that lands the reader at the top of
     * the file, which on a long study is worse than no link at all.
     * Unit errors were the sharpest case: the walker computed the
     * highlight width correctly and threw the anchor away.
     */
    const r = parse(BROKEN);
    const unit = r.diagnostics.find((d) => d.code === 'UNIT_WRONG_QUANTITY');
    expect(unit, 'the study should raise a unit error').toBeDefined();
    expect(unit!.line).toBeGreaterThan(1);
    expect(unit!.length).toBe('KA'.length);
  });

  it('point at the suffix, which is what the message is about', () => {
    const r = parse(BROKEN);
    const unit = r.diagnostics.find((d) => d.code === 'UNIT_WRONG_QUANTITY')!;
    const line = BROKEN.split('\n')[unit.line - 1];
    expect(line.slice(unit.column - 1, unit.column - 1 + unit.length)).toBe('KA');
  });

  it('anchor a parse error on the token, not past it', () => {
    /*
     * The lexer recorded a token's position *after* consuming it, so
     * every token's line and column described the character following
     * it and every anchored diagnostic was off by the token's width.
     * No test asserted a column, which is why it survived: the two
     * positions differ by a token, which reads as plausible until you
     * try to highlight the thing being complained about.
     */
    const src = 'relay R { element 51 { curve = @ } }';
    const errors = parse(src).parseErrors;
    const at = (e: { column: number; length: number }): string =>
      src.slice(e.column - 1, e.column - 1 + Math.max(1, e.length));

    const stray = errors.find((e) => e.code === 'UNEXPECTED_CHARACTER');
    expect(stray, 'the stray character should be reported').toBeDefined();
    expect(at(stray!)).toBe('@');

    /* And each error points at what its own message is about: the
     * missing value is a complaint about the `=`, not about `@`. */
    const missing = errors.find((e) => e.code === 'MISSING_VALUE');
    expect(missing, 'the empty assignment should be reported').toBeDefined();
    expect(at(missing!)).toBe('=');
  });

  it('report every occurrence, not just the first', () => {
    /*
     * The unknown-unit check deduped by suffix, which was defensible
     * when every finding landed at 1:1 and repeating it would have been
     * noise. With a lint gutter it means the second and third mistakes
     * are unmarked, and the reader fixes them one reload at a time.
     */
    const twice = `
system { voltages { "MV" { V = 11 kV; } } }
relay R { voltage = "MV"; ct_ratio = 600/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 4 KA; tms = 0.2; }
  element 50 { function = "phase_oc"; curve = definite; I_pickup = 9 KA; t_delay = 50 ms; } }
view { voltage = "MV"; }
`;
    const found = parse(twice).diagnostics.filter((d) => d.code === 'UNIT_WRONG_QUANTITY');
    expect(found).toHaveLength(2);
    expect(new Set(found.map((d) => d.line)).size).toBe(2);
  });
});
