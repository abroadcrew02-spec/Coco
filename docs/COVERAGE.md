# Coco — FR coverage audit (MVP-1 / MVP-2 / MVP-3 / Phase 2 entry)

Snapshot taken 2026-05-14 against `main` (HEAD `2f25f34`).
Supersedes the older `docs/MVP1_AUDIT.md` (covered only §4.1).
Verdict legend:

- OK — implemented and acceptance criterion plausibly met
- PARTIAL — round-trip works but live UX is reduced (e.g. authoring only via snapshot, no live highlight), or known caveat
- MISSING — no implementation found

## §4.1 MVP-1: ワークブック作成・編集・保存

| ID     | Verdict | Notes |
| ------ | ------- | ----- |
| FR-001 | OK      | `useWorkbookStore.newWorkbook` → `workbook_new`; EditorScreen renders empty `Sheet1` (1000 × 100) when no snapshot. |
| FR-002 | OK      | Cell input/edit/delete via `UniverSheetsUIPlugin` (editor + clear-selection commands); round-trip covered by xlsx_io. |
| FR-003 | OK      | `UniverFormulaEnginePlugin` + `UniverSheetsFormulaPlugin` + `UniverSheetsFormulaUIPlugin`. P0 round-trip test suite at `src-tauri/tests/xlsx_p0_formulas.rs` (H4); P1 set at `xlsx_p1_formulas.rs` (I2). |
| FR-004 | OK      | Sheet add / delete / rename / reorder via Univer footer tabs; xlsx_io preserves `sheetOrder`. Tab color via `SheetTabColorDialog` (J2). |
| FR-005 | OK      | Per-cell number formats, borders, fonts, fills round-trip via xlsx_io; Univer toolbar surfaces editing. `NumberFormatDialog` (Ctrl+1, G2) for direct edit. |
| FR-006 | OK      | Merge via `add-worksheet-merge.command`; frozen panes round-trip (`c561abd`); both preserved in snapshot. |
| FR-007 | OK      | Univer clipboard service: Ctrl+C / Ctrl+X / Ctrl+V plus paste-special (values / formats / values+formats). |
| FR-008 | OK      | `AutoFillController` in `UniverSheetsUIPlugin` — drag fill handle for numeric / date series and copy-down. |
| FR-009 | OK      | Filter via `UniverSheetsFilterPlugin` (I1, registered in `EditorScreen.tsx`); sort via toolbar `SortDialog` (H1) writing reordered rows into snapshot. Round-trip preserved by xlsx_io (`74594d0`). |
| FR-010 | OK      | `UniverFindReplacePlugin` + `UniverSheetsFindReplacePlugin` (`852ac45`); Ctrl+F / Ctrl+H. |
| FR-011 | OK      | `CappedUndoRedoService` overrides Univer's default `LocalUndoRedoService` (cap 20 → 100). Registered via `override: undoRedoOverride` in Univer ctor. Unit-tested (H2). |
| FR-012 | OK      | `promptSaveAs` offers xlsx (default) and `.coco` filters; routes to `workbook_export_xlsx` or `workbook_save_as`. Auto-save via `useAutoSave`. Atomic save with `PRAGMA integrity_check` + `.bak.1..5` rotation. |
| FR-013 | OK      | `HomeScreen` recents (≤ 10 from backend); each row has "見つかりません" badge when `!f.exists`; × button → `removeRecent`. |
| FR-014 | OK      | xlsx_io emits `XLSM_MACROS_DISCARDED` warning; `App.tsx` shows `XlsmMacroLossDialog` once per workbook + banner. |

§4.1 totals: 14 OK / 0 PARTIAL / 0 MISSING.

## §4.2 MVP-2: xlsx インポート

| ID     | Verdict | Notes |
| ------ | ------- | ----- |
| FR-101 | OK      | `workbook_import_xlsx` in `xlsx_io.rs`; Excel 2016+ / Google Sheets representative-file corpus exercised by `xlsx_p0_compat.rs` (10 fixtures, E3). |
| FR-102 | OK      | `currentHandle.path` preserves source xlsx path; Ctrl+S overwrites via `workbook_export_xlsx` with `rotate_backups` (`.bak.1..5`) — `backup_rotation.rs` covers rotation. |
| FR-103 | OK      | `detect_unsupported_features` + import path emit `CompatibilityWarning[]`; `CompatibilityWarningsDialog` lists them; banner shows top 3 + 詳細. |
| FR-104 | OK      | `security_scan_xlsx` in `commands/security.rs`: 50 MB input cap, 300 MB inflated cap, 2,000 entries, 50 MB per-XML cap, sheet 100/200 warn/block. Blocking surfaces via `SecurityBlockDialog`. Row/column/formula caps explicitly marked Phase 2 (informational warning included). |
| FR-105 | OK      | `xlsx_p0_compat.rs` round-trips 10 representative fixtures verifying values, formulas, cached results, formats, merges, sheet order. |

§4.2 totals: 5 OK / 0 PARTIAL / 0 MISSING. (FR-104 row/col/formula caps remain Phase 2 follow-up.)

## §4.3 MVP-3: xlsx エクスポート

| ID     | Verdict | Notes |
| ------ | ------- | ----- |
| FR-201 | OK      | `exportXlsx` action prompts for path; for `.coco`-backed workbooks the working path stays `.coco` (`saveAs` only mutates `currentHandle.path` on save-as, not on export). |
| FR-202 | OK      | `workbook_export_xlsx` via rust_xlsxwriter; P0 features round-trip per `xlsx_roundtrip.rs`, `xlsx_atomic_export.rs`, plus per-feature suites (chart preservation, hyperlinks, comments, images, CF, DV, pivots, etc.). |
| FR-203 | OK      | `export_xlsx_core` collects warnings (e.g. discarded features); `exportWarnings` flows through store, surfaced via export-side `CompatibilityWarningsDialog` + banner. |
| FR-204 | OK      | Atomic-export path writes to temp + renames; on failure `SaveFailureDialog` offers retry or `promptSaveAs`. `.coco` is untouched on export. |

§4.3 totals: 4 OK / 0 PARTIAL / 0 MISSING.

## §4.7 CSV エクスポート

| ID     | Verdict | Notes |
| ------ | ------- | ----- |
| FR-301 | OK      | `workbook_export_csv` writes UTF-8 BOM by default (`utf8_bom` encoding option); Shift_JIS available for legacy. Round-trip tests in `csv_export.rs`. |
| FR-302 | OK      | `SheetPickerModal` invoked in `EditorScreen.handleCsvExport` when sheet count > 1; single-sheet path skips the dialog. |
| FR-303 | OK      | CSV emission honors `_fmt` per cell (表示値ベース): date / datetime via `format_date_or_datetime` (token substitution `yyyy/yy/mm/m/dd/d/hh/h/mm/m/ss/s`, US-style `m/d/yyyy` supported), time-only `hh:mm:ss`, percent `0%` / `0.00%`, currency `$#,##0.00` / `¥#,##0` (locale-tagged `[$X-409]` symbol detected), `@` text format. Cached formula values used over formula text. |
| FR-304 | OK      | `needs_injection_guard` in `csv_io.rs` prefixes `=`, `+`, `-`, `@` cells with `'`. Test coverage in `csv_export.rs`. |

§4.7 totals: 4 OK / 0 PARTIAL / 0 MISSING.

## Phase 2 オーサリング UI

Each entry below has a toolbar entry point.
"snapshot" means authoring writes into the snapshot's underscore-prefixed
field (round-trips through xlsx) but live in-grid rendering is deferred.
"live" means the change is also visible immediately in the running workbook.

| Feature              | Component                       | Status        | Notes |
| -------------------- | ------------------------------- | ------------- | ----- |
| Conditional Format   | `ConditionalFormattingDialog`   | PARTIAL (snapshot-only) | Authoring + edit-in-place (J4); live highlight deferred (Univer CF model differs). Round-trip extended to top10 + duplicate/unique rules (D3). |
| Data Validation      | `DataValidationDialog`          | OK (live)     | Authoring (F2) + edit-in-place (J4) + live enforcement via `validateMutation` `onBeforeCommandExecute` guard (J1). Round-trip B2. |
| Hyperlink            | `InsertHyperlinkDialog`         | PARTIAL (snapshot-only) | Ctrl+K. Appends to `_hyperlinks[]`; round-trip preserved (`a754503`). |
| Comment              | `InsertCommentDialog`           | PARTIAL (snapshot-only) | Shift+F2. Author preserved (D2). |
| Chart                | `InsertChartDialog`             | PARTIAL (snapshot-only) | Appends to `_charts[]`; chart parts preserved byte-for-byte on export (`f221672`). |
| Number Format        | `NumberFormatDialog`            | OK (live)     | Ctrl+1. Sets `_fmt` on each cell in selection; format applies on next render via Univer style pipeline. |
| Image                | `InsertImageDialog`             | PARTIAL (snapshot-only) | Anchors into `_preservedParts`; media bytes round-tripped (E1). |
| Sort                 | `SortDialog`                    | OK (live)     | Sorts cellData rows in place; takes effect on next snapshot sync. |
| Sheet Tab Color      | `SheetTabColorDialog`           | OK (live)     | Writes `_tabColor`; round-trip D6. |
| Named Ranges         | `NamedRangesDialog`             | OK (live)     | Ctrl+F3. Uses Univer's `insertDefinedName` / `deleteDefinedName` facade — live + round-tripped. |
| Sheet Protection     | toolbar toggle                  | OK (live)     | Toggle button + live enforcement via `onBeforeCommandExecute` block (I3). Round-trip G3. |

Phase 2 dialog count: **10 dialogs** (CF, DV, Hyperlink, Comment, Chart, NumberFormat, Image, Sort, TabColor, NamedRanges) + 1 toolbar toggle (Sheet Protection). Six entries are fully live (DV, NumberFormat, Sort, TabColor, NamedRanges, Sheet Protection); five remain snapshot-only authoring (CF, Hyperlink, Comment, Chart, Image).

## Non-functional gates

| Section | Verdict | Notes |
| ------- | ------- | ----- |
| §5.1 Performance | PARTIAL (unverified) | `src-tauri/tests/perf.rs` exists but no benchmark harness ties the acceptance numbers (60 fps scroll, 8 s 5 MB import, etc.) to CI. Code paths look reasonable; needs measurement. |
| §5.2 Offline | OK | No outbound network calls in `src-tauri/src`; xlsx import/export, CSV, fonts all local. CI offline check not yet wired. |
| §5.3 Security | OK | `security_scan_xlsx` enforces §5.3.2 caps (50/300 MB, 2,000 entries, 100/200 sheets). VBA discarded, external links preserved as warnings + blob-only (E2). No cell values logged. Encryption (§5.3.4 DG-04) deferred. Audit log (§5.3.5) deferred. |
| §5.4 Save / recovery | OK | Atomic .coco save via tmp + rename + `PRAGMA integrity_check`; `.bak.1..5` rotation with 1 GB total cap (`enforce_backup_size_cap`); auto-save 30 s default via `useAutoSave` + recovery candidates surfaced in `HomeScreen`; end-to-end recovery test `recovery_flow.test.tsx` (I4). |
| §5.5 Compatibility | OK | Windows 10+ / macOS 12+ from Tauri's matrix. P0 elements covered by `xlsx_p0_compat.rs`. |
| §5.6 Distribution | PARTIAL | `npm run pack` stages a Tauri release into `./distbin/` (`7192bc9`); README + CHANGELOG + installer notes (`db737cb`). Code-signing / notarization not yet automated; SHA-256 emission not wired. |

## Known limitations / deferred

- **CF live highlighting** — authoring writes `_conditionalFormatting`; in-grid rendering deferred until a Univer dxf adapter is built.
- **Hyperlink / Comment / Chart / Image live rendering** — snapshots round-trip, but the active workbook surface does not re-render these between save+reopen.
- **Encryption (DG-04)** — `.coco` encryption (SQLCipher / SEE / app-layer) not implemented; required only if data classification A/B is confirmed.
- **Audit log (§5.3.5)** — local audit log not implemented.
- **Performance benchmark harness** — `perf.rs` exists but no acceptance-number gate is wired into CI.
- **Code signing / notarization / SHA-256 in distribution** — packager exists but signing steps are not automated.
- **CSV exotic format codes** — date / datetime / time-only / percent / currency (`$`, `¥`, `€`, `£`) and `@` text are honored on export; locale-tagged currency `[$X-409]` parses the symbol. Exponential (`0.0E+00`), fraction (`??/??`), elapsed-time (`[h]:mm`), and multi-letter month names (`mmm`, `mmmm`) still fall through to plain numeric.

## What changed since the prior audit (`MVP1_AUDIT.md`)

- FR-009 closed: `UniverSheetsFilterPlugin` registered (I1, `3d36451`); `SortDialog` shipped (H1, `0dee307`).
- FR-011 closed: `CappedUndoRedoService` lifts cap to 100 (H2, `64dc786`).
- Phase 2 authoring dialogs added: CF, DV, Hyperlink, Comment, Chart, NumberFormat, Image, Sort, TabColor, NamedRanges.
- Live enforcement: sheet protection (I3), data validation (J1).
- Distribution: `npm run pack` (`7192bc9`) + README/CHANGELOG/dist notes (`db737cb`).

## Totals

- §4.1 / §4.2 / §4.3 / §4.7 combined: **27 FR-IDs — 27 OK / 0 PARTIAL / 0 MISSING**.
- Phase 2 authoring: **10 dialogs + 1 toolbar toggle**; 6 live, 5 snapshot-only.
- Non-functional: 4 OK / 2 PARTIAL (Performance, Distribution) / 0 MISSING.
- Biggest remaining gap: in-grid live rendering for CF / Hyperlink / Comment / Chart / Image (round-trip is solid, UX is reduced).
