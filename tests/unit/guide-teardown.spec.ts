/**
 * The guide, after the page has gone.
 *
 * `ensureLoaded` is asynchronous, so an update can land after the
 * element has been removed -- or, in a test, after the DOM itself has
 * been torn down. The copy-button pass reached for the *global*
 * `document` and threw `document is not defined` from a promise nobody
 * was awaiting, which vitest reports as an unhandled rejection and
 * exits 1 on even though every test passed.
 *
 * It ran green locally and failed in CI four times: the race resolves
 * differently under a different Node, which is the character of the
 * bug and the reason it wants a test rather than a fix alone.
 */

import { describe, expect, it } from 'vitest';
import '@tc/components/tc-guide.js';

type Guide = HTMLElement & { updateComplete: Promise<unknown>; open: boolean };

const call = (el: Guide, method: string): unknown =>
  (el as unknown as Record<string, () => unknown>)[method]();

describe('a guide detached mid-load', () => {
  it('does not decorate a document it no longer belongs to', async () => {
    const el = document.createElement('tc-guide') as Guide;
    document.body.append(el);
    await el.updateComplete;
    el.remove();

    /* `ownerDocument` survives removal, so the guard that matters is
     * `isConnected` -- this is the exact call the late update makes. */
    expect(() => call(el, 'addCopyButtons')).not.toThrow();
  });

  it('does not throw when it has no document at all', async () => {
    /*
     * The CI failure verbatim: the environment is gone, the global
     * `document` is undefined, and a queued update runs anyway.
     */
    const el = document.createElement('tc-guide') as Guide;
    document.body.append(el);
    await el.updateComplete;

    const owner = Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument');
    Object.defineProperty(el, 'ownerDocument', { value: null, configurable: true });
    try {
      expect(() => call(el, 'addCopyButtons')).not.toThrow();
    } finally {
      if (owner) Object.defineProperty(el, 'ownerDocument', owner);
      el.remove();
    }
  });
});
