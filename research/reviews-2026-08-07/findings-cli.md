# tc-curves CLI / output-format findings

Run as `npx tsx src/cli.ts <args>` from repo root. Node v22.16.0, tsx 4.23.9.
Exit codes captured explicitly.

## 1. Exit codes - reachable and correct (CLEAN)
0: check examples/00-minimal.ptc -> 0
1: check t/err-ref.ptc (grade primary -> non-existent relay) -> 1
2: check /nope/nothere.ptc -> 2 ; chmod 000 file -> 2 EACCES ; directory -> 2 EISDIR ;
   --bogus -> 2 ; unknown command frobnicate -> 2
3: check examples/07-upstream-miscoordination.ptc -> 3
Of 19 examples only 07 exits 3.

## FINDING A - extra positionals silently discarded (CI gate defeat). HIGH. VERIFIED.
$ npx tsx src/cli.ts check examples/00-minimal.ptc examples/07-upstream-miscoordination.ptc
  -> "examples/00-minimal.ptc: no errors", rc=0
$ npx tsx src/cli.ts check examples/00-minimal.ptc wibble wobble -> rc=0
parseArgs src/cli.ts:120 `const [command, input] = rest;` drops the rest silently.
07 alone exits 3. So `tc-curves check *.ptc` in CI checks only the first file and
exits 0. README.adoc:105-113 sells check as "a CI gate on coordination"; src/cli.ts:246-252
says collapsing was deliberately fixed. Reintroduced via argv. No warning on stdout/stderr.

## 2. --view: CLEAN
Bad name -> rc=2 with the list: `tc-curves: no view named "NoSuchSheet"; this study
declares "Phase", "NEGATIVE_SEQUENCE", "THREE_TIMES_I2", "Residual"`. Matches
docs/guide.adoc:1455 promise. Study with no views -> "this study declares none", rc=2.

## FINDING B - bogus --size silently becomes A4. MEDIUM-HIGH. VERIFIED.
$ npx tsx src/cli.ts render examples/00-minimal.ptc --pdf --size ZZ9 -o t/bad.pdf  -> rc=0
$ ... --size A9  -> rc=0 ;  ... --size ""  -> rc=0
MediaBox of ZZ9 / A9 / "" / A4 all identical: [0 0 841.89 595.28] (A4 landscape).
A3 correctly gives [0 0 1190.55 841.89].
Cause: src/export/export-pdf.ts resolvePageMm -> `portrait = PAPER_MM[match ?? 'A4'];`
USAGE src/cli.ts:80 promises "PDF paper size: A0-A5, Letter, Legal, Tabloid (default A4)".
`--size A9` is a realistic typo for A4/A3 and produces a plausible wrong-size sheet
that gets printed and filed. No warning on stdout or stderr. (Case-insensitive
matching does work: `--size a3` is fine.)
Note: every PDF render also prints an unexplained jsdom line to stderr:
"Not implemented: HTMLCanvasElement's getContext() method: without installing the canvas npm package"

## 3. PNG dimensions - correct for valid input (CLEAN)
Native SVG is 1200x750 (viewBox="0 0 1200 750") for examples/00-minimal.ptc.
  --png (no opts)      -> 2400x1500   (scale 2 default, as documented)
  --png --width 1600   -> 1600x1000   (aspect preserved)
  --png --scale 1      -> 1200x750
  --png --scale 3      -> 3600x2250
  --png --width 1600 --scale 3 -> 1600x1000  (width wins; USAGE says scale applies
                                              "when --width is absent")
All rc=0. Run from repo root with the native @resvg/resvg-js rasteriser.

## FINDING C - nonsense --width silently downgrades the PNG to 1x. MEDIUM. VERIFIED.
$ npx tsx src/cli.ts render examples/00-minimal.ptc --png --width abc -o t/w-abc.png -q
  rc=0, PNG is 1200x750
$ ... --width -100 -o t/w-neg.png -q
  rc=0, PNG is 1200x750
Expected: rc=2 (usage error), or at minimum the documented default of scale 2
(2400x1500). Cause: src/cli.ts:109 `opts.width = Number(argv[++i])` yields NaN, and
src/export/export-png.ts renderWithResvg tests `options.width != null` - NaN passes -
so fitTo becomes {mode:'width', value: NaN} and resvg falls back to 1:1. A typo in
--width therefore ships a half-resolution image with no error anywhere.
(`--width 0` and `--scale 0` are handled properly: rc=2, "Target size is zero", no
file written.)

## FINDING D - huge --scale aborts the process with an undocumented status. MEDIUM. VERIFIED.
$ npx tsx src/cli.ts render examples/00-minimal.ptc --png --scale 1e9 -o t/sc-big.png -q
  stderr: "note: run with `RUST_BACKTRACE=1` ... fatal runtime error: failed to
           initiate panic, error 5"
  rc=134
The try/catch at src/cli.ts:375 cannot catch a native abort in @resvg/resvg-js.
Header comment src/cli.ts:16 and README.adoc:105 promise "0 clean, 1 ..., 2 usage or
I/O failure, 3 ...". 134 is outside that contract and the message is not prefixed
"tc-curves:". A CI gate keying on the documented set sees an unknown status.

## FINDING E - `-o` swallows the following flag and writes a file named after it. LOW-MEDIUM. VERIFIED.
$ npx tsx src/cli.ts render examples/00-minimal.ptc -o --png -q
  rc=0; wrote a 24632-byte SVG to a file literally named `--png` in the cwd.
src/cli.ts:108 `opts.output = argv[++i]` takes the next token unconditionally.
No error, and --png was consumed so the format silently stayed SVG. (Removed the
stray file; repo left clean.)

## 4. --all-views guard and flag order: CLEAN
--all-views with --svg / --png / default format -> rc=2,
"tc-curves: --all-views needs --pdf; an SVG or PNG is a single image", no file written.
Options before the command work: `--pdf --size A3 render examples/00-minimal.ptc`
-> rc=0, MediaBox [0 0 1190.55 841.89] = A3 landscape.

## 5. --json: valid, complete, and agrees with the human report (LARGELY CLEAN)
`report <f> --json` for all 19 examples: `jq -e .` exits 0 on every one (valid JSON,
round-trips). Carries both diagnostics and grading, as README.adoc:115 promises.
Cross-checked JSON verdicts against the text report:
  07: json worst_margin_s -0.310247 at 12446.66 A; text "worst -0.310 s at 12447 A"; both fail, rc=3. AGREE.
  12: 4 grades, json pass/pass/unevaluated/pass; text PASS/PASS/not evaluated/PASS. AGREE.
  03: json verdict "unevaluated"; text "not evaluated -- no margin could be computed". AGREE.
JSON is also emitted (with the parse error inside it) for a file with a syntax error:
  `check t/garbage.ptc --json` -> rc=1, valid JSON, counts.errors=1. Good.

## FINDING F - one mistake is reported as two errors. MEDIUM-LOW. VERIFIED.
$ npx tsx src/cli.ts check t/err-ref.ptc --json | jq '.counts.errors'  -> 2
The same UNRESOLVED_REFERENCE, identical message, appears twice: once at the real
site (line 45) and once at a meaningless 1:1.
Reproduced with three different bad references (bad primary, bad backup, bad fault) -
always exactly 2. Human `check` prints both lines too. A dashboard or PR annotation
reading `counts.errors` reports "2 errors" for one typo, and annotates line 1 of the
file with an error that is not there.
(By contrast the 4 errors for a bad `curve` are 2 genuine cascading codes x 2 relays,
not duplication.)

## FINDING G - `render --json` silently ignores --json. LOW-MEDIUM. VERIFIED.
$ npx tsx src/cli.ts render examples/00-minimal.ptc --json -o t/j.svg
  rc=0; stdout is the human margin report, not JSON (`jq -e .` rc=5).
src/cli.ts:256 gates the JSON branch on `command === 'check' || 'report'`. USAGE
lists --json in the common Options block with no "check/report only" note (unlike
--all-views, which is explicitly labelled "PDF only" and *does* error out when
misapplied). A pipeline doing `render --json | jq` gets prose and exit 0.

## FINDING H - two different messages for the same diagnostic code. LOW. VERIFIED.
MARGIN_NO_SOLVE on examples/03-mixed-ansi-iec.ptc:
  top-level (src/semantics/validate.ts:1267): "... Add solve { ... } to act on it, or use margin for a constraint"
  per-grade  (src/semantics/grades.ts:1088):  "... Add solve { ... } to have the tool meet it, or use margin for a constraint"
Both land in the same JSON document, under `.diagnostics[]` and `.grades[].diagnostics[]`
respectively. A consumer keyed on message text sees two distinct findings.

## Minor: cosmetic
- The text report prints `t_backup = no-op s` and `achieved margin = no-op s`
  (examples/03). "no-op s" is not a quantity; it reads as a unit-bearing value.
- `grading: "pass"` is emitted when some grades are `unevaluated` (12-sequence-scenario:
  3 pass + 1 unevaluated -> overall "pass", rc=0). Intended per json-report.ts
  overallVerdict comment, but neither `counts` nor the top level surfaces how many
  pairs could not be judged, so a CI gate reading `grading` cannot tell.
- An empty .ptc file: `check t/empty.ptc` -> "no errors", rc=0.
- Bare `npx tsx src/cli.ts` (no args) prints USAGE to stdout and exits 0, not 2.

## 6. SVG: well-formed and standalone (CLEAN)
`render --svg` for 00, 09, 11, 16, 17, 18: all rc=0 and all parse with
xml.dom.minidom (well-formed XML). Output starts
`<?xml version="1.0" encoding="UTF-8" standalone="no"?>` and carries
xmlns + xmlns:xlink + viewBox + width/height, so it opens standalone.

## 7. --force stamping: works in ALL THREE formats (CLEAN)
Without --force a study with errors is refused: rc=1,
"tc-curves: <file> has errors; no sheet written. Fix them, or pass --force to draw
it anyway." and no file is created (verified with ls).
With --force, rc=1 and the sheet is written, stamped:
  SVG: `<g data-layer="invalid">` ... `DRAWN FROM A STUDY WITH 2 ERRORS — NOT VALID`
       on a #c0392b band, 1200x26, at y=0.
  PDF: pdftotext extracts "DRAWN FROM A STUDY WITH 2 ERRORS — NOT VALID".
  PNG: pixel (0,0) of the decoded IDAT is RGBA (192,57,43,255) = #c0392b, the stamp band.
Caveat: the stamp says "2 ERRORS" for the single mistake in t/err-ref.ptc - the
duplicate-diagnostic bug (FINDING F) is printed on the face of the drawing.

## FINDING I - PDF output is not byte-reproducible. LOW-MEDIUM. VERIFIED.
Rendering examples/09-capability-tour.ptc twice:
  SVG md5 e2af7a3d... == e2af7a3d...  IDENTICAL
  PNG md5 8bd5afc4... == 8bd5afc4...  IDENTICAL
  PDF md5 7725366a... != 04c43738...  DIFFER, 64 bytes
The differing bytes are `/CreationDate (D:20260807134304+10'00')` and the random
trailer `/ID [ <379B448C...> <379B448C...> ]` emitted by jsPDF 4.2.1.
src/semantics/json-report.ts's rounding rationale states "A CI artefact that is
diffed has to be stable"; PDF is the one artefact that is not. Content is identical,
so this is a reproducibility/caching problem, not a correctness one.
SVG and PNG determinism is clean.

## 8. PDF --all-views page counts: CORRECT (CLEAN)
  examples/17-sequence-sheets.ptc --pdf --all-views -> rc=0, Pages: 4, A4 landscape
  examples/18-bess-two-chains.ptc --pdf --all-views -> rc=0, Pages: 4, A3 landscape
  examples/00-minimal.ptc (no views)  --pdf --all-views -> rc=0, Pages: 1
  17 and 18 without --all-views       -> Pages: 1
pdftotext confirms the 4 pages of each are distinct sheets, in declaration order
(17: Phase / I2 / 3I2 / Residual; 18: incomer-phase / BESS feeder / incomer / aux feeder).
Paper size comes from the study's `page { size }` (18 declares A3) as documented.
`--portrait` / `--landscape` given together: last one wins (595x841 vs 841x595). Sane.

## 9. [page] / [of] macros: CORRECT (CLEAN)
Copied examples/17 with `footer { right = "SHEET [page] OF [of]" }`:
  --pdf --all-views -> pages read "SHEET 1 OF 4", "SHEET 2 OF 4", "SHEET 3 OF 4", "SHEET 4 OF 4"
  --pdf (single sheet) -> "SHEET ? OF ?", Pages: 1
  --svg -> "SHEET ? OF ?"
Exactly what src/cli.ts:350-352 and the comment in examples/17-sequence-sheets.ptc:327-331
promise ("resolve to '?' until the study is exported to PDF, where the exporter counts
the views").

## 10. CLI vs library consistency: CLEAN
Drove `process()` from src/index.ts directly and diffed its diagnostic list against
`check` stderr for examples/03, 07, 12 and t/err-ref.ptc: byte-identical sets every time
(3, 2, 0 and 3 diagnostics). The CLI calls the shared function; there is no second
code path to drift.
Root cause of FINDING F located here: src/index.ts:66-73 concatenates
`validate(study, document)` with the error-severity diagnostics of every grade report,
re-anchored to line 1 col 1. Codes emitted by both validate() and reportGrades()
(UNRESOLVED_REFERENCE) therefore appear twice.

## FINDING J - `render` exits 0 on a study whose grading fails. HIGH. VERIFIED.
$ npx tsx src/cli.ts render examples/07-upstream-miscoordination.ptc --svg -o t/r07.svg -q  -> rc=0
$ ... --png  -> rc=0
$ ... --pdf  -> rc=0
$ npx tsx src/cli.ts check  examples/07-upstream-miscoordination.ptc  -> rc=3
$ npx tsx src/cli.ts report examples/07-upstream-miscoordination.ptc  -> rc=3
src/cli.ts:385 is `return hasErrors ? 1 : 0;` - the render path never returns the
status 3 that src/cli.ts:254 computed. USAGE src/cli.ts:89 and README.adoc:105 state
the exit contract for the whole tool, not per-command: "0 clean, 1 validation errors,
2 usage or I/O failure, 3 valid study, grading fails."
This is the same class of defect the file's own comment (src/cli.ts:246-252) says was
fixed for `check`: a pipeline that renders the issue sheet and gates on the render's
status is gating on syntax while believing it gates on coordination - and here it
also ships a drawn, un-stamped sheet of a study that does not coordinate.

## FINDING K - `--quiet` does the opposite of what it documents. MEDIUM. VERIFIED.
USAGE src/cli.ts:85: "-q, --quiet   Suppress the margin report on stdout".
$ npx tsx src/cli.ts report examples/00-minimal.ptc -q
  -> rc=0, prints the full 7-line margin report anyway. src/cli.ts:271 calls
     formatGradeReports unconditionally; `report` ignores --quiet entirely.
$ npx tsx src/cli.ts check examples/03-mixed-ansi-iec.ptc -q
  -> rc=0, ZERO output. Without -q the same command prints 2 infos and a
     MARGIN_NO_SOLVE *warning* on stderr plus "no errors" on stdout.
     src/cli.ts:239 makes -q suppress every non-error diagnostic - stderr content the
     doc never mentions - while `check` has no margin report to suppress in the first
     place.
Net: -q silences the diagnostics it should keep and keeps the report it should silence.

## Minor
- `--all-views` together with `--view <name>`: --view is silently ignored (still
  4 pages). An unknown --view name is still rejected rc=2 even though it will not be
  used. src/cli.ts:344 computes `chosen` and then discards it when wantsEverySheet.
- `check --json` writes JSON to stdout AND the same diagnostics as text to stderr;
  `-q --json` suppresses the stderr copy but keeps the full JSON (counts.warnings=1).

## 11. --view selection: CLEAN
examples/17-sequence-sheets.ptc, checking the rendered sheet title each time:
  --view Phase                -> "Phase sheet"      (also the no---view default; default=true honoured)
  --view NEGATIVE_SEQUENCE    -> "I2 sheet"
  --view "Negative sequence"  -> "I2 sheet"   (byte-identical md5 to the id form)
  --view THREE_TIMES_I2       -> "3I2 sheet"
  --view Residual             -> "Residual sheet"
Matching by id and by display name both work, as docs/guide.adoc:1461-1466 describes.

## 12. Theme handling: CLEAN
Study with `page { theme = dark; }`:
  SVG paper fill #1a1a19; PNG pixel (0,0) = (26,26,25) - dark honoured.
  PDF rasterised with mutool: centre pixel (242,242,238) - light.
Exactly what src/cli.ts:299-303 states ("A PDF is printed and filed, so it is always
rendered light ... SVG and PNG honour the declared theme").

## FINDING L - value-less trailing flags are silently swallowed. MEDIUM. VERIFIED.
Every value-taking option reads `argv[++i]` with no check that a value exists.
$ npx tsx src/cli.ts render examples/17-sequence-sheets.ptc --svg -o t/tv.svg -q --view
  rc=0, rendered "Phase sheet" - the default. --view was requested and silently ignored.
$ npx tsx src/cli.ts render examples/17-sequence-sheets.ptc --svg -o t/tve.svg -q --view ""
  rc=0, same silent fall back (selectedView's `if (!wanted) return {}` treats "" as absent).
$ npx tsx src/cli.ts render examples/00-minimal.ptc --png -o t/tw.png -q --width
  rc=0, 1200x750 (see FINDING C).
$ npx tsx src/cli.ts render examples/00-minimal.ptc --svg -q -o
  rc=0, wrote ./00-minimal.svg (the default path) - the -o was dropped.
src/cli.ts:150-153 explicitly states the design rule this breaks: "An unknown name is
an error rather than a silent fall back to the first -- the whole point of asking was
to get a particular sheet." A missing or empty name gets exactly the silent fall back
that an unknown name is protected against.

## Minor / observations
- Default output goes to the *cwd*, not beside the input:
  `render examples/00-minimal.ptc --svg` writes ./00-minimal.svg, not
  examples/00-minimal.svg. defaultOutput (src/cli.ts:140) uses basename only.
  README.adoc:97 shows only the same-directory case so this is ambiguous rather than
  wrong, but it will silently overwrite a same-named file in the cwd.
- `render --pdf` on a 4-sheet study without --all-views produces a 1-page PDF with no
  hint that 3 sheets were dropped. Documented behaviour, but nothing on stdout/stderr
  says "this study declares 4 views".
- All temporary outputs written under the scratchpad; the two files that landed in the
  repo root during testing (`--png` and `00-minimal.svg`) were removed.
  `git status --short` is empty. Nothing in the repo was modified.

## Summary of clean areas
Exit codes 0/1/2/3 all reachable and correct for check and report; --view name
resolution and its error message; --all-views guard against non-PDF; option-before-
command ordering; PNG dimensions for valid --width/--scale; SVG XML well-formedness and
standalone prolog; NOT VALID stamping in all three formats and the no-file-without-
--force rule; PDF page counts for --all-views (4/4/1) and page ordering; [page]/[of]
resolution and the "?" fallback; JSON validity, completeness and agreement with the
text report across all 19 examples; CLI/library diagnostic parity; SVG and PNG
byte-determinism; theme handling per format.
