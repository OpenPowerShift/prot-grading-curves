/**
 * A finding reports where it was written.
 *
 * 21 diagnostics reported at `1:1`, 20 of them hard errors -- and the
 * location is a clickable go-to-line in the playground, so on a
 * 300-line study every one of them landed at the top of the file and
 * the reader had to find the fault by reading.
 *
 * The cause was structural rather than per-site: `Fault`, `Relay`,
 * `Device`, `StudyPoint`, `VoltageLevel`, `Group` and `Annotation`
 * carried no source location at all, so every check about one had
 * nothing to pass and passed `undefined`.
 *
 * This is the guard rather than a case-by-case list: one study with a
 * different mistake on every line, and nothing may report at `1:1`.
 */

import { describe, expect, it } from 'vitest';
import { process as parse } from '@tc/index';

/*
 * Each mistake is alone on its own line, and no two are of a kind, so
 * a finding at `1:1` is a check that has nothing to point at rather
 * than one that merely points at the wrong thing.
 */
const WRONG = `system {
  voltages {
    MV { V = 11 kV; }
    BAD { V = 0 kV; }
  }
}
faults {
  F_NEG { I = -5 A; type = three_phase; voltage = MV; }
  F_GHOST { I = 1 kA; voltage = NOPE; }
  F_RANGE { I = 1 kA; I0 = 100 A; I0_min = 50 A; voltage = MV; }
}
device D_EMPTY {
  kind = cable;
  voltage = ALSO_NOPE;
}
point P_BAD { I = 0 A; t = 1 s; label = "x"; }
point P_TIME { I = 100 A; t = 0 s; label = "y"; }
relay R_GHOST { voltage = MISSING; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
group G { members = [NOT_A_RELAY]; }
view { voltage = MV; }
`;

const findings = () => {
  const r = parse(WRONG);
  return [...r.parseErrors, ...r.diagnostics];
};

describe('every finding on a study of mistakes', () => {
  it('raises a good number of them, or this proves nothing', () => {
    expect(findings().length).toBeGreaterThan(8);
  });

  it('reports none of them at 1:1', () => {
    const atOrigin = findings()
      .filter((d) => d.line === 1 && d.column === 1)
      .map((d) => `${d.code}: ${d.message.slice(0, 60)}`);
    expect(atOrigin, 'reported at the top of the file').toEqual([]);
  });

  it('reports each within the file, not past its end', () => {
    const lines = WRONG.split('\n').length;
    for (const d of findings()) {
      expect(d.line, `${d.code}`).toBeGreaterThan(0);
      expect(d.line, `${d.code}`).toBeLessThanOrEqual(lines);
    }
  });

  it('points at the block the message names', () => {
    /*
     * A location inside the file is not enough: it has to be the
     * right block. Each of these is checked against the line its own
     * subject is declared on.
     */
    const lineOf = (needle: string): number =>
      WRONG.split('\n').findIndex((l) => l.includes(needle)) + 1;

    const at = (code: string, subject: string): void => {
      const d = findings().find((x) => x.code === code && x.message.includes(subject));
      expect(d, `${code} about ${subject}`).toBeDefined();
      expect(d!.line, `${code} about ${subject}`).toBe(lineOf(subject));
    };

    at('VOLTAGE_LEVEL_INVALID', 'BAD');
    at('FAULT_CURRENT_INVALID', 'F_NEG');
    at('VOLTAGE_UNKNOWN', 'F_GHOST');
    at('RANGE_INCOMPLETE', 'F_RANGE');
    at('DEVICE_NO_CURVE', 'D_EMPTY');
    at('POINT_CURRENT_INVALID', 'P_BAD');
    at('POINT_TIME_INVALID', 'P_TIME');
    at('VOLTAGE_UNKNOWN', 'R_GHOST');
    at('UNRESOLVED_GROUP_MEMBER', 'NOT_A_RELAY');
  });
});

describe('a mistake both the validator and the grading find', () => {
  /*
   * `UNRESOLVED_REFERENCE` was reported twice for one typo -- once at
   * its real line by the validator, once at `1:1` by the grade report
   * -- which inflated `counts.errors` in the JSON and reached the
   * drawing, where a `--force` sheet read "DRAWN FROM A STUDY WITH 2
   * ERRORS".
   */
  const BAD_REF = `system { voltages { MV { V = 11 kV; } } }
faults { F { I = 6 kA; type = three_phase; voltage = MV; } }
relay R { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.1; } }
grade { primary = R:51; backup = R_MISSING:51; fault = F; margin = 0.3 s; }
view { voltage = MV; }
`;

  it('is counted once', () => {
    const r = parse(BAD_REF);
    const unresolved = r.diagnostics.filter((d) => d.code === 'UNRESOLVED_REFERENCE');
    expect(unresolved).toHaveLength(1);
  });

  it('keeps the copy that knows where it is', () => {
    const d = parse(BAD_REF).diagnostics.find((x) => x.code === 'UNRESOLVED_REFERENCE');
    expect(d!.line).toBeGreaterThan(1);
  });

  it('still reports a grading error the validator does not find', () => {
    /*
     * The deduplication must not swallow the findings that only
     * grading can make -- that was the whole point of joining them.
     */
    const r = parse(`system { voltages { MV { V = 11 kV; } } }
faults { F { I = 60 kA; type = three_phase; voltage = MV; } }
relay R_P { voltage = MV; ct_ratio = 400/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 400 A; tms = 0.1;
               I_cutoff = 20 kA; } }
relay R_B { voltage = MV; ct_ratio = 800/5;
  element 51 { function = phase_oc; curve = iec.si; I_pickup = 800 A; tms = 0.3; } }
grade { primary = R_P:51; backup = R_B:51; fault = F; margin = 0.3 s; upstream = false; }
view { voltage = MV; }
`);
    expect(r.diagnostics.map((d) => d.code)).toContain('GRADE_BEYOND_CUTOFF');
  });
});

describe('the shipped examples', () => {
  it('report nothing at 1:1 either', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync('examples').filter((f) => f.endsWith('.ptc'));
    expect(files.length).toBeGreaterThan(10);

    const stuck: string[] = [];
    for (const file of files) {
      const r = parse(readFileSync(`examples/${file}`, 'utf8'));
      for (const d of [...r.parseErrors, ...r.diagnostics]) {
        if (d.line === 1 && d.column === 1) stuck.push(`${file}: ${d.code}`);
      }
    }
    expect(stuck).toEqual([]);
  });
});
