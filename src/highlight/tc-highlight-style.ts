/**
 * Editor colour scheme for `.ptc`.
 *
 * Every colour is a `var(--tc-syn-*)` reference rather than a literal,
 * so the same highlight style serves both themes: flipping
 * `data-theme` on the root element re-colours the editor through the
 * cascade, with no extension reconfiguration and no editor rebuild.
 *
 * The token vocabulary matches what `tc-language.ts` emits.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export const tcHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: 'var(--tc-syn-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--tc-syn-keyword)', fontWeight: '600' },
  { tag: t.propertyName, color: 'var(--tc-syn-property)' },
  { tag: t.string, color: 'var(--tc-syn-string)' },
  { tag: t.number, color: 'var(--tc-syn-number)' },
  { tag: t.unit, color: 'var(--tc-syn-unit)' },
  { tag: t.atom, color: 'var(--tc-syn-atom)' },
  { tag: t.variableName, color: 'var(--tc-syn-variable)' },
  { tag: t.operator, color: 'var(--tc-syn-operator)' },
  { tag: t.punctuation, color: 'var(--tc-syn-operator)' },
  { tag: t.invalid, color: 'var(--tc-error)' },
]);

/**
 * Chrome around the text -- gutters, cursor, selection, active line.
 * CodeMirror's own base theme hard-codes light-mode colours for these,
 * so they have to be restated in tokens or the editor looks broken on
 * a dark background.
 */
export const tcEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--tc-fg)',
    backgroundColor: 'var(--tc-bg-sunken)',
  },
  '.cm-content': {
    caretColor: 'var(--tc-accent)',
    fontFamily: 'var(--tc-font)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--tc-accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--tc-bg-elevated)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--tc-accent) 8%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--tc-bg-sunken)',
    color: 'var(--tc-fg-muted)',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--tc-accent) 8%, transparent)',
    color: 'var(--tc-fg)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--tc-accent) 25%, transparent)',
    color: 'inherit',
  },
  '.cm-nonmatchingBracket': {
    color: 'var(--tc-error)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--tc-bg-elevated)',
    color: 'var(--tc-fg)',
    border: '1px solid var(--tc-border)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--tc-accent)',
    color: 'var(--tc-accent-fg)',
  },
}, { dark: false });

/** The complete visual package for the editor. */
export const tcEditorAppearance = [
  tcEditorTheme,
  syntaxHighlighting(tcHighlightStyle, { fallback: true }),
];
