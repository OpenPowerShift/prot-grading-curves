# Units-everywhere rename — working plan

Working document for an in-progress breaking change. Delete when done.

## Decisions (settled with the user, do not re-litigate)

- **No unit lives in a key name.** The user always writes the unit.
- Terse engineering names, because `voltage` is already a key meaning
  *which level* (`voltage = "HV"`), so it cannot also mean a magnitude.

| old | new | note |
|---|---|---|
| `I_A` | `I` | phase current |
| `I1_A` / `I2_A` / `I0_A` | `I1` / `I2` / `I0` | components |
| `earth_A` | `residual` | 3·I0 stated directly |
| `min_A` / `max_A` | `I_min` / `I_max` | fault range |
| `kV` | `V` | in `voltages { "HV" { V = 33 kV; } }` |
| `t_s` | `t` | point / times |
| `t_delay` | `t_delay` | unchanged, already unitless name |
| `CTI_min_s` | `margin` | value in `s` |
| `margin_s` | `margin_target` | avoid clashing with the above |
| `at_I_A` / `at_I1_A` … | `at_I` / `at_I1` / `at_I2` / `at_I0` / `at_residual` | annotate |
| `at_t_s` | `at_t` | annotate |
| `rating_A` / `rating_kV` / `rating_MVA` | `rating_I` / `rating_V` / `rating_S` | device |
| `I_pu` | `I_pickup` | `I_pu` reads as "per unit"; the value carries `A`/`pu`/`A_sec` |
| `I_base_A` | `I_base` | system |
| `base_MVA` | `base_S` | system |
| `current_pct` | `share` | value in `%` |
| `size_px`, `width_px`, `label_size_px`, … | keep | page cosmetics, px is the only unit |
| `margins_mm` | keep | ditto |
| `frequency_Hz` | **removed** | parsed, stored, read by nothing |
| `grounding` | **removed** | parsed, stored, read by nothing |

`base_MVA` → `base_S` is **kept** (not removed): used by
`validate.ts` `PICKUP_TOO_LOW_FOR_VOLTAGE`.

- **Hard break.** The parser recognises each old name and errors with
  `RENAMED_KEY`: `"I_A" was renamed to "I"; give the unit explicitly
  (I = 450 A)`. Better migration aid than silent acceptance.
- **Unknown keys warn**, so the plot still renders. Keep an *error*
  only where the key changes a number and a typo would silently move a
  result (the `tsm`-for-`tms` class); merely-inapplicable keys such as
  `upstream` inside an `annotate` warn.
- **Per-field unit checking** supersedes the union check in `107b9db`:
  each field declares which quantity it takes, and a suffix valid for
  another quantity (`I_pickup = 5 ms`) is refused too.

## Order of work

1. `units.ts`: a field→quantity table, exported, single source of truth.
2. `parser.ts`: new key names; `RENAMED_KEY` for every old one;
   per-field unit check at the point of parse; unknown-key warnings.
3. `ast.ts`, `model.ts`: field renames through the model.
4. Drop `frequency_Hz`, `grounding` everywhere.
5. `help-data.ts`: keys, values, and the missing hover entries
   (`grade > upstream` among them).
6. Examples (12), then `spec/sections/*.adoc`, then `docs/guide.adoc`.
7. Tests — expect wide but mechanical churn.
8. Hover panel on the right-hand side for named values (`iec.si`).
9. Broadsound file rewritten last, in the final syntax.

## Invariants

- `npx tsc --noEmit`, `npx eslint src/`, `npx vitest run`, both builds
  clean before each commit. Check exit status directly, never through
  a pipe into `tail`.
- Every example must parse and render with zero errors.

## Progress

Done:
- `units.ts`: `FIELD_QUANTITY`, `suffixesFor`, `suffixFits`.
- `parser.ts`: `RENAMED_KEYS`, `REMOVED_KEYS`, `noteUnknownKey`,
  per-field unit check in `parseNumberWithUnit`, KEYWORDS updated,
  case labels renamed, `frequency_Hz` / `grounding` parse arms removed.
- `ast.ts` / `model.ts` / `validate.ts`: `base_MVA` -> `base_S`, the
  two dead system fields gone.

Parser layer complete and verified:

| written | result |
|---|---|
| `I_pickup = 400 A` | ok |
| `I_pu = 400 A` | error RENAMED_KEY |
| `tsm = 0.1` | error UNKNOWN_SETTING (unknown anywhere -> a typo) |
| `I_pickup = 5 ms` | error UNIT_WRONG_QUANTITY |
| `I_pickup = 4 KA` | error UNIT_WRONG_QUANTITY |
| `upstream` in an element | warning UNKNOWN_KEY (known elsewhere -> misplaced) |
| `kV = 33` | error RENAMED_KEY |
| `frequency_Hz = 50` | error REMOVED_KEY |

The misplaced-vs-mistyped rule: a word `KEYWORDS` knows is in the wrong
block and warns; a word it does not know anywhere is a typo and, in a
block whose every field changes a number, errors.

Next, in order:
1. AST/model internal field names (`I_A` -> `I` etc.) through
   `model.ts`, `grades.ts`, `svg.ts`, `condition.ts`, `quantity.ts`.
4. Examples (12), spec, guide.
5. Tests: ~202 currently red, all from the old syntax. Mechanical.
6. Hover panel; Broadsound last.
