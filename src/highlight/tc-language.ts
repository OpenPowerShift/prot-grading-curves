/**
 * CodeMirror syntax highlighting for `.ptc`.
 *
 * A hand-written `StreamParser` rather than a Lezer grammar: the
 * language is small and line-oriented, the token classes are decided
 * by the lexical rules in `spec/sections/lexical-structure.adoc`, and
 * a stream parser keeps highlighting alive inside a file that does not
 * yet parse -- which is the normal state of a file being typed.
 *
 * Token classes emitted (CodeMirror standard tags):
 *   comment      `#` and `//` to end of line, `/* ... *\/` spans
 *   keyword      block keywords: meta, system, relay, element, ...
 *   propertyName field names on the left of `=`
 *   string       double-quoted strings
 *   number       numeric literals, with the unit suffix as `unit`
 *   atom         curve identifiers (`iec.si`) and enum-ish bare words
 *   variableName block identifiers (`R_FDR_1`) and refs (`R_FDR_1:51`)
 *   operator     `=` `:` `/`
 */

import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { BLOCK_FIELDS, TOP_BLOCK_KEYWORDS } from '../help/help-data.js';

/** Keywords that open a block (`relay R_X { ... }`, `page { ... }`). */
const BLOCK_KEYWORDS = new Set<string>([
  ...TOP_BLOCK_KEYWORDS,
  'stage', 'stages', 'solve', 'voltages', 'scale', 'legend', 'axes',
  'curves', 'points', 'leaders', 'footer', 'margins_mm', 'title',
]);

/** Every field name any block accepts, for `propertyName` colouring. */
const FIELD_NAMES = new Set<string>(
  Object.values(BLOCK_FIELDS).flat(),
);

/** Bare words that are values rather than fields. */
const VALUE_ATOMS = new Set([
  'true', 'false', 'definite', 'primary', 'secondary', 'multiples',
  'instant', 'dependent', 'disk_emulation', 'forward', 'reverse', 'none',
  'phase_oc', 'earth_fault', 'neg_seq', 'thermal', 'breaker_fail',
  'composite', 'individual', 'tight', 'loose', 'safety_factor',
  'envelope_min', 'envelope_max', 'sum', 'select_first',
  'light', 'dark', 'monochrome', 'print',
  'fuse', 'recloser', 'cable', 'transformer_damage', 'motor_startup', 'breaker',
  'leader', 'pin', 'tag', 'solid', 'dashed', 'dotted',
  'portrait', 'landscape', 'sparse', 'normal', 'dense',
]);

/** Unit suffixes from the spec's _Recognised units_ table. */
const UNITS = new Set([
  'A', 'kA', 'mA', 'MA',
  's', 'ms', 'min', 'ks',
  'V', 'kV', 'MV',
  'W', 'kW', 'MW', 'VA', 'kVA', 'MVA',
  'deg', 'ohm', 'kohm', 'm', 'km', 'Hz',
  'pu', 'xCT', 'xIn',
]);

interface TcState {
  /** Inside a `/* ... *\/` block comment. */
  inComment: boolean;
  /** The previous significant token, to tell fields from values. */
  afterEquals: boolean;
  /** Open `{` / `[` nesting depth, carried for the indent hook. */
  depth: number;
}

const parser: StreamParser<TcState> = {
  name: 'tc',

  startState(): TcState {
    return { inComment: false, afterEquals: false, depth: 0 };
  },

  copyState(state): TcState {
    return { ...state };
  },

  token(stream, state): string | null {
    /* ---- block comments ------------------------------------------ */
    if (state.inComment) {
      while (!stream.eol()) {
        if (stream.match('*/')) { state.inComment = false; return 'comment'; }
        stream.next();
      }
      return 'comment';
    }

    if (stream.eatSpace()) return null;

    /* ---- comments ------------------------------------------------- */
    if (stream.match('/*')) { state.inComment = true; return 'comment'; }
    if (stream.match('//') || stream.match('#')) { stream.skipToEnd(); return 'comment'; }

    /* ---- strings -------------------------------------------------- */
    /*
     * A value closes the value position.
     *
     * `afterEquals` was only cleared by a `;` or a brace, so a
     * statement written without its semicolon left the flag set and
     * the *next* field was drawn as a value: in a block with
     * `fault = "F"` and no semicolon, `label` on the following line
     * came out a different colour from `fault` above it. The
     * highlighter cannot fix the missing semicolon, but it should not
     * mislead about the line after it.
     */
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) { state.afterEquals = false; return 'string'; }

    /*
     * ---- device numbers ------------------------------------------
     *
     * `50G`, `67N`, `51X` are single identifiers, not a number
     * followed by a letter. The number rule below matched the digits
     * and left the suffix to the identifier rule, so an element id was
     * drawn in two colours -- orange digits, plain letters -- while
     * `51` beside it was drawn in one.
     *
     * The spec has this rule already: a digit-leading identifier
     * absorbs the letters that follow it with no space between, which
     * is what keeps `67N` from reading as `67` and `N`. Whitespace is
     * still what separates a value from its unit, so `480 A` is
     * unaffected.
     */
    if (stream.match(/^\d[\d_]*[A-Za-z_]\w*/)) return 'variableName';

    /* ---- numbers, with an optional unit suffix -------------------- */
    if (stream.match(/^-?\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?/)) {
      /* A `600/5` ratio reads as number-operator-number. */
      const ahead = stream.match(/^\s*(?=[A-Za-z])/, false);
      if (ahead) {
        const save = stream.pos;
        stream.eatSpace();
        if (stream.match(/^[A-Za-z]+/, false)) {
          const word = stream.match(/^[A-Za-z]+/) as RegExpMatchArray | null;
          if (word && UNITS.has(word[0])) { state.afterEquals = false; return 'unit'; }
          stream.pos = save;
        } else {
          stream.pos = save;
        }
      }
      state.afterEquals = false;
      return 'number';
    }

    /* ---- punctuation ---------------------------------------------- */
    if (stream.match('=')) { state.afterEquals = true; return 'operator'; }
    if (stream.match('{')) { state.depth++; state.afterEquals = false; return 'punctuation'; }
    if (stream.match('}')) { state.depth = Math.max(0, state.depth - 1); state.afterEquals = false; return 'punctuation'; }
    if (stream.match('[')) { state.depth++; return 'punctuation'; }
    if (stream.match(']')) { state.depth = Math.max(0, state.depth - 1); return 'punctuation'; }
    if (stream.match(';')) { state.afterEquals = false; return 'punctuation'; }
    if (stream.match(/^[(),]/)) return 'punctuation';
    if (stream.match(/^[:/]/)) return 'operator';
    /* `~name` in a list: "every declared one except this". */
    if (stream.match('~')) return 'operator';

    /* ---- identifiers ---------------------------------------------- */
    const word = stream.match(/^[A-Za-z_][\w]*/) as RegExpMatchArray | null;
    if (word) {
      const name = word[0];

      /* A dotted curve id (`iec.si`, `ge.ur.vi`) reads as one atom. */
      if (stream.match(/^(?:\.[A-Za-z_]\w*)+/)) return 'atom';

      if (state.afterEquals) {
        state.afterEquals = false;
        return VALUE_ATOMS.has(name) ? 'atom' : 'variableName';
      }
      if (BLOCK_KEYWORDS.has(name)) return 'keyword';
      if (FIELD_NAMES.has(name)) return 'propertyName';
      return 'variableName';
    }

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: '#', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },

  /**
   * One indent unit per open brace, with a closing brace on the new
   * line dedenting by one. The depth is carried on the stream state,
   * which is what a `StreamParser` has available at a line start.
   */
  indent(state, textAfter, cx): number {
    const depth = /^\s*[}\]]/.test(textAfter) ? state.depth - 1 : state.depth;
    return Math.max(0, depth) * cx.unit;
  },
};

/** The `.ptc` language, ready to hand to an `EditorState`. */
export const tcLanguage = StreamLanguage.define(parser);

