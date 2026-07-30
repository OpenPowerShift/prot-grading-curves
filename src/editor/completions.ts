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

/** Decide the most likely enclosing block based on the source text
 *  up to the cursor. We walk backwards looking for the most
 *  unmatched `meta`, `system`, etc. block.  Anything inside the
 *  `{}` of that block is the "active" scope. */
function detectActiveBlock(src: string, pos: number): string | null {
  let depth = 0;
  const blocks: string[] = [];
  for (let i = 0; i < pos && i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    // Try matching a block keyword right after whitespace/newline
    // at this position; the keyword block-start detection is rough
    // but it covers 95% of the cases.
    const tail = src.slice(Math.max(0, i - 12), i).trim();
    for (const kw of TOP_BLOCK_KEYWORDS) {
      if (tail === kw || tail.endsWith(kw)) {
        if (depth > 0) blocks.push(kw);
        break;
      }
    }
  }
  if (blocks.length === 0) return null;
  // Return the deepest block we're currently inside (last pushed).
  // `element` vs `stage` need disambiguation -- if any `stages {...}`
  // is open and we're inside it, we are inside `stages`.
  const last = blocks[blocks.length - 1];
  if (last === 'element') {
    // Check if a `stages { ... }` sub-block is currently open.
    const text = src.slice(0, pos);
    const lastStages = text.lastIndexOf('stages');
    const lastRbraceAfterStages = text.indexOf('}', lastStages);
    const lastLbraceAfterStages = text.indexOf('{', lastStages);
    if (lastStages >= 0 && (lastLbraceAfterStages === -1 || lastLbraceAfterStages < lastRbraceAfterStages)) {
      return 'stage';
    }
  }
  if (last === 'system') {
    // Are we inside `voltages { ... }`?
    const text = src.slice(0, pos);
    const lastVoltages = text.lastIndexOf('voltages');
    if (lastVoltages >= 0) {
      const after = text.slice(lastVoltages);
      const opens = (after.match(/\{/g) ?? []).length;
      const closes = (after.match(/\}/g) ?? []).length;
      if (opens > closes) return 'system.voltages';
    }
  }
  return last;
}

function makeCompletion(label: string, detailKind?: string): Completion {
  const help = KEYWORD_HELP[label];
  const infoText = help
    ? `<b>${label}</b> · <i>${escapeHtml(help.scope)}</i><br>${escapeHtml(help.summary)}<br><pre>${escapeHtml(help.example)}</pre>`
    : undefined;
  return {
    label,
    type: 'keyword',
    detail: help?.summary ?? detailKind ?? 'tc-curves',
    info: infoText,
    boost: help?.scope === 'top' ? 5 : 1,
  };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c] as string));
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
function faultCompletions(src: string): Completion[] {
  const out: Completion[] = [];
  const faultsBlock = src.match(/\bfaults\s*\{([\s\S]*?)\n\}/);
  if (!faultsBlock) return out;
  const nameRe = /"([^"]+)"\s*\{/g;
  for (let m = nameRe.exec(faultsBlock[1]); m; m = nameRe.exec(faultsBlock[1])) {
    out.push({ label: m[1], type: 'variable', detail: 'fault', boost: 4 });
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
   * Unit position first: `I_pu = 5.0 ` wants amperes, not field names.
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
    else if (target === 'fault') options = faultCompletions(src);
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

  if (!word) return null;
  if (word.from === word.to && !ctx.explicit) return null;

  const block = detectActiveBlock(src, pos);

  const from = word.from;
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
