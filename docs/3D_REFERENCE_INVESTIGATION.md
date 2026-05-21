# 3D reference investigation (issue #175)

`=SUM(Sheet1:Sheet3!A1)` — Excel-style 3D references that span the same
range across a contiguous run of sheets.

Date: 2026-05-21. Univer: 0.5.x (`@univerjs/engine-formula`).

## Verdict

**Evaluation: not supported (Univer 0.5.x limitation). Text preservation: supported and tested.**

Coco preserves 3D-reference formula *text* losslessly through xlsx
import/export, but Univer's formula engine cannot *evaluate* a 3D reference —
it resolves to `#REF!`/empty. This is a Univer engine limitation, not a Coco
bug, and `patch-package`-ing the engine to add sheet-range expansion was
judged too risky (touches the core lexer + reference-resolution path).

## Univer formula engine findings

All offsets below are into `node_modules/@univerjs/engine-formula/lib/es/index.js`.

### 1. The lexer *accepts* `Sheet1:Sheet3!A1` as a single reference token

The reference regex is assembled around offset 5827:

```
cc = "((?![\[\]\/?*\\]).)*!"      // sheet-name segment: any char not in []/?*\ , then "!"
Rr = `'?(${Yi})?(${cc})?'?`        // optional [workbook] + optional "sheetname!"
```

The `:` colon is **not** in the sheet-name exclusion class `[[\]/?*\\]`, so
`Sheet1:Sheet3!` matches the sheet-name segment `cc` by accident. Confirmed:

- `isReferenceString("Sheet1:Sheet3!A1")` → `true`
- `LexerTreeBuilder.sequenceNodesBuilder("=SUM(Sheet1:Sheet3!A1)")` →
  `["SUM", "(", "Sheet1:Sheet3!A1", ")"]` — one REFERENCE node (nodeType 4).

A multi-cell 3D range is **mis-tokenized**, however:

- `sequenceNodesBuilder("=SUM(Sheet1:Sheet3!A1:B2)")` →
  `["SUM", "(", "Sheet1:Sheet3!A1", ":", "B2", ")"]` — the `A1:B2` range is
  split because the first `:` was already consumed by the sheet name.

### 2. The reference is resolved as a *literal* sheet name — no span expansion

`deserializeRangeWithSheet("Sheet1:Sheet3!A1")` returns
`{ sheetName: "Sheet1:Sheet3", range: {A1} }` — the span endpoints are kept
as one opaque string, never split into start/end sheets.

Sheet resolution during evaluation goes through `getSheetBySheetName(name)`
(offset ~13224). With `name === "Sheet1:Sheet3"` no worksheet matches, so the
reference object resolves to nothing → the accumulator (`SUM`/`AVERAGE`/
`COUNT`) sees an empty/`#REF!` operand.

### 3. No 3D-reference machinery exists anywhere in the engine

A full-bundle search for every plausible identifier returned nothing:
`acrossSheets`, `sheetRange`, `startSheet`, `endSheet`, `fromSheet`,
`toSheet`, `3-d`, `3d reference` — all absent. There is no code path that
expands a sheet span into a list of sheets and accumulates across them.

### Formula-bar / UI behavior

The renderer uses Univer's stock `UniverFormulaEnginePlugin` +
`UniverSheetsFormulaPlugin` + `UniverSheetsFormulaUIPlugin`
(`src/components/EditorScreen.tsx`). Typing `=SUM(Sheet1:Sheet3!A1)` into the
formula bar is *accepted* (no syntax error — the lexer tolerates it per
finding 1), but the cell shows `#REF!`/empty because resolution fails per
finding 2. Coco adds no custom formula wiring, so there is nothing on the
Coco side to change.

## xlsx I/O findings

`src-tauri/src/commands/xlsx_io.rs` treats cell formulas as opaque strings:

- **Import** (`import_xlsx_core`, ~line 4422): calamine's `worksheet_formula`
  yields the formula text, stored verbatim into `cell["f"]` (with a leading
  `=` re-added if missing).
- **Export** (`export_xlsx_core`, ~line 5631): `cell["f"]` is written verbatim
  via `rust_xlsxwriter`'s `write_formula` / `write_formula_with_format`.

Neither side parses the formula, so a 3D reference round-trips losslessly as
text — the same guarantee as every other formula (`xlsx_p0_formulas.rs`,
`xlsx_p1_formulas.rs`).

## What was done

- Added `src-tauri/tests/xlsx_3d_reference.rs` — a round-trip test
  (import → export → re-import + on-disk calamine check) covering
  `SUM`/`AVERAGE`/`COUNT` with single-cell, multi-cell, and quoted-span 3D
  references. Asserts the `Sheet1:Sheet3` span and range survive verbatim.
- No engine patch. Sheet insert/delete *range-following* tests were **not**
  added: range-following only fires for references the engine actually
  models, and a 3D span is stored as an opaque literal sheet name, so there
  is nothing for the engine to follow. Wiring it would require the engine
  patch we explicitly ruled out.

## Acceptance-criteria disposition

| Criterion | Status |
|-|-|
| Univer lexer accepts `Sheet1:Sheet3!A1`? | Yes (incidental — `:` not excluded from sheet-name class). Logged above. |
| Formula-bar accept/error behavior | Accepted syntactically; evaluates to `#REF!`/empty. Logged above. |
| Univer-side PR / patch-package or wontfix | Wontfix for evaluation — Univer 0.5.x has no 3D machinery; patching the core lexer + resolver is too risky. |
| Sheet insert/delete range-following test | N/A — no engine model to follow; would require the rejected patch. |
| xlsx round-trip test | Added (`xlsx_3d_reference.rs`). |
