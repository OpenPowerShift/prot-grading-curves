/**
 * .ptc parser -- hand-rolled recursive-descent with a precise tokenizer.
 *
 * Why handwritten: the language has a single grammar author (you),
 * ~150 productions, and lex-time errors benefit from a tighter
 * error model than Chevrotain provides out of the box. The grammar
 * lives in `parser.ts`; a future Codemirror highlight shares its
 * token vocabulary with the tokenizer here.
 */

import { FIELD_QUANTITY, suffixFits, suffixesFor } from '../semantics/units.js';
import type {
  AnnotateBlock,
  BaseNode,
  CombineBlock,
  DeviceBlock,
  Document,
  ElementBlock,
  FaultsBlock,
  FlexPoint,
  GradeBlock,
  MetaBlock,
  NotesBlock,
  PageBlock,
  PageTitle,
  ParseError,
  ParseResult,
  Ref,
  RelayBlock,
  ScalarValue,
  SolveBlock,
  SpanEnd,
  StageBlock,
  SystemBlock,
  TopLevel,
  ViewBlock,
  VoltageLevelDecl,
} from './ast.js';

/* ----------------------- tokenizer ----------------------- */

/* Exported as a const so external tools (e.g. the autocompletion source)
 * can reuse this set; the parser source remains the canonical
 * vocabulary.
 */
/**
 * Keys renamed by the units-everywhere change, and what to write now.
 *
 * A hard break, but a signposted one: the old spelling is recognised
 * precisely so it can be refused with the new one in the message. No
 * key names its own unit any more -- the unit is the author's to write
 * and the field's to check -- so `I_A = 450 A` was saying it twice and
 * `I_A = 450` was saying it once, ambiguously.
 */
export const RENAMED_KEYS: Readonly<Record<string, string>> = {
  I_A: 'I', I1_A: 'I1', I2_A: 'I2', I0_A: 'I0', earth_A: 'residual',
  min_A: 'I_min', max_A: 'I_max',
  kV: 'V', t_s: 't',
  CTI_min_s: 'margin', margin_s: 'margin_target',
  I_pu: 'I_pickup', I_base_A: 'I_base', base_MVA: 'base_S',
  current_pct: 'share',
  at_I_A: 'at_I', at_I1_A: 'at_I1', at_I2_A: 'at_I2', at_I0_A: 'at_I0',
  at_earth_A: 'at_residual', at_t_s: 'at_t',
  rating_A: 'rating_I', rating_kV: 'rating_V', rating_MVA: 'rating_S',
};

/** Keys removed outright, with why. */
/**
 * Fields each `page` styling sub-block accepts.
 *
 * These blocks took anything at all: `page { legend = { titel = "E" } }`
 * parsed, validated, rendered, and silently used the default heading. A
 * cosmetic key is not a margin, but a study can still be issued looking
 * nothing like the office standard its author thought they had set, and
 * nothing anywhere said why.
 */
export const PAGE_SUB_FIELDS: Readonly<Record<string, readonly string[]>> = {
  legend: ['show', 'style', 'position', 'color', 'swatch', 'title', 'currents', 'notes',
    'comment'],
  axes: ['color', 'grid_color', 'label_color', 'label_size_px', 'tick_size_px',
    'frame', 'mirror'],
  curves: ['palette', 'line_width_px', 'auto_color'],
  points: ['color', 'shape', 'size_px', 'outline'],
  leaders: ['show', 'style', 'width_px', 'color', 'label_offset_px'],
  scale: ['auto', 'x_min', 'x_max', 'y_min', 'y_max', 'tick_density'],
  margins_mm: ['top', 'right', 'bottom', 'left'],
  faults: ['width_px', 'color', 'style', 'labels'],
  times: ['width_px', 'color', 'style', 'labels'],
  footer: ['left', 'center', 'right', 'font_size_px', 'color', 'border'],
};

/**
 * What a `page` sub-block member may hold.
 *
 * A list joined the three scalars for free text running to several
 * lines: one long string with `\n` in it is legal and unreadable in a
 * file an engineer maintains.
 */
type PageSubValue = string | number | boolean | string[];

export const REMOVED_KEYS: Readonly<Record<string, string>> = {
  frequency_Hz: 'nothing in the tool reads it',
  grounding: 'nothing in the tool reads it; zero_sequence declares what mattered',
};

export const KEYWORDS = new Set([
  // top-level blocks
  'meta', 'system', 'faults', 'times', 'scenario', 'level', 'sees',
  'relay', 'element', 'device', 'grade',
  'annotate', 'combine', 'view', 'views', 'page', 'notes', 'stage', 'stages', 'point',
  // system sub-block header
  'voltages',
  // solve / grades
  'solve', 'strategy', 'free', 'fault', 'primary', 'backup',
  // device kinds
  'fuse', 'recloser', 'cable', 'transformer_damage', 'motor_startup', 'breaker',
  // function names
  'phase_oc', 'earth_fault', 'neg_seq', 'thermal', 'breaker_fail',
  // reset keywords
  'instant', 'dependent', 'disk_emulation',
  // formula / curve
  'definite', 'formula', 'flex_points', 'curve', 't_r',
  // attribute keys
  'function', 'tms', 't_delay', 't_reset', 'I_units',
  'char_angle', 'reset', 'directional', 'direction',
  'tolerance_pct', 'upstream', 'upstream_to',
  /* Units-everywhere names. No key carries its own unit. */
  'I', 'I_min', 'I_max', 'residual', 't', 'V',
  'I_pickup', 'I_base', 'base_S', 'share', 'margin', 'margin_target',
  'at_I', 'at_I1', 'at_I2', 'at_I0', 'at_residual', 'at_t',
  'rating_I', 'rating_V', 'rating_S',
  /* Recognised only to be refused with the new spelling. */
  'I_A', 'min_A', 'max_A', 'earth_A', 'I0_A', 'I2_A', 't_s',
  'kV', 'I_pu', 'I_base_A', 'base_MVA', 'current_pct',
  'CTI_min_s', 'margin_s', 'frequency_Hz', 'grounding',
  'at_I_A', 'at_I1_A', 'at_I2_A', 'at_I0_A', 'at_earth_A', 'at_t_s',
  'rating_A', 'rating_kV', 'rating_MVA',
  'voltage',
  'ct_ratio', 'maker', 'model', 'name',
  'measures', 'quantity', 'phase', 'I1', 'I2', '3I2', 'I0', '3I0', 'any',
  'type', 'condition', 'three_phase', 'two_phase', 'two_phase_earth',
  'single_phase_earth', 'zero_sequence', 'blocked', 'continuous',
  /* `to` is shared: the joiner in `zero_sequence { "A" to "B" }` and
   * the far end of an annotate span. Both are read positionally, so
   * one keyword serves. */
  'from', 'to',
  'min_melt', 'total_clear',
  // combine/view/page sub
  'sources', 'as', 'style', 'label', 'color', 'name', 'two_axes',
  'reference_ct', 'stages', 'axis', 'voltage', 'pickup',
  'current_min', 'current_max', 'time_min', 'time_max',
  'current_pad', 'current_pad_low', 'current_pad_high',
  'time_pad', 'time_pad_low', 'time_pad_high',
  'comment', 'description', 'reference',
  'size', 'orientation', 'margins_mm', 'scale', 'legend', 'border',
  'axes', 'curves', 'points', 'leaders', 'title', 'footer', 'theme', 'watermark',
  'show', 'position', 'swatch', 'frame', 'line_width_px', 'auto_color',
  'palette', 'auto', 'x_min', 'x_max', 'y_min', 'y_max',
  'tick_density', 'label_color', 'label_size_px', 'tick_size_px', 'mirror',
  'shape', 'size_px', 'outline', 'width_px', 'label_offset_px', 'coords',
  'subtitle', 'font_size_px', 'align', 'border', 'text',
  'style', 'column', 'inside', 'direct', 'stretch',
  'top_right', 'top_left', 'bottom_right', 'bottom_left',
  'text', 'top', 'right', 'bottom', 'left', 'center',
  // theme / orientation / palette / etc.
  'portrait', 'landscape',
  'light', 'dark', 'monochrome', 'print',
  'default', 'pasteur', 'okabe_ito', 'grayscale', 'ieee', 'high_contrast',
  'circle', 'square', 'diamond', 'triangle', 'cross', 'x', 'box',
  'line', 'arrow', 'dot',
  'composite', 'individual', 'primary', 'secondary', 'multiples',
  'envelope_min', 'envelope_max', 'sum', 'select_first',
  'solid', 'dashed', 'dotted',
  'sparse', 'normal', 'dense',
  'forward', 'reverse', 'none',
  'tight', 'loose', 'safety_factor',
  'true', 'false',
  'k', 'c', 'alpha',
]);

export type TokenKind =
  | 'LBRACE' | 'RBRACE' | 'LBRACK' | 'RBRACK' | 'LPAREN' | 'RPAREN'
  | 'SEMI' | 'COMMA' | 'EQUALS' | 'PERCENT' | 'SLASH' | 'DOT' | 'COLON'
  | 'NUMBER' | 'STRING' | 'IDENT' | 'KW' | 'EOF';

export interface Token {
  kind: TokenKind;
  image: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

function isDigit(c: string) { return c >= '0' && c <= '9'; }
function isNameStart(c: string) { return /[A-Za-z_]/.test(c); }
function isNameCont(c: string) { return /[A-Za-z0-9_]/.test(c); }

export function tokenize(source: string): { tokens: Token[]; errors: ParseError[] } {
  const tokens: Token[] = [];
  const errors: ParseError[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const emit = (k: TokenKind, image: string, start: number) => {
    tokens.push({ kind: k, image, start, end: i, line, col });
  };

  while (i < source.length) {
    const c = source[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r') {
      i++; col++;
      continue;
    }
    if (c === '\n') {
      i++; line++; col = 1;
      continue;
    }

    // line comment `#` or `//`
    if (c === '#' || (c === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // block comment /* ... */
    if (c === '/' && source[i + 1] === '*') {
      const start = i; const sLine = line; const sCol = col;
      i += 2; col += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { line++; col = 1; }
        else col++;
        i++;
      }
      if (i < source.length) { i += 2; col += 2; }
      else {
        errors.push({
          message: 'unterminated block comment',
          line: sLine, column: sCol, offset: start, length: i - start,
          severity: 'error', code: 'UNTERMINATED_BLOCK_COMMENT',
        });
      }
      continue;
    }

    // punctuation
    const pu = c;
    if ('{}[](),;=%./:'.includes(pu)) {
      const kMap: Record<string, TokenKind> = {
        '{': 'LBRACE', '}': 'RBRACE',
        '[': 'LBRACK', ']': 'RBRACK',
        '(': 'LPAREN', ')': 'RPAREN',
        ',': 'COMMA', ';': 'SEMI', '=': 'EQUALS',
        '%': 'PERCENT', '/': 'SLASH', '.': 'DOT', ':': 'COLON',
      };
      emit(kMap[pu], pu, i);
      i++; col++;
      continue;
    }

    // string
    if (c === '"') {
      const start = i; const sLine = line; const sCol = col;
      i++; col++;
      /*
       * Escapes are decoded here, not left for `unquote` to deal with.
       *
       * They used to be copied through raw and the whole buffer handed
       * to `JSON.stringify`, which escaped the backslash again -- so
       * `\n` round-tripped back to a literal backslash-n and every
       * escape in the spec was silently dead, `\"` included. Decoding
       * at the point of scanning is also the only way to support
       * `\u{XXXXX}`, whose braces JSON does not accept.
       */
      let buf = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          const simple: Record<string, string> = {
            '"': '"', '\\': '\\', '/': '/',
            n: '\n', t: '\t', r: '\r', b: '\b', f: '\f',
          };

          if (esc === 'u' && source[i + 2] === '{') {
            const close = source.indexOf('}', i + 3);
            const hex = close > 0 ? source.slice(i + 3, close) : '';
            const code = /^[0-9a-fA-F]{1,6}$/.test(hex) ? Number.parseInt(hex, 16) : NaN;
            if (Number.isFinite(code) && code <= 0x10ffff) {
              buf += String.fromCodePoint(code);
              col += close + 1 - i;
              i = close + 1;
              continue;
            }
            /* Malformed: fall through and keep the text verbatim. */
          }

          if (esc in simple) {
            buf += simple[esc];
          } else {
            /* Unknown escape: preserved rather than swallowed, so no
             * character the author typed is silently lost. */
            buf += '\\' + esc;
          }
          i += 2; col += 2;
          continue;
        }
        if (source[i] === '\n') { line++; col = 1; }
        else col++;
        buf += source[i];
        i++;
      }
      if (i < source.length) {
        emit('STRING', JSON.stringify(buf), start);
        i++; col++;
      } else {
        errors.push({
          message: 'unterminated string literal',
          line: sLine, column: sCol, offset: start, length: i - start,
          severity: 'error', code: 'UNTERMINATED_STRING',
        });
      }
      continue;
    }

    // number -- optionally signed, so `char_angle = -45 deg` lexes
    if (
      isDigit(c) ||
      (c === '.' && isDigit(source[i + 1] ?? '')) ||
      (c === '-' && (isDigit(source[i + 1] ?? '') ||
        (source[i + 1] === '.' && isDigit(source[i + 2] ?? ''))))
    ) {
      const start = i;
      if (c === '-') { i++; col++; }
      // maybe a dot-leading number
      let saw = false;
      while (i < source.length) {
        const cc = source[i];
        if (isDigit(cc)) { i++; col++; }
        else if (cc === '_') { i++; col++; }
        else if (cc === '.' && !saw) { saw = true; i++; col++; }
        else break;
      }
      emit('NUMBER', source.slice(start, i).replace(/_/g, ''), start);
      continue;
    }

    // identifier or keyword
    if (isNameStart(c)) {
      const start = i;
      while (i < source.length && isNameCont(source[i])) {
        // dotted identifiers (curve refs, voltage-level refs)
        if (source[i] === '.' && isNameStart(source[i + 1] ?? '')) {
          i++; col++;
          continue;
        }
        i++; col++;
      }
      const image = source.slice(start, i);
      const isKw = KEYWORDS.has(image);
      emit(isKw ? 'KW' : 'IDENT', image, start);
      continue;
    }

    // unexpected
    errors.push({
      message: `unexpected character ${JSON.stringify(c)}`,
      line, column: col, offset: i, length: 1,
      severity: 'error', code: 'UNEXPECTED_CHARACTER',
    });
    i++; col++;
  }

  emit('EOF', '', i);
  return { tokens, errors };
}

/* ----------------------- recursive-descent parser ----------------------- */

class Parser {
  private tokens: Token[];
  private pos = 0;
  readonly errors: ParseError[] = [];
  private recoveryTopLevelQueue: TokenKind[] = [
    'KW', // top-level keyword starts
  ];

  /**
   * Lexer errors are *copied in*, not aliased. Assigning the caller's
   * array here made `parser.errors` and the lexer's array the same
   * object, so `parse` spreading both reported every error twice --
   * and a `.ptc` file with one stray brace listed the same complaint
   * two lines running.
   */
  constructor(tokens: Token[], lexErrors: readonly ParseError[] = []) {
    this.tokens = tokens;
    this.errors.push(...lexErrors);
  }

  private peek(off = 0): Token {
    return this.tokens[this.pos + off] ?? this.tokens[this.tokens.length - 1];
  }
  private at(k: TokenKind): boolean { return this.peek().kind === k; }
  private eat(k: TokenKind): Token | null {
    if (this.peek().kind !== k) return null;
    const t = this.tokens[this.pos++];
    return t;
  }
  private expect(k: TokenKind, what: string): Token {
    if (this.peek().kind === k) return this.tokens[this.pos++];
    const t = this.peek();
    this.errors.push({
      message: `expected ${what}, got ${tokenDescribe(t)}`,
      line: t.line, column: t.col, offset: t.start, length: t.end - t.start,
      severity: 'error', code: 'EXPECTED_TOKEN',
    });
    return t;
  }
  /**
   * Match one of a set of enum values.
   *
   * The spec writes these quoted (`axis = "primary"`, `kind = "fuse"`)
   * but bare spellings read naturally too, so both are accepted and
   * normalised to the bare word. An IDENT is accepted for values that
   * the lexer does not treat as keywords.
   */
  private matchKeyword(...names: string[]): string | null {
    const t = this.peek();
    if ((t.kind === 'KW' || t.kind === 'IDENT') && names.includes(t.image)) {
      this.pos++;
      return t.image;
    }
    if (t.kind === 'STRING') {
      const bare = unquote(t.image);
      if (names.includes(bare)) {
        this.pos++;
        return bare;
      }
    }
    return null;
  }
  /**
   * One name, or a bracketed list of them.
   *
   * `scenario = "A"` and `scenarios = ["A", "B"]` are the same shape as
   * far as the reader is concerned, so both spellings of the key accept
   * both forms rather than pairing a singular key with a scalar and a
   * plural key with a list -- which only produces a syntax error for
   * writing the sentence the other way round.
   */
  private parseNameList(): string[] {
    if (this.eat('LBRACK')) {
      const names: string[] = [];
      if (!this.at('RBRACK')) {
        names.push(this.parseStringOrIdent());
        while (this.eat('COMMA')) names.push(this.parseStringOrIdent());
      }
      this.expect('RBRACK', ']');
      return names;
    }
    const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
    return tok ? [unquote(tok.image)] : [];
  }

  /**
   * A key the block did not recognise.
   *
   * Three cases, and they want different answers. A *renamed* key is an
   * error naming its replacement -- the author knows what they meant
   * and needs the new spelling. A *removed* key is an error saying so.
   * Anything else is a **warning**: a key that is merely inapplicable
   * here, `upstream` inside an `annotate`, should not stop the sheet
   * being drawn, and a drawing with a warning is more use than no
   * drawing at all.
   *
   * The exception is `strict`, for the fields that carry a number a
   * typo would silently move -- `tsm` for `tms` left an element at the
   * default multiplier and the margin out by ten. There a warning is
   * too quiet.
   */
  private noteUnknownKey(
    block: string,
    at: Token,
    accepts: readonly string[],
    strict = false,
  ): void {
    /*
     * Many blocks route their *ordinary* fields through `default:` --
     * an element stores `tms` and `t_delay` as generic members -- so
     * the accepted list is consulted first. Only a name that is not on
     * it has anything wrong with it.
     */
    if (accepts.includes(at.image)) return;

    const renamed = RENAMED_KEYS[at.image];
    if (renamed) {
      this.errors.push({
        message: `"${at.image}" was renamed to "${renamed}"; no key carries its own unit `
          + `any more, so write the unit yourself (${renamed} = 450 A)`,
        line: at.line, column: at.col, offset: at.start, length: at.end - at.start,
        severity: 'error', code: 'RENAMED_KEY',
      });
      return;
    }

    const removed = REMOVED_KEYS[at.image];
    if (removed) {
      this.errors.push({
        message: `"${at.image}" was removed: ${removed}`,
        line: at.line, column: at.col, offset: at.start, length: at.end - at.start,
        severity: 'error', code: 'REMOVED_KEY',
      });
      return;
    }

    /*
     * A key that means something elsewhere in the language is
     * *misplaced*, not mistyped -- `upstream` inside an `annotate`.
     * The author knows the word; they have put it in the wrong block,
     * and the sheet is still drawable, so it warns even where the
     * block is otherwise strict.
     *
     * A word the language does not know anywhere is a typo, and in a
     * block whose every field changes a number that is refused: `tsm`
     * for `tms` left an element at the default multiplier and the
     * margin out by ten.
     */
    const knownElsewhere = KEYWORDS.has(at.image);
    const isTypo = strict && !knownElsewhere;

    this.errors.push({
      message: isTypo
        ? `unknown setting "${at.image}"; ${block} accepts ${accepts.join(', ')}`
        : `${block} does not accept "${at.image}"`
          + (accepts.length > 0 ? `; it accepts ${accepts.join(', ')}` : ''),
      line: at.line, column: at.col, offset: at.start, length: at.end - at.start,
      severity: isTypo ? 'error' : 'warning',
      code: isTypo ? 'UNKNOWN_SETTING' : 'UNKNOWN_KEY',
    });
  }

  private expectKeyword(...names: string[]): string {
    const v = this.matchKeyword(...names);
    if (v !== null) return v;
    const t = this.peek();
    this.errors.push({
      message: `expected one of ${names.join(' / ')}, got ${tokenDescribe(t)}`,
      line: t.line, column: t.col, offset: t.start, length: t.end - t.start,
      severity: 'error', code: 'EXPECTED_KEYWORD',
    });
    return names[0];
  }
  private loc(t: Token | undefined): BaseNode['loc'] {
    return t ? { line: t.line, column: t.col, offset: t.start } : { line: 0, column: 0, offset: 0 };
  }
  /** Skip until we find an item that looks like the start of a top-level block. */
  private recoverySync() {
    while (!this.at('EOF')) {
      const t = this.peek();
      if (t.kind === 'KW'
          && ['meta','system','faults','relay','element','device',
              'grade','annotate','combine','view','page','notes'].includes(t.image)) {
        return;
      }
      this.pos++;
    }
  }

  /* ----------------------- top-level ----------------------- */

  parseDocument(): Document {
    const items: TopLevel[] = [];
    while (!this.at('EOF')) {
      const before = this.pos;
      try {
        const item = this.parseTopLevel();
        if (item) items.push(item);
      } catch (err) {
        this.errors.push({
          message: (err as Error).message,
          line: this.peek().line, column: this.peek().col,
          offset: this.peek().start, length: 1,
          severity: 'error', code: 'TOPLEVEL_PARSE',
        });
      }
      if (this.pos === before) {
        // avoid infinite loop -- skip a token and continue
        this.pos++;
      }
    }
    return { type: 'document', items, loc: { line: 1, column: 1, offset: 0 } };
  }

  private parseTopLevel(): TopLevel | null {
    const t = this.peek();
    if (t.kind === 'RBRACE' || t.kind === 'SEMI' || t.kind === 'EOF') {
      // stray closing brace / semicolon between blocks -- not a parse
      // error, just an artefact; consume and let the loop continue.
      if (t.kind !== 'EOF') this.pos++;
      return null;
    }
    if (t.kind !== 'KW') {
      this.errors.push({
        message: `expected top-level keyword, got ${tokenDescribe(t)}`,
        line: t.line, column: t.col, offset: t.start, length: t.end - t.start,
        severity: 'error', code: 'EXPECTED_TOP_LEVEL',
      });
      this.recoverySync();
      return null;
    }
    const kw = t.image;
    switch (kw) {
      case 'meta':    return this.parseMeta();
      case 'system':  return this.parseSystem();
      case 'faults':  return this.parseFaults();
      case 'times':   return this.parseTimes();
      case 'scenario':return this.parseScenario();
      case 'relay':   return this.parseRelay();
      case 'element': return this.parseElement(/*topLevel*/ true);
      case 'device':  return this.parseDevice();
      case 'grade':   return this.parseGrade();
      case 'annotate':return this.parseAnnotate();
      case 'combine': return this.parseCombine();
      case 'view':    return this.parseView();
      case 'page':    return this.parsePage();
      case 'point':   return this.parsePoint();
      case 'notes':   return this.parseNotes();
      default:
        this.errors.push({
          message: `unrecognised top-level keyword ${JSON.stringify(kw)}`,
          line: t.line, column: t.col, offset: t.start, length: t.end - t.start,
          severity: 'error', code: 'UNKNOWN_TOP_LEVEL',
        });
        this.recoverySync();
        return null;
    }
  }

  /* ----------------------- blocks ----------------------- */

  private parseBlock<T>(open: string, body: () => T, close: string): T | null {
    this.expectKeyword(open);
    if (!this.eat('LBRACE')) {
      this.errors.push({
        message: `expected '{' after ${open}`,
        line: this.peek().line, column: this.peek().col,
        offset: this.peek().start, length: 1,
        severity: 'error', code: 'EXPECTED_LBRACE',
      });
      return null;
    }
    const v = body();
    this.expect(close === '}' ? 'RBRACE' : 'RBRACK', close);
    return v;
  }

  private parseMeta(): MetaBlock | null {
    const head = this.peek();
    return this.parseBlock('meta', () => {
      const entries: Record<string, ScalarValue> = {};
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const id = this.eat('KW') ?? this.eat('IDENT');
        if (!id) { this.pos++; continue; }
        this.expect('EQUALS', '=');
        const val = this.parseScalarValue();
        this.eat('SEMI');
        entries[id.image] = val;
      }
      return { type: 'meta', entries, loc: this.loc(head) } as MetaBlock;
    }, '}');
  }

  private parsePoint(): import('./ast.js').PointBlock | null {
    const head = this.peek();
    this.pos++; // 'point'
    const idTok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
    if (!idTok) return null;
    this.expect('LBRACE', '{');
    const p: import('./ast.js').PointBlock = {
      type: 'point', id: unquote(idTok.image), I_A: NaN, t_s: NaN, loc: this.loc(head),
    };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const k = this.eat('KW') ?? this.eat('IDENT');
      if (!k) { this.pos++; continue; }
      this.expect('EQUALS', '=');
      switch (k.image) {
        /* The same vocabulary a fault and a scenario level use, so
         * one way of writing a current covers the whole language. */
        case 'I':     p.I_A = this.parseNumberWithUnit_A('I'); break;
        case 'I1':    p.I1_A = this.parseNumberWithUnit_A('I1'); break;
        case 'I2':    p.I2_A = this.parseNumberWithUnit_A('I2'); break;
        case 'I0':    p.I0_A = this.parseNumberWithUnit_A('I0'); break;
        case 'residual': p.earth_A = this.parseNumberWithUnit_A('residual'); break;
        case 'type': {
          const kw = this.matchKeyword(
            'three_phase', 'two_phase', 'two_phase_earth', 'single_phase_earth');
          if (kw) p.faultType = kw as import('./ast.js').FaultTypeKeyword;
          break;
        }
        case 't':   p.t_s = this.parseNumberWithUnit_s('t'); break;
        /* The current may come from a named condition instead. */
        case 'fault':
        case 'faults':
        case 'scenario':
        case 'scenarios': {
          const names = this.parseNameList();
          if (names.length > 0) p.conditions = [...(p.conditions ?? []), ...names];
          break;
        }
        case 'label': p.label = this.parseStringOrIdent(); break;
        case 'voltage': p.voltage = this.parseStringOrIdent(); break;
        case 'view':
        case 'views': {
          const names = this.parseNameList();
          if (names.length > 0) p.views = [...(p.views ?? []), ...names];
          break;
        }
        case 'color': p.color = this.parseStringOrIdent(); break;
        case 'description': p.description = this.parseStringOrIdent(); break;
        case 'coords': p.coords = this.parseBool(); break;
        case 'shape': {
          const v = this.matchKeyword('circle','square','diamond','triangle','cross','x');
          if (v) p.shape = v as import('./ast.js').PointBlock['shape'];
          break;
        }
        default:
          this.parseScalarValue();
          this.noteUnknownKey('a point', k, ['I', 'I1', 'I2', 'I0', 'residual', 't',
            'type', 'fault', 'faults', 'scenario', 'scenarios', 'label', 'voltage',
            'view', 'views', 'color', 'description', 'coords', 'shape', 'on_curve']);
          break;
      }
      this.eat('SEMI');
    }
    this.expect('RBRACE', '}');
    return p;
  }

  private parseNotes(): NotesBlock | null {
    const head = this.peek();
    return this.parseBlock('notes', () => {
      const entries: Record<string, ScalarValue> = {};
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const id = this.eat('KW') ?? this.eat('IDENT');
        if (!id) { this.pos++; continue; }
        this.expect('EQUALS', '=');
        const val = this.parseScalarValue();
        this.eat('SEMI');
        entries[id.image] = val;
      }
      return { type: 'notes', entries, loc: this.loc(head) } as NotesBlock;
    }, '}');
  }

  private parseSystem(): SystemBlock | null {
    const head = this.peek();
    return this.parseBlock('system', () => {
      const sys: SystemBlock = { type: 'system', voltages: [], loc: this.loc(head) };
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const t = this.peek();
        if (t.kind !== 'KW') { this.pos++; continue; }
        switch (t.image) {
          case 'voltages': {
            // Inline parse the voltages block -- nested parseBlock
            // confused the inner loop with the outer's while boundary.
            this.expectKeyword('voltages');
            this.expect('LBRACE', '{');
            const levels: VoltageLevelDecl[] = [];
            while (!this.at('RBRACE') && !this.at('EOF')) {
              const nameTok = this.eat('STRING') ?? this.eat('IDENT');
              if (!nameTok) { this.pos++; continue; }
              const lvl: VoltageLevelDecl = {
                name: unquote(nameTok.image),
                kV: NaN,
                loc: this.loc(nameTok),
              };
              this.expect('LBRACE', '{');
              while (!this.at('RBRACE') && !this.at('EOF')) {
                const k = this.eat('KW');
                if (!k) { this.pos++; continue; }
                this.expect('EQUALS', '=');
                if (k.image === 'V') lvl.kV = this.parseNumberWithUnit_kV('V');
                else if (k.image === 'description') {
                  lvl.description = String(this.parseScalarValue());
                } else {
                  this.noteUnknownKey('a voltage level', k, ['V', 'description']);
                  this.parseScalarValue();
                }
                this.eat('SEMI');
              }
              this.expect('RBRACE', '}');
              levels.push(lvl);
            }
            this.expect('RBRACE', '}');
            sys.voltages = levels;
            continue;
          }
          case 'zero_sequence': {
            this.pos++;
            this.expect('LBRACE', '{');
            const links: import('./ast.js').ZeroSequenceDecl[] = [];
            while (!this.at('RBRACE') && !this.at('EOF')) {
              const fromTok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              if (!fromTok) { this.pos++; continue; }
              /* `to` reads as a word between the two level names. */
              if (this.peek().kind === 'KW' && this.peek().image === 'to') this.pos++;
              else this.eat('IDENT');
              const toTok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.expect('EQUALS', '=');
              const link = this.matchKeyword('blocked', 'continuous');
              this.eat('SEMI');
              if (toTok && link) {
                links.push({
                  from: unquote(fromTok.image),
                  to: unquote(toTok.image),
                  link: link as import('./ast.js').ZeroSequenceLink,
                  loc: this.loc(fromTok),
                });
              }
            }
            this.expect('RBRACE', '}');
            sys.zero_sequence = links;
            continue;
          }
          case 'base_S':
            this.pos++; this.expect('EQUALS', '=');
            sys.base_S = this.parseNumberWithUnit_MVA('base_S');
            this.eat('SEMI'); continue;
          case 'I_base':
            this.pos++; this.expect('EQUALS', '='); sys.I_base_A = this.parseNumber(); this.eat('SEMI'); continue;
          case 'I_units':
            this.pos++; this.expect('EQUALS', '='); {
              const k = this.matchKeyword('primary', 'secondary');
              if (k) sys.I_units = k as 'primary' | 'secondary';
              this.eat('SEMI');
            } continue;
          default:
            /* `t` is the switch subject here, the loop reading tokens
             * rather than a `k` bound per arm. */
            this.noteUnknownKey('system', t,
              ['voltages', 'zero_sequence', 'base_S', 'I_base', 'I_units']);
            this.pos++;
            continue;
        }
      }
      return sys;
    }, '}');
  }

  /**
   * `scenario "name" { level "HV" { ... } sees R { ... } }`
   *
   * One condition, its currents at each level. Shaped like `faults`
   * -- a name then sub-blocks -- but keyed by level rather than by
   * fault, because the point is to describe the same condition
   * wherever it is measured.
   */
  private parseScenario(): import('./ast.js').ScenarioBlock | null {
    const head = this.peek();
    this.pos++; // 'scenario'

    const nameTok = this.eat('STRING') ?? this.eat('IDENT');
    if (!nameTok) {
      this.errors.push({
        message: 'expected a scenario name',
        line: this.peek().line, column: this.peek().col,
        offset: this.peek().start, length: 1,
        severity: 'error', code: 'EXPECTED_IDENT',
      });
      this.recoverySync();
      return null;
    }

    const block: import('./ast.js').ScenarioBlock = {
      type: 'scenario',
      name: unquote(nameTok.image),
      levels: [],
      shares: [],
      loc: this.loc(head),
    };

    this.expect('LBRACE', '{');
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const t = this.peek();
      if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }

      if (t.image === 'level') {
        this.pos++;
        const levelTok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
        const level: import('./ast.js').ScenarioLevelDecl = {
          voltage: levelTok ? unquote(levelTok.image) : '',
          loc: this.loc(levelTok ?? t),
        };
        this.expect('LBRACE', '{');
        while (!this.at('RBRACE') && !this.at('EOF')) {
          const k = this.eat('KW') ?? this.eat('IDENT');
          if (!k) { this.pos++; continue; }
          this.expect('EQUALS', '=');
          switch (k.image) {
            case 'I':     level.I_A = this.parseNumberWithUnit_A('I'); break;
            case 'I1':    level.I1_A = this.parseNumberWithUnit_A('I1'); break;
            case 'I2':    level.I2_A = this.parseNumberWithUnit_A('I2'); break;
            case 'I0':    level.I0_A = this.parseNumberWithUnit_A('I0'); break;
            case 'residual': level.earth_A = this.parseNumberWithUnit_A('residual'); break;
            default:
              this.parseScalarValue();
              this.noteUnknownKey("a scenario's level", k,
                ['I', 'I1', 'I2', 'I0', 'residual']);
              break;
          }
          this.eat('SEMI');
        }
        this.expect('RBRACE', '}');
        this.eat('SEMI');
        block.levels.push(level);
        continue;
      }

      if (t.image === 'sees') {
        this.pos++;
        const relayTok = this.eat('IDENT') ?? this.eat('STRING') ?? this.eat('KW');
        const share: import('./ast.js').ScenarioShareDecl = {
          relay: relayTok ? unquote(relayTok.image) : '',
          current_pct: 100,
          loc: this.loc(relayTok ?? t),
        };
        this.expect('LBRACE', '{');
        while (!this.at('RBRACE') && !this.at('EOF')) {
          const k = this.eat('KW') ?? this.eat('IDENT');
          if (!k) { this.pos++; continue; }
          this.expect('EQUALS', '=');
          if (k.image === 'share') share.current_pct = this.parseNumber();
          else this.parseScalarValue();
          this.eat('SEMI');
        }
        this.expect('RBRACE', '}');
        this.eat('SEMI');
        block.shares.push(share);
        continue;
      }

      if (t.image === 'description') {
        this.pos++;
        this.expect('EQUALS', '=');
        block.description = this.parseStringOrIdent();
        this.eat('SEMI');
        continue;
      }

      if (t.image === 'type') {
        this.pos++;
        this.expect('EQUALS', '=');
        block.faultType = this.parseQuantityValue() as
          import('./ast.js').FaultTypeKeyword | undefined;
        this.eat('SEMI');
        continue;
      }

      /* Unknown member: consume it so the loop cannot stick, and say
       * so -- silently skipped, a mistyped `level` or `sees` took a
       * whole level's figures out of the study without a word. */
      this.pos++;
      this.noteUnknownKey('a scenario', t, ['level', 'sees', 'type', 'description']);
      if (this.at('EQUALS')) { this.pos++; this.parseScalarValue(); this.eat('SEMI'); }
      else {
        /*
         * A misspelled `level` still has a braced body behind it. Left
         * to the loop, every field inside it is read as a scenario
         * member and warned about in turn, so one typo produced a
         * column of complaints and the real one was the first.
         */
        void (this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW'));
        if (this.at('LBRACE')) this.skipBracedGroup();
      }
    }
    this.expect('RBRACE', '}');
    return block;
  }

  private parseFaults(): FaultsBlock | null {
    const head = this.peek();
    return this.parseBlock('faults', () => {
      const list: import('./ast.js').FaultDecl[] = [];
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const nameTok = this.eat('STRING') ?? this.eat('IDENT');
        if (!nameTok) { this.pos++; continue; }
        const f: import('./ast.js').FaultDecl = { name: unquote(nameTok.image), I_A: NaN, loc: this.loc(nameTok) };
        this.expect('LBRACE', '{');
        while (!this.at('RBRACE') && !this.at('EOF')) {
          const k = this.eat('KW');
          if (!k) { this.pos++; continue; }
          this.expect('EQUALS', '=');
          switch (k.image) {
            /* Fault currents carry an `A` / `kA` suffix; fold it in. */
            case 'type':     f.type = this.parseQuantityValue() as
                               import('./ast.js').FaultTypeKeyword | undefined; break;
            case 'I':      f.I_A = this.parseNumberWithUnit_A('I'); break;
            case 'I_min':    f.min_A = this.parseNumberWithUnit_A('I_min'); break;
            case 'I_max':    f.max_A = this.parseNumberWithUnit_A('I_max'); break;
            case 'residual':  f.earth_A = this.parseNumberWithUnit_A('residual'); break;
            case 'I0':     f.I0_A = this.parseNumberWithUnit_A('I0'); break;
            case 'I1':     f.I1_A = this.parseNumberWithUnit_A('I1'); break;
            case 'I2':     f.I2_A = this.parseNumberWithUnit_A('I2'); break;
            case 'voltage':  {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              if (tok) f.voltage = unquote(tok.image);
              break;
            }
            case 'view':
            case 'views': {
              const names = this.parseNameList();
              if (names.length > 0) f.views = [...(f.views ?? []), ...names];
              break;
            }
            case 'description': {
              const tok = this.eat('STRING') ?? this.eat('KW') ?? this.eat('IDENT');
              if (tok) f.description = unquote(tok.image);
              break;
            }
            default: /* ignore */ this.parseScalarValue();
              this.noteUnknownKey('a fault', k, ['I', 'I_min', 'I_max', 'I1', 'I2', 'I0', 'residual', 'type', 'voltage', 'view', 'views', 'description']);
          }
          this.eat('SEMI');
        }
        this.expect('RBRACE', '}');
        list.push(f);
      }
      return { type: 'faults', faults: list, loc: this.loc(head) } as FaultsBlock;
    }, '}');
  }

  /**
   * `times { "Arc flash limit" { t_s = 200 ms; } }`
   *
   * The horizontal counterpart of `faults`, and deliberately the same
   * shape so one is read by anyone who knows the other. A time needs no
   * voltage level: a second is a second on every winding.
   */
  private parseTimes(): import('./ast.js').TimesBlock | null {
    const head = this.peek();
    return this.parseBlock('times', () => {
      const list: import('./ast.js').TimeDecl[] = [];
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const nameTok = this.eat('STRING') ?? this.eat('IDENT');
        if (!nameTok) { this.pos++; continue; }
        const t: import('./ast.js').TimeDecl = {
          name: unquote(nameTok.image), t_s: NaN, loc: this.loc(nameTok),
        };
        this.expect('LBRACE', '{');
        while (!this.at('RBRACE') && !this.at('EOF')) {
          const k = this.eat('KW') ?? this.eat('IDENT');
          if (!k) { this.pos++; continue; }
          this.expect('EQUALS', '=');
          switch (k.image) {
            case 't': t.t_s = this.parseNumberWithUnit_s('t'); break;
            case 'at_I': t.at_I_A = this.parseNumberWithUnit_A('at_I'); break;
            case 'at_I1': t.at_I1_A = this.parseNumberWithUnit_A('at_I1'); break;
            case 'at_I2': t.at_I2_A = this.parseNumberWithUnit_A('at_I2'); break;
            case 'at_I0': t.at_I0_A = this.parseNumberWithUnit_A('at_I0'); break;
            case 'at_residual':
              t.at_earth_A = this.parseNumberWithUnit_A('at_residual'); break;
            case 'type': {
              const kw = this.matchKeyword(
                'three_phase', 'two_phase', 'two_phase_earth', 'single_phase_earth');
              if (kw) t.faultType = kw as import('./ast.js').FaultTypeKeyword;
              break;
            }
            case 'view':
            case 'views': {
              const names = this.parseNameList();
              if (names.length > 0) t.views = [...(t.views ?? []), ...names];
              break;
            }
            case 'description': {
              const tok = this.eat('STRING') ?? this.eat('KW') ?? this.eat('IDENT');
              if (tok) t.description = unquote(tok.image);
              break;
            }
            default:
              this.parseScalarValue();
              this.noteUnknownKey('a time', k, [
                't', 'at_I', 'at_I1', 'at_I2', 'at_I0', 'at_residual', 'type',
                'view', 'views', 'description']);
          }
          this.eat('SEMI');
        }
        this.expect('RBRACE', '}');
        list.push(t);
      }
      return { type: 'times', times: list, loc: this.loc(head) } as import('./ast.js').TimesBlock;
    }, '}');
  }

  private parseElement(_topLevel: boolean): ElementBlock | null {
    const head = this.peek();
    this.pos++; // eat 'element'
    const idTok = this.parseDeviceNumberId();
    if (!idTok) {
      this.errors.push({
        message: 'expected element identifier',
        line: this.peek().line, column: this.peek().col, offset: this.peek().start, length: 1,
        severity: 'error', code: 'EXPECTED_IDENT',
      });
      this.recoverySync();
      return null;
    }
    this.expect('LBRACE', '{');
    const el = this.parseElementBody(idTok.image, head);
    this.expect('RBRACE', '}');
    return el;
  }

  private parseElementBody(id: string, head: Token): ElementBlock {
    const el: ElementBlock = { type: 'element', id, members: [], loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const t = this.peek();
      if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
      // curve / formula / flex_points (these take `= value ;` form) vs.
      // `stages { ... }` (sub-block, no `=`).
      if (t.kind === 'KW' && t.image === 'stages') {
        this.pos++;
        this.expect('LBRACE', '{');
        const stages: StageBlock[] = [];
        while (!this.at('RBRACE') && !this.at('EOF')) {
          const stNameTok = this.matchKeyword('stage');
          if (stNameTok === null) { this.pos++; continue; }
          const stIdTok = this.parseDeviceNumberId();
          if (!stIdTok) continue;
          this.expect('LBRACE', '{');
          const stBody = this.parseStageBody(stIdTok.image, stIdTok);
          stages.push(stBody);
          this.expect('RBRACE', '}');
        }
        this.expect('RBRACE', '}');
        el.members.push({ kind: 'scalar', key: 'stages', value: { kind: 'stages', stages } as any });
        continue;
      }
      if (t.kind === 'KW' && (t.image === 'curve' || t.image === 'formula' || t.image === 'flex_points')) {
        const kwName = t.image;
        this.pos++; this.expect('EQUALS', '=');
        if (kwName === 'curve') {
          // dotted identifier OR `definite`
          const v = this.parseCurveOrDefinite();
          this.eat('SEMI');
          el.members.push({ kind: 'scalar', key: 'curve', value: v });
          continue;
        }
        if (kwName === 'formula') {
          // { k=..; c=..; alpha=..; }
          this.expect('LBRACE', '{');
          const obj: Record<string, number> = {};
          while (!this.at('RBRACE') && !this.at('EOF')) {
            const k = this.eat('KW') ?? this.eat('IDENT');
            if (k) {
              this.expect('EQUALS', '=');
              /* `k` and `c` are seconds and are written with the
               * suffix (`k = 4.0 s`); `alpha` is dimensionless. */
              obj[k.image] = this.parseNumberWithUnit_s();
              this.eat('SEMI');
            } else { this.pos++; }
          }
          this.expect('RBRACE', '}');
          this.eat('SEMI');
          el.members.push({ kind: 'scalar', key: 'formula', value: obj as any });
          continue;
        }
if (kwName === 'flex_points') {
          const pts = this.parseFlexList();
          el.members.push({ kind: 'scalar', key: 'flex_points', value: { kind: 'flex_points', points: pts } as any });
          continue;
        }
      }
      // member scalar
      const k = this.parseElementScalar(el);
      if (!k) {
        this.noteUnknownElementSetting('an element');
        this.pos++;
      }
    }
    return el;
  }

  /**
   * A name the language does not know, being assigned to inside an
   * element or a stage.
   *
   * Skipped in silence, a transposition cost a study its answer without
   * a word: `tsm = 0.1` left the element at the default multiplier and
   * the margin out by a factor of ten. Every field in these two blocks
   * is a setting that decides whether a relay operates, so an
   * unrecognised one is refused rather than warned about.
   *
   * Shared between the two callers, because it was written for
   * `element` alone: `parseStageBody` did `this.pos++` and said
   * nothing, and a stage is where a multi-stage study actually puts the
   * `tms` that was being dropped.
   */
  /** Consume a `{ ... }` group, braces balanced, wherever the cursor is. */
  private skipBracedGroup(): void {
    if (!this.at('LBRACE')) return;
    let depth = 0;
    while (!this.at('EOF')) {
      if (this.at('LBRACE')) depth++;
      else if (this.at('RBRACE')) { depth--; this.pos++; if (depth === 0) break; continue; }
      this.pos++;
    }
    this.eat('SEMI');
  }

  private noteUnknownElementSetting(what: 'an element' | 'a stage'): void {
    const at = this.peek();
    if (!((at.kind === 'IDENT' || at.kind === 'KW') && this.peekAt(1).kind === 'EQUALS')) return;
    this.errors.push({
      message: `unknown setting "${at.image}"; ${what} accepts function, measures, `
        + 'curve, formula, flex_points, I_pickup, I_units, share, tms, t_delay, '
        + 't_reset, char_angle, reset, directional, name, comment, current_max, '
        + 'color, style, width_px, view, views'
        + (what === 'an element' ? ', stages' : ''),
      line: at.line, column: at.col, offset: at.start, length: at.end - at.start,
      severity: 'error', code: 'UNKNOWN_SETTING',
    });
  }

  private parseStageBody(id: string, head: Token): StageBlock {
    const st: StageBlock = { type: 'stage', id, members: [], loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      // no nested stages
      const t = this.peek();
      if (!(t.kind === 'KW' && (t.image === 'curve' || t.image === 'formula' || t.image === 'flex_points'))) {
        const ok = this.parseElementScalar(st);
        if (!ok) {
          this.noteUnknownElementSetting('a stage');
          this.pos++;
        }
      } else {
        // curve / formula / flex_points
        const kw = t.image;
        this.pos++; this.expect('EQUALS', '=');
        if (kw === 'curve') {
          st.members.push({ kind: 'scalar', key: 'curve', value: this.parseCurveOrDefinite() });
          this.eat('SEMI');
        } else if (kw === 'formula') {
          this.expect('LBRACE', '{');
          const obj: Record<string, number> = {};
          while (!this.at('RBRACE') && !this.at('EOF')) {
            const k = this.eat('KW') ?? this.eat('IDENT');
            if (k) { this.expect('EQUALS', '='); obj[k.image] = this.parseNumberWithUnit_s(); this.eat('SEMI'); }
            else this.pos++;
          }
          this.expect('RBRACE', '}');
          this.eat('SEMI');
          st.members.push({ kind: 'scalar', key: 'formula', value: obj as any });
        } else if (kw === 'flex_points') {
          st.members.push({ kind: 'scalar', key: 'flex_points', value: { kind: 'flex_points', points: this.parseFlexList() } as any });
        }
      }
    }
    return st;
  }

  /**
   * Read an element or stage identifier.
   *
   * Element ids are IEEE C37.2 device numbers -- `50`, `51`, `67N`,
   * `51X` -- so they may lead with digits and carry a letter suffix.
   * The tokenizer splits `67N` into NUMBER + IDENT, so the two are
   * rejoined here when they are lexically *adjacent*. The adjacency
   * test is what keeps `I_pickup = 480 A` from being read as an id: the
   * space between them means they are separate tokens.
   */
  /**
   * A measured-quantity value: `phase`, `I2`, `3I0`, quoted or not.
   *
   * `3I0` and `3I2` start with a digit, so the lexer hands back a
   * NUMBER followed by an identifier -- the same shape as a device
   * number like `67N`, and read the same way. Without this, the
   * natural unquoted spelling parsed as nothing and the field was
   * silently unset.
   */
  private parseQuantityValue(): string | null {
    const t = this.peek();
    if (t.kind === 'STRING') { this.pos++; return unquote(t.image); }
    if (t.kind === 'NUMBER') {
      const merged = this.parseDeviceNumberId();
      return merged ? merged.image : null;
    }
    const tok = this.eat('KW') ?? this.eat('IDENT');
    return tok ? tok.image : null;
  }

  private parseDeviceNumberId(): Token | null {
    const first = this.eat('IDENT') ?? this.eat('NUMBER') ?? this.eat('KW');
    if (!first) return null;
    if (first.kind !== 'NUMBER') return first;

    let merged = first;
    for (;;) {
      const next = this.peek();
      const adjacent =
        (next.kind === 'IDENT' || next.kind === 'KW' || next.kind === 'NUMBER') &&
        next.start === merged.end;
      if (!adjacent) break;
      this.pos++;
      merged = { ...merged, image: merged.image + next.image, end: next.end };
    }
    return merged;
  }

  private parseCurveOrDefinite(): string {
    const t = this.peek();
    if (t.kind === 'KW' && t.image === 'definite') {
      this.pos++;
      return 'definite';
    }
    return this.parseDottedIdent();
  }

  private parseDottedIdent(): string {
    let s = '';
    while (true) {
      const id = this.eat('IDENT') ?? this.eat('KW');
      if (!id) break;
      s += id.image;
      if (!this.eat('DOT')) break;
      s += '.';
    }
    return s;
  }

  private parseFlexList(): FlexPoint[] {
    this.expect('LBRACK', '[');
    const pts: FlexPoint[] = [];
    if (!this.at('RBRACK')) {
      pts.push(this.parseFlexPoint());
      while (this.eat('COMMA')) {
        pts.push(this.parseFlexPoint());
      }
    }
    this.expect('RBRACK', ']');
    this.eat('SEMI');
    return pts;
  }

  private parseFlexPoint(): FlexPoint {
    this.expect('LPAREN', '(');
    const i = this.parseNumberWithUnit_A();
    this.eat('COMMA');
    const t = this.parseNumberWithUnit_s();
    this.expect('RPAREN', ')');
    return { I_A: i, t_s: t };
  }

  /**
   * Parse a member scalar inside `element` or `stage`. Returns the
   * key name on success, null on failure (caller skips one token).
   */
  private parseElementScalar(el: { members: import('./ast.js').ElementMember[] }): string | null {
    const k = this.eat('KW');
    if (!k) return null;
    this.expect('EQUALS', '=');
    switch (k.image) {
      case 'measures': {
        const v = this.parseQuantityValue();
        this.eat('SEMI');
        el.members.push({ kind: 'scalar', key: k.image, value: v ?? '' });
        return k.image;
      }
      /*
       * Which sheets this curve belongs on, by `view` name.
       *
       * The marks -- faults, times, points, annotations -- have taken
       * this since they were scoped; the curves themselves had not, so
       * a study with a phase sheet and a sequence sheet drew every
       * element on both and the only way to separate them was two
       * files.
       */
      case 'view':
      case 'views': {
        const names = this.parseNameList();
        this.eat('SEMI');
        el.members.push({ kind: 'scalar', key: 'views', value: names as never });
        return k.image;
      }
      /*
       * Enum-ish members, written bare or quoted. `style` is here with
       * them because it is the same shape: a word from a closed set.
       * It says how the curve is *drawn* rather than how the element
       * operates, which is the only thing that sets it apart.
       */
      case 'function':
      case 'I_units':
      case 'reset':
      case 'directional':
      case 'direction':
      case 'style': {
        const v = this.eat('KW') ?? this.eat('IDENT') ?? this.eat('STRING');
        this.eat('SEMI');
        /* These are enum-ish and may be written bare or quoted; strip
         * the quotes so consumers compare against one spelling. */
        el.members.push({ kind: 'scalar', key: k.image, value: v ? unquote(v.image) : '' });
        return k.image;
      }
      default: {
        /*
         * Strict here. Every field of an element is a setting that
         * decides whether a relay operates, so a name it does not know
         * is refused rather than warned about: `tsm` for `tms` left the
         * element at the default multiplier and the margin out by ten.
         */
        this.noteUnknownKey('an element', k, [
          'name', 'function', 'measures', 'curve', 'formula', 'flex_points',
          'I_pickup', 'I_units', 'share', 'tms', 't_delay', 't_reset',
          'char_angle', 'reset', 'directional', 'stages', 'comment',
          'current_max',
          /* How the curve is drawn, as opposed to how it operates. */
          'color', 'style', 'width_px',
          /* Which sheets it belongs on. */
          'view', 'views',
        ], /* strict */ true);
        const v = this.parseScalarValue();
        this.eat('SEMI');
        el.members.push({ kind: 'scalar', key: k.image, value: v });
        return k.image;
      }
    }
  }

  private parseRelay(): RelayBlock | null {
    const head = this.peek();
    this.pos++; // 'relay'
    const idTok = this.eat('IDENT') ?? this.eat('KW');
    if (!idTok) return null;
    this.expect('LBRACE', '{');
    const r: RelayBlock = { type: 'relay', id: idTok.image, members: [], loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const t = this.peek();
      if (t.kind === 'KW' && t.image === 'element') {
        const el = this.parseElement(false);
        if (el) r.members.push({ kind: 'element', element: el });
        continue;
      }
      if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
      const k = this.eat('KW') ?? this.eat('IDENT');
      if (!k) { this.pos++; continue; }
      this.expect('EQUALS', '=');
      switch (k.image) {
        case 'ct_ratio':
          {
            const num = this.eat('NUMBER');
            this.expect('SLASH', '/');
            const den = this.eat('NUMBER');
            this.eat('SEMI');
            const v: ScalarValue = {
              kind: 'ratio',
              numerator: num ? Number(num.image) : NaN,
              denominator: den ? Number(den.image) : NaN,
            };
            r.members.push({ kind: 'scalar', key: 'ct_ratio', value: v });
          }
          break;
        case 'faults':
          {
            // [ "F1", "F2" ]
            this.expect('LBRACK', '[');
            const names: string[] = [];
            if (!this.at('RBRACK')) {
              names.push(this.parseStringOrIdent());
              while (this.eat('COMMA')) names.push(this.parseStringOrIdent());
            }
            this.expect('RBRACK', ']');
            this.eat('SEMI');
            r.members.push({ kind: 'scalar', key: 'faults', value: names as any });
          }
          break;
        case 'voltage':
        case 'maker':
        case 'model':
        case 'name':
        case 'direction':
        case 'comment':
        case 'description':
        case 'reference':
          {
            const v = this.parseScalarValue();
            this.eat('SEMI');
            r.members.push({ kind: 'scalar', key: k.image, value: v });
          }
          break;
        default:
          this.noteUnknownKey('a relay', k, ['name', 'voltage', 'maker', 'model', 'ct_ratio', 'direction', 'faults', 'comment', 'description', 'reference']);
          // unknown relay scalar -- consume the value to avoid stuck loops
          this.parseScalarValue();
          this.eat('SEMI');
      }
    }
    this.expect('RBRACE', '}');
    return r;
  }

  private parseDevice(): DeviceBlock | null {
    const head = this.peek();
    this.pos++; // 'device'
    const idTok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
    if (!idTok) return null;
    this.expect('LBRACE', '{');
    const d: DeviceBlock = { type: 'device', id: unquote(idTok.image), loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const t = this.peek();
      if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
      const k = this.eat('KW') ?? this.eat('IDENT');
      if (!k) { this.pos++; continue; }
      this.expect('EQUALS', '=');
      switch (k.image) {
        case 'kind':
          {
            const kindKw = this.matchKeyword('fuse','recloser','cable','transformer_damage','motor_startup','breaker');
            this.eat('SEMI');
            if (kindKw) d.kind = kindKw as any;
          }
          break;
        /* Ratings and delays carry unit suffixes; fold them in. */
        case 'rating_I':
          d.rating_A = this.parseNumberWithUnit_A('rating_I');
          this.eat('SEMI');
          break;
        case 'rating_V':
          d.rating_kV = this.parseNumberWithUnit_kV('rating_V');
          this.eat('SEMI');
          break;
        case 'rating_S':
          /*
           * Was `parseNumber` followed by eating whatever token came
           * next, so the suffix was swallowed rather than read: `25 kVA`
           * and `25 MVA` both became 25, and a bare `25` passed too.
           */
          d.rating_MVA = this.parseNumberWithUnit_MVA('rating_S');
          this.eat('SEMI');
          break;
        case 't_delay':
          d.t_delay = this.parseNumberWithUnit_s('t_delay');
          this.eat('SEMI');
          break;
        case 'flex_points':
          d.flex_points = this.parseFlexList();
          break;
        case 'min_melt':
          d.min_melt = this.parseFlexList();
          break;
        case 'total_clear':
          d.total_clear = this.parseFlexList();
          break;
        case 'voltage':
        case 'maker': case 'model': case 'description': case 'comment': case 'reference':
          {
            /*
             * `parseScalarValue` returns a tagged value, not a string;
             * `String(...)` on it yields "[object Object]", which is
             * what these fields used to carry into the legend.
             */
            const v = this.parseStringOrIdent();
            this.eat('SEMI');
            if (k.image === 'voltage') d.voltage = v;
            if (k.image === 'maker') d.maker = v;
            if (k.image === 'model') d.model = v;
            if (k.image === 'description') d.description = v;
            if (k.image === 'comment') d.comment = v;
            if (k.image === 'reference') d.reference = v;
          }
          break;
        default:
          this.noteUnknownKey('a device', k, ['kind', 'voltage', 'maker', 'model', 'rating_I', 'rating_V', 'rating_S', 'flex_points', 'min_melt', 'total_clear', 't_delay', 'comment', 'description', 'reference']);
          this.parseScalarValue();
          this.eat('SEMI');
      }
    }
    this.expect('RBRACE', '}');
    return d;
  }

  private parseGrade(): GradeBlock | null {
    const head = this.peek();
    return this.parseBlock('grade', () => {
      const g: GradeBlock = { type: 'grade', loc: this.loc(head) };
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const t = this.peek();
        if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
        const k = this.eat('KW') ?? this.eat('IDENT');
        if (!k) { this.pos++; continue; }
        // Keys whose value is a sub-block rather than `= ... ;`
        if (k.image === 'solve') {
          // We already consumed the 'solve' keyword; the next token
          // is `{`, not `=`.
          this.expect('LBRACE', '{');
          g.solve = this.parseSolveInner();
          this.expect('RBRACE', '}');
          continue;
        }
        this.expect('EQUALS', '=');
        switch (k.image) {
          case 'primary':
          case 'backup':
            {
              // We already consumed `<keyword> =`; parseRef starts
              // at the relay-ref path now.
              const r = this.parseRef();
              this.eat('SEMI');
              if (k.image === 'primary') g.primary = r;
              else g.backup = r;
            }
            break;
          case 'scenario':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) g.scenario = unquote(tok.image);
            }
            break;
          case 'fault':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) g.fault = unquote(tok.image);
            }
            break;
          case 'margin':
          case 'margin_target':
            {
              const n = this.parseNumberWithUnit_s();
              this.eat('SEMI');
              if (k.image === 'margin') g.CTI_min_s = n;
              else g.margin_s = n;
            }
            break;
          /* Sweep the margin above the declared fault as well. */
          case 'upstream':
            g.upstream = this.parseBool();
            this.eat('SEMI');
            break;
          case 'upstream_to':
            g.upstream_to_A = this.parseNumberWithUnit_A('upstream_to');
            this.eat('SEMI');
            break;
          case 'tolerance_pct':
            {
              const n = this.parseNumber();
              this.eat('SEMI');
              g.tolerance_pct = n;
            }
            break;
          case 'comment':
            {
              const v = this.parseScalarValue();
              this.eat('SEMI');
              g.comment = String(v);
            }
            break;
          default:
            this.noteUnknownKey('a grade', k, ['primary', 'backup', 'fault', 'scenario', 'margin', 'margin_target', 'tolerance_pct', 'upstream', 'upstream_to', 'solve', 'comment']);
            this.parseScalarValue();
            this.eat('SEMI');
        }
      }
      return g;
    }, '}');
  }

  private parseSolveInner(): SolveBlock {
    const head = this.peek();
    const s: SolveBlock = { type: 'solve', loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const t = this.peek();
      if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
      const k = this.eat('KW') ?? this.eat('IDENT');
      if (!k) { this.pos++; continue; }
      this.expect('EQUALS', '=');
      switch (k.image) {
        case 'strategy':
          {
            const v = this.matchKeyword('tight','loose','safety_factor');
            this.eat('SEMI');
            if (v) s.strategy = v as any;
          }
          break;
        case 'tolerance_pct':
          s.tolerance_pct = this.parseNumber(); this.eat('SEMI'); break;
        case 'free':
          {
            this.expect('LBRACK', '[');
            const arr: ('tms'|'t_delay'|'I_pickup')[] = [];
            if (!this.at('RBRACK')) {
              const v = this.matchKeyword('tms','t_delay','I_pickup');
              if (v) arr.push(v as any);
              while (this.eat('COMMA')) {
                const w = this.matchKeyword('tms','t_delay','I_pickup');
                if (w) arr.push(w as any);
              }
            }
            this.expect('RBRACK', ']');
            this.eat('SEMI');
            s.free = arr;
          }
          break;
        default:
          this.noteUnknownKey('a solve', k, ['strategy', 'tolerance_pct', 'free', 'comment']);
          this.parseScalarValue();
          this.eat('SEMI');
      }
    }
    return s;
  }

  private parseAnnotate(): AnnotateBlock | null {
    const head = this.peek();
    return this.parseBlock('annotate', () => {
      const a: AnnotateBlock = { type: 'annotate', loc: this.loc(head) };
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const t = this.peek();
        if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
        const k = this.eat('KW') ?? this.eat('IDENT');
        if (!k) { this.pos++; continue; }
        this.expect('EQUALS', '=');
        switch (k.image) {
          case 'on_curve':
            a.on_curve = this.parseRef();
            this.eat('SEMI');
            break;
          case 'at_I':
            a.at_I_A = this.parseNumberWithUnit_A('at_I');
            this.eat('SEMI');
            break;
          case 'at_I1':
            a.at_I1_A = this.parseNumberWithUnit_A('at_I1'); this.eat('SEMI'); break;
          case 'at_I2':
            a.at_I2_A = this.parseNumberWithUnit_A('at_I2'); this.eat('SEMI'); break;
          case 'at_I0':
            a.at_I0_A = this.parseNumberWithUnit_A('at_I0'); this.eat('SEMI'); break;
          case 'at_residual':
            a.at_earth_A = this.parseNumberWithUnit_A('at_residual'); this.eat('SEMI'); break;
          case 'type': {
            const kw = this.matchKeyword(
              'three_phase', 'two_phase', 'two_phase_earth', 'single_phase_earth');
            this.eat('SEMI');
            if (kw) a.faultType = kw as import('./ast.js').FaultTypeKeyword;
            break;
          }
          case 'at_t':
            a.at_t_s = this.parseNumberWithUnit_s('at_t');
            this.eat('SEMI');
            break;
          case 'from':
            a.from = this.parseCurrentOrTime('from'); this.eat('SEMI'); break;
          case 'to':
            a.to = this.parseCurrentOrTime('to'); this.eat('SEMI'); break;
          case 'point':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) a.pointRef = unquote(tok.image);
            }
            break;
          case 'voltage':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) a.voltage = unquote(tok.image);
            }
            break;
          /* Margin form: the pair whose separation is being labelled. */
          case 'primary':
            a.primary = this.parseRef();
            this.eat('SEMI');
            break;
          case 'backup':
            a.backup = this.parseRef();
            this.eat('SEMI');
            break;
          /*
           * The condition -- a fault or a scenario, one or several.
           * They are alternative names for the same idea, so they
           * accumulate into one list and the annotation is drawn once
           * per condition named.
           */
          case 'fault':
          case 'faults':
          case 'scenario':
          case 'scenarios':
            {
              const names = this.parseNameList();
              this.eat('SEMI');
              if (names.length > 0) a.conditions = [...(a.conditions ?? []), ...names];
            }
            break;
          case 'label':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) a.label = unquote(tok.image);
            }
            break;
          case 'coords':
            a.coords = this.parseBool();
            this.eat('SEMI');
            break;
          case 'style':
            {
              const at = this.peek();
              const styleKw = this.matchKeyword('leader', 'pin', 'tag');
              this.eat('SEMI');
              if (styleKw) a.style = styleKw as any;
              else {
                /*
                 * Said rather than silently defaulted. A spelling the
                 * parser does not know used to leave the field unset
                 * and fall back to `leader`, so a study asking for
                 * something else got a leader and no indication that
                 * its request had been dropped.
                 */
                this.errors.push({
                  message: `annotate style must be leader, pin or tag, not ${tokenDescribe(at)}`,
                  line: at.line, column: at.col,
                  offset: at.start, length: at.end - at.start,
                  severity: 'error', code: 'ANNOTATE_STYLE_UNKNOWN',
                });
              }
            }
            break;
          case 'view':
          case 'views': {
            const names = this.parseNameList();
            if (names.length > 0) a.views = [...(a.views ?? []), ...names];
            this.eat('SEMI');
            break;
          }
          case 'color':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) a.color = unquote(tok.image);
            }
            break;
          default:
            this.noteUnknownKey('an annotate', k, ['on_curve', 'primary', 'backup', 'point', 'at_I', 'at_I1', 'at_I2', 'at_I0', 'at_residual', 'at_t', 'from', 'to', 'voltage', 'type', 'fault', 'faults', 'scenario', 'scenarios', 'label', 'style', 'color', 'coords', 'view', 'views']);
            this.parseScalarValue(); this.eat('SEMI');
        }
      }
      return a;
    }, '}');
  }

  private parseCombine(): CombineBlock | null {
    const head = this.peek();
    return this.parseBlock('combine', () => {
      const c: CombineBlock = {
        type: 'combine', name: '', sources: [], as: 'envelope_min',
        loc: this.loc(head),
      };
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const t = this.peek();
        if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
        const k = this.eat('KW') ?? this.eat('IDENT');
        if (!k) { this.pos++; continue; }
        this.expect('EQUALS', '=');
        switch (k.image) {
          case 'name':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) c.name = unquote(tok.image);
            }
            break;
          case 'sources':
            c.sources = this.parseRefList();
            this.eat('SEMI');
            break;
          case 'as':
            {
              const v = this.matchKeyword('envelope_min','envelope_max','sum','select_first');
              this.eat('SEMI');
              if (v) c.as = v as any;
            }
            break;
          case 'color':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) c.color = unquote(tok.image);
            }
            break;
          case 'style':
            {
              const v = this.matchKeyword('solid','dashed','dotted');
              this.eat('SEMI');
              if (v) c.style = v as any;
            }
            break;
          case 'label':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) c.label = unquote(tok.image);
            }
            break;
          default:
            this.noteUnknownKey('a combine', k, ['name', 'sources', 'as', 'color', 'style', 'label']);
            this.parseScalarValue(); this.eat('SEMI');
        }
      }
      return c;
    }, '}');
  }

  private parseView(): ViewBlock | null {
    const head = this.peek();
    this.expectKeyword('view');

    /* `view "Phase grading" { ... }` -- the name is optional, so a
     * study with one sheet reads exactly as it always did. */
    const nameTok = this.at('STRING') ? this.eat('STRING') : null;

    if (!this.eat('LBRACE')) {
      this.errors.push({
        message: "expected '{' after view",
        line: this.peek().line, column: this.peek().col,
        offset: this.peek().start, length: 1,
        severity: 'error', code: 'EXPECTED_LBRACE',
      });
      return null;
    }

    const v = ((): ViewBlock => {
      const v: ViewBlock = { type: 'view', loc: this.loc(head) };
      if (nameTok) v.name = unquote(nameTok.image);
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const t = this.peek();
        if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
        const k = this.eat('KW') ?? this.eat('IDENT');
        if (!k) { this.pos++; continue; }
        this.expect('EQUALS', '=');
        switch (k.image) {
          case 'stages':
            {
              const v2 = this.matchKeyword('composite','individual');
              this.eat('SEMI');
              if (v2) v.stages = v2 as any;
            }
            break;
          case 'axis':
            {
              const v2 = this.matchKeyword('primary','secondary','multiples');
              this.eat('SEMI');
              if (v2) v.axis = v2 as any;
            }
            break;
          case 'quantity':
            {
              const q = this.parseQuantityValue();
              this.eat('SEMI');
              if (q) v.quantity = q as import('./ast.js').AxisQuantityKeyword;
            }
            break;
          case 'condition':
            {
              const c = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (c) v.condition = unquote(c.image);
            }
            break;
          case 'voltage':
            {
              // value is one of: string "HV", numeric kV like "33 kV",
              // or the keyword "pickup" (project into each curve's
              // own voltage, no projection).
              const vtok = this.peek();
              if (vtok.kind === 'KW' && vtok.image === 'pickup') {
                this.pos++;
                v.voltage = 'pickup';
                this.eat('SEMI');
                break;
              }
              const val = this.parseScalarValue();
              this.eat('SEMI');
              // If numeric, store as "[n] kV" string (renderer
              // normalises).
              if (val && val.kind === 'number') {
                const u = (val as any).unit ?? 'kV';
                const n = (val as any).value as number;
                v.voltage = `${n} ${u}`;
              } else if (val && val.kind === 'string') {
                v.voltage = (val as any).value as string;
              }
            }
            break;
          case 'current_min':
            v.current_min = this.parseNumberWithUnit_A('current_min'); this.eat('SEMI'); break;
          case 'current_max':
            v.current_max = this.parseNumberWithUnit_A('current_max'); this.eat('SEMI'); break;
          case 'time_min':
            v.time_min = this.parseNumberWithUnit_s('time_min'); this.eat('SEMI'); break;
          case 'time_max':
            v.time_max = this.parseNumberWithUnit_s('time_max'); this.eat('SEMI'); break;
          /* Axis padding, in decades, beyond the auto-fitted domain. */
          case 'current_pad':
            v.current_pad = this.parseNumber(); this.eat('SEMI'); break;
          case 'current_pad_low':
            v.current_pad_low = this.parseNumber(); this.eat('SEMI'); break;
          case 'current_pad_high':
            v.current_pad_high = this.parseNumber(); this.eat('SEMI'); break;
          case 'time_pad':
            v.time_pad = this.parseNumber(); this.eat('SEMI'); break;
          case 'time_pad_low':
            v.time_pad_low = this.parseNumber(); this.eat('SEMI'); break;
          case 'time_pad_high':
            v.time_pad_high = this.parseNumber(); this.eat('SEMI'); break;
          case 'two_axes':
            v.two_axes = this.parseBool(); this.eat('SEMI'); break;
          case 'reference_ct':
            v.reference_ct = this.parseRef(); this.eat('SEMI'); break;
          /* Per-sheet heading, overriding `page { title }`. */
          case 'title':
            v.title = this.parseStringOrIdent(); this.eat('SEMI'); break;
          case 'subtitle':
            v.subtitle = this.parseStringOrIdent(); this.eat('SEMI'); break;
          case 'name':
            v.name = this.parseStringOrIdent(); this.eat('SEMI'); break;
          /* Which sheet a non-interactive render draws. */
          case 'default':
            v.isDefault = this.parseBool(); this.eat('SEMI'); break;
          default:
            this.noteUnknownKey('a view', k, ['name', 'default', 'voltage', 'axis', 'quantity', 'condition', 'title', 'subtitle', 'stages', 'current_min', 'current_max', 'time_min', 'time_max', 'two_axes', 'reference_ct']);
            this.parseScalarValue(); this.eat('SEMI');
        }
      }
      return v;
    })();

    this.expect('RBRACE', '}');
    return v;
  }

  /** Token `n` positions ahead, without consuming anything. */
  private peekAt(n: number): Token {
    return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
  }

  /**
   * Read a `{ key = value; ... }` clause into a flat record.
   *
   * Values keep their parsed form -- numbers with units folded, strings
   * unquoted, booleans as booleans -- so the caller can assign them to
   * typed fields without re-parsing.
   */
  private parsePageSubBlock(name: string): Record<string, PageSubValue> {
    this.expect('LBRACE', '{');
    const accepts = PAGE_SUB_FIELDS[name] ?? [];
    const out: Record<string, PageSubValue> = {};
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const key = this.eat('KW') ?? this.eat('IDENT');
      if (!key) { this.pos++; continue; }
      if (accepts.length > 0) this.noteUnknownKey(`page ${name}`, key, accepts);
      this.expect('EQUALS', '=');

      const t = this.peek();
      if (t.kind === 'NUMBER') {
        out[key.image] = this.parseNumberWithUnit_any();
      } else if (t.kind === 'KW' && (t.image === 'true' || t.image === 'false')) {
        out[key.image] = this.parseBool();
      } else if (t.kind === 'LBRACK') {
        /*
         * A bracketed list, for text that runs to several lines. The
         * alternative is one long string with `\n` in it, which is
         * legal and unreadable in a source file an engineer maintains.
         */
        this.pos++;
        const items: string[] = [];
        if (!this.at('RBRACK')) {
          items.push(this.parseStringOrIdent());
          while (this.eat('COMMA')) items.push(this.parseStringOrIdent());
        }
        this.expect('RBRACK', ']');
        out[key.image] = items;
      } else {
        out[key.image] = this.parseStringOrIdent();
      }
      this.eat('SEMI');
    }
    this.expect('RBRACE', '}');
    return out;
  }

  /** A number with any unit suffix folded to its base unit. */
  private parseNumberWithUnit_any(): number {
    const t = this.eat('NUMBER');
    if (!t) return NaN;
    const raw = Number(t.image.replace(/_/g, ''));
    const u = this.eat('IDENT') ?? this.eat('KW');
    switch (u?.image) {
      case 'kA': return raw * 1e3;
      case 'mA': return raw * 1e-3;
      case 'ms': return raw * 1e-3;
      case 'min': return raw * 60;
      case 'V': return raw;
      default:   return raw;
    }
  }

  /** The structured `title { text; subtitle; ... }` clause. */
  private parsePageTitle(): PageTitle {
    const head = this.peek();
    this.expect('LBRACE', '{');
    const t: PageTitle = { text: '', loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const key = this.eat('KW') ?? this.eat('IDENT');
      if (!key) { this.pos++; continue; }
      this.expect('EQUALS', '=');
      switch (key.image) {
        case 'text':      t.text = this.parseStringOrIdent(); break;
        case 'subtitle':  t.subtitle = this.parseStringOrIdent(); break;
        case 'color':     t.color = this.parseStringOrIdent(); break;
        case 'align': {
          const a = this.matchKeyword('left', 'center', 'right');
          if (a) t.align = a as PageTitle['align'];
          break;
        }
        case 'font_size_px': t.font_size_px = this.parseNumber(); break;
        default: this.parseScalarValue(); break;
      }
      this.eat('SEMI');
    }
    this.expect('RBRACE', '}');
    return t;
  }

  private parsePage(): PageBlock | null {
    const head = this.peek();
    return this.parseBlock('page', () => {
      const p: PageBlock = { type: 'page', loc: this.loc(head) };
      while (!this.at('RBRACE') && !this.at('EOF')) {
        const t = this.peek();
        if (t.kind !== 'KW' && t.kind !== 'IDENT') { this.pos++; continue; }
        const k = this.eat('KW') ?? this.eat('IDENT');
        if (!k) { this.pos++; continue; }

        /*
         * Spec _Page_: most sub-blocks are written without an `=`
         * (`legend { ... }`), while `title` and `margins_mm` take one
         * (`margins_mm = { ... }`). Both spellings are accepted, and a
         * sub-block is recognised by the brace rather than the key, so
         * the two forms need no separate handling downstream.
         */
        const equalsThenBrace = this.at('EQUALS') && this.peekAt(1).kind === 'LBRACE';
        if (this.at('LBRACE') || equalsThenBrace) {
          if (equalsThenBrace) this.pos++;      // consume '='
          if (k.image === 'title') {
            p.title = this.parsePageTitle();
            this.eat('SEMI');
            continue;
          }
          const fields = this.parsePageSubBlock(k.image);
          this.eat('SEMI');
          applyPageSubBlock(p, k.image, fields);
          continue;
        }

        this.expect('EQUALS', '=');
        switch (k.image) {
          case 'size':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) p.size = unquote(tok.image);
            }
            break;
          case 'border':
            p.border = this.parseBool();
            this.eat('SEMI');
            break;
          case 'stretch':
            p.stretch = this.parseBool();
            this.eat('SEMI');
            break;
          case 'orientation':
            {
              const v = this.matchKeyword('portrait','landscape');
              this.eat('SEMI');
              if (v) p.orientation = v as any;
            }
            break;
          case 'theme':
            {
              const v = this.matchKeyword('light','dark','monochrome','print');
              this.eat('SEMI');
              if (v) p.theme = v as any;
            }
            break;
          case 'watermark':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT');
              this.eat('SEMI');
              if (tok) p.watermark = unquote(tok.image);
            }
            break;
          case 'title':
            {
              /*
               * Spec _Title / footer / watermark_: `title` accepts
               * either a bare string or a `{ text; subtitle; ... }`
               * clause. Both spellings are handled here.
               */
              if (this.at('LBRACE')) {
                this.pos++;
                const t: import('./ast.js').PageTitle = { text: '', loc: this.loc(this.peek()) };
                while (!this.at('RBRACE') && !this.at('EOF')) {
                  const key = this.eat('KW') ?? this.eat('IDENT');
                  if (!key) { this.pos++; continue; }
                  this.expect('EQUALS', '=');
                  switch (key.image) {
                    case 'text':      t.text = this.parseStringOrIdent(); break;
                    case 'subtitle':  t.subtitle = this.parseStringOrIdent(); break;
                    case 'color':     t.color = this.parseStringOrIdent(); break;
                    case 'align': {
                      const a = this.matchKeyword('left', 'center', 'right');
                      if (a) t.align = a as PageTitle['align'];
                      break;
                    }
                    case 'font_size_px': t.font_size_px = this.parseNumber(); break;
                    default: this.parseScalarValue(); break;
                  }
                  this.eat('SEMI');
                }
                this.expect('RBRACE', '}');
                this.eat('SEMI');
                p.title = t;
              } else {
                const tok = this.eat('STRING') ?? this.eat('IDENT');
                this.eat('SEMI');
                if (tok) p.title = unquote(tok.image);
              }
            }
            break;
          case 'footer':
            {
              // v0.1.0: a plain string only; the renderer treats it
              // as the right slot of the footer bar.
              const tok = this.eat('STRING') ?? this.eat('IDENT');
              this.eat('SEMI');
              if (tok) p.footer = { right: unquote(tok.image) } as any;
            }
            break;
          case 'margins_mm':
            {
              /*
               * Shorthand for the four-sided block: `margins_mm = 0;`
               * is the same as declaring every side zero, which is how
               * a study asks to fill the sheet edge to edge. The
               * scalar used to fall through to the placeholder below
               * and be silently dropped -- accepted, then ignored,
               * which is the worst of both.
               */
              const all = this.parseNumber();
              this.eat('SEMI');
              if (Number.isFinite(all)) {
                p.margins_mm = { loc: p.loc, top: all, right: all, bottom: all, left: all };
              }
            }
            break;
          default:
            // Other page members (scale, legend, axes, curves,
            // points, leaders) are read into a placeholder.
            this.parseScalarValue();
            this.eat('SEMI');
        }
      }
      return p;
    }, '}');
  }

  /* ----------------------- helpers ----------------------- */

  private parseNumber(): number {
    const t = this.eat('NUMBER');
    if (!t) {
      this.errors.push({
        message: 'expected number',
        line: this.peek().line, column: this.peek().col,
        offset: this.peek().start, length: 1,
        severity: 'error', code: 'EXPECTED_NUMBER',
      });
      return NaN;
    }
    return Number(t.image.replace(/_/g, ''));
  }

  /* Parse a number with optional unit suffix (e.g. "100 A" or "33 kV"),
   * returning the canonical value converted to a single unit. */
  /**
   * A number with a unit suffix, folded to the base unit.
   *
   * An unrecognised suffix is an *error*, not a shrug. Each of these
   * used to end in `return raw` for anything it did not know, so `4 KA`
   * became 4 A and `60 msec` became 60 seconds -- a factor of a
   * thousand, silently, in a field that decides whether a relay trips.
   * The case matters (`kA`, not `KA`) and so does the spelling, so the
   * message lists what is accepted rather than merely refusing.
   */
  private parseNumberWithUnit(
    factors: Record<string, number>,
    base: string,
    /**
     * The key being assigned, so a suffix valid for another quantity
     * can be refused too. Checking against the union of every suffix
     * caught a misspelling but not a category error: `I_pickup = 5 ms`
     * was a real suffix in the wrong place, and passed.
     */
    field?: string,
  ): number {
    const t = this.eat('NUMBER');
    if (!t) return NaN;
    const raw = Number(t.image.replace(/_/g, ''));

    /* Only take the next token if it could be a suffix: a bare number
     * is followed by `;`, and eating that would swallow the statement. */
    if (!this.at('IDENT') && !this.at('KW')) {
      /*
       * A bare number where the field has a quantity.
       *
       * No key names its own unit any more, which was done precisely so
       * that the author states it -- and nothing made them. The base
       * unit was assumed in silence, so `t_delay = 50;` on an
       * instantaneous element meant fifty *seconds* where the author
       * meant fifty milliseconds, and the sheet drew it without a word.
       * A thousandfold error on a trip time is not a thing to infer.
       *
       * Refused rather than warned about, on the same rule the element
       * block already follows: in a place where every value changes a
       * number, a guess is worse than a complaint.
       */
      if (field != null && FIELD_QUANTITY[field] != null) {
        this.errors.push({
          message: `"${field}" needs a unit; write one of `
            + suffixesFor(FIELD_QUANTITY[field]!).map((k) => `"${k}"`).join(', ')
            + ` -- a bare number would be read as ${base}`,
          line: t.line, column: t.col, offset: t.start, length: t.end - t.start,
          severity: 'error', code: 'UNIT_MISSING',
        });
      }
      return raw;
    }

    const u = this.tokens[this.pos];
    const factor = factors[u.image];

    if (factor == null && field != null && suffixFits(field, u.image) === false) {
      this.errors.push({
        message: `"${u.image}" is not a unit of ${base}; "${field}" takes `
          + suffixesFor(FIELD_QUANTITY[field]!).map((k) => `"${k}"`).join(', '),
        line: u.line, column: u.col, offset: u.start, length: u.end - u.start,
        severity: 'error', code: 'UNIT_WRONG_QUANTITY',
      });
      this.pos++;
      return raw;
    }

    if (factor == null) {
      this.errors.push({
        message: `unknown unit "${u.image}"; ${base} accepts `
          + Object.keys(factors).map((k) => `"${k}"`).join(', '),
        line: u.line, column: u.col, offset: u.start, length: u.end - u.start,
        severity: 'error', code: 'UNIT_UNKNOWN',
      });
      this.pos++;
      return raw;
    }
    this.pos++;
    return raw * factor;
  }

  /**
   * A figure that may be a current or a time, reporting which it was.
   *
   * For `from` and `to`, where the *unit* is what says whether the
   * span is drawn across the sheet or up it. Asking the author to
   * declare the orientation separately would let the two disagree;
   * `400 A` and `300 ms` already carry it, and units are mandatory
   * everywhere else for exactly this reason.
   */
  private parseCurrentOrTime(field: string): SpanEnd | undefined {
    const at = this.peek();
    const unit = this.tokens[this.pos + 1];
    const isTime = unit != null && (unit.kind === 'IDENT' || unit.kind === 'KW')
      && ['s', 'ms', 'min', 'ks'].includes(unit.image);

    if (isTime) {
      const value = this.parseNumberWithUnit_s(field);
      return Number.isFinite(value) ? { value, quantity: 'time' } : undefined;
    }

    /*
     * Anything else is read as a current, so an unknown or missing
     * unit produces the ordinary current diagnostic rather than a
     * second, vaguer one about not being able to tell what was meant.
     */
    if (at.kind !== 'NUMBER') return undefined;
    const value = this.parseNumberWithUnit_A(field);
    return Number.isFinite(value) ? { value, quantity: 'current' } : undefined;
  }

  private parseNumberWithUnit_A(field?: string): number {
    return this.parseNumberWithUnit(
      { A: 1, kA: 1e3, mA: 1e-3, MA: 1e6 }, 'current', field);
  }
  private parseNumberWithUnit_kV(field?: string): number {
    return this.parseNumberWithUnit(
      { kV: 1, V: 1e-3, MV: 1e3 }, 'voltage', field);
  }
  private parseNumberWithUnit_MVA(field?: string): number {
    return this.parseNumberWithUnit(
      { MVA: 1, kVA: 1e-3, GVA: 1e3, MW: 1 }, 'apparent power', field);
  }
  private parseNumberWithUnit_s(field?: string): number {
    return this.parseNumberWithUnit(
      { s: 1, ms: 1e-3, min: 60, ks: 1e3 }, 'time', field);
  }
  private parseBool(): boolean {
    const v = this.matchKeyword('true','false');
    return v === 'true';
  }
  private parseStringOrIdent(): string {
    const t = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
    return t ? unquote(t.image) : '';
  }
  private parseScalarValue(): ScalarValue {
    const t = this.peek();
    if (t.kind === 'NUMBER') {
      this.pos++;
      const num = Number(t.image.replace(/_/g, ''));
      let unit: string | undefined;
      if (this.at('IDENT') || this.at('KW')) {
        const ut = this.tokens[this.pos++];
        unit = ut.image;
      }
      return { kind: 'number', value: num, unit };
    }
    if (t.kind === 'STRING') {
      this.pos++;
      return { kind: 'string', value: unquote(t.image) };
    }
    if (t.kind === 'KW' && (t.image === 'true' || t.image === 'false')) {
      this.pos++;
      return { kind: 'boolean', value: t.image === 'true' };
    }
    if (t.kind === 'IDENT' || t.kind === 'KW') {
      this.pos++;
      return { kind: 'string', value: t.image };
    }
    return { kind: 'string', value: '' };
  }

  private parseRef(): Ref {
    /*
     * A quoted id is accepted as well as a bare one. A device is
     * *declared* with quotes -- `device "fuse_100T" { ... }` -- so
     * writing `primary = "fuse_100T"` is the natural reference, and it
     * used to parse as nothing and report an unresolved reference.
     */
    const quoted = this.eat('STRING');
    if (quoted) {
      const id = unquote(quoted.image);
      return { deviceId: id, text: id };
    }

    const first = this.eat('IDENT') ?? this.eat('KW');
    if (!first) return { text: '' };
    if (this.eat('COLON')) {
      /*
       * The element half is a device number, so it is read with the
       * same rule the declaration uses: a digit-leading identifier
       * absorbs the letters that follow it immediately.
       *
       * Eating a single token instead dropped the suffix, so
       * `R_INC:51G` referred to `51` -- resolving to a different
       * element where one existed, and to nothing where it did not.
       * Every letter-suffixed reference was affected: 51G, 67N, 51X,
       * 50BF.
       */
      const second = this.parseDeviceNumberId();
      const deviceId = first.image;
      const elementId = second ? second.image : '';

      /* `R_850:46/energ` -- one stage of a multi-stage element. */
      if (this.eat('SLASH')) {
        const stageTok = this.eat('IDENT') ?? this.eat('KW');
        const stageId = stageTok ? stageTok.image : '';
        return {
          deviceId, elementId, stageId,
          text: `${deviceId}:${elementId}/${stageId}`,
        };
      }
      return { deviceId, elementId, text: `${deviceId}:${elementId}` };
    }
    return { deviceId: first.image, text: first.image };
  }

  private parseRefList(): Ref[] {
    this.expect('LBRACK', '[');
    const out: Ref[] = [];
    if (!this.at('RBRACK')) {
      out.push(this.parseRef());
      while (this.eat('COMMA')) out.push(this.parseRef());
    }
    this.expect('RBRACK', ']');
    return out;
  }
}

/* ----------------------- helpers ----------------------- */

function tokenDescribe(t: Token | undefined): string {
  if (!t) return 'EOF';
  if (t.image === '') return 'EOF';
  return JSON.stringify(t.image);
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  return s;
}

/* ----------------------- public ----------------------- */

/**
 * Structural checks made over the token stream, before the grammar.
 *
 * Two faults that the block parsers cannot see between them:
 *
 *   - *a key assigned twice in one block*. The typed blocks build a
 *     record and the second assignment simply overwrites the first,
 *     so a `view` that sets `current_max` twice silently honours
 *     whichever came last -- and the reader has no way to tell which
 *     that is by looking.
 *   - *an assignment with nothing after the `=`*. Each field parser
 *     fails in its own way, mostly by returning `NaN` or `null` and
 *     leaving the field unset, so a half-typed line vanished from the
 *     study rather than being reported.
 *
 * Done here rather than in each parser because there is one rule for
 * every block, and because a scan over braces is the only view that
 * sees all of them.
 */
function structuralErrors(tokens: Token[]): ParseError[] {
  const errors: ParseError[] = [];

  /** One map of assigned keys per brace depth. */
  const scopes: Array<Map<string, Token>> = [new Map()];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.kind === 'LBRACE') { scopes.push(new Map()); continue; }
    if (t.kind === 'RBRACE') { if (scopes.length > 1) scopes.pop(); continue; }
    if (t.kind !== 'EQUALS') continue;

    /* `=` with no value before the statement ends. */
    const next = tokens[i + 1];
    const key = tokens[i - 1];
    if (!next || next.kind === 'SEMI' || next.kind === 'RBRACE' || next.kind === 'EOF') {
      errors.push({
        message: key
          ? `${key.image} is assigned nothing; expected a value after '='`
          : "expected a value after '='",
        line: t.line, column: t.col, offset: t.start, length: Math.max(1, t.end - t.start),
        severity: 'error', code: 'MISSING_VALUE',
      });
      continue;
    }

    /* The same key assigned twice in one block. */
    if (!key || (key.kind !== 'IDENT' && key.kind !== 'KW')) continue;
    const scope = scopes[scopes.length - 1];
    const first = scope.get(key.image);
    if (first) {
      errors.push({
        message:
          `${key.image} is assigned more than once in this block ` +
          `(first at line ${first.line}); the later value silently wins`,
        line: key.line, column: key.col, offset: key.start,
        length: Math.max(1, key.end - key.start),
        severity: 'error', code: 'DUPLICATE_KEY',
      });
    } else {
      scope.set(key.image, key);
    }
  }

  return errors;
}

export function parse(source: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(source);
  const parser = new Parser(tokens, lexErrors);
  const doc = parser.parseDocument();
  return {
    document: doc,
    errors: [...parser.errors, ...structuralErrors(tokens)]
      .sort((a, b) => a.offset - b.offset),
  };
}

export function lex(source: string) {
  return tokenize(source);
}

/**
 * Assign a parsed `page` sub-block onto the typed block.
 *
 * Kept as a plain function rather than a parser method because it is
 * pure shape-mapping: the reading is done, this only decides where
 * each field lands.
 */
function applyPageSubBlock(
  page: PageBlock,
  name: string,
  fields: Record<string, PageSubValue>,
): void {
  const str = (k: string): string | undefined =>
    typeof fields[k] === 'string' ? (fields[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof fields[k] === 'number' ? (fields[k] as number) : undefined;
  const bool = (k: string): boolean | undefined =>
    typeof fields[k] === 'boolean' ? (fields[k] as boolean) : undefined;
  /**
   * Free text, written either as one string or as a list of lines.
   *
   * Normalised to lines here so nothing downstream has to know which
   * spelling was used. A `\n` inside a single string breaks it the
   * same way, for text pasted in from somewhere else.
   */
  const lines = (k: string): string[] | undefined => {
    const value = fields[k];
    if (Array.isArray(value)) return value.filter((s) => s.trim() !== '');
    if (typeof value !== 'string') return undefined;
    const split = value.split('\n').filter((s) => s.trim() !== '');
    return split.length > 0 ? split : undefined;
  };

  switch (name) {
    case 'legend':
      page.legend = {
        loc: page.loc,
        show: bool('show'),
        style: str('style') as import('./ast.js').LegendStyle | undefined,
        position: str('position') as import('./ast.js').PageLegend['position'],
        color: str('color'),
        swatch: str('swatch') as 'line' | 'box' | 'circle' | undefined,
        title: str('title'),
        currents: str('currents') as import('./ast.js').LegendCurrents | undefined,
        notes: bool('notes'),
        comment: lines('comment'),
      };
      break;
    case 'axes':
      page.axes = {
        loc: page.loc,
        color: str('color'),
        grid_color: str('grid_color'),
        label_color: str('label_color'),
        label_size_px: num('label_size_px'),
        tick_size_px: num('tick_size_px'),
        frame: bool('frame'),
        mirror: bool('mirror'),
      };
      break;
    case 'curves':
      page.curves = {
        loc: page.loc,
        palette: str('palette'),
        line_width_px: num('line_width_px'),
        auto_color: bool('auto_color'),
      };
      break;
    case 'points':
      page.points = {
        loc: page.loc,
        color: str('color'),
        shape: str('shape') as 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'x' | undefined,
        size_px: num('size_px'),
        outline: bool('outline'),
      };
      break;
    case 'leaders':
      page.leaders = {
        loc: page.loc,
        show: bool('show'),
        style: str('style') as 'line' | 'arrow' | 'dot' | undefined,
        width_px: num('width_px'),
        color: str('color'),
        label_offset_px: num('label_offset_px'),
      };
      break;
    case 'scale':
      page.scale = {
        loc: page.loc,
        auto: bool('auto'),
        x_min: num('x_min'),
        x_max: num('x_max'),
        y_min: num('y_min'),
        y_max: num('y_max'),
        tick_density: str('tick_density') as 'sparse' | 'normal' | 'dense' | undefined,
      };
      break;
    case 'margins_mm':
      page.margins_mm = {
        loc: page.loc,
        top: num('top'),
        right: num('right'),
        bottom: num('bottom'),
        left: num('left'),
      };
      break;
    case 'faults':
      page.faults = {
        loc: page.loc,
        width_px: num('width_px'),
        color: str('color'),
        style: str('style') as 'solid' | 'dashed' | 'dotted' | undefined,
        labels: bool('labels'),
      };
      break;
    case 'times':
      page.times = {
        loc: page.loc,
        width_px: num('width_px'),
        color: str('color'),
        style: str('style') as 'solid' | 'dashed' | 'dotted' | undefined,
        labels: bool('labels'),
      };
      break;
    case 'footer':
      page.footer = {
        loc: page.loc,
        left: str('left'),
        center: str('center'),
        right: str('right'),
        font_size_px: num('font_size_px'),
        color: str('color'),
        border: bool('border'),
      };
      break;
    default:
      /* Unknown sub-block: the validator reports it; ignore here. */
      break;
  }
}
