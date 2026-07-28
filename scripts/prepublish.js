import { readFileSync, writeFileSync, renameSync } from "node:fs";

// npm renders Markdown, not AsciiDoc. For the published package we generate a
// README.md from README.adoc and hide README.adoc; postpublish restores the repo.
const asciidoc = readFileSync("README.adoc", "utf8");

const markdown = asciidoc
  .replace(/^=+(?= \w)/gm, (m) => "#".repeat(m.length))
  .replace(/(https?:[^[]+)\[(|.*?[^\\])\]/g, "[$2]($1)");

writeFileSync("README.md", markdown);
renameSync("README.adoc", ".README.adoc");
