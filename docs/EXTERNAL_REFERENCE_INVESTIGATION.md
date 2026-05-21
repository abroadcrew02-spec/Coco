# External workbook reference investigation (issue #176)

`=[Other.xlsx]Sheet1!A1` — Excel-style references to a cell in a *different*
workbook. Split from #171.

Date: 2026-05-21. Univer: 0.5.x (`@univerjs/engine-formula`).

## Verdict

**Live evaluation: not supported (Coco is a single-workbook editor). Text +
cached-value preservation: supported and tested.**

Coco preserves an external-reference formula's *text* and its *cached value*
losslessly through xlsx import/export. It does **not** live-evaluate external
references, because Coco edits exactly one workbook per session — the
referenced book is never loaded as a second Univer unit, so there is no data
for the engine to read. This is an architectural constraint, not a Univer
limitation: the engine *could* resolve a cross-unit reference if the second
unit were registered (see below), but Coco's design never registers one.

The issue's premise — "同セッションで両方のブックを開いている" (both books open
in one session) — has no realization in Coco. Live evaluation is therefore
**wontfix**, the same disposition as #175 (3D references).

## Univer formula engine findings

All offsets below are into `node_modules/@univerjs/engine-formula/lib/es/index.js`.

### 1. The lexer *does* tokenize the `[Book]` workbook bracket

The reference regex assembled around offset 147 includes an explicit
workbook-bracket group:

```
Yi = '\\[([^\\[\\]\\/?:"<>|*\\\\]+)\\]'    // [BookName] — any non-special chars
Rr = `'?(${Yi})?(${cc})?'?`                 // optional [workbook] + optional sheetname!
```

`na()` (offset ~242) splits a reference string into `{ unitId, sheetName,
refBody }`, where `unitId` is the **verbatim bracket content** — the literal
string between `[` and `]` (`"1"`, `"Other.xlsx"`, …). There is no
name→real-unitId resolver layer.

### 2. The engine resolves cell data from `_unitData[unitId][sheetId]`

When a reference token carries a bracket, `setForcedUnitIdDirect(unitId)` is
called (offsets ~21248–21261). `getUnitId()` then returns the forced unit id,
and cell reads go through `_unitData[getUnitId()][getSheetId()]` (offset
~6432). So the engine **can** read a foreign unit's cells — *if* `_unitData`
contains an entry keyed by exactly that bracket string.

In a real xlsx the bracket is a numeric index (`[1]`, `[2]`) that points into
`<externalReferences>` in `workbook.xml`; resolving it to a loaded workbook
would require Coco to (a) open the referenced file, (b) register it as a
Univer unit, and (c) key `_unitData` by the same index. Coco does none of
these.

### 3. Coco is a single-workbook editor

`src/store/useWorkbookStore.ts` holds exactly one `currentHandle` +
`currentSnapshotJson`. Opening another file *replaces* that state (guarded by
the `openSeq` "newer wins" counter). `src/components/EditorScreen.tsx` makes a
single `univer.createUnit(UniverInstanceType.UNIVER_SHEET, …)` call
(`~line 6782`); there is no multi-unit / multi-tab surface. The whole codebase
reads the workbook via `fUniver.getActiveWorkbook()` (singular).

Consequently the precondition from finding 2 — a second unit registered in
`_unitData` — is structurally unreachable. Live cross-workbook evaluation
cannot happen without first making Coco a multi-workbook editor, which is far
outside #176's scope and conflicts with the local-first, single-document
product direction.

## xlsx I/O findings

`src-tauri/src/commands/xlsx_io.rs`.

### Structure preservation (already correct)

External-link parts were already preserved before #176:

- `xl/externalLinks/` is in `PRESERVED_PREFIXES`, so every external-link blob
  is base64-captured into the snapshot's `_preservedParts` (`parse_xlsx_preserved_parts`).
- `parse_xlsx_preserved_parts` also captures the workbook-level wiring:
  `workbookExternalLinkRels` (the `xl/_rels/workbook.xml.rels` entries whose
  `Type` ends in `/externalLink`) and `workbookExternalReferences` (the
  verbatim `<externalReferences>` block from `workbook.xml`).
- `inject_preserved_parts` splices all of that back on export, including
  rId-collision remapping (`resolve_ext_link_rid_remap`) so a preserved rId
  that clashes with a rust_xlsxwriter-emitted one is rewritten consistently in
  both the rels file and the `<externalReference r:id="…">` references.

### Formula text preservation (already correct)

`import_xlsx_core` (~line 4465) stores the formula verbatim into `cell["f"]`
(re-adding a leading `=` if missing). `export_xlsx_core` (~line 5631) writes
`cell["f"]` verbatim via rust_xlsxwriter's `write_formula`. No parsing happens,
so `=[1]Sheet1!A1` round-trips as text — the same guarantee as every other
formula.

### Cached-value preservation (gap found — fixed in #176)

On *import*, a formula cell gets `{ f, v, t?, s?, _fmt? }` — the cached value
from calamine is folded into `v` (~line 4476).

On *export*, the gap: rust_xlsxwriter's `write_formula` **does not write the
cached value**. It always stores `0` as the formula result and sets a global
"recalculate on open" flag (rust_xlsxwriter 0.77 `worksheet.rs:8507`). For a
normal formula this is harmless — Excel and Univer both recompute. But an
external reference **cannot** be recomputed by Univer (finding 3), so after a
Coco round-trip the cell would display `0` instead of the cached value,
breaking the closed-book fallback.

**Fix:** in the export formula path, when the formula is an external reference
(`formula_is_external_ref`), the imported cached value (`cached_formula_result`)
is re-emitted via `worksheet.set_formula_result(...)`. Normal formulas are
left untouched so Univer still recalculates them at render time.

`formula_is_external_ref` keys off the OOXML workbook bracket: a `[...]`
followed (after the `]`) by a sheet-name `!`. Structured table references
(`Table1[Column]`) have no sheet `!` and are correctly rejected.

## "Refresh" button — wontfix

The acceptance criteria flag a possible "refresh external links" button.
Per the issue's own local-first constraint, Coco does not fetch external
workbooks over the network or from disk on demand, and — being single-workbook
— has no in-session second book to refresh against. There is nothing for a
refresh button to do. **Wontfix**, as anticipated in the issue.

## What was done

- **Production fix** (`src-tauri/src/commands/xlsx_io.rs`): added
  `formula_is_external_ref` + `cached_formula_result`; the export formula path
  re-emits the cached value of external-reference cells via
  `set_formula_result` so the closed-book fallback survives xlsx round-trip.
- **Unit tests** (in-file `external_ref_tests` module): cover external-ref
  detection (numeric/named brackets, quoted sheet names, `SUM(...)` wrapping)
  and rejection of normal formulas, structured table references, and
  unbalanced brackets; plus cached-value stringification across number /
  string / bool / missing / null / empty.
- **Round-trip test** (`src-tauri/tests/xlsx_external_reference_formula.rs`):
  imports a fixture with an `=[1]Sheet1!A1` formula cell carrying a cached
  value, exports, re-imports, and asserts both the formula string and the
  cached value survive. Complements the existing
  `xlsx_external_link_preservation.rs` (blob/wiring preservation).
- No Univer engine patch. No multi-workbook support.

## Acceptance-criteria disposition

| Criterion | Status |
|-|-|
| `=[B.xlsx]Sheet1!A1` re-evaluates when both books are open | Wontfix — Coco is a single-workbook editor; the "both books open" state cannot exist. Univer *could* resolve a cross-unit ref, but Coco never registers a second unit. Logged above. |
| Closed book shows cached value, no error | Yes. Import folds the cached value into `cell.v`; the #176 fix keeps it through export so it survives the round-trip. |
| xlsx round-trip test | Added (`xlsx_external_reference_formula.rs`); blob/wiring already covered by `xlsx_external_link_preservation.rs`. |
| Refresh button | Wontfix — local-first constraint + no in-session second book. Logged above. |
