import { unlinkSync, renameSync } from "node:fs";

// Undo prepublish: remove the generated README.md and restore README.adoc.
unlinkSync("README.md");
renameSync(".README.adoc", "README.adoc");
