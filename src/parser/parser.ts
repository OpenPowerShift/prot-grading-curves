/**
 * .tc parser -- hand-rolled recursive-descent with a precise tokenizer.
 *
 * Why handwritten: the language has a single grammar author (you),
 * ~150 productions, and lex-time errors benefit from a tighter
 * error model than Chevrotain provides out of the box. The grammar
 * lives in `parser.ts`; a future Codemirror highlight shares its
 * token vocabulary with the tokenizer here.
 */

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
export const KEYWORDS = new Set([
  // top-level blocks
  'meta', 'system', 'faults', 'relay', 'element', 'device', 'grade',
  'annotate', 'combine', 'view', 'page', 'notes', 'stage', 'stages', 'point',
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
  'function', 'tms', 't_delay', 't_reset', 'I_pu', 'I_units',
  'current_pct', 'char_angle', 'reset', 'directional', 'direction',
  'tolerance_pct', 'CTI_min_s', 'margin_s', 'upstream', 'upstream_to',
  'I_A', 'min_A', 'max_A', 'earth_A', 'I0_A', 'I2_A', 't_s',
  'voltage', 'kV', 'frequency_Hz', 'base_MVA', 'grounding', 'I_base_A',
  'ct_ratio', 'maker', 'model',
  'rating_A', 'rating_kV', 'rating_MVA',
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
      let buf = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          buf += source[i] + source[i + 1];
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

  constructor(tokens: Token[], errors: ParseError[]) {
    this.tokens = tokens;
    this.errors = errors;
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
        case 'I_A':   p.I_A = this.parseNumberWithUnit_A(); break;
        case 't_s':   p.t_s = this.parseNumberWithUnit_s(); break;
        case 'label': p.label = this.parseStringOrIdent(); break;
        case 'voltage': p.voltage = this.parseStringOrIdent(); break;
        case 'color': p.color = this.parseStringOrIdent(); break;
        case 'description': p.description = this.parseStringOrIdent(); break;
        case 'coords': p.coords = this.parseBool(); break;
        case 'shape': {
          const v = this.matchKeyword('circle','square','diamond','triangle','cross','x');
          if (v) p.shape = v as import('./ast.js').PointBlock['shape'];
          break;
        }
        default: this.parseScalarValue(); break;
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
                if (k.image === 'kV') lvl.kV = this.parseNumber();
                else {
                  const v = this.parseScalarValue();
                  if (k.image === 'description') lvl.description = String(v);
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
          case 'frequency_Hz':
            this.pos++; this.expect('EQUALS', '='); sys.frequency_Hz = this.parseNumber(); this.eat('SEMI'); continue;
          case 'base_MVA':
            this.pos++; this.expect('EQUALS', '='); sys.base_MVA = this.parseNumber(); this.eat('SEMI'); continue;
          case 'grounding':
            this.pos++; this.expect('EQUALS', '='); {
              const tok = this.eat('STRING') ?? this.eat('KW') ?? this.eat('IDENT');
              if (tok) sys.grounding = unquote(tok.image);
              this.eat('SEMI');
            } continue;
          case 'I_base_A':
            this.pos++; this.expect('EQUALS', '='); sys.I_base_A = this.parseNumber(); this.eat('SEMI'); continue;
          case 'I_units':
            this.pos++; this.expect('EQUALS', '='); {
              const k = this.matchKeyword('primary', 'secondary');
              if (k) sys.I_units = k as 'primary' | 'secondary';
              this.eat('SEMI');
            } continue;
          default:
            this.pos++;
            continue;
        }
      }
      return sys;
    }, '}');
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
            case 'I_A':      f.I_A = this.parseNumberWithUnit_A(); break;
            case 'min_A':    f.min_A = this.parseNumberWithUnit_A(); break;
            case 'max_A':    f.max_A = this.parseNumberWithUnit_A(); break;
            case 'earth_A':  f.earth_A = this.parseNumberWithUnit_A(); break;
            case 'I0_A':     f.I0_A = this.parseNumberWithUnit_A(); break;
            case 'I2_A':     f.I2_A = this.parseNumberWithUnit_A(); break;
            case 'voltage':  {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              if (tok) f.voltage = unquote(tok.image);
              break;
            }
            case 'description': {
              const tok = this.eat('STRING') ?? this.eat('KW') ?? this.eat('IDENT');
              if (tok) f.description = unquote(tok.image);
              break;
            }
            default: /* ignore */ this.parseScalarValue();
          }
          this.eat('SEMI');
        }
        this.expect('RBRACE', '}');
        list.push(f);
      }
      return { type: 'faults', faults: list, loc: this.loc(head) } as FaultsBlock;
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
        // unknown token -- skip one
        this.pos++;
      }
    }
    return el;
  }

  private parseStageBody(id: string, head: Token): StageBlock {
    const st: StageBlock = { type: 'stage', id, members: [], loc: this.loc(head) };
    while (!this.at('RBRACE') && !this.at('EOF')) {
      // no nested stages
      const t = this.peek();
      if (!(t.kind === 'KW' && (t.image === 'curve' || t.image === 'formula' || t.image === 'flex_points'))) {
        const ok = this.parseElementScalar(st);
        if (!ok) this.pos++;
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
   * test is what keeps `I_pu = 480 A` from being read as an id: the
   * space between them means they are separate tokens.
   */
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
      case 'function':
      case 'I_units':
      case 'reset':
      case 'directional':
      case 'direction': {
        const v = this.eat('KW') ?? this.eat('IDENT') ?? this.eat('STRING');
        this.eat('SEMI');
        /* These are enum-ish and may be written bare or quoted; strip
         * the quotes so consumers compare against one spelling. */
        el.members.push({ kind: 'scalar', key: k.image, value: v ? unquote(v.image) : '' });
        return k.image;
      }
      default: {
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
        case 'rating_A':
          d.rating_A = this.parseNumberWithUnit_A();
          this.eat('SEMI');
          break;
        case 'rating_kV':
          d.rating_kV = this.parseNumberWithUnit_kV();
          this.eat('SEMI');
          break;
        case 'rating_MVA':
          d.rating_MVA = this.parseNumber();
          this.eat('IDENT'); this.eat('KW');
          this.eat('SEMI');
          break;
        case 't_delay':
          d.t_delay = this.parseNumberWithUnit_s();
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
        case 'maker': case 'model': case 'description': case 'comment': case 'reference':
          {
            /*
             * `parseScalarValue` returns a tagged value, not a string;
             * `String(...)` on it yields "[object Object]", which is
             * what these fields used to carry into the legend.
             */
            const v = this.parseStringOrIdent();
            this.eat('SEMI');
            if (k.image === 'maker') d.maker = v;
            if (k.image === 'model') d.model = v;
            if (k.image === 'description') d.description = v;
            if (k.image === 'comment') d.comment = v;
            if (k.image === 'reference') d.reference = v;
          }
          break;
        default:
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
          case 'fault':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) g.fault = unquote(tok.image);
            }
            break;
          case 'CTI_min_s':
          case 'margin_s':
            {
              const n = this.parseNumberWithUnit_s();
              this.eat('SEMI');
              if (k.image === 'CTI_min_s') g.CTI_min_s = n;
              else g.margin_s = n;
            }
            break;
          /* Sweep the margin above the declared fault as well. */
          case 'upstream':
            g.upstream = this.parseBool();
            this.eat('SEMI');
            break;
          case 'upstream_to':
            g.upstream_to_A = this.parseNumberWithUnit_A();
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
            const arr: ('tms'|'t_delay'|'I_pu')[] = [];
            if (!this.at('RBRACK')) {
              const v = this.matchKeyword('tms','t_delay','I_pu');
              if (v) arr.push(v as any);
              while (this.eat('COMMA')) {
                const w = this.matchKeyword('tms','t_delay','I_pu');
                if (w) arr.push(w as any);
              }
            }
            this.expect('RBRACK', ']');
            this.eat('SEMI');
            s.free = arr;
          }
          break;
        default:
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
          case 'at_I_A':
            a.at_I_A = this.parseNumberWithUnit_A();
            this.eat('SEMI');
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
          case 'fault':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) a.fault = unquote(tok.image);
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
              const styleKw = this.matchKeyword('leader','pin','tag');
              this.eat('SEMI');
              if (styleKw) a.style = styleKw as any;
            }
            break;
          case 'color':
            {
              const tok = this.eat('STRING') ?? this.eat('IDENT') ?? this.eat('KW');
              this.eat('SEMI');
              if (tok) a.color = unquote(tok.image);
            }
            break;
          default:
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
            this.parseScalarValue(); this.eat('SEMI');
        }
      }
      return c;
    }, '}');
  }

  private parseView(): ViewBlock | null {
    const head = this.peek();
    return this.parseBlock('view', () => {
      const v: ViewBlock = { type: 'view', loc: this.loc(head) };
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
            v.current_min = this.parseNumberWithUnit_A(); this.eat('SEMI'); break;
          case 'current_max':
            v.current_max = this.parseNumberWithUnit_A(); this.eat('SEMI'); break;
          case 'time_min':
            v.time_min = this.parseNumberWithUnit_s(); this.eat('SEMI'); break;
          case 'time_max':
            v.time_max = this.parseNumberWithUnit_s(); this.eat('SEMI'); break;
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
          default:
            this.parseScalarValue(); this.eat('SEMI');
        }
      }
      return v;
    }, '}');
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
  private parsePageSubBlock(): Record<string, string | number | boolean> {
    this.expect('LBRACE', '{');
    const out: Record<string, string | number | boolean> = {};
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const key = this.eat('KW') ?? this.eat('IDENT');
      if (!key) { this.pos++; continue; }
      this.expect('EQUALS', '=');

      const t = this.peek();
      if (t.kind === 'NUMBER') {
        out[key.image] = this.parseNumberWithUnit_any();
      } else if (t.kind === 'KW' && (t.image === 'true' || t.image === 'false')) {
        out[key.image] = this.parseBool();
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
      case 'kV': return raw;
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
          const fields = this.parsePageSubBlock();
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
          default:
            // Other page members (margins_mm, scale, legend, axes,
            // curves, points, leaders) are read into a placeholder.
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
  private parseNumberWithUnit_A(): number {
    const t = this.eat('NUMBER');
    if (!t) return NaN;
    const raw = Number(t.image.replace(/_/g, ''));
    const u = this.eat('IDENT') ?? this.eat('KW');
    const unit = u?.image ?? 'A';
    if (unit === 'kA') return raw * 1e3;
    if (unit === 'mA') return raw * 1e-3;
    if (unit === 'MA') return raw * 1e6;
    return raw; // assume A
  }
  private parseNumberWithUnit_kV(): number {
    const t = this.eat('NUMBER');
    if (!t) return NaN;
    const raw = Number(t.image.replace(/_/g, ''));
    const u = this.eat('IDENT') ?? this.eat('KW');
    const unit = u?.image ?? 'kV';
    if (unit === 'V') return raw * 1e-3;
    if (unit === 'MV') return raw * 1e3;
    return raw; // assume kV
  }
  private parseNumberWithUnit_s(): number {
    const t = this.eat('NUMBER');
    if (!t) return NaN;
    const raw = Number(t.image.replace(/_/g, ''));
    const u = this.eat('IDENT') ?? this.eat('KW');
    const unit = u?.image ?? 's';
    if (unit === 'ms') return raw * 1e-3;
    if (unit === 'min') return raw * 60;
    if (unit === 'ks') return raw * 1e3;
    return raw; // assume seconds
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
    const first = this.eat('IDENT') ?? this.eat('KW');
    if (!first) return { text: '' };
    if (this.eat('COLON')) {
      const second = this.eat('IDENT') ?? this.eat('KW') ?? this.eat('NUMBER');
      const deviceId = first.image;
      const elementId = second ? second.image : '';
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

export function parse(source: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(source);
  const parser = new Parser(tokens, lexErrors);
  const doc = parser.parseDocument();
  return {
    document: doc,
    errors: [...lexErrors, ...parser.errors],
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
  fields: Record<string, string | number | boolean>,
): void {
  const str = (k: string): string | undefined =>
    typeof fields[k] === 'string' ? (fields[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof fields[k] === 'number' ? (fields[k] as number) : undefined;
  const bool = (k: string): boolean | undefined =>
    typeof fields[k] === 'boolean' ? (fields[k] as boolean) : undefined;

  switch (name) {
    case 'legend':
      page.legend = {
        loc: page.loc,
        show: bool('show'),
        position: str('position') as 'right' | 'left' | 'top' | 'bottom' | undefined,
        color: str('color'),
        swatch: str('swatch') as 'line' | 'box' | 'circle' | undefined,
        title: str('title'),
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
