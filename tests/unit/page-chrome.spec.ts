/**
 * The sheet's furniture: the declared theme, and the title block.
 *
 * Two reported faults, both of the same kind -- a setting written in
 * the source that the drawing appeared to ignore.
 */

import { describe, expect, it } from 'vitest';
import { process, renderStudy } from '@tc/index';

const SYS = 'system { voltages { "MV" { V = 11 kV; } } }\n';
const RELAY = `relay R { voltage = "MV"; ct_ratio = 400/5;
  element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 400 A; tms = 0.2; } }`;

const sheet = (page: string): string =>
  renderStudy(process(`${SYS}${RELAY}\npage { ${page} }\nview { voltage = "MV"; }`),
    { theme: 'light' });

describe('a theme declared in the source', () => {
  /*
   * The playground passed its own UI preference for the plot
   * unconditionally, so `page { theme = "dark" }` did nothing on
   * screen and the sheet being looked at was not the sheet that would
   * be exported -- with nothing to say which one you were seeing.
   */
  it('reaches the study, so the app can honour it', () => {
    const study = process(`${SYS}${RELAY}\npage { theme = "dark"; }`).study;
    expect(study?.page?.theme).toBe('dark');
  });

  it('is absent when nothing declares one, leaving the UI preference to decide', () => {
    const study = process(`${SYS}${RELAY}`).study;
    expect(study?.page?.theme).toBeUndefined();
  });

  it('draws dark when the renderer is given it', () => {
    const src = `${SYS}${RELAY}\npage { theme = "dark"; }\nview { voltage = "MV"; }`;
    const dark = renderStudy(process(src), { theme: 'dark' });
    const light = renderStudy(process(src), { theme: 'light' });
    expect(dark).not.toBe(light);
    expect(/background:\s*#([0-9a-f]{6})/.exec(dark)![1])
      .not.toBe(/background:\s*#([0-9a-f]{6})/.exec(light)![1]);
  });
});

describe('the title block', () => {
  const WITH_BOTH = (size: number): string => sheet(
    `border = true; title = { text = "Heading"; subtitle = "Subtitle line"; };
     footer = { left = "FOOT"; font_size_px = ${size}; };`);

  /** Baseline of a named piece of text, and the size it is set at. */
  const textAt = (svg: string, label: string): { y: number; size: number } => {
    const m = new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*font-size="([\\d.]+)"[^>]*>${label}<`)
      .exec(svg);
    expect(m, `${label} was drawn`).not.toBeNull();
    return { y: Number(m![1]), size: Number(m![2]) };
  };

  it('applies the footer font size it was given', () => {
    for (const size of [4, 10, 18]) {
      expect(textAt(WITH_BOTH(size), 'FOOT').size).toBe(size);
    }
  });

  it('keeps the footer clear of the subtitle at every size', () => {
    /*
     * The block was a flat 54 px whatever was in it, with the footer
     * pinned 6 px above its bottom edge -- so a block carrying both a
     * subtitle and a footer put their baselines 8 px apart. They
     * overlapped at the default size and collided outright at any
     * larger one, which is why setting `font_size_px` looked like it
     * did nothing: the text grew into the line above it.
     */
    for (const size of [4, 8, 11, 14, 20]) {
      const svg = WITH_BOTH(size);
      const foot = textAt(svg, 'FOOT');
      const sub = textAt(svg, 'Subtitle line');
      const clearance = (foot.y - foot.size) - sub.y;
      expect(clearance, `footer overlaps the subtitle at ${size}px`).toBeGreaterThan(0);
    }
  });

  it('grows with its contents rather than clipping them', () => {
    const small = textAt(WITH_BOTH(4), 'Subtitle line').y;
    const large = textAt(WITH_BOTH(20), 'Subtitle line').y;
    /* A bigger footer pushes the text above it up, not off. */
    expect(large).toBeLessThan(small);
  });

  it('stays compact when there is no footer and no subtitle', () => {
    const bare = sheet('border = true; title = { text = "Heading"; };');
    const full = WITH_BOTH(11);
    const plotOf = (svg: string): number => Number(/data-plot="[\d.]+,[\d.]+,[\d.]+,([\d.]+)"/.exec(svg)![1]);
    /* More furniture means less plot; a bare block must not pay for
     * space it does not use. */
    expect(plotOf(bare)).toBeGreaterThan(plotOf(full));
  });
});
