/**
 * Draft persistence and shareable links.
 *
 * The encoding has to survive two hostile round trips: text that is
 * not ASCII (the language allows em dashes and Greek letters in
 * strings and comments), and a URL that gets pasted through a chat
 * client. Both are pinned here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDraft,
  decodeSource,
  encodeSource,
  loadDraft,
  saveDraft,
  shareLink,
  sourceFromLink,
} from '@tc/editor/share';

const STUDY = `
meta { project = "Northgate — 11 kV"; }
system { voltages { "MV" { kV = 11.0; } } }
relay R { voltage = "MV"; element 51 { curve = iec.si; I_pu = 5 A_sec; tms = 0.2; } }
`;

describe('encoding', () => {
  it('round-trips a study unchanged', () => {
    expect(decodeSource(encodeSource(STUDY))).toBe(STUDY);
  });

  it('survives non-ASCII, which btoa alone cannot carry', () => {
    const text = 'meta { project = "Ω — 33 kV · naïve"; } # ✓';
    expect(decodeSource(encodeSource(text))).toBe(text);
  });

  it('emits only URL-safe characters', () => {
    /* A long study is likely to produce + and / under plain base64. */
    const encoded = encodeSource(STUDY.repeat(20));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(decodeSource('!!!not base64!!!')).toBeNull();
  });
});

describe('links', () => {
  it('puts the study in the fragment, never the query string', () => {
    const link = shareLink(STUDY, 'https://example.test/tcc/');
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#s=')).toBe(true);
  });

  it('reads a study back out of its own link', () => {
    const link = shareLink(STUDY, 'https://example.test/tcc/');
    expect(sourceFromLink(new URL(link).hash)).toBe(STUDY);
  });

  it('ignores a fragment that carries something else', () => {
    expect(sourceFromLink('#section-2')).toBeNull();
    expect(sourceFromLink('')).toBeNull();
  });

  it('keeps the path it was given, so it works wherever it is served', () => {
    const link = shareLink('x', 'https://example.test/deep/path/index.html');
    expect(link.startsWith('https://example.test/deep/path/index.html#s=')).toBe(true);
  });
});

describe('drafts', () => {
  beforeEach(() => clearDraft());

  it('keeps what was typed', () => {
    saveDraft(STUDY, 'riverside');
    expect(loadDraft()).toEqual({ source: STUDY, exampleId: 'riverside', savedAt: 0 });
  });

  it('records that a draft came from no example', () => {
    saveDraft(STUDY, 'riverside');
    saveDraft(STUDY, null);
    expect(loadDraft()?.exampleId).toBeNull();
  });

  it('reports nothing when there is nothing, or only blank text', () => {
    expect(loadDraft()).toBeNull();
    saveDraft('   \n  ', null);
    expect(loadDraft()).toBeNull();
  });

  it('forgets on request', () => {
    saveDraft(STUDY, null);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});
