/**
 * DOM geometry jsdom does not implement, supplied for the suite.
 *
 * jsdom has no layout engine, so everything measures zero and several
 * measurement APIs are simply absent. That is fine for most of this
 * suite -- the logic under test is arithmetic the renderer does, not
 * the browser's -- but CodeMirror *measures on every dispatch that
 * asks to scroll*, and calls `Range.getClientRects`, which jsdom does
 * not define at all.
 *
 * The result was eight unhandled `TypeError`s inside
 * `requestAnimationFrame` callbacks: every assertion still passed, and
 * `vitest` still exited non-zero, which is exactly the failure mode
 * where a green-looking run is not a green run.
 *
 * Stubbing the two missing methods is the honest fix. The alternative
 * -- dropping `scrollIntoView` so the editor never measures -- would
 * remove a real behaviour to satisfy a test environment, and the
 * behaviour is the point: after a reflow the caret's line may have
 * moved a long way down the document.
 *
 * The values are deliberately zero. Nothing here asserts on layout;
 * these exist so the measure cycle completes rather than throws.
 */

const ZERO_RECT: DOMRect = {
  x: 0, y: 0, width: 0, height: 0,
  top: 0, right: 0, bottom: 0, left: 0,
  toJSON: () => ({}),
} as DOMRect;

if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = function getClientRects(): DOMRectList {
      const list = [] as unknown as DOMRectList;
      (list as unknown as { item(i: number): DOMRect | null }).item = () => null;
      return list;
    };
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = (): DOMRect => ZERO_RECT;
  }
}
