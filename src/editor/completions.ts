/**
 * CodeMirror 6 autocomplete source for the .tc language.
 *
 * - At top level (or when the cursor is on an empty line), suggest
 *   the top-level block keywords (meta, system, faults, ...).
 * - Inside an open block, suggest the field keywords that the
 *   language allows inside it. We don't try to be perfect about
 *   nesting -- the parser is the source of truth -- but we do
 *   look at the indentation depth and the most-recently-opened
 *   block keyword to pick a reasonable field set.
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

import {
  KEYWORD_HELP,
  type HelpEntry,
  TOP_BLOCK_KEYWORDS,
  BLOCK_FIELDS,
  CURVE_HELP,
  FIELD_VALUES,
  FIELD_UNITS,
  UNIT_FAMILY,
  BOOLEAN_FIELDS,
} from '../help/help-data.js';
import { allCurveIds } from '../constants/curves.js';
import { constantsFromId } from '../semantics/curves.js';
import { snippetCompletions } from './snippets.js';

/**
 * The keyword that opened the block whose `{` sits at `braceIndex`.
 *
 * Read back to whatever ended the previous statement and take the
 * first word of what is left, so the name between the keyword and the
 * brace is stepped over: `relay R_FDR {` opens a `relay`, and
 * `device "spur_fuse" {` a `device`.
 *
 * An empty string for a brace opened by something that is not a
 * keyword -- a fault entry, a voltage level, any block named by a bare
 * string. The stack still needs the entry so the matching `}` pops the
 * right thing; the name simply is not one we have fields for.
 */
function blockKeywordAt(src: string, braceIndex: number): string {
  let start = braceIndex - 1;
  while (start >= 0 && !'{};\n'.includes(src[start])) start--;

  const head = src.slice(start + 1, braceIndex).trim();
  const first = /^([A-Za-z_][\w]*)/.exec(head);
  return first ? first[1] : '';
}

/**
 * The block the cursor is inside, as a key into `BLOCK_FIELDS`.
 *
 * A brace stack rather than a scan for keywords near a brace. The scan
 * looked back a fixed twelve characters, so whether a block was
 * recognised depended on how long the name in front of its brace
 * happened to be: `element 51 {` was found and `relay R {` was not,
 * and the fields offered inside a relay were the top-level block
 * keywords.
 *
 * The stack also gives nesting for free, which the old code had to
 * special-case by searching for the nearest `stages` or `voltages`.
 */
function detectActiveBlock(src: string, pos: number): string | null {
  const stack: string[] = [];
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === '{') stack.push(blockKeywordAt(src, i));
    else if (src[i] === '}') stack.pop();
  }

  const open = stack.filter(Boolean);
  if (open.length === 0) return null;

  /* `stages { stage { ... } }` and the shorthand both take stage
   * fields; `BLOCK_FIELDS` keys that set as `stage`. */
  const named = open.map((b) => (b === 'stages' ? 'stage' : b));

  /*
   * Most specific first: a sub-block with its own field list is keyed
   * by its path (`system.voltages`), and anything else falls back to
   * the innermost block that has fields at all.
   */
  for (let depth = named.length; depth > 0; depth--) {
    const path = named.slice(named.length - depth).join('.');
    if (path in BLOCK_FIELDS) return path;
  }
  for (let i = named.length - 1; i >= 0; i--) {
    if (named[i] in BLOCK_FIELDS) return named[i];
  }
  return named[named.length - 1] ?? null;
}

/**
 * The panel beside a completion, built as elements.
 *
 * `Completion.info` renders a *string* as text, so markup handed to it
 * arrives on screen as `<b>scenario</b> &middot; <i>top</i><br>...` --
 * the tags read out literally next to the thing they were meant to
 * style. A function returning a node is the form CodeMirror renders,
 * and building the node also means nothing has to be escaped: text
 * assigned to `textContent` cannot be markup.
 */
function helpPanel(label: string, help: HelpEntry): () => Node {
  return () => {
    const dom = document.createElement('div');
    dom.className = 'tc-help-info';

    const head = dom.appendChild(document.createElement('div'));
    head.className = 'cm-help-line';
    const name = head.appendChild(document.createElement('b'));
    name.textContent = label;
    const scope = head.appendChild(document.createElement('span'));
    scope.className = 'cm-help-scope';
    scope.textContent = ` · ${help.scope}`;

    const summary = dom.appendChild(document.createElement('div'));
    summary.className = 'cm-help-summary';
    summary.textContent = help.summary;

    if (help.example) {
      const example = dom.appendChild(document.createElement('pre'));
      example.className = 'cm-help-example';
      example.textContent = help.example;
    }
    return dom;
  };
}

function makeCompletion(label: string, detailKind?: string): Completion {
  const help = KEYWORD_HELP[label];
  return {
    label,
    type: 'keyword',
    detail: help?.summary ?? detailKind ?? 'tc-curves',
    info: help ? helpPanel(label, help) : undefined,
    boost: help?.scope === 'top' ? 5 : 1,
  };
}

/**
 * Curve identifiers from the constants table, offered at a
 * `curve = ...` position. Typing `iec.` narrows to that namespace,
 * which is the behaviour the spec's Phase 5 acceptance calls for.
 */
function curveCompletions(): Completion[] {
  return allCurveIds().map((id) => {
    const constants = constantsFromId(id);
    return {
      label: id,
      type: 'enum',
      detail: constants?.name ?? 'curve',
      info: CURVE_HELP[id],
      boost: id.startsWith('iec.') || id.startsWith('ansi.') ? 3 : 0,
    };
  }).concat({
    label: 'definite',
    type: 'enum',
    detail: 'Definite time: t = t_delay above pickup',
    info: CURVE_HELP.definite,
    boost: 2,
  });
}

/**
 * `relay:element` references and device ids declared in the source,
 * offered wherever a curve reference is expected. Scraped from the
 * text rather than the AST so completion still works while the file
 * is mid-edit and does not parse.
 */
function refCompletions(src: string): Completion[] {
  const out: Completion[] = [];

  const relayRe = /\brelay\s+([A-Za-z_]\w*)\s*\{/g;
  for (let m = relayRe.exec(src); m; m = relayRe.exec(src)) {
    const relayId = m[1];
    /* Elements belonging to this relay: scan to its closing brace. */
    let depth = 0;
    let i = src.indexOf('{', m.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start, i);
    const elementRe = /\belement\s+([A-Za-z0-9_]+)\s*\{/g;
    for (let e = elementRe.exec(body); e; e = elementRe.exec(body)) {
      out.push({
        label: `${relayId}:${e[1]}`,
        type: 'variable',
        detail: `element ${e[1]} on ${relayId}`,
        boost: 4,
      });
    }
  }

  const deviceRe = /\bdevice\s+"([^"]+)"\s*\{/g;
  for (let m = deviceRe.exec(src); m; m = deviceRe.exec(src)) {
    out.push({ label: m[1], type: 'variable', detail: 'device', boost: 3 });
  }

  return out;
}

/** Named faults declared in the source, offered at `fault = "..."`. */
/**
 * Named conditions declared in the document: faults and scenarios.
 *
 * Both, because everything that references a condition -- `grade`,
 * `annotate`, `point`, `view { condition }` -- accepts either, so
 * offering only the faults hides half the answer.
 */
function faultCompletions(src: string): Completion[] {
  const out: Completion[] = [];

  const faultsBlock = src.match(/\bfaults\s*\{([\s\S]*?)\n\}/);
  if (faultsBlock) {
    const nameRe = /"([^"]+)"\s*\{/g;
    for (let m = nameRe.exec(faultsBlock[1]); m; m = nameRe.exec(faultsBlock[1])) {
      out.push({ label: m[1], type: 'variable', detail: 'fault', boost: 4 });
    }
  }

  /* `scenario "name" {` is a top-level block, so it is matched
   * directly rather than inside an enclosing one. */
  const scenarioRe = /\bscenario\s+"([^"]+)"\s*\{/g;
  for (let m = scenarioRe.exec(src); m; m = scenarioRe.exec(src)) {
    out.push({ label: m[1], type: 'variable', detail: 'scenario', boost: 4 });
  }

  return out;
}

/** Voltage level names declared in `system { voltages { ... } }`. */
function voltageCompletions(src: string): Completion[] {
  const out: Completion[] = [];
  const block = src.match(/\bvoltages\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return out;
  const nameRe = /"([^"]+)"\s*\{/g;
  for (let m = nameRe.exec(block[1]); m; m = nameRe.exec(block[1])) {
    out.push({ label: m[1], type: 'variable', detail: 'voltage level', boost: 4 });
  }
  return out;
}

/**
 * The field being assigned at the cursor, if the cursor sits on the
 * right-hand side of an `=`. Drives value-aware completion.
 */
function assignmentTarget(src: string, pos: number): string | null {
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
  const line = src.slice(lineStart, pos);
  const m = line.match(/([A-Za-z_]\w*)\s*=\s*"?[\w.]*$/);
  return m ? m[1] : null;
}

/**
 * A number immediately before the cursor, with any partial unit.
 *
 * Units are required wherever they are not the field's default, and
 * an engineer mid-line should not have to go and look the suffix up.
 * Matched off the raw line rather than the token stream so it still
 * works while the document does not parse.
 */
function unitContext(
  src: string,
  pos: number,
): { field: string; from: number } | null {
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
  const line = src.slice(lineStart, pos);

  /* `<field> = ... <number><space?><partial unit>` at the end of the line. */
  const m = line.match(/([A-Za-z_]\w*)\s*=[^=;]*?\d[\d_]*(?:\.\d+)?\s*([A-Za-z_]*)$/);
  if (!m) return null;

  const field = m[1];
  if (!UNIT_FAMILY[field]) return null;
  return { field, from: lineStart + line.length - m[2].length };
}

/** Unit suffixes for a field, as completions. */
function unitCompletions(field: string): Completion[] {
  const units = FIELD_UNITS[UNIT_FAMILY[field]] ?? [];
  return units.map((u, i) => ({
    label: u.value,
    type: 'unit',
    detail: u.detail,
    boost: units.length - i,
  }));
}

/** Enumerated values a field accepts, as completions. */
function valueCompletions(field: string): Completion[] {
  const choices = FIELD_VALUES[field];
  if (choices) {
    return choices.map((c, i) => ({
      label: c.value,
      type: 'enum',
      detail: c.detail,
      boost: choices.length - i,
    }));
  }
  if (BOOLEAN_FIELDS.has(field)) {
    return [
      { label: 'true', type: 'enum', detail: 'on', boost: 2 },
      { label: 'false', type: 'enum', detail: 'off', boost: 1 },
    ];
  }
  return [];
}

export function tcCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[A-Za-z_][\w.:]*/);
  const src = ctx.state.doc.toString();
  const pos = ctx.pos;

  /*
   * Unit position first: `I_pickup = 5.0 ` wants amperes, not field names.
   * Checked before the assignment target because the number in
   * between defeats that pattern anyway.
   */
  const unit = unitContext(src, pos);
  if (unit) {
    const options = unitCompletions(unit.field);
    if (options.length > 0) {
      return { from: unit.from, options, validFor: /[A-Za-z_]*/ };
    }
  }

  /* Value position: what is being assigned decides the candidates. */
  const target = assignmentTarget(src, pos);
  if (target) {
    /*
     * An opening quote the user has already typed is swallowed into
     * the replaced range: several of these values are quoted strings,
     * and inserting one after a bare `"` would otherwise double it.
     */
    let from = word ? word.from : pos;
    if (src[from - 1] === '"') from -= 1;

    let options: Completion[] | null = null;
    if (target === 'curve') options = curveCompletions();
    else if (target === 'primary' || target === 'backup' || target === 'on_curve' ||
             target === 'reference_ct' || target === 'sources') options = refCompletions(src);
    /* Every spelling of a condition reference offers the same names. */
    else if (target === 'fault' || target === 'faults' || target === 'scenario'
             || target === 'scenarios' || target === 'condition') {
      options = faultCompletions(src);
    }
    else if (target === 'voltage') {
      /* `voltage` names a level everywhere except inside a fault or a
       * device rating, so offer the declared levels first and fall
       * back to the enumeration if none are declared yet. */
      const levels = voltageCompletions(src);
      options = levels.length > 0 ? levels : valueCompletions(target);
    } else {
      const values = valueCompletions(target);
      if (values.length > 0) options = values;
    }

    if (options && options.length > 0) {
      return { from, options, validFor: /[\w.:]*/ };
    }
  }

  /*
   * Asking outright is always answered.
   *
   * `matchBefore` finds nothing on an empty line, which used to end the
   * whole function -- so pressing `?` on the blank line inside a fresh
   * `view { }` offered nothing at all, and the only way to see a
   * block's fields was to guess a first letter and ask again. Typing
   * ahead still needs a word to filter on; an explicit request does
   * not, and lists everything the block accepts.
   */
  if (!word && !ctx.explicit) return null;
  if (word && word.from === word.to && !ctx.explicit) return null;

  const block = detectActiveBlock(src, pos);

  const from = word ? word.from : pos;
  let options: Completion[];
  if (block == null) {
    /* Top level: block keywords, plus the snippet skeletons. */
    options = [
      ...TOP_BLOCK_KEYWORDS.map((k) => makeCompletion(k)),
      ...snippetCompletions,
    ];
  } else {
    const fields = BLOCK_FIELDS[block] ?? [];
    options = fields.map((f) => makeCompletion(f));
    // a couple of cross-cutting favourites the user might still want
    if (block !== 'system.voltages') {
      options.push(makeCompletion('comment'));
    }
    /* `element` / `stages` skeletons are useful inside a relay too. */
    if (block === 'relay') {
      options.push(...snippetCompletions.filter((s) =>
        typeof s.label === 'string' && s.label.startsWith('element')));
    }
  }

  return {
    from,
    options,
    validFor: /[\w.]*/,
  };
}
