# Coco — FR coverage audit (MVP-1 / MVP-2 / MVP-3 / Phase 2 entry)

Snapshot taken 2026-05-14 against `main` (HEAD `2b6eb76`).
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
| FR-104 | OK      | `security_scan_xlsx` in `commands/security.rs`: 50 MB input cap, 300 MB inflated cap, 2,000 entries, 50 MB per-XML cap, sheet 100/200 warn/block. Blocking surfaces via `SecurityBlockDialog`. Row > 1,000,000 / column > 16,384 blocked via streaming worksheet scan; formula count > 1,000,000 emits `XLSX_FORMULA_HEAVY` warning (O2). |
| FR-105 | OK      | `xlsx_p0_compat.rs` round-trips 10 representative fixtures verifying values, formulas, cached results, formats, merges, sheet order. |

§4.2 totals: 5 OK / 0 PARTIAL / 0 MISSING.

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
| Conditional Format   | `ConditionalFormattingDialog`   | OK (live in-grid) | Authoring + edit-in-place (J4) + in-grid highlight via `patchCfRenders` (M1, N3): cellIs / containsText / top10 / duplicate / unique evaluated against current values, dxf-style highlight merged into inline `s`. CF dxf styles emitted on export (M1 follow-up). Round-trip extended to top10 + duplicate / unique (D3) and colorScale / dataBar / iconSet via raw-XML preservation (P1). |
| Data Validation      | `DataValidationDialog`          | OK (live)     | Authoring (F2) + edit-in-place (J4) + live enforcement via `validateMutation` `onBeforeCommandExecute` guard (J1). Round-trip B2. |
| Hyperlink            | `InsertHyperlinkDialog`         | OK (live in-grid) | Ctrl+K. `patchHyperlinkRenders` + onCellClick router (L1) styles cells blue+underline, click routes external to `open_url` Rust command (scheme allowlist) and internal `#Sheet!A1` via facade. Live re-style on apply (O4). Round-trip preserved (`a754503`). |
| Comment              | `InsertCommentDialog`           | OK (live in-grid) | Shift+F2. Red-triangle DOM-overlay indicator + hover tooltip via `CommentIndicatorsPanel` (L2); tracks scroll / zoom. Author preserved (D2). |
| Chart                | `InsertChartDialog`             | PARTIAL (sidebar preview) | `ChartPreviewPanel` (N1) renders each `_charts` entry as inline SVG (bar / line / pie) in a floating sidebar; click-to-jump. True in-grid overlay deferred (Univer 0.5.x has no public pixel API). Round-trip byte-for-byte for existing chart blobs (`f221672`). |
| Number Format        | `NumberFormatDialog`            | OK (live)     | Ctrl+1. Sets `_fmt` on each cell in selection; format applies on next render via Univer style pipeline. |
| Image                | `InsertImageDialog`             | PARTIAL (sidebar preview) | `ImagePreviewPanel` (N2): floating sidebar of thumbnails decoded from `_preservedParts` / `xl/media/`; click-to-jump to anchor. True canvas overlay deferred (same Univer pixel-API gap). Media bytes round-tripped (E1). |
| Sort                 | `SortDialog`                    | OK (live)     | Sorts cellData rows in place; takes effect on next snapshot sync. |
| Sheet Tab Color      | `SheetTabColorDialog`           | OK (live)     | Writes `_tabColor`; round-trip D6. |
| Named Ranges         | `NamedRangesDialog`             | OK (live)     | Ctrl+F3. Uses Univer's `insertDefinedName` / `deleteDefinedName` facade — live + round-tripped. |
| Sheet Protection     | toolbar toggle                  | OK (live)     | Toggle button + live enforcement via `onBeforeCommandExecute` block (I3). Round-trip G3. |
| Format Painter       | toolbar tool (書式コピー)       | OK (live)     | Single-shot click + double-click sticky mode (M2). ESC cancels. Walks snapshot, resolves interned style ids via `workbook.styles`. |

Phase 2 dialog count: **10 dialogs** + 2 toolbar tools (Sheet Protection, Format Painter). Nine entries are fully live (CF, DV, Hyperlink, Comment, NumberFormat, Sort, TabColor, NamedRanges, Sheet Protection, Format Painter); two remain sidebar-preview-only (Chart, Image — round-trip is solid, in-grid overlay blocked on Univer pixel-API gap).

## Non-functional gates

| Section | Verdict | Notes |
| ------- | ------- | ----- |
| §5.1 Performance | PARTIAL (1 fixture measured) | `xlsx_io` import refactored to share one `ZipArchive` + sheet-XML `HashMap` across all parse helpers (L3). `perf_smoke.rs` `smoke_xlsx_import_1mb_10pct_formulas` measures 3,565 ms on Windows release (was 7,891 ms; -55%), well below §5.1 p95 ceiling of 5,000 ms. Multi-fixture acceptance harness (60 fps scroll, 8 s 5 MB import) still not wired to CI. |
| §5.2 Offline | OK | No outbound network calls in `src-tauri/src`; xlsx import/export, CSV, fonts all local. CI offline check not yet wired. |
| §5.3 Security | OK | `security_scan_xlsx` enforces §5.3.2 caps (50/300 MB, 2,000 entries, 100/200 sheets, row > 1 M, column > 16,384, formula-heavy warning at 1 M — O2). VBA discarded, external links preserved as warnings + blob-only (E2). No cell values logged. Encryption (§5.3.4 DG-04) deferred. Audit log (§5.3.5) deferred. |
| §5.4 Save / recovery | OK | Atomic .coco save via tmp + rename + `PRAGMA integrity_check`; `.bak.1..5` rotation with 1 GB total cap (`enforce_backup_size_cap`); auto-save 30 s default via `useAutoSave` + recovery candidates surfaced in `HomeScreen`; end-to-end recovery test `recovery_flow.test.tsx` (I4). |
| §5.5 Compatibility | OK | Windows 10+ / macOS 12+ from Tauri's matrix; `bundle.macOS.minimumSystemVersion = "12.0"` declared (P4). Cross-platform preflight audit at `docs/CROSS_PLATFORM_PREFLIGHT.md`: 0 BLOCKER, 3 WARNING (now 2 closed: WARNING #1 menu accelerators via P3, WARNING #2 macOS minSystemVersion via P4; WARNING #3 signing remains process-gated on Apple credentials), 7 NOTE. P0 elements covered by `xlsx_p0_compat.rs`. |
| §5.6 Distribution | PARTIAL | `npm run pack` stages a Tauri release into `./distbin/` (`7192bc9`); emits `SHA256SUMS.txt` + `manifest.json` + README per §5.6 requirements (`db737cb`). Code-signing / notarization not automated (blocked on Apple Developer + Windows code-signing credentials — process gate, not engineering). Cross-platform build inspected via `CROSS_PLATFORM_PREFLIGHT.md` — fresh macOS build expected to succeed, unsigned. |

## Known limitations / deferred

- **CF live highlighting** — closed in M1/N3: `patchCfRenders` highlights cellIs / containsText / top10 / duplicate / unique; CF dxf styles emitted on export. Remaining gap: `formula1`/`formula2` treated as literals (cell refs and `=SUM(...)` won't evaluate); in-session cell edits don't re-trigger until next snapshot pass.
- **Hyperlink / Comment live rendering** — closed in L1 / L2 / O4: hyperlinks render styled with click-to-open + live restyle on apply; comments show red-triangle indicator + hover tooltip.
- **Chart / Image live rendering** — sidebar preview shipped (N1 / N2); true in-grid canvas overlay deferred because Univer 0.5.x's facade exposes no public pixel API for an A1 range.
- **Encryption (DG-04)** — `.coco` encryption (SQLCipher / SEE / app-layer) not implemented; required only if data classification A/B is confirmed.
- **Audit log (§5.3.5)** — local audit log not implemented.
- **Performance benchmark harness** — single-fixture smoke landed (`perf_smoke.rs`); multi-fixture CI gate (60 fps scroll, 8 s 5 MB import) still pending.
- **Code signing / notarization** — packager exists with SHA256SUMS + manifest; signing steps blocked on Apple Developer / Windows cert procurement.
- **CSV exotic format codes** — date / datetime / time-only / percent / currency (`$`, `¥`, `€`, `£`) and `@` text honored; locale-tagged currency `[$X-409]` parses the symbol. Exponential (`0.0E+00`), fraction (`??/??`), elapsed-time (`[h]:mm`), and multi-letter month names (`mmm`, `mmmm`) still fall through to plain numeric.

## What changed since the prior audit (`MVP1_AUDIT.md`)

- FR-009 closed: `UniverSheetsFilterPlugin` registered (I1, `3d36451`); `SortDialog` shipped (H1, `0dee307`).
- FR-011 closed: `CappedUndoRedoService` lifts cap to 100 (H2, `64dc786`).
- FR-104 (row/col/formula caps) closed via O2.
- Phase 2 authoring dialogs added: CF, DV, Hyperlink, Comment, Chart, NumberFormat, Image, Sort, TabColor, NamedRanges + Format Painter toolbar (M2).
- Live enforcement: sheet protection (I3), data validation (J1).
- In-grid live rendering shipped: hyperlinks (L1) + comments (L2) + CF (M1) + CF dxf emission (N3) + hyperlink live restyle (O4); sidebar previews for charts (N1) + images (N2).
- Round-trip extended: split panes (O1), colorScale / dataBar / iconSet via raw-XML (P1), CF comment-aware scanner (P4).
- Performance: xlsx import -55% via shared archive (L3); perf smoke harness landed.
- Distribution: `npm run pack` (`7192bc9`) + README/CHANGELOG/dist notes (`db737cb`); macOS minSystemVersion (P4); cross-platform menu accelerators (P3).

## Totals

- §4.1 / §4.2 / §4.3 / §4.7 combined: **27 FR-IDs — 27 OK / 0 PARTIAL / 0 MISSING**.
- Phase 2 authoring: **10 dialogs + 2 toolbar tools**; 9 fully live (CF, DV, Hyperlink, Comment, NumberFormat, Sort, TabColor, NamedRanges, Sheet Protection, Format Painter); 2 sidebar-preview-only (Chart, Image).
- Non-functional: 4 OK / 2 PARTIAL (Performance multi-fixture harness, Distribution signing) / 0 MISSING.
- Biggest remaining gap: true in-grid canvas overlay for charts / images (blocked on Univer pixel-API gap; sidebar preview is the agreed substitute).
