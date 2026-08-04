/**
 * Source formatter for `.tc`.
 *
 * Reflows a study to the house style: two-space indentation per brace
 * level, one space either side of `=`, one statement per line, and
 * blank lines collapsed to at most one.
 *
 * Deliberately *line-based* rather than a print of the AST. A parsed
 * document has thrown away comments and the author's grouping, and a
 * formatter that silently deletes an engineer's notes is worse than no
 * formatter at all. Working on lines keeps every comment, and means a
 * file that does not currently parse can still be tidied.
 *
 * The one thing it must get right is not being fooled by braces inside
 * strings and comments, which `scanLine` handles.
 */

/*
 * Two spaces. Four made a deeply nested study -- `page` > `legend`, or
 * `element` > `stages` > `stage` -- spend more of the line on
 * indentation than on the setting.
 */
const INDENT = '  ';

/** How a single line affects nesting, and where it should sit. */
interface LineScan {
  /** Depth change contributed by this line. */
  delta: number;
  /** Depth change from closers *before* any opener, which dedent this line. */
  leadingClose: number;
  /** True when the line is entirely inside a block comment. */
  inComment: boolean;
}

/**
 * Count structural braces on a line, ignoring any that appear inside
 * string literals, line comments, or block comments.
 */
function scanLine(line: string, startInComment: boolean): LineScan {
  let depth = 0;
  let leadingClose = 0;
  let sawOpen = false;
  let inComment = startInComment;
  let inString = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];

    if (inComment) {
      if (c === '*' && next === '/') { inComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') { inString = true; continue; }
    if (c === '/' && next === '*') { inComment = true; i++; continue; }
    if (c === '#' || (c === '/' && next === '/')) break; // rest is a comment

    if (c === '{' || c === '[') { depth++; sawOpen = true; }
    else if (c === '}' || c === ']') {
      depth--;
      if (!sawOpen) leadingClose++;
    }
  }

  return { delta: depth, leadingClose, inComment };
}

/**
 * Split a simple `key = value;` line into its parts, for alignment.
 * Returns null for anything that is not a plain assignment -- block
 * headers, comments, list continuations -- which are left alone.
 */
function splitAssignment(line: string): { key: string; rest: string } | null {
  if (/^[#/]/.test(line)) return null;

  /*
   * Only *structural* braces disqualify a line -- a brace inside a
   * string value is just a character, and `project = "a { b } c";` is
   * still a plain assignment that should align with its neighbours.
   */
  if (/[{}[\]]/.test(stripStringsAndComments(line))) return null;

  const eq = line.indexOf('=');
  if (eq <= 0) return null;

  const key = line.slice(0, eq).trimEnd();
  /* A key is a single identifier, possibly with a leading block word. */
  if (!/^[A-Za-z_][\w.]*$/.test(key)) return null;

  return { key, rest: line.slice(eq + 1).trim() };
}

/** Blank out string literals and trailing comments, keeping length. */
function stripStringsAndComments(line: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (inString) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === '"') inString = false;
      out += ' ';
      continue;
    }
    if (c === '"') { inString = true; out += ' '; continue; }
    if (c === '#' || (c === '/' && (next === '/' || next === '*'))) break;
    out += c;
  }
  return out;
}

/**
 * Split a line so that each brace and each statement stands alone.
 *
 * A block written inline reads as one dense run of punctuation:
 *
 *   title = { text = "Northgate 33/11 kV"; subtitle = "cascade"; };
 *
 * and the `=` alignment below cannot help, because alignment works down
 * a column and there is only one line. Broken up, the keys line up
 * under each other and the braces show the nesting:
 *
 *   title = {
 *       text     = "Northgate 33/11 kV";
 *       subtitle = "cascade";
 *   };
 *
 * Only `{` and `}` split. A `[` list is a *value* -- `flex_points`
 * tables are read as rows and exploding them by element would make them
 * unreadable -- so brackets are left exactly as written.
 *
 * Returns fragments in order, or a single-element array when there is
 * nothing structural to split. Never splits inside a string or a
 * comment, and a trailing comment stays attached to the fragment it
 * followed.
 */
function explodeLine(line: string, startInComment: boolean): string[] {
  if (startInComment) return [line];

  const parts: string[] = [];
  let buf = '';
  let inString = false;

  const flush = (): void => {
    if (buf.trim() !== '') parts.push(buf.trim());
    buf = '';
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];

    if (inString) {
      buf += c;
      if (c === '\\' && next !== undefined) { buf += next; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') { buf += c; inString = true; continue; }

    /*
     * A comment runs to the end of the line and stays with what it was
     * written beside. If the statement it trailed has already been
     * flushed -- `project = "X"; # why` -- it rejoins that fragment
     * rather than starting a line of its own, where it would read as
     * annotating whatever came next.
     */
    if (c === '#' || (c === '/' && (next === '/' || next === '*'))) {
      const rest = line.slice(i);
      if (buf.trim() === '' && parts.length > 0) {
        parts[parts.length - 1] += ` ${rest.trim()}`;
        buf = '';
      } else {
        buf += rest;
      }
      break;
    }

    if (c === '{') { buf += c; flush(); continue; }
    if (c === '}') {
      /* Whatever preceded the closer belongs to the block it closes. */
      flush();
      /*
       * A closer stands alone, but takes an immediately following `;`
       * with it -- `};` ends a nested value block and splitting the two
       * would leave a line holding a single semicolon. Emitted at once
       * so that `} "LV" {` starts the next block on its own line
       * instead of trailing after the brace that closed the last.
       */
      let j = i + 1;
      while (j < line.length && line[j] === ' ') j++;
      if (line[j] === ';') { parts.push('};'); i = j; } else { parts.push('}'); }
      continue;
    }
    if (c === ';') { buf += c; flush(); continue; }

    buf += c;
  }
  flush();

  return parts.length > 0 ? parts : [line.trim()];
}

export interface FormatOptions {
  /**
   * Pad keys so `=` lines up within a run. Defaults to *false*.
   *
   * Aligned columns look tidy and cost the author every time they add a
   * longer key to a block: one new line reflows a dozen others, and the
   * diff stops showing what changed. A single space costs nothing and
   * leaves the value where the eye already is.
   */
  alignAssignments?: boolean;
  /**
   * Give each brace and each statement its own line. Defaults to true.
   * Off, the formatter only re-indents what the author already broke.
   */
  expandBlocks?: boolean;
}

/**
 * Format a `.tc` source.
 *
 * Idempotent: formatting an already-formatted document returns it
 * unchanged, which `tests/unit/format.spec.ts` pins.
 */
export function formatSource(source: string, options: FormatOptions = {}): string {
  const align = options.alignAssignments === true;
  const expand = options.expandBlocks !== false;
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');

  interface Out { indent: number; text: string; assignment: { key: string; rest: string } | null }
  const out: Out[] = [];

  let depth = 0;
  let inComment = false;
  let blankRun = 0;

  for (const raw of rawLines) {
    const trimmed = raw.trim();

    if (trimmed === '') {
      /* Collapse runs of blank lines to one, and drop leading blanks. */
      if (out.length > 0) blankRun++;
      continue;
    }
    if (blankRun > 0) {
      out.push({ indent: 0, text: '', assignment: null });
      blankRun = 0;
    }

    const wasInComment = inComment;

    /*
     * A continuation line of a block comment keeps its relative shape;
     * re-indenting the inside of a comment would mangle ASCII art and
     * aligned notes. Its braces are still counted, so that a `{` inside
     * a comment cannot shift the nesting of the code around it.
     */
    if (wasInComment) {
      inComment = scanLine(trimmed, true).inComment;
      out.push({ indent: depth, text: trimmed, assignment: null });
      continue;
    }

    /*
     * Split first, then indent each fragment: the depth bookkeeping is
     * per emitted line, so a line carrying `page { legend = {` has to
     * become two before either can be given a level.
     */
    const fragments = expand ? explodeLine(trimmed, false) : [trimmed];

    for (const fragment of fragments) {
      const scan = scanLine(fragment, inComment);
      inComment = scan.inComment;

      const indent = Math.max(0, depth - scan.leadingClose);
      depth = Math.max(0, depth + scan.delta);

      out.push({
        indent,
        text: fragment,
        assignment: splitAssignment(fragment),
      });
    }
  }

  /*
   * Align `=` within each contiguous run of assignments at the same
   * indent. Runs are broken by a blank line, a block boundary, or any
   * line that is not a plain assignment -- so unrelated groups do not
   * get dragged to a common column by one long key elsewhere.
   */
  /*
   * Rewrite every assignment to `key = value`, and pad the key only
   * when alignment was asked for. Without this the old hand-alignment
   * survived: turning padding off left `t    = 430 ms;` exactly as
   * typed, which is not "unaligned", it is "whatever was there".
   */
  {
    let runStart = 0;
    const flushRun = (end: number): void => {
      const run = out.slice(runStart, end).filter((o) => o.assignment);
      const width = align && run.length > 1
        ? Math.max(...run.map((o) => o.assignment!.key.length))
        : 0;
      for (const o of run) {
        o.text = `${o.assignment!.key.padEnd(width)} = ${o.assignment!.rest}`;
      }
      runStart = end;
    };

    for (let i = 0; i < out.length; i++) {
      const line = out[i];
      const prev = out[runStart];
      const breaksRun =
        !line.assignment ||
        line.text === '' ||
        (prev && prev.assignment && prev.indent !== line.indent);
      if (breaksRun) {
        flushRun(i);
        runStart = i + 1;
      }
    }
    flushRun(out.length);
  }

  const text = out
    .map((o) => (o.text === '' ? '' : INDENT.repeat(o.indent) + o.text))
    /*
     * One space before an opening brace and none inside the padding a
     * hand-aligned file leaves behind: `"3ph clearance"     {` becomes
     * `"3ph clearance" {`. The run of spaces was there to line the
     * braces up, which is the same false economy as aligning `=`.
     */
    .map((line) => line.replace(/[ \t]+\{$/, ' {'))
    /* Trailing whitespace is invisible, survives in the diff, and is
     * one of the things a formatter exists to stop arguing about. */
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

  return `${text}\n`;
}
