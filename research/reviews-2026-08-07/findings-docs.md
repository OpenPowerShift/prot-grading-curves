# tc-curves docs vs implementation audit (working notes)

## A. Diagnostic codes named in spec that NO src path emits (VERIFIED, class (a))
A1 CT_RATIO_UNSPECIFIED  - validation.adoc:148, semantics.adoc:939. src emits CT_RATIO_MISSING instead. Renamed code.
A2 MISSING_SEQUENCE_DATA - semantics.adoc:90. src emits SEQUENCE_DATA_MISSING (transposed). validation.adoc uses correct name -> spec self-contradicts.
A3 ANNOTATE_VOLTAGE_MISMATCH - validation.adoc:153, semantics.adoc:956. No hits in src, no equivalent. Whole check missing.
A4 CROSS_VOLTAGE_AXIS_PRIMARY_UNSUITABLE - linting-rules.adoc:35, examples-extended.adoc:232. No hits in src. Whole check missing.

## B. 76 of 129 emitted codes documented nowhere (class (b)) - see srccodes.txt

## C. two_axes - VERIFIED DEAD, and docs contradict each other (class a + c) HIGH
guide.adoc:1368 "two_axes repeats the time scale on the right-hand edge"
semantics.adoc:1391 "two_axes = true adds a second X-axis below the primary, labelled in the alternate unit (primary <-> secondary)"
=> Two docs describe DIFFERENT axes (time/right vs current/below).
Implementation: parsed (parser.ts:2399), stored (ast.ts:713), read ONLY by validate.ts:1752 to emit TWO_AXES_WITH_MULTIPLES. NO renderer consumer.
TEST: rendered base study with `view V1 { two_axes = true; }` vs `view V1 { }` -> SVG files byte-IDENTICAL.

## D. *** I_base / `pu` pickups -- SEVERE (class c) *** VERIFIED
guide.adoc:277 "I_base is what 1.0 pu means. A pickup written I_pickup = 1.2 pu is resolved against it"
guide.adoc:269 "I_base = 1000 A;  # the 1.0 pu current, for `pu` pickups"
grammar.adoc:49 has the production. semantics.adoc:918 also refers to system.I_base_A fallback.

BEHAVIOUR: `pu` is NOT resolved against I_base. model.ts:1136-1143 lumps `pu` in with
xCT/xIn: `inSecondary = pickup.secondary || pickup.perUnit || ...` then
`I_pu_A = I_pu_declared * ctRatio`. I_base is parsed (parser.ts:1038), stored
(model.ts:663 study.I_base_A) and read by NOTHING (grep I_base_A -> only decl/assign sites).

TEST (base = examples/00-minimal.ptc, R_FDR ct_ratio 400/5 = 80):
  I_pickup = 1.2 pu, I_base = 1000 A  -> worst_margin_s 0.759715
  I_pickup = 96 A                     -> worst_margin_s 0.759715  (EXACT MATCH)
  I_pickup = 1200 A (docs' promise)   -> worst_margin_s 0.501471
  I_base varied 50 / 1000 / 2000 A    -> margin UNCHANGED at 0.759715
=> 1.2 pu resolves to 1.2 * 80 = 96 A, i.e. multiples of the CT RATIO.
=> Docs promise 1200 A; engine uses 96 A. Factor 12.5, and in the dangerous
   direction (pickup far too low -> relay looks faster -> margin looks fine).
   Parses CLEAN, exit 0, no diagnostic.
SEVERITY: HIGH. Would mislead an engineer into a wrong setting silently.

## E. axis = "multiples" -- VERIFIED DEAD (class a/c) HIGH
guide.adoc:1377 "`\"multiples\"` -- the last drawing the abscissa in multiples of pickup, which is how a relay manual states its curves."
semantics.adoc:2077 "`multiples` -- current axis labelled in `M = I / I_p` (per-curve multiple), so each curve's pickup lands on `M = 1`. This mode is the only one in which the curves line up vertically by their pickup"
semantics.adoc:902 "or in `view { axis = \"multiples\"; }` so each pick-up lands on `M = 1` regardless of voltage."
grammar.adoc:631 lists it as a valid view-axis-keyword.

BEHAVIOUR: svg.ts:542 reads axisMode but only ever branches on `=== 'secondary'`
(lines 553,566,595,1584). 'multiples' falls through to primary everywhere.
TEST: rendered base study with view { axis = "primary" | "secondary" | "multiples" }
  primary   md5 083f60aa4905b46ff56694c7cb641d68
  multiples md5 083f60aa4905b46ff56694c7cb641d68   <- IDENTICAL to primary
  secondary md5 4d2f463456886a4e98467ac8d72ddea2   <- differs (secondary works)
  no view at all -> 083f60... (same as primary)
No diagnostic emitted. Silent fallback to primary amps.
SEVERITY: HIGH-ish. Sheet is labelled in amps while the author asked for M=I/Ip;
the promised "curves line up by pickup" property is absent with nothing said.

## F. Device catalogue -- VERIFIED DEAD (class a) HIGH
src/constants/catalog.ts ships 8 entries (ferraz_abc_100a, bussmann_jjl_50a,
mersen_a4bt_63a, urd_4_0_aepr_no7, tx_25mva_33_11kv, recloser_cooper_form6_fast,
recloser_cooper_form6_slow, motor_startup_induction_500hp) plus lookupCatalog()
and isKnownShorthand(). Header comment: "Device catalog -- ship-with TCC assets ...
References by shorthand (e.g. `ferraz_abc_100a`)."
NO consumer: only `export * from './catalog.js'` in constants/index.ts. Nothing in
semantics/, renderer/, parser/ imports CATALOG or lookupCatalog.

TEST: grade { primary = ferraz_abc_100a; backup = R_INC:51; ... } with no device block
  -> error: UNRESOLVED_REFERENCE: grade primary "ferraz_abc_100a" does not resolve
     to a relay element or device.  exit=1

Two validation.adoc rules are therefore UNREACHABLE:
 - "A `device` block whose shorthand is unknown to the catalog and whose `device`
    block is missing `kind`. *Error* (catalog fallback requires a `kind`
    discriminator)."  -> there IS no catalog fallback. (DEVICE_NO_KIND fires on a
    plain missing-kind, and its message still says "the catalog fallback needs one"
    -- validate.ts:1071.)
 - "A grade.primary ... referencing a device-id matching BOTH a built-in catalog
    entry and a user device block. *Error*" -> can never fire.
SEVERITY: HIGH as a documented-and-absent feature; the shipped data is unreachable.

## G. page { size = { width_mm; height_mm } } -- VERIFIED ABSENT (class a) MODERATE-HIGH
grammar.adoc:661-662:
  size-value      ::= paper-keyword | "{" "width_mm" "=" number ";"
                                          "height_mm" "=" number ";" "}" ;
validation.adoc also promises: "A `page { size = { ... } }` only providing `width_mm`
or `height_mm` (the other is missing). *Error*." (PAGE_SIZE_INCOMPLETE, validate.ts:1854)

BEHAVIOUR: parser.ts:2551-2556 `case 'size':` only accepts STRING|IDENT|KW.
A `{` matches none -> p.size stays undefined and the object body is swallowed.
TEST: page { size = { width_mm = 420; height_mm = 297; } }
  check -> "no errors", exit 0 (NO diagnostic)
  render --pdf -> MediaBox [0 0 841.889 595.275]  == byte-identical to the
  no-page-block default (A4 landscape). Custom size SILENTLY IGNORED.
Controls: size = A5 -> MediaBox [0 0 595.275 419.527] (works);
          size = A9 -> error PAGE_SIZE_UNKNOWN (works).
So the keyword form is fine; the documented object form is absent AND silent.
PAGE_SIZE_INCOMPLETE is unreachable from source text.
SEVERITY: MODERATE-HIGH -- silently wrong paper size on an issued drawing.

## H. meta { margin } "default for grade blocks" -- VERIFIED FALSE (class c) HIGH
guide.adoc:255  `    margin    = 0.30 s;          # default for grade blocks that omit it`
guide.adoc:47   `    margin    = 0.30 s;              # default grading interval`

BEHAVIOUR: parseMeta (parser.ts:791-805) shovels every key into a free-form
`entries: Record<string, ScalarValue>` map. NOTHING reads meta.margin
(`grep -rn meta src/semantics/model.ts | grep -i margin` -> no hits).

TEST: examples/00-minimal.ptc with `margin = 0.30 s;` REMOVED from the grade and
`meta { margin = 0.90 s; }` added. If honoured, required 0.90 s vs actual 0.654 s
=> verdict "fail".
ACTUAL: {"verdict": "unevaluated", "worst_margin_s": 0.654104}  -- no
required_margin_s at all. The meta default is not applied; the grade is simply
never evaluated.
SEVERITY: HIGH. An engineer who sets the study-wide margin in `meta` per the guide
gets NO margin check, and `check` exits 0. A study that does not coordinate passes
CI silently. (Compare cli.ts's own comment: "a CI job gating on this tool was
gating on syntax while believing it gated on grading" -- this reintroduces exactly
that failure via the documented meta.margin route.)

## H2. meta accepts ANY key, no typo check (class c) MODERATE
validation.adoc "=== Typos" promises UNKNOWN_SETTING for misspelled names, and
"Names and units the language does not know are refused."
TEST: meta { enginer = "A. Cooper"; wibble = 42; margn = 0.3 s; }
  -> "no errors", exit 0. Three bogus keys, silence.
The `meta` block is exempt from the typo regime the spec advertises; guide.adoc
documents a fixed key list (project/study/engineer/date/revision/reference/margin)
which is not enforced. Note `margn`/`margin` is exactly the class of typo the spec
says is caught -- and here it is doubly harmless only because margin is dead anyway.

## I. *** skill.adoc names FOUR curves that do not exist *** VERIFIED (class c) HIGH
docs/skill.adoc:142  `| IEEE C37.112  | \`ieee.mi\`, \`ieee.vi\`, \`ieee.ei\``
docs/skill.adoc:144  `| Vendor        | \`sel.c1\`, \`abb.rel_ni\`, and others -- see the reference`
Preamble at skill.adoc:129 "Write the standard's name. The tool carries the constants."

TEST (substituted into examples/00-minimal.ptc, `tc-curves check`):
  iec.si iec.vi iec.ei iec.lti sel.c1 abb.ri  -> OK
  ieee.mi     -> error CURVE_UNKNOWN "not in the constants table"
  ieee.vi     -> error CURVE_UNKNOWN ... -- did you mean "iec.vi"?
  ieee.ei     -> error CURVE_UNKNOWN ... -- did you mean "iec.ei"?
  abb.rel_ni  -> error CURVE_UNKNOWN "not in the constants table"
The real namespace is `ansi` (curves.ts:177-178 registry `{iec, ansi, sel, siemens,
ge, abb, schneider}`); ansi.mi / ansi.vi / ansi.ei all verified OK.

WHY THIS IS THE WORST KIND: the suggestion engine actively pushes the reader to the
WRONG CURVE. ieee.vi -> "did you mean iec.vi?" but
  ANSI/IEEE VI = k 19.61, c 0.491, alpha 2.0   (curves.ts:87)
  IEC VI       = k 13.5,  c 0,     alpha 1.0   (curves.ts:75)
Different characteristic entirely. An engineer following the doc, then accepting the
tool's own suggestion, silently grades against the wrong curve family.
Second-order: tmsRangeFor() (curves.ts:192-196) applies TMS_RANGE_ANSI (0.5..15) only
to namespace `ansi`; taking the iec.* suggestion also swaps the validated TMS range
to 0.025..1.5, so an ANSI time dial of e.g. 3.0 would then read as out of range.
SEVERITY: HIGH. This is the AI-facing document; it is the one that must be literal.

## I2. skill.adoc:129 "Or in `meta`" for grading margin -- compounds finding H
docs/skill.adoc:129
`| Grading margin 0.3 s | \`margin = 0.30 s;\` on the \`grade\` | Or in \`meta\`.`
meta.margin is dead (finding H). An AI following this row puts the margin in meta,
the grade is never evaluated, verdict "unevaluated", and `check` exits 0.
SEVERITY: HIGH -- silently unGRADED study that reports success.

## I3. skill.adoc positives (VERIFIED OK, no action)
- All 15 [source,tc] blocks parse; the only errors are fragment artifacts
  (VOLTAGE_UNKNOWN / UNRESOLVED_GROUP*) from blocks quoted out of context.
- skill.adoc:88 "That is a complete, valid, useful study" -> check exits 0. TRUE.
- Exit-status table (0/1/2/3) verified: forcing a failing margin gives
  "no errors, but grading fails" exit=3. TRUE.
- Minor: skill.adoc:26 says "about ninety checks"; 129 distinct codes are emitted.
  Cosmetic understatement.

## J. Bogus curve ids elsewhere (class c)
spec/sections/examples-extended.adoc:286  `    curve        = ansi.e;`
TEST -> error CURVE_UNKNOWN "did you mean \"ansi.ei\"?"  A spec example does not compile.
(schneider.c10 at semantics.adoc:1144 is explicitly hypothetical - "Adding a NEW vendor
curve (e.g. schneider.c10)" - not a defect. ge.ur.* are all real.)
Full sweep: every `ns.family` token in docs/ + spec/ + README vs allCurveIds() (31 real).
Non-existent: abb.rel_ni, ansi.e, ieee.ei, ieee.mi, ieee.vi.

## K. Dead directional / reset cluster -- VERIFIED (class a) MODERATE-HIGH
Sweep method: inserted each key into examples/00-minimal.ptc element 51, rendered SVG,
compared md5 against the unmodified base.
  name = "Zed"       -> affects output
  color / style / width_px / share  -> affect output
  comment = "hi"     -> NO EFFECT (benign, it is a comment)
  directional = true -> parses clean, NO EFFECT on SVG
  char_angle = 45 deg-> parses clean, NO EFFECT on SVG
  reset = "instant"  -> parses clean, NO EFFECT on SVG
  t_reset = 2 s      -> parses clean, NO EFFECT on SVG
Confirmed by grep: model.ts:1165-1166 assigns `directional` and `char_angle_deg` onto
the element model; nothing in semantics/, renderer/ or export/ ever reads either.
relay `direction` likewise: model.ts:975 assigns, no reader.
`tReset()` (curves.ts:99) is exported and covered by tests/unit/curves.spec.ts:177-180
but has NO production consumer -- the reset characteristic is never used in any margin
or drawing.

guide.adoc:561-575 gives all of these real protection meaning:
  "`reset` is what the element does *after* a fault clears but before it has finished
   timing ... on a reclosing scheme that memory decides whether the second shot lands
   on a partly-run disc."
  "`directional = true` restricts the element to faults in front of it, which is what
   stops one of a parallel pair tripping for a fault on the other."
  guide.adoc:553-554 `reset = disk_emulation;` / `t_reset = 6 s;`
NONE of this is modelled. Note semantics.adoc:745-747 is HONEST about directional
("The processor does not (v1) compute the directional characteristic itself"), so the
spec and the user guide disagree with each other; guide.adoc reads as a promise.
SEVERITY: MODERATE-HIGH. guide.adoc leads an engineer to believe a parallel-feeder
study is directionally discriminated when every element is in fact non-directional.

## L. tutorial.adoc -- worked numbers VERIFIED CORRECT (no defect)
tutorial.adoc:115-118 claims
    t_primary       = 0.267 s
    t_backup        = 0.921 s
    achieved margin = 0.654 s        -- pass
    overall         : PASS
Rebuilt that exact study and ran `tc-curves report`:
    t_primary       = 0.267 s        (M = 12.92)
    t_backup        = 0.921 s        (M = 6.46)
    achieved margin = 0.654 s        -- pass
    overall         : PASS (worst 0.654 s at 6200 A) vs margin
EXACT MATCH. (Tutorial abbreviates the last line; cosmetic only.)
Aside, not a doc defect: the real last line ends "...vs margin" which reads like a
truncated string in formatGradeReports.

## L2. tutorial.adoc repeats the dead meta.margin claim (class c) HIGH
tutorial.adoc:543  `    margin   = 0.30 s;        # the default for every grade block`
Same defect as finding H. The false meta.margin promise now appears in FOUR places:
  guide.adoc:47, guide.adoc:255, tutorial.adoc:543, skill.adoc:129.

## L3. tutorial.adoc [meta.*] macros -- VERIFIED TRUE (no defect)
tutorial.adoc:547 "Titles and footers can pull from it: `[meta.project]`, `[meta.date]`,
and any key you invent yourself."
TEST: meta { project="Northgate"; date="2026-08-01"; wibble="INVENTED"; } with
page { border = true; title = { text = "[meta.project] / [meta.date] / [meta.wibble]"; } }
Rendered SVG contains "Northgate / 2026-08-01 / INVENTED". Invented keys DO work.

## M. grammar.adoc: "SVG ... margins baked into the document" -- FALSE (class c) MODERATE
grammar.adoc (page section preamble, ~line 632):
  "SVG, PNG, and PDF outputs *all* consume these settings; for PNG/PDF the page size
   and orientation map directly to canvas / PDF dimensions, while SVG honours the
   viewBox (with margins baked into the document)."
TEST: page { margins_mm = 5; } vs page { margins_mm = 40; }
  SVG md5 083f60aa4905 for BOTH; viewBox="0 0 1200 750" for BOTH. No effect.
  PDF md5 5048e88de97f vs 0006bc600650 -> differs (PDF DOES honour it, via
  cli.ts:371 -> export-pdf.ts:53).
So margins_mm is PDF-only. PNG rasterises the SVG so it ignores margins too.
Also `page { size = ... }` is PDF-only by the same argument (SVG viewBox unchanged),
contradicting "SVG, PNG, and PDF outputs all consume these settings".
SEVERITY: MODERATE -- an engineer setting margins for an SVG deliverable gets silence.

## N. grammar.adoc view-member production is INCOMPLETE (class b) LOW-MODERATE
grammar.adoc:614-627 lists view-member as exactly: name, stages, axis, quantity,
condition, voltage, title, subtitle, current_min, current_max, time_min, time_max,
two_axes, reference_ct.
The parser ALSO accepts, and guide.adoc:1355-1361 documents, six padding keys that
have NO production:
  current_pad, current_pad_low, current_pad_high, time_pad, time_pad_low, time_pad_high
TEST: each inserted into `view V1 { ... = 3; }` -> all six "affect output" (SVG md5
changes vs the empty-view baseline). All real, all undocumented in the EBNF.
Also missing from the production: `default` (in the parser's own accept list at
parser.ts:2414), and `group` (used by skill.adoc:013 and accepted).
Sub-note: parser.ts:2414's UNKNOWN_SETTING suggestion list for a view also omits the
six pad keys, so a typo like `current_pd` gets a suggestion list that cannot help.

## N2. grammar terminal-key sweep (method note)
Extracted all 127 quoted `"key" "="` terminals from grammar.adoc and compared with
every quoted identifier in parser.ts. Only `width_mm` and `height_mm` appear in the
grammar with no occurrence in the parser at all -- that is finding G.

## O. spec/sections/linting-rules.adoc -- MOSTLY UNIMPLEMENTED
Header claim (linting-rules.adoc:1-5): "The processor emits a *warning*, not an error,
on the following situations. Warnings appear in the margin report and on the rendered
plot but do NOT BLOCK grading computation."  Tested all the concrete ones:

O1. "Unit confusion. `I_pickup = 1.2` (no A or xIn suffix) ... *Warning*."
    ACTUAL: hard ERROR UNIT_MISSING. Blocks rendering (no sheet written, exit 1).
    Class (c), severity MODERATE -- documented severity is wrong in the direction that
    matters (doc says it won't block; it does).

O2. "Bare curve names. `curve = si;` -- RESOLVED VIA THE DISAMBIGUATION TABLE, but
     flagged so the engineer chooses IEC vs ANSI explicitly."
    ACTUAL: 2 hard ERRORS -- CURVE_UNKNOWN ("si ... not in the constants table") and
    STAGE_NO_CURVE. There is NO disambiguation table. Bare curve names do not work
    at all. Class (a)+(c), severity MODERATE-HIGH: the doc says a form is supported
    and merely warned; it is rejected.

O3. "Pick-up discrimination insufficient. `I_pu_backup / I_pu_primary` less than 1.2
     -- flagged per IEEE 242 Section 15.3.2 and BS 7671."
    TEST: backup 504 A / primary 480 A = 1.05  -> NOTHING emitted. ABSENT. Class (a).
    Severity MODERATE-HIGH -- this is a genuine coordination defect the doc claims to
    catch and does not.

O4. "TMS outside device characteristic range ... (v0.2; uses relay-compatibility
     table)". No relay-compatibility table exists in src. ABSENT (doc self-flags v0.2).

O5. "Mixing `abb.ri` / `abb.rd` ... in the same grading pair with IDMT curves.
     *Warning*." TEST: primary abb.ri vs backup iec.si -> NOTHING. ABSENT.

O6. "`page { theme = "monochrome" }` with curves whose `line_width_px < 0.4`.
     *Warning*." TEST: monochrome + width_px = 0.3 -> NOTHING. ABSENT.
     (Also note the doc key is `line_width_px`; the real key is `width_px`.)

O7. "`page { watermark = "DRAFT" }` while a `meta.standard` declaration is non-empty.
     *Warning*." TEST with meta.standard -> NOTHING.
     The implemented rule keys on meta.study == "final" (WATERMARK_ON_FINAL, verified
     firing). validation.adoc describes it correctly; linting-rules.adoc does not.
     Doc-vs-doc contradiction. Class (c).

O8. "CT-ratio spread ... exceeds 5:1 -- *Warning* in the renderer when
     `axis = "secondary"`." VERIFIED PRESENT:
     CT_SPREAD_WIDE "CT ratios in this study span 10.0:1 ... consider axis = \"multiples\""
     *** BUT the remedy it recommends is finding E: `axis = "multiples"` is DEAD. ***
     The tool tells the engineer to switch to a mode that renders identically to
     primary. Compounds finding E to HIGH.

O9. CROSS_VOLTAGE_AXIS_PRIMARY_UNSUITABLE (linting-rules.adoc:35) -- absent, finding A4.

Net: of the ~14 rules in linting-rules.adoc, 2 verified present (CT spread, and the
watermark rule under different conditions), 2 present but as ERRORS not warnings,
and the rest could not be triggered. This file is the least trustworthy in the set.

## P. docs/api.adoc -- one wrong export name (class c) LOW-MODERATE
Ran a real import of src/index.ts and probed all 25 symbols api.adoc names.
24 of 25 exist. One does not:
  docs/api.adoc:113  `tTripLinear(M, a, b, tms)            // ABB RI`
  -> `lib.tTripLinear` is undefined. The real export is `tTripRI`
     (curves.ts:72, identical signature `(M, a, b, tms)`).
Everything else verified present: allCurveIds, exportPdf, exportPng,
formatGradeReport, formatGradeReports, lookupCurve, parseAndRender, process,
renderStudy, renderSvg, reportGrades, solveGrade, suggestCurveId, tmsRangeFor,
toExportableSvg, tReset, tTripCombine, tTripDefinite, tTripElement, tTripFlex,
tTripIDMT, tTripLog, tTripStage, validate.
SEVERITY: LOW-MODERATE. A copy-pasted import fails loudly at once, so it misleads
nobody into a wrong setting -- purely a broken-doc defect.
Note api.adoc also advertises `tReset` as a public API; it is exported and tested
but has no production consumer (finding K).

## Q. "ANSI curves" TMS range applies to ONLY the `ansi.` namespace (class c) HIGH
validation.adoc:
  ". *`tms` outside* `0.025 <= tms <= 1.5` for IEC curves, *or*
     `0.5 <= tms <= 15` for ANSI curves. *Error* with the valid range in the message."
Boundaries VERIFIED EXACT for the two namespaces that behave:
  iec.si   0.02 -> error, 0.025 -> ok, 1.5 -> ok, 1.6 -> error
  ansi.vi  0.4  -> error, 0.5   -> ok, 15  -> ok, 15.1 -> error

BUT curves.ts:192 `const ANSI_NAMESPACES = new Set(['ansi']);` and tmsRangeFor()
keys on the NAMESPACE STRING, not on whether the curve is an ANSI/C37.112 curve.
Curves the constants table ITSELF describes as C37.112 / US-dialled are therefore
given the IEC range:
  ge.ur.mi tms=3.0 -> error "outside the valid range [0.025, 1.5]"
     (curves.ts:133 "GE UR moderately inverse ... (C37.112 mi, default)")
  ge.ur.vi tms=3.0 -> error [0.025, 1.5]   (curves.ts:134 "(C37.112 vi)")
  sel.u1   tms=3.0 -> error [0.025, 1.5]   (curves.ts:104 "SEL U1 (CO-2 emulation)")
  sel.c1   tms=3.0 -> error [0.025, 1.5]
  ansi.mi  tms=3.0 -> accepted
SEVERITY: HIGH, and dangerous. A real GE UR or SEL setting sheet quoting a time dial
of 3.0 is REJECTED as invalid. The obvious way to make the error go away is to divide
the dial by ten -- which yields a curve ten times fast and a margin that does not
exist. The message even names a range the doc says does not apply to that curve.

## R. relay `direction` -- VERIFIED DEAD (class a) MODERATE
guide.adoc:574-575 "The relay itself carries `direction = forward`, `reverse` or
`none` -- `reverse` for an element looking back into the busbar behind it, `none` for
a non-directional backup that must not [trip]..."
TEST: relay R_FDR with `direction = "reverse";` -> parses clean, SVG md5 IDENTICAL to
base. model.ts:975 assigns it; no reader anywhere.
Benign-by-design inert relay keys (not flagged): reference, description, comment.
Live relay keys confirmed: maker, model, name, ct_ratio, voltage.

## SUMMARY TABLE
| # | Item | Class | Severity |
|---|------|-------|----------|
| D | I_base / `pu` resolves to 1.2*CT_ratio not 1.2*I_base | c | HIGH |
| I | skill.adoc names ieee.mi/vi/ei + abb.rel_ni; none exist | c | HIGH |
| H,I2,L2 | meta.margin "default for grade blocks" is dead (4 docs) | c | HIGH |
| Q | ANSI TMS range keyed on namespace; ge.ur.*/sel.* rejected | c | HIGH |
| E | axis = "multiples" inert (and CT_SPREAD_WIDE recommends it) | a/c | HIGH |
| F | device catalogue unreachable; 2 validation rules dead | a | HIGH |
| O2,O3 | linting: bare curve names, pickup discrimination absent | a/c | MOD-HIGH |
| A3,A4 | ANNOTATE_VOLTAGE_MISMATCH / CROSS_VOLTAGE_... never emitted | a | MOD-HIGH |
| K | directional / char_angle / reset / t_reset all inert | a | MOD-HIGH |
| C | two_axes inert AND guide/semantics describe different axes | a/c | MOD-HIGH |
| G | page size object form absent + silent | a | MOD-HIGH |
| M | "SVG bakes margins in" false; margins_mm is PDF-only | c | MOD |
| O1,O7 | linting severities/conditions wrong vs implementation | c | MOD |
| A1,A2 | CT_RATIO_UNSPECIFIED / MISSING_SEQUENCE_DATA misnamed | a | MOD |
| R | relay `direction` inert | a | MOD |
| J | ansi.e in examples-extended.adoc does not compile | c | MOD |
| N | grammar view-member omits 6 pad keys + default + group | b | LOW-MOD |
| B | 76 of 129 emitted codes documented nowhere | b | LOW-MOD |
| H2 | meta block exempt from typo checking | c | MOD |
| P | api.adoc tTripLinear -> real name tTripRI | c | LOW-MOD |

VERIFIED-CORRECT (no defect): tutorial worked numbers 0.267/0.921/0.654 exact;
[meta.*] macros incl. invented keys; skill.adoc 15 blocks all parse; skill.adoc
exit-status table; IEC/ANSI TMS boundary values; view pad keys; page size keyword
form; PAGE_SIZE_UNKNOWN; WATERMARK_ON_FINAL; CT_SPREAD_WIDE; 24/25 api.adoc exports.
