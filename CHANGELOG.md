# Changelog

All notable changes to this project are documented here. The format follows
[Conventional Commits](https://www.conventionalcommits.org/) and releases are
cut by [release-please](https://github.com/googleapis/release-please); entries
below this line are generated from commit messages.

## 0.1.0 (unreleased)

Initial release of the `tc-curves` language, library, CLI, and playground.

### Features

* `.tc` language per `spec/spec.adoc` v0.1.0 — `meta`, `system`, `faults`,
  `relay`/`element`/`stages`, `device`, `grade`/`solve`, `combine`, `annotate`,
  `view`, `page`, `notes`.
* Curve constants for IEC 60255-151 Annex A (curves A–F), the withdrawn
  IEC 60255-3 LTI/STI pair, IEEE C37.112, and vendor families from SEL,
  Siemens, GE, ABB, and Schneider.
* Operate-time evaluation for IDMT, definite-time, user `formula`, piecewise
  FlexCurve tables, and the non-IDMT ABB RI/RD forms.
* Multi-stage elements resolved to a pointwise-minimum composite, and
  synthetic `combine` curves (`envelope_min`/`envelope_max`/`sum`/
  `select_first`).
* Grading margin reports with `CTI_min_s` constraint sweeps and `margin_s`
  targets, plus a closed-form `tms` solver with `tight`/`loose` snapping and
  unsatisfiable-target reporting.
* Cross-voltage studies via named `system.voltages` levels — turns ratios are
  derived, not declared.
* Hand-rolled log-log SVG renderer, with PNG (`@resvg/resvg-js` under Node, a
  canvas fallback in-browser) and PDF (`jspdf` + `svg2pdf.js`) export.
* `tc-curves` CLI: `render` (`--svg`/`--png`/`--pdf`), `report`, and `check`
  with CI-usable exit codes.
* Browser playground with a CodeMirror editor (syntax highlighting,
  autocompletion, hover help, snippets), an interactive plot, a grading report
  panel, and a light/dark theme.
