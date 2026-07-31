/**
 * The language specification, converted to HTML at build time by
 * `scripts/guide-plugin.js`. See that file for why the conversion does
 * not happen in the browser.
 */
declare module 'virtual:tc-guide' {
  export interface GuideHeading {
    /** 2 for a chapter, 3 or 4 for a section beneath it. */
    level: number;
    /** Anchor id, matching the `id` on the rendered heading. */
    id: string;
    text: string;
  }

  export interface Guide {
    title: string;
    /** Spec version attribute, e.g. `0.1.0-draft`. */
    revision: string;
    revdate: string;
    html: string;
    toc: GuideHeading[];
  }

  const guide: Guide;
  export default guide;

  /**
   * The tutorial -- `docs/tutorial.adoc`, converted the same way.
   *
   * A walkthrough that builds one study up step by step, where the
   * guide is a reference organised by block. Both are shipped so a
   * reader can start with whichever suits them.
   */
  export const tutorial: Guide;
}
