# tc-curves playground — usability findings

Session started. Server: http://localhost:5173/

## Environment
- Chrome tab 300627703, viewport 1777x914 CSS px, dpr 0.9. Window resize was ignored by the
  extension, so narrow layouts were tested by shrinking `tc-app` via JS (per brief).
- Console on load: clean apart from two Lit dev-mode notices:
  - `Lit is in dev mode` (expected in dev)
  - WARNING `Element tc-viewer scheduled an update ... after an update completed` — a re-entrant
    render in tc-viewer. Cosmetic in dev, but it fires on every load.

## F1. VERIFIED — 21 diagnostics (20 of them hard errors) report location `1:1`
What I did: cycled all 19 gallery examples via the picker and dumped `ul.diagnostics`.
What happened: every `FAULT_SINGLE_POINT` info reads e.g.
`ℹ 1:1 fault F_33_BUS_3PH_MIN declares only I_A; min_A and max_A default to it` — the fault block
is at line ~40, not 1:1. The `1:1` is a clickable link, so it jumps the cursor to the top of file.
Source: `src/semantics/validate.ts:82` — `const at = loc ?? NOWHERE;`. 21 of 117 `add(ctx,...)`
calls pass `undefined` for loc:
UNRESOLVED_GROUP_MEMBER, VOLTAGE_LEVEL_INVALID, VOLTAGE_UNKNOWN (x4), FAULT_CURRENT_INVALID,
RANGE_WITHOUT_CENTRE, RANGE_INCOMPLETE, FAULT_SINGLE_POINT, FAULT_RANGE_INVERTED, DEVICE_NO_KIND,
DEVICE_NO_CURVE (x3), COMBINE_NO_SOURCES, DUPLICATE_POINT, POINT_CURRENT_AND_CONDITION,
POINT_CURRENT_INVALID (x2), POINT_TIME_INVALID.
Expected: the link lands on the offending block.
Severity: slows work (blocks work on a long study — "error at 1:1" in a 300-line file is a search).
Evidence: DOM dump of diagnostics for all 19 examples; validate.ts:74-92, 645-655.

## F2. VERIFIED — "No issues" chip shown while info diagnostics are listed
What I did: loaded Gallery 1 (default). Toolbar counter reads `No issues`; the diagnostics strip
below the editor simultaneously lists 1 info diagnostic. Same on 16 of 19 examples.
Expected: either the chip counts infos ("1 note") or the strip is collapsed when the chip says
"No issues". As-is the two disagree at a glance.
Severity: cosmetic/slows work. Evidence: `.counts` = "No issues", `ul.diagnostics li.info` present.

## F3. VERIFIED — all 19 examples render
Every example produced a non-empty SVG (1-19 `<path>` elements). No render failures, no console
errors while cycling. Multi-sheet examples expose a sheet picker: Advanced/Kestrel Rise (4 sheets),
Gallery 5 (4), Parallel feeders (2).

## F4. VERIFIED — example picker is sorted alphabetically, burying the starter
Options order puts "Advanced — Kestrel Rise BESS (two chains, four sheets)" first and
"Gallery 1 — Minimal (two relays, one fault)" 6th, even though Gallery 1 is DEFAULT_EXAMPLE and the
one a newcomer wants. The list also mixes tutorial "Gallery n" entries with topic examples.
Severity: cosmetic. Evidence: select option list.

## F5. VERIFIED — diagnostic line links work when a location exists, but land at the bottom edge
What I did: loaded "Cross-vendor (ANSI MI + IEC VI)", clicked the `68:1` link on the
MARGIN_NO_SOLVE warning.
What happened: the editor scrolled and line 68 (`grade {`) is highlighted with a ⚠ gutter marker —
correct line. But the target line is placed on the *last* visible row of the editor, and a hover
tooltip for `grade` immediately opens beneath the cursor, covering the row. You cannot see any of
the block you were sent to without scrolling again.
Expected: reveal the line roughly centred (CodeMirror `EditorView.scrollIntoView(..., {y:"center"})`).
Severity: slows work. Evidence: screenshot ss_06386zsmq.

## F6. VERIFIED — completion and hover docs are genuinely good
Typed `vol` inside `system {` → completion popup offered `voltages`, with a doc panel
("The named voltage levels of the study. Turns ratios are derived from them; there is deliberately
no transformer block.") and a worked one-liner `voltages { "HV" { V = 33 kV; } }`.
No auto-close-brackets (typed braces are not doubled), auto-indent works.
No complaint. Evidence: screenshot ss_56023f29l.

## F7. VERIFIED — error messages for missing unit / missing tms are excellent
Typed a study from scratch with three planted mistakes. Messages produced:
- `17:3  R1:51/main declares an inverse-time curve with no tms; it would be drawn and graded at
  1.0, which on a standard inverse is about ten times a usual setting. Give the multiplier the
  relay is set to, or let a grade solve for it with solve { free = ["tms"]; }`  (TMS_MISSING)
- `17:3  R1:51 declares "I_pickup" without a unit; write one of "A", "kA", "mA", "MA", "pu",
  "xCT", "xIn", "xct", "xin", "A_sec", … a bare …`  (unit list)
- `2:5  unknown setting "vol"; a system accepts voltages, zero_sequence, transformer, base_S,
  I_base, I_units`  (UNKNOWN_SETTING)
These say what is wrong, what it will do instead, and how to fix it. Best part of the tool.
Evidence: screenshot ss_7059edc1c.

## F8. VERIFIED — a typo'd key inside `fault` is only a WARNING, silently dropped, no "did you mean"
What I did: wrote `voltag = MV;` (typo of `voltage`) inside a fault block.
What happened: `11:5 ⚠ a fault does not accept "voltag"; it accepts I, I_min, I_max, I1, I2, I0,
residual, I1_min, I1_max, I2_min, I2_max, I0_min, I0_max, residual_min, residual_max, type,
voltage, view, views, name, description` — severity **warning**, the assignment is dropped, and the
plot still draws (the fault legend just loses its `· 11 kV`).
Expected: a "did you mean voltage?" hint. The file already has `didYouMeanOf()`
(`src/parser/parser.ts:60`) but it is used **only** for VALUE_UNKNOWN (`parser.ts:655`), never for
unknown keys. And `noteUnknownKey(..., strict)` defaults to `false` (`parser.ts:566`) with only
3 strict call sites (`parser.ts:915, 1008, 1707`), so almost every mistyped key anywhere in the
language is a warning you can ship past, not an error.
Severity: slows work — a 20-name "it accepts …" list makes you scan for your own typo when a
one-word suggestion was already available.
Evidence: screenshot ss_7059edc1c; parser.ts:606-630.

## F9. VERIFIED — the "NOT VALID" banner is good, but the plot still draws a wrong curve
With `tms` missing and `I_pickup` unitless, the plot drew `R1:51 / IEC SI · 300 A / 11 kV` at an
assumed TMS of 1.0. The red banner `DRAWN FROM A STUDY WITH 2 ERRORS — NOT VALID` is prominent and
correct, and the legend omits the TMS — but nothing on the *curve itself* marks it as assumed, and
Save SVG / Save PNG / Copy PNG stay enabled, so an invalid sheet can leave the tool.
Severity: slows work (risk of an invalid sheet being circulated). Evidence: ss_7059edc1c.

## F10. VERIFIED — diagnostics panel is capped at 28% and starts scrolling at 4 messages
`ul.diagnostics` has `max-height: 28%; overflow-y: auto`. With only 4 diagnostics
scrollHeight 307 > clientHeight 255, so the last message is already clipped mid-sentence
("… a bare"). There is no count ("showing 3 of 9"), no way to enlarge the panel, and it is not
part of the draggable splitter.
Severity: slows work. Evidence: computed style dump; screenshot ss_7059edc1c.

## F11. VERIFIED — hover readout and snapping work well
Hovering near the fault line gave `Bus / I = 5.00 kA / fault level`; hovering on the R1 curve gave
`R1:51 / MV / I = 30.47 kA / t = 144.53 ms` with the curve thickened and a marker drawn on it.
Snap radius is generous and it picks the nearer of curve/fault sensibly.
Two nits: (a) the readout box is drawn up-and-left of the cursor and sits *on top of* the curves it
is reading (it covered R2's curve in my test); (b) the readout does not clear or follow when the
view changes under it — after a wheel event the stale box stayed painted at the old point.
Severity: cosmetic. Evidence: ss_8981lvtm5, ss_0927l7png.

## F12. VERIFIED (synthetic wheel) — wheel zoom on/off the plot matches its documented behaviour
- Wheel **on** the plot area: changes the current axis about the cursor
  (`currentMin/currentMax` went null → 36.7 A…58.1 kA → 103.6 A…37.6 kA on two ticks).
- Wheel **off** the plot (over the legend): raises `displayScale` 1 → 1.25, i.e. sizes the paper.
Both match the `?` panel ("Wheel off the plot — size the drawing").
CAVEAT: the Chrome-automation `scroll` action never reached the app's `@wheel` handler (state
unchanged, no visual change) in either tab; the behaviour above was confirmed by dispatching a real
`WheelEvent` on `div.pane-host`. So **I could not test a physical mouse wheel**. The handler is
bound via Lit `@wheel` on `div.pane-host` (`tc-viewer.ts:1574`) and calls `preventDefault()`, which
in Chrome is honoured for a non-root listener, so I have no reason to think a real wheel fails.

## F13. VERIFIED — −, Fit, 1:1, +, Reset view all do what their tooltips say
`+` 1 → 1.25 → 1.5625; `−` back to 1.25; `Fit` → 1.001 (pane-fit); `1:1` → 1.
`Reset view` restored `currentMin/currentMax` to null AND `displayScale` to 1.
Nit: `Reset view`'s tooltip is "Reset the plot zoom to the view block's bounds" — it does not
mention that it also drops the display size back to 1:1, which it does. The `?` panel gets this
right ("Reset — return to the view block's bounds, at actual size").
Nit: there is no readout of the current display zoom anywhere, so at 1.5625 you cannot tell what
scale you are on without pressing 1:1 and losing it.
Severity: cosmetic.

## F14. VERIFIED — at displayScale > 1 the legend text is clipped by the pane, not scrolled to
At displayScale 1.25 the pane gains H+V scrollbars (correct — the drawing is bigger than the pane),
but the right-hand legend column is cut mid-word ("IEC SI · 3", "Bus · 5 kA") and the horizontal
scrollbar has to be used to read it. Since the legend is what you zoom in to read, this is the
wrong thing to push off screen. Severity: slows work. Evidence: ss_6037jvbg3.

## F15. VERIFIED — middle-drag pan works, but is unclamped
Synthetic middle-button drag (button 1) on `div.pane-host`: the host gets class `panning` and
`cursor: grabbing`, and the current domain shifts (37 A…58.6 kA → 509 A…807 kA for a 200 px drag).
Note the domain is clamped for *zoom* (1/3 to 6 decades) but not for *pan*, so you can drag the
axis out to 800 kA and beyond — well past anything physical — with only "Reset view" to get back.
CAVEAT: the Chrome-automation tool has no middle-button drag, so this was a dispatched
MouseEvent, not a physical middle button. Severity: cosmetic.

## F16. VERIFIED — Copy PNG shows "Copied!" and reverts
Real click on Copy PNG turned the button into a highlighted "Copied!" and it reverted on its own.
Timer in code is 5000 ms (`tc-app.ts:177`); my measurement (~6 s) is consistent within the ±1 s
resolution I had (background-tab timer throttling). A *programmatic* click never shows "Copied!" —
correct, the code deliberately only reports success (`tc-app.ts:162-178`).

## F17. VERIFIED — Save SVG / PNG / PDF all produce a file, but every study is named "tcc"
I patched `HTMLAnchorElement.prototype.click` in the page so downloads were captured rather than
written to disk (I did not want to drop files in the user's Downloads folder without their say-so).
Clicking Save SVG, Save PNG, Save PDF produced, in order: `tcc.svg`, `tcc.pdf`, `tcc.png` — all
three real blobs, no errors, no console output.
The stem comes from `study.meta.project` and falls back to the literal `tcc`
(`tc-viewer.ts:1464-1468`). It ignores the name you saved the study under and the sheet you are
looking at, so exporting sheet 2 of a 4-sheet study, then sheet 3, gives you `tcc.pdf` and
`tcc (1).pdf` in your Downloads with nothing to tell them apart.
Severity: slows work. Evidence: captured download list.
Also: Save SVG and Save PNG give no in-app acknowledgement at all (unlike Copy PNG's "Copied!").

## F18. VERIFIED — **BLOCKS WORK**: "Show report" pushes the whole application off screen
What I did: loaded "Advanced — Kestrel Rise BESS (two chains, four sheets)" (4 grades), clicked
`Show report 4 pass` in a 1580x892 window.
What happened: the report `<pre>` rendered 791 px tall at the top of the window. Everything else —
both toolbars, the editor, the plot — was squashed into the bottom 73 px. The editor showed 3 lines
of source; the plot SVG's own box ran from y=865 to y=1485, i.e. 600 px of it is below the window
and unreachable (`tc-app` is `overflow:hidden`, so nothing scrolls to it). The only way back is to
find and click "Hide report" in the 20 px strip that is left.
Expected: `.report` is *meant* to be capped — `src/components/tc-app.ts:593` says
`.report { flex: 0 0 auto; max-height: 30vh; overflow: auto; ... }`.
Root cause (VERIFIED at runtime): `TcApp.createRenderRoot()` returns `this`
(`tc-app.ts:865`), so the component renders into the **light DOM** and Lit never adopts its
`static styles` block — `document.adoptedStyleSheets.length === 0`. Computed style on the live
`pre.report` is `max-height: none; overflow-y: visible; background: transparent; padding: 0`.
The real styling lives in `src/styles/global.css`, and `.report` has no rule there at all.
Severity: **blocks work**. Evidence: screenshots ss_6867rphbp, ss_56595uwth; computed-style dump.

## F19. VERIFIED — same root cause: 9 classes in tc-app's dead `static styles` are unstyled
Diffing the selectors in tc-app.ts's `static styles` against `src/styles/global.css`, these are
styled only in the dead block and therefore render with no styling at all:
`report`, `report-toggle`, `verdict.pass`, `verdict.fail`, `err-count`, `warn-count`,
`tabs-shell`, `spacer`, `active`.
Two of these matter to a reader:
- **`verdict.pass` / `verdict.fail`** — the grading badge is supposed to be a green or red chip
  (`.verdict.pass { background: var(--tc-ok,#3f9d58) }`). Live, `background-color` is
  `rgba(0,0,0,0)` and colour is the ordinary foreground, so "4 pass" and "2 fail" look identical
  at a glance. (`tc-app .verdict.unevaluated` *was* migrated to global.css — so only that third
  state is styled, which is backwards.)
- **`err-count` / `warn-count`** — the error/warning number in the counter is supposed to be red /
  amber. Live it is `rgb(157,163,175)`, the same muted grey as "No issues", so "2 errors" does not
  read as an alarm.
Severity: slows work (pass/fail and error counts are exactly what you scan for).
Evidence: computed styles `.verdict.pass` bg = transparent, `.counts` colour = muted grey;
selector diff of tc-app.ts static styles vs global.css.

## F20. VERIFIED — sheet picker and "PDF (all sheets)" work
The 4-sheet study exposes a "Which declared view to draw" select. All four sheets draw, each with
its own title ("BESS inverter transformer - phase grading", "… negative-sequence grading",
"Auxiliary kiosk transformer - phase/negative-sequence grading") and 3-4 curves.
"PDF (all sheets)" (tooltip "Download every declared sheet as one PDF, a page each") produced
`kestrel-rise-bess-all.pdf` — correctly named from `meta.project`, confirming the "tcc" default in
F17 only bites studies that do not declare one. The button is correctly absent on single-sheet
studies.

## F21. VERIFIED — Guide modal: four tabs, contents, and Escape all work
Tutorial / Reference / Advanced / For an AI all switch and render (29 / 58 / 14 / 17 code blocks
respectively, each with its own Copy button). Contents links scroll correctly — clicking
"11. Making it a drawing" put that heading at the top of the body. Escape closes the dialog.
The Tutorial's opening text is genuinely good ("A time-current coordination study, built up one
step at a time").

## F22. VERIFIED — Guide filter matches section HEADINGS only; "tms" and "margin" find nothing
What I did: typed `tms` in the "Filter contents…" box, on each of the four tabs.
What happened: the contents column reads **"No section matches."** on all four tabs — including
Reference, which has 49 sections — while the body of the page I am looking at visibly contains
`tms = 0.10;` and the sentence "`tms` is the time multiplier". The body is not filtered, not
scrolled and nothing is highlighted; only the left-hand section list responds.
Tested: "fault" → 3 sections, "relay" → 3, "grade" → 1, "curve" → 1, "tms" → none,
"margin" → none.
Expected: a reader looking up a key types the key. Matching heading text only means the single most
common lookup in a protection reference (a setting name) fails, and it fails with a dead end rather
than a fallback.
Severity: slows work. Evidence: ss_7690549gk; scripted filter sweep across all four tabs.

## F23. VERIFIED — Guide's per-snippet Copy buttons are invisible until you hover the block
`button.tc-copy` has computed `opacity: 0` until the surrounding `pre` is hovered. A reader who does
not happen to sweep the mouse over a code block never learns the buttons exist, and a keyboard user
tabbing onto one sees nothing (opacity 0 hides the focus ring too). When revealed, the button is
low-contrast dim grey on the dark code background.
Severity: cosmetic/slows work. Evidence: computed style; ss_924279a36 (revealed on hover).

## F24. NOT VERIFIED (environment) — Guide Copy button feedback
A real click reached the button (I attached a capture listener: 1 hit) with
`clipboard-write` permission granted, but the label never changed to "Copied!" or "Copy failed".
Cause is this environment, not the app: `document.hidden === true` (the browser window is occluded
in this X session) and a direct probe showed `navigator.clipboard.writeText()` **never settling** —
neither resolve nor reject within 3 s. `copySnippet` (`tc-guide.ts:359-379`) awaits that promise
with no timeout, so in that state the button gives no feedback at all, which is the one case its
own comment says it wants to avoid ("a reader who saw nothing happen would paste stale clipboard
content"). Worth a timeout, but I cannot claim it misbehaves in a normal browser.
