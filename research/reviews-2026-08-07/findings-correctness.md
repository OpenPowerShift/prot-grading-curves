# tc-curves — adversarial correctness findings (language + engine)

Probes are in this scratchpad dir only; the repo was not modified.

---

## F1 — VERIFIED — HIGH — Cross-level *curve* placement ignores the vector-group referral factor that the fault rule and the margin report both apply

`faultCurrentAt()` (src/semantics/xvoltage.ts:88) multiplies the turns ratio by the
vector-group shape factor (2/sqrt3 phase-phase, 1/sqrt3 phase-earth across a delta-star).
The renderer applies the SAME factor to the FAULT RULE (src/renderer/svg.ts:858).
But an ELEMENT CURVE on another level is placed by the plain turns ratio only —
`placementFor` -> `{ factor: 1, V_source: element.voltage_kV }` and
`project() = I * (V_source / V_view_kV)` (svg.ts:1010-1011, 1873-1876).
`conditionPlacement` (svg.ts:1770) is the only path that would fix it and it returns
null for a `fault` (one level, one current).

Result: on a cross-voltage sheet the far-level element's curve stands 2/sqrt3 = 15.5%
(phase-phase) or sqrt3 = 73% (phase-earth) away from where the report evaluates it.

### Minimal repro (scratchpad/p3.ptc)

    system {
        voltages { "HV" { V = 33 kV; } "LV" { V = 11 kV; } }
        transformer "HV" to "LV" { vector_group = "Dyn11"; }
    }
    faults { "F2" { I = 1000 A; voltage = "LV"; type = two_phase; } }
    relay R_LV { voltage = "LV";
        element 50 { function = "phase_oc"; curve = definite; I_pickup = 1100 A; t_delay = 100 ms; } }
    relay R_HV { voltage = "HV";
        element 51 { function = "phase_oc"; curve = definite; I_pickup = 200 A; t_delay = 500 ms; } }
    grade { primary = R_LV:50; backup = R_HV:51; fault = "F2"; margin = 0.3 s; upstream = false; }
    view { voltage = "HV"; current_min = 10 A; current_max = 10 kA; }

    npx tsx src/cli.ts report  p3.ptc
    npx tsx src/cli.ts render  p3.ptc --svg -o p3.svg

### Produced vs expected

* Report: `seen by primary = 1000 A`, `t_primary = no-op` (1100 A pickup is above the
  fault), `overall: not evaluated`.
* Sheet (HV frame): fault rule at x=503.1 px, data-current="384.9" (=1000*11/33*2/sqrt3,
  factor applied). `R_LV:50` pickup knee drawn at x=497.7 px = 366.7 A (=1100*11/33,
  plain ratio). Axis scale 259.2 px/decade measured from the two knees.
* So the DRAWING shows the 1100 A element picking up BEFORE the fault (operating in
  100 ms) while the REPORT says it never operates. For agreement the knee must be at
  1100*11/33*2/sqrt3 = 423.4 A, i.e. to the RIGHT of the rule.
* With `type = single_phase_earth` the rule moves to 192.5 A while the curve stays at
  366.7 A — a sqrt3 disagreement.

### Aggravating: the caveat note misdescribes what was done, and can be switched off

Sheet note reads `• fault F2 placed by the LV-HV turns ratio. Zero sequence is blocked
between them...`. F2 was NOT placed by the turns ratio (it was ratio x 2/sqrt3), and
zero sequence is irrelevant to a phase-phase fault.

`noteReferralCaveat` only fires when zeroSequence == 'blocked' (svg.ts:706). Adding one
legitimate line — `system { zero_sequence { "HV" to "LV" = continuous; } }` — removes the
Notes section entirely while the 384.9 vs 366.7 disagreement stands. VERIFIED (p3b.ptc).

Severity: HIGH — wrong drawn margin on a cross-voltage sheet, optimistic direction.

---

## F2 — VERIFIED — MEDIUM — A fault whose component is zero on the sheet's quantity is dropped silently AND drags the current axis to 0

`resolveCurrent` returns `{value: 0}` (not null) for e.g. `3I0` of a `three_phase`
fault. The fault loop in src/renderer/svg.ts (~line 815-885) checks only
`if (resolved == null)`; there is no `> 0` guard before
`if (I_view * 0.8 < I_lo) I_lo = I_view * 0.8;`. The scenario loop right below
(svg.ts:960) DOES have that guard and pushes an `unmarkedScenarios` note.

### Repro (scratchpad/p5.ptc)

    system { voltages { "LV" { V = 11 kV; } } }
    faults {
      "F3"  { I = 6000 A; voltage = "LV"; type = three_phase; }
      "F1p" { I = 900 A;  voltage = "LV"; type = single_phase_earth; }
    }
    relay R { voltage = "LV";
        element 51G { function = "earth_fault"; curve = iec.si; I_pickup = 100 A; tms = 0.2; } }
    view { voltage = "LV"; quantity = 3I0; condition = "F1p"; }

    npx tsx src/cli.ts render p5.ptc --svg -o p5.svg

### Produced vs expected

* With `F3` present: current axis runs **10 mA -> 10 kA** (6 decades) for content that
  spans 100 A to 900 A. Curves squashed into the right-hand third.
* Delete the `F3` line: axis runs **10 A -> 100 kA**, the sensible fit. (VERIFIED, p5b.)
* `F3` appears nowhere — no rule, no legend entry, and **no Notes entry**, although the
  guide promises "Where a scenario cannot be marked, the legend says so rather than
  leaving it off quietly" and the code comment beside the null branch says the same for
  faults ("A fault silently absent from a sheet reads as one that was not relevant").

Severity: MEDIUM — no wrong number, but a distorted sheet and a silently dropped
condition; the reader cannot tell the three-phase fault was considered and discarded.

---

## F3 — VERIFIED — HIGH — The range sweep and the upstream sweep ignore each side's `measures`: they feed phase current to a sequence-measuring element

src/semantics/grades.ts, the interior-range loop (~line 838) and the upstream loop
(~line 905):

    for (const I_p of rangeSweep) {                    // rangeSweep is fault.min_A..max_A -- PHASE amps
      const I_b = I_p * backupRatio(study, fault, primary.voltage, backup.voltage);
      const t_p = primary.tAt(I_p);
      const t_b = backup.tAt(I_b);

`backupRatio` is a pure voltage/phase referral (`faultCurrentAt` twice). Neither loop
calls `sideCurrentAt`, so neither honours `measures`. The three declared rows
(`'I' | 'min' | 'max'`) DO go through `sideCurrentAt` and are correct — so the two
halves of one table are computed on different currents.

### F3a — self-contradictory report and a false FAIL (scratchpad/p7.ptc)

    system { voltages { "LV" { V = 11 kV; } } }
    faults { "F" { I = 900 A; I_min = 900 A; I_max = 1200 A; voltage = "LV"; type = single_phase_earth; } }
    relay R1 { voltage = "LV";
        element 51 { function = "phase_oc"; curve = iec.si; I_pickup = 100 A; tms = 0.1; } }
    relay R2 { voltage = "LV";
        element 46 { function = "neg_seq"; measures = "I2"; curve = iec.si; I_pickup = 50 A; tms = 0.6; } }
    grade { primary = R1:51; backup = R2:46; fault = "F"; margin = 1.5 s; upstream = false; }

    npx tsx src/cli.ts report p7.ptc

Output (verbatim):

    range check:
        I_f =     900 A  t_p = 0.312 s  t_b = 2.302 s  margin = 1.991 s  pass (300 A at backup)
        I_f =    1200 A  t_p = 0.275 s  t_b = 1.978 s  margin = 1.703 s  pass (400 A at backup)
    overall         : FAIL (worst 1.005 s at 1200 A) vs margin

Exit status 3. Every printed row passes; the overall verdict is FAIL, and the quoted
worst is **at the same 1200 A the table above says gives 1.703 s**. The 1.005 s row is
an interior row where R2:46 (an I2 element) was evaluated at the **phase** current
1200 A instead of its I2 of 400 A — a factor of 3 in the current.
Correct worst margin is 1.703 s -> PASS.

### F3b — a margin is reported for a pair the tool has just refused to grade (scratchpad/p8.ptc)

Same file, but the fault declares neither `type` nor `I2`:

    faults { "F" { I = 900 A; I_min = 900 A; I_max = 1200 A; voltage = "LV"; } }
    grade { primary = R1:51; backup = R2:46; fault = "F"; margin = 0.3 s; upstream = false; }

Output:

    overall : PASS (worst 1.005 s at 1200 A) vs margin
    [error] SEQUENCE_DATA_MISSING: R2:46 measures I2, but fault "F" declares no I2 and
            has no type to derive it from; this pair cannot be graded until it does

`--json` gives `"verdict": "pass", "worst_margin_s": 1.00525`.

The declared rows are correctly blocked, but the sweep rows are computed anyway from
the phase current — exactly the substitution docs/guide.adoc forbids: "No other quantity
is substituted -- a margin computed off the wrong current is a wrong number that looks
right."

Severity: HIGH — wrong verdict, wrong `worst_margin_s`, wrong CLI exit status, and a
report that contradicts its own printed table. Applies to every study whose grade has a
declared `I_min`/`I_max` range or a live upstream sweep and a non-`phase` element on
either side.

---

## F4 — VERIFIED — HIGH — `combine` evaluates sources on different voltage levels at the same numeric current (no referral), so the envelope contradicts its own source curves on the same sheet

src/semantics/combine.ts `sourceTimes()` maps every source through
`tTripElement(element, I_total)` with one `I_total`. Nothing consults
`element.voltage`. Individual element curves ARE referred by the turns ratio when
drawn, so the composite and its ingredients are drawn in different frames.
`validate.ts` checks combine sources for existence and chaining only — no
mixed-voltage diagnostic.

### Repro (scratchpad/p10.ptc)

    system { voltages { "HV" { V = 33 kV; } "LV" { V = 11 kV; } } }
    faults { "F" { I = 3000 A; voltage = "LV"; } }
    relay R_LV { voltage = "LV";
        element 51 { function = "phase_oc"; curve = definite; I_pickup = 600 A; t_delay = 200 ms; } }
    relay R_HV { voltage = "HV";
        element 51 { function = "phase_oc"; curve = definite; I_pickup = 600 A; t_delay = 50 ms; } }
    combine { name = "Bus OR"; sources = [R_LV:51, R_HV:51]; as = envelope_min; }
    view { voltage = "LV"; current_min = 100 A; current_max = 10 kA; }

    npx tsx src/cli.ts check  p10.ptc     # "no errors"
    npx tsx src/cli.ts render p10.ptc --svg -o p10.svg

### Produced vs expected (SVG path knees, LV-frame sheet, 389 px/decade)

| curve      | knee x | current implied | time    |
|------------|--------|-----------------|---------|
| R_LV:51    | 394.7  | 600 A           | 200 ms  |
| R_HV:51    | 580.3  | 1800 A (600 A HV x 33/11 — correct) | 50 ms |
| Bus OR     | 395.4  | 600 A           | **50 ms** |

The envelope claims 50 ms clearance from 600 A LV upward, but its own `R_HV:51`
source — drawn on the same sheet — does not pick up until 1800 A LV. Expected:
Bus OR = 200 ms from 600 A, stepping to 50 ms at 1800 A.

Factor-of-3 error (the turns ratio), no diagnostic. Severity: HIGH for any
multi-voltage study using `combine`; the envelope is exactly the line an engineer
reads as "what the bus does".

---

## F5 — VERIFIED — MEDIUM/HIGH — Two `solve` blocks on one backup: the first grade's report keeps a stale TMS, and the legend's "was" figure is another solver's output rather than the declared setting

`reportGrade` mutates the shared model (`result.stage.tms = result.tms`, grades.ts
~1065) and only recomputes *its own* rows. `reportGrades` runs the blocks in source
order, so a later solve on the same backup silently invalidates every earlier report
that used it. `tms_declared` is also overwritten by the second pass, losing the
author's figure.

### Repro (scratchpad/p11.ptc)

    system { voltages { "LV" { V = 11 kV; } } }
    faults { "Fa" { I = 3000 A; voltage = "LV"; } }
    relay R1 { voltage = "LV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=100 A; tms=0.10; } }
    relay R2 { voltage = "LV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=200 A; tms=0.20; } }
    relay R3 { voltage = "LV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=300 A; tms=0.45; } }
    grade { primary=R1:51; backup=R3:51; fault="Fa"; margin_target=0.30 s; upstream=false;
            solve { strategy="tight"; free=[tms]; } }
    grade { primary=R2:51; backup=R3:51; fault="Fa"; margin_target=1.20 s; upstream=false;
            solve { strategy="tight"; free=[tms]; } }

    npx tsx src/cli.ts report p11.ptc
    npx tsx src/cli.ts render p11.ptc --svg -o p11.svg

### Produced vs expected

* Grade 1 report: `t_backup_auto = 0.505 s (TMS_b = 0.170)`, `achieved margin = 0.306 s`,
  `PASS`.
* Grade 2 report: `TMS_b = 0.575`, and the drawing (legend) reads
  **`TMS 0.575 (auto, was 0.17)`**.
* So R3:51 is drawn and asserted at 0.575, but grade 1's block still quotes 0.170 and a
  0.306 s margin. At 0.575 the true grade-1 margin is 1.708 - 0.199 = **1.509 s**.
  One element, two TMS values in one report; the engineer sets from the drawing.
* The `was` figure is wrong twice over: the file declares **0.45**, not 0.17. The second
  `SOLVE_OVERRODE_SETTING` warning says "solve replaced the declared tms 0.17", naming a
  value that appears nowhere in the source.

Severity: MEDIUM/HIGH — the numbers someone acts on (dial setting, margin) disagree
inside one run, and there is no diagnostic that two solves touched one element.

---

## F6 — VERIFIED — HIGH — The drawn CTI arrow uses the plain turns ratio while the report uses the vector-group factor: the sheet prints 326 ms where the report prints 194 ms and FAIL

Same root cause family as F1 but a different, directly-readable wrong number.
`annotationCurrent` / `conditionCurrentAt` (src/renderer/svg.ts:1447-1465, 1524-1527)
refer a condition to a side's level with `resolved.value * (fromKv / levelKv)` only.
No `transformerReferral`. The fault *rule* on the same sheet does apply it (svg.ts:858).

### Repro (scratchpad/p13.ptc)

    system {
        voltages { "HV" { V = 33 kV; } "LV" { V = 11 kV; } }
        transformer "HV" to "LV" { vector_group = "Dyn11"; }
    }
    faults { "F" { I = 6400 A; voltage = "LV"; type = two_phase; } }
    relay R_FDR { voltage = "LV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=480 A; tms=0.30; } }
    relay R_INC { voltage = "HV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=720 A; tms=0.175; } }
    grade    { primary=R_FDR:51; backup=R_INC:51; fault="F"; margin=0.3 s; upstream=false; }
    annotate { primary=R_FDR:51; backup=R_INC:51; fault="F"; label="CTI"; }
    view { voltage = "HV"; }

    npx tsx src/cli.ts report p13.ptc
    npx tsx src/cli.ts render p13.ptc --svg -o p13.svg

### Produced vs expected

* Report: `seen by backup = 2463 A`, `t_backup = 0.984 s`,
  `achieved margin = 0.194 s -- FAIL`, `overall: FAIL`.
* Sheet: the CTI arrow is drawn at **x = 545.0 px** and labelled **"CTI 326 ms"**.
  Axis calibration from the tick labels: 194.5 px/decade, `1 kA` at x = 481.0, so
  x = 545.0 = **2133 A** (= 6400 x 11/33, the bare ratio).
  The fault rule `F` for the same condition stands at **x = 557.2 = 2464 A**.
* So one sheet carries two marks for one condition 15.5 % apart, and the CTI caption
  (326 ms) is the margin at 2133 A while the report's is 194 ms at 2463 A.
* Control: with `type` removed (balanced) the same file gives `achieved margin = 0.326 s`
  and `CTI 326 ms` — agreement. So the divergence is exactly the vector-group factor.

Severity: HIGH — the drawing says PASS-looking 326 ms; the report says FAIL at 194 ms.
The CTI on the drawing is the number that ends up in the report pack.

---

### F3c — VERIFIED — HIGH — the upstream sweep also runs after `REFERRAL_NEEDS_CONNECTION`, producing PASS for a pair the tool has refused to grade

    system {
        voltages { "HV" { V = 33 kV; } "LV" { V = 11 kV; } }
        transformer "HV" to "LV" { vector_group = "Dyn11"; }
    }
    faults {
      "F2e"  { I = 1000 A; voltage = "LV"; type = two_phase_earth; }
      "Fmax" { I = 4000 A; voltage = "LV"; type = three_phase; }
    }
    relay R_LV { voltage="LV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=100 A; tms=0.1; } }
    relay R_HV { voltage="HV"; element 51 { function="phase_oc"; curve=iec.si; I_pickup=100 A; tms=0.3; } }
    grade { primary=R_LV:51; backup=R_HV:51; fault="F2e"; margin=0.3 s; }

Output:

    upstream sweep  : to 4000 A (48 points)
        tightest at I_f = 4000 A  t_p = 0.183 s  t_b = 0.790 s  margin = 0.607 s  pass
    overall         : PASS (worst 0.607 s at 4000 A) vs margin
    [error] REFERRAL_NEEDS_CONNECTION: ... a two-phase-earth fault splits by zero-sequence
            impedance, which this study does not carry

`--json` -> `"verdict": "pass", "worst_margin_s": 0.607063`.

`backupRatio()` calls `faultCurrentAt()` and reads only `.I_A`, discarding
`.referralIssue` — so the sweep uses precisely the unadjusted turns ratio the refusal
exists to prevent (xvoltage.ts comment: "A refusal is not applied here -- the caller
reports it ... because silently returning the unadjusted number is exactly the
behaviour being removed"). The sweep is that caller and it does exactly that.

---

## F7 — VERIFIED — MEDIUM — The documented `I0` / `residual` consistency check is implemented for `scenario` levels but not for `faults`

docs/guide.adoc (faults section): "`I0` is the component `I0`; `residual` is the
residual `3*I0` stated directly. Declare either -- the processor derives the other,
**and errors if you declare both inconsistently**."

src/semantics/validate.ts:529 implements exactly that check — but inside the
*scenario* loop only. There is no equivalent in the fault loop.

### Repro (scratchpad/p19.ptc)

    system { voltages { "LV" { V = 11 kV; } } }
    faults { "F" { I = 3000 A; I0 = 800 A; residual = 1000 A; voltage = "LV"; } }
    relay R  { voltage="LV"; element 51G { function="earth_fault"; curve=definite; I_pickup=100 A; t_delay=200 ms; } }
    relay R2 { voltage="LV"; element 51  { function="phase_oc";    curve=definite; I_pickup=100 A; t_delay=1 s; } }
    grade { primary=R:51G; backup=R2:51; fault="F"; margin=0.3 s; upstream=false; }

    npx tsx src/cli.ts check p19.ptc     # no error about I0/residual

`I0 = 800 A` implies a residual of 2400 A; `residual = 1000 A` was declared. The tool
takes 1000 A silently (`currentFor('3I0')` prefers `residual`) and reports
`seen by primary = 1000 A`. Expected: the same `SEQUENCE_INCONSISTENT`-style error the
scenario path raises. A 2.4x error in the earth-fault current, from a plausible
transcription slip, with no diagnostic.

Severity: MEDIUM (documented guard simply absent on one of the two condition kinds).

---

## F8 — VERIFIED — HIGH — Current share is applied twice: `element { share }` and `scenario { sees R { share } }` compound. Affects shipped example 15.

Two independent share mechanisms multiply:

* `element { share = 50; }` -> `stage.current_pct`, applied inside `tTripStage`
  (`const I = I_total * (stage.current_pct / 100)`, curves.ts).
* `scenario { sees R_A { share = 50; } }` -> `scenario.shares`, applied in
  `sideCurrentInScenario` (`return { I_A: declared * share }`, grades.ts:~490).

Nothing reconciles them, and `multipleOf()` applies `current_pct` again on top of the
already-shared current, so the report's `I_f` column and its `M` column disagree.

### Shipped example (no probe file needed)

    npx tsx src/cli.ts report examples/15-parallel-feeders.ptc

    grade R_FDR_A:51 / R_SRC:51:
        fault           = BOTH_CIRCUITS_IN (I_f = 3600 A)
        seen by primary = 3600 A ...
        t_primary       = 2.037 s        (M = 3.75)

`R_FDR_A:51` has `I_pickup = 480 A`. 3600 / 480 = **7.5**, not 3.75. The printed
multiple (and the operate time) correspond to 1800 A — the 7.2 kA level current halved
by the scenario share *and again* by the element's own `share = 50`.

The second grade is worse: scenario `ONE_CIRCUIT_OUT` declares
`sees R_FDR_A { share = 100; }` ("B out for maintenance; A carries the lot") at 6.4 kA,
yet the report prints `M = 6.67` = 3200/480. The scenario's explicit 100 % is silently
halved by the element field, defeating the point of the scenario.

### Minimal repro + sheet/report contradiction (scratchpad/p21.ptc)

    system { voltages { "HV" { V = 33 kV; } } }
    scenario S {
      name = "Both in"; type = three_phase;
      level HV { I = 4000 A; I1 = 4000 A; I2 = 0 A; I0 = 0 A; }
      sees R_A { share = 50; }
    }
    relay R_A { voltage = HV;
      element 51 { function="phase_oc"; curve=definite; I_pickup=1500 A; t_delay=100 ms; share=50; } }
    relay R_B { voltage = HV;
      element 51 { function="phase_oc"; curve=definite; I_pickup=100 A;  t_delay=1 s; } }
    grade { primary=R_A:51; backup=R_B:51; scenario="S"; margin=0.3 s; }

* Report: `seen by primary = 2000 A`, `t_primary = no-op`, `overall: not evaluated`.
  A 1500 A definite pickup at a stated 2000 A **must** operate; the report contradicts
  itself in adjacent lines because the current was quietly reduced to 1000 A.
* Sheet: the `R_A:51` curve knee is at x = 574.4 px = **3021 A** (axis: `1 kA` at
  x = 481.0, 194.5 px/decade) and the scenario rule stands at **4000 A** — so the
  drawing plainly shows R_A operating for this scenario while the report says it does
  not.
* Deleting `share = 50;` from the element gives `M = 2.00` (correct) in the control run.

Severity: HIGH — factor-of-two error in the current a relay is graded at, in the
optimistic-for-the-primary direction, present in a shipped example that documents the
feature.

---

## F9 — VERIFIED — LOW — A component-only range (`I2_min`/`I2_max`) gets its endpoints but no interior sweep

`rangeSweep` is built only from `fault.min_A` / `fault.max_A` (phase). A fault declaring
`I2_min = 200 A; I2_max = 500 A` and no phase range yields exactly three rows
(300 / 200 / 500 A), so the interior 200-500 A band is never walked — the very thing the
code comment beside `RANGE_SAMPLES` says three points cannot tell you
("a fuse and a relay that grade at 200 A and at 1.2 kA can be five seconds the wrong way
round at 300 A"). Verified with scratchpad/p22.ptc.

(If the phase range *is* also declared, the interior rows appear but are wrong — see F3.)

---

## Areas probed and found CLEAN

* **Vector-group referral maths itself** — `2/sqrt3` for phase-phase and `1/sqrt3` for
  phase-earth across a delta-star reproduce exactly (1000 A at LV -> 385 A / 192 A at HV
  through 33/11 kV Dyn11). Refusals fire correctly and with good messages for
  `two_phase_earth`, for a fault on the delta side, and for no transformer declared.
  (p1*.ptc)
* **Multi-stage composite + `I_cutoff`** — a stage cutoff makes the composite step *back*
  onto the surviving stage, and the drawn path does the same: transitions at 200 A,
  1000 A, back at 2050 A, ending at 8003 A for `I_cutoff = 8 kA`. Report and sheet agree.
  (p14.ptc)
* **Stage-reference grading** — `R1:50/main`, `R1:50/energ` and the composite `R1:50`
  give 0.400 / 0.050 / 0.050 s exactly as expected. (p23.ptc)
* **Quantity conversion onto a component axis** — on `quantity = I2; condition = "F2p"`
  (two_phase), a 390 A phase element is drawn at 225.2 A = 390 x 0.577, coincident with
  the fault rule at 225.17 A, and the legend says `x0.577`. (p15.ptc)
* **`combine` operators** (single-voltage) — envelope_min / envelope_max / sum /
  select_first all reproduce exactly, including `envelope_max` and `sum` correctly
  refusing to start until *both* sources operate. (p25.ptc)
* **Current-margin annotations** — `at_t` percentages match the guide's published
  figures to the digit: `min 2ph 152.9%`, `inrush 120.3%`, symmetric `AB`/`BA 235.3%`,
  `band 300 ms`, `window 266.7%`. (p24.ptc)
* **Fuse grading across a transformer** — total-clear as primary, min-melt as backup,
  fuse referred to its own winding; log-log interpolation matches hand calc
  (0.1417 s at 900 A). (p16/p17.ptc)
* **Degenerate scalars** — zero / negative kV, current, pickup and tms all produce
  precise, separate errors (`FAULT_CURRENT_INVALID`, `VOLTAGE_LEVEL_INVALID`,
  `PICKUP_NOT_POSITIVE`, `TMS_OUT_OF_RANGE`, `GRADE_SELF_PAIR`). Equal `I_min`/`I_max`
  and a pickup above every fault give `not evaluated`, not a fake pass. Non-ASCII
  identifiers are rejected with clear lexical errors (non-ASCII *strings* are fine).
  (d1/d2/d4/d5.ptc)
* **CLI baseline** — all 19 `examples/*.ptc` `check` clean except `07-upstream-
  miscoordination.ptc`, which exits 3 by design.
