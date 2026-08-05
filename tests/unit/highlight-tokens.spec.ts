/**
 * What colour the editor paints each word.
 *
 * Three reported inconsistencies, all of them one thing being drawn
 * two ways: a device number split across two colours, two fields in
 * one block coming out differently, and two of the four page margins
 * not reading as fields at all.
 */

import { describe, expect, it } from 'vitest';
import { tcLanguage } from '@tc/highlight/tc-language';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Token classes for one line, as `text=class` pairs. */
function tokens(line: string): Record<string, string> {
  const parser = (tcLanguage as any).streamParser;
  const state = parser.startState();
  const out: Record<string, string> = {};
  const stream: any = {
    pos: 0, start: 0, string: line,
    eol() { return this.pos >= this.string.length; },
    peek() { return this.string[this.pos]; },
    next() { return this.string[this.pos++]; },
    eatSpace() {
      const s = this.pos;
      while (/\s/.test(this.string[this.pos])) this.pos++;
      return this.pos > s;
    },
    skipToEnd() { this.pos = this.string.length; },
    match(p: any, consume = true) {
      if (typeof p === 'string') {
        if (this.string.startsWith(p, this.pos)) {
          if (consume !== false) this.pos += p.length;
          return true;
        }
        return null;
      }
      const m = p.exec(this.string.slice(this.pos));
      if (m && m.index === 0) {
        if (consume !== false) this.pos += m[0].length;
        return m;
      }
      return null;
    },
  };
  let guard = 0;
  while (!stream.eol() && guard++ < 500) {
    stream.start = stream.pos;
    const cls = parser.token(stream, state);
    if (stream.pos === stream.start) stream.pos++;
    const text = line.slice(stream.start, stream.pos).trim();
    if (text) out[text] = cls ?? '-';
  }
  return out;
}

describe('a device number', () => {
  it('is one token, letters and all', () => {
    /* `50` matched as a number and `G` fell to the identifier rule, so
     * an element id was drawn in two colours while `51` beside it was
     * drawn in one. */
    expect(tokens('element 50G {')['50G']).toBe('variableName');
  });

  for (const id of ['51G', '67N', '51X', '87T']) {
    it(`keeps ${id} whole`, () => {
      expect(tokens(`element ${id} {`)[id]).toBe('variableName');
    });
  }

  it('leaves a plain number alone', () => {
    expect(tokens('element 51 {')['51']).toBe('number');
  });

  it('does not swallow a value that is followed by a unit', () => {
    /*
     * A value and its suffix are emitted as one `unit` span -- the
     * number rule reaches past the space to claim it. What matters
     * here is that the device-number rule did not take `480` first
     * and leave `A` stranded: whitespace still separates a value from
     * its unit, which is the rule that keeps `67N` one token and
     * `480 A` two things.
     */
    const t = tokens('I_pickup = 480 A;');
    expect(t['480 A']).toBe('unit');
  });

  it('still reads a ratio as two numbers', () => {
    const t = tokens('ct_ratio = 600/5;');
    expect(t['600']).toBe('number');
    expect(t['5']).toBe('number');
  });
});

describe('two fields in one block', () => {
  it('are drawn the same way', () => {
    const t = tokens('annotate { label = "x"; fault = "F"; }');
    expect(t.label).toBe('propertyName');
    expect(t.fault).toBe(t.label);
  });

  it('stay the same when a semicolon is missing', () => {
    /*
     * `afterEquals` was cleared only by a `;` or a brace, so a
     * statement written without its semicolon left the flag set and
     * the *next* field was painted as a value. The highlighter cannot
     * supply the missing semicolon, but it should not mislead about
     * the line after it.
     */
    const t = tokens('annotate { fault = "F" label = "x"; }');
    expect(t.fault).toBe('propertyName');
    expect(t.label).toBe('propertyName');
  });

  it('recovers after an unterminated number too', () => {
    const t = tokens('times { t = 430 ms at_I = 200 A; }');
    expect(t.at_I).toBe('propertyName');
  });
});

describe('the four page margins', () => {
  it('are all fields', () => {
    /* `left` and `right` were fields because the footer uses them;
     * `top` and `bottom` were field names nowhere in the language. */
    const t = tokens('margins_mm = { top = 2; right = 2; bottom = 2; left = 2; };');
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(t[side], side).toBe('propertyName');
    }
  });
});
