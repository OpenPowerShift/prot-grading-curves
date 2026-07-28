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
}
