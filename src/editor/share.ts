/**
 * Draft persistence and shareable links.
 *
 * Two jobs that share one encoding:
 *
 *   - the working draft is written to `localStorage` as it is typed,
 *     so closing the tab does not lose it;
 *   - a link carries the whole study in its fragment, so a study can
 *     be sent to someone without a server or a file.
 *
 * The source goes in the URL *fragment*, never the query string: a
 * fragment is not sent to the server, so a study pasted into a link
 * stays between the people holding it.
 */

/** Key holding the working draft. */
const DRAFT_KEY = 'tc.draft';
/** Key holding the example the draft was started from, if any. */
const DRAFT_ORIGIN_KEY = 'tc.draft.origin';

export interface Draft {
  source: string;
  /** Example id the draft began as, for the picker. */
  exampleId: string | null;
  /** When it was last written, epoch milliseconds. */
  savedAt: number;
}

/**
 * Base64 for arbitrary text.
 *
 * `btoa` handles bytes, not characters, so a study containing an em
 * dash or a Greek letter -- both of which the language allows -- would
 * throw. The text is encoded to UTF-8 first, and the result is made
 * URL-safe so it survives being pasted into a chat client or a ticket.
 */
export function encodeSource(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of {@link encodeSource}; null when the text is not valid. */
export function decodeSource(encoded: string): string | null {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A link to this study.
 *
 * Built from the current location so it works wherever the playground
 * is served -- a local dev server, a Pages deployment, a file path.
 */
export function shareLink(source: string, base: string = window.location.href): string {
  const url = new URL(base);
  url.hash = `s=${encodeSource(source)}`;
  return url.toString();
}

/** The study carried by a link, if it carries one. */
export function sourceFromLink(hash: string = window.location.hash): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const encoded = params.get('s');
  return encoded ? decodeSource(encoded) : null;
}

/**
 * Write the working draft.
 *
 * Failures are swallowed: a full or disabled store is a reason to
 * lose the convenience, not to interrupt the work.
 */
export function saveDraft(source: string, exampleId: string | null): void {
  try {
    localStorage.setItem(DRAFT_KEY, source);
    if (exampleId) localStorage.setItem(DRAFT_ORIGIN_KEY, exampleId);
    else localStorage.removeItem(DRAFT_ORIGIN_KEY);
  } catch { /* storage unavailable; the draft is simply not kept */ }
}

/** Read the working draft, if one was kept. */
export function loadDraft(): Draft | null {
  try {
    const source = localStorage.getItem(DRAFT_KEY);
    if (source == null || source.trim() === '') return null;
    return {
      source,
      exampleId: localStorage.getItem(DRAFT_ORIGIN_KEY),
      savedAt: 0,
    };
  } catch {
    return null;
  }
}

/** Forget the working draft, so the next load starts from an example. */
export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(DRAFT_ORIGIN_KEY);
  } catch { /* nothing to do */ }
}

/* ------------------------------------------------------------------ */
/* Saved studies                                                       */
/* ------------------------------------------------------------------ */

/** Key holding the map of named studies kept in the browser. */
const STUDIES_KEY = 'tc.studies';

/** Prefix marking a picker value as a saved study rather than an example. */
export const SAVED_PREFIX = 'saved:';

export interface SavedStudy {
  name: string;
  source: string;
  /** Epoch milliseconds, so the list can be shown newest first. */
  savedAt: number;
}

function readStudies(): Record<string, SavedStudy> {
  try {
    const raw = localStorage.getItem(STUDIES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, SavedStudy> : {};
  } catch {
    return {};
  }
}

function writeStudies(studies: Record<string, SavedStudy>): void {
  try {
    localStorage.setItem(STUDIES_KEY, JSON.stringify(studies));
  } catch { /* storage full or disabled; the study stays in the buffer */ }
}

/** Saved studies, most recently saved first. */
export function listStudies(): SavedStudy[] {
  return Object.values(readStudies()).sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Save a study under a name, replacing any study of that name.
 *
 * The name is also the picker entry, so it is trimmed but otherwise
 * taken as given -- an engineer's own filing is not ours to correct.
 */
export function saveStudy(name: string, source: string): SavedStudy | null {
  const key = name.trim();
  if (!key) return null;

  const studies = readStudies();
  const entry: SavedStudy = { name: key, source, savedAt: Date.now() };
  studies[key] = entry;
  writeStudies(studies);
  return entry;
}

/** The source of a saved study, or null if it is not there. */
export function studySource(name: string): string | null {
  return readStudies()[name]?.source ?? null;
}

/** Remove a saved study. */
export function deleteStudy(name: string): void {
  const studies = readStudies();
  delete studies[name];
  writeStudies(studies);
}
