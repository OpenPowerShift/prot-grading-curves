/**
 * `times` -- required clearances, drawn as horizontal rules.
 *
 * The other axis's answer to a `fault`. A coordination study is judged
 * against currents *and* against times -- an arc-flash limit, a
 * withstand, a grid-code clearance -- and those are lines the curves
 * must sit under. Written down, the sheet shows the requirement beside
 * the characteristic that has to meet it, instead of the reader holding
 * the number in their head.
 */

import { describe, expect, it } from 'vitest';
import { parseAndRender, process } from '@tc/index';
import { LabelPlacer, type Rect } from '@tc/renderer/labels';

const STUDY = `
system { voltages { "HV" { V  = 33 kV; } } }
faults { "Bus max" { I   = 9 kA; voltage = "HV"; } }

times {
    "Arc flash limit"     { t   = 200 ms; description = "PPE category boundary"; }
    "Grid code clearance" { t   = 430 ms; }
    "Bus zone backup"     { t   = 2 s; }
}

relay R {
  voltage = "HV"; ct_ratio = 250/1;
  element 51 { curve = iec.si; I_pickup = 400 A; tms = 0.2; }
}
view { voltage = "HV"; current_min = 100 A; current_max = 40 kA; }
`;

const result = process(STUDY);
const svg = parseAndRender(STUDY, { theme: 'light' }).svg;

/** The horizontal rules the sheet drew: name and time. */
function rules(src: string): Array<[string, number]> {
  return [...src.matchAll(/data-time-name="([^"]+)" data-time="([\d.]+)"/g)]
    .map((m) => [m[1], Number(m[2])] as [string, number]);
}

describe('declaring required times', () => {
  it('parses and validates', () => {
    expect(result.parseErrors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('resolves them by name, with their seconds folded', () => {
    expect([...result.study!.times.keys()])
      .toEqual(['Arc flash limit', 'Grid code clearance', 'Bus zone backup']);
    expect(result.study!.times.get('Arc flash limit')!.t_s).toBeCloseTo(0.2, 9);
    expect(result.study!.times.get('Bus zone backup')!.t_s).toBe(2);
  });

  it('rejects a repeated name, as a repeated fault is rejected', () => {
    /* Keyed by name, so a repeat replaces the first with nothing said
     * -- and which limit the sheet rules at becomes a question of
     * declaration order. */
    const codes = process(STUDY.replace('"Bus zone backup"', '"Arc flash limit"'))
      .diagnostics.map((d) => d.code);
    expect(codes).toContain('DUPLICATE_TIME');
  });

  it('rejects a time with no place on a logarithmic axis', () => {
    const codes = process(STUDY.replace('t   = 200 ms;', 't = 0 s;'))
      .diagnostics.map((d) => d.code);
    expect(codes).toContain('TIME_INVALID');
  });
});

describe('drawing them', () => {
  it('draws one horizontal rule each, at its own time', () => {
    expect(rules(svg)).toEqual([
      ['Arc flash limit', 0.2],
      ['Grid code clearance', 0.43],
      ['Bus zone backup', 2],
    ]);
  });

  it('spans the plot, unlike a fault rule which spans its height', () => {
    const rule = svg.match(
      /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" class="tc-time"/,
    );
    expect(rule).not.toBeNull();
    /* Horizontal: the ends share a y and differ in x. */
    expect(Number(rule![2])).toBeCloseTo(Number(rule![4]), 6);
    expect(Number(rule![3])).toBeGreaterThan(Number(rule![1]) + 100);
  });

  it('labels each one with its name and time', () => {
    expect(svg).toContain('Arc flash limit · 200 ms');
    expect(svg).toContain('Bus zone backup · 2 s');
  });

  it('keeps the label off its own rule', () => {
    /*
     * The worst case of all: the line running through the text it
     * belongs to. The rules are handed to the placer as obstacles, so
     * a caption steps above its own line.
     */
    const caption = svg.match(
      /<text x="([\d.-]+)" y="([\d.-]+)" text-anchor="(start|end)" font-size="11"[^>]*>Bus zone backup · 2 s</,
    );
    expect(caption).not.toBeNull();

    const FONT = 11;
    const text = 'Bus zone backup · 2 s';
    const w = text.length * FONT * 0.6;
    const box: Rect = {
      x: caption![3] === 'end' ? Number(caption![1]) - w : Number(caption![1]),
      y: Number(caption![2]) - FONT,
      w,
      h: FONT + 2,
    };

    const probe = new LabelPlacer({ x: 0, y: 0, w: 10_000, h: 10_000 });
    for (const [, y1, , y2] of [...svg.matchAll(
      /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" class="tc-time"/g,
    )].map((m) => m.slice(1).map(Number))) {
      probe.avoidLine([{ x: 0, y: y1 }, { x: 10_000, y: y2 }]);
    }
    expect(probe.onLine(box)).toBe(false);
  });

  it('lists them in their own legend section', () => {
    expect(svg).toContain('>Required times</text>');
    /* And the author's note on what the limit is. */
    expect(svg).toContain('PPE category boundary');
  });

  it('widens the time domain to hold a requirement', () => {
    /*
     * A limit off the sheet cannot be shown being met. A 4000 s
     * requirement pulls the top of the axis up to reach it.
     */
    const far = parseAndRender(
      STUDY.replace('"Bus zone backup"     { t   = 2 s; }', '"Long withstand" { t   = 4000 s; }'),
      { theme: 'light' },
    ).svg;
    expect(rules(far).map(([n]) => n)).toContain('Long withstand');
  });

  it('says when a declared bound puts one off the sheet', () => {
    /* An explicit `view` bound is authoritative, so the rule cannot be
     * drawn -- but the requirement is the point of the drawing, so its
     * absence is stated rather than silent. */
    const clipped = parseAndRender(
      STUDY.replace('view { voltage = "HV";',
        'view { voltage = "HV"; time_min = 10 ms; time_max = 1 s;'),
      { theme: 'light' },
    ).svg;
    expect(rules(clipped).map(([n]) => n)).not.toContain('Bus zone backup');
    expect(clipped).toContain('Bus zone backup (2 s) is outside the plotted times');
  });

  it('leaves a study with no times exactly as it was', () => {
    const none = parseAndRender(
      STUDY.replace(/times \{[\s\S]*?\n\}\n/, ''), { theme: 'light' },
    ).svg;
    expect(rules(none)).toHaveLength(0);
    expect(none).not.toContain('Required times');
  });
});

describe('a required time and a fault rule together', () => {
  it('keeps their captions off each other', () => {
    const both = parseAndRender(STUDY, { theme: 'light' }).svg;
    /* Both kinds of furniture are present and distinguishable. */
    expect(both).toContain('class="tc-time"');
    expect(both).toContain('class="tc-fault"');
    expect(both).toContain('>Bus max</text>');
  });

  it('styles them apart, so the axis each belongs to is obvious', () => {
    const timeStroke = svg.match(/class="tc-time"[^/]*stroke="([^"]+)"/)![1];
    const faultStroke = svg.match(/class="tc-fault"[^/]*stroke="([^"]+)"/)![1];
    expect(timeStroke).not.toBe(faultStroke);
  });

  it('takes styling from page { times }', () => {
    const styled = parseAndRender(
      `${STUDY}\npage { times = { color = "#0000ff"; width_px = 3; style = "solid"; }; }`,
      { theme: 'light' },
    ).svg;
    expect(styled).toMatch(/class="tc-time"[^/]*stroke="#0000ff"[^/]*stroke-width="3"/);
    expect(styled).not.toMatch(/class="tc-time"[^/]*stroke-dasharray/);
  });

  it('can have its labels turned off, keeping the rules', () => {
    /*
     * The plot caption goes; the legend entry stays, since that is what
     * still names the rule. Matched on the placed-label form -- a
     * `text-anchor`ed text with no legend class -- rather than on the
     * words, which appear in both places.
     */
    const onPlot = (src: string): number =>
      [...src.matchAll(/<text x="[\d.-]+" y="[\d.-]+" text-anchor="(?:start|end)" font-size="11"[^>]*>Arc flash limit · 200 ms</g)].length;

    const bare = parseAndRender(
      `${STUDY}\npage { times = { labels = false; }; }`, { theme: 'light' },
    ).svg;
    expect(rules(bare)).toHaveLength(3);
    expect(onPlot(svg)).toBe(1);
    expect(onPlot(bare)).toBe(0);
    /* Still listed, so the requirement is not lost. */
    expect(bare).toContain('>Required times</text>');
  });
});
