# MVP-1 (requirements.md §4.1) coverage audit

Snapshot taken 2026-05-14 against `main` (commit pre-audit: `ee970a0`).
Verdict legend: OK = implemented and acceptance criterion plausibly met;
TODO = partial / behavioral gap noted in source via `TODO(FR-NNN)`;
MISSING = no implementation found.

| ID     | Verdict | Notes |
| ------ | ------- | ----- |
| FR-001 | OK      | `useWorkbookStore.newWorkbook` invokes `workbook_new`; EditorScreen renders an empty `Sheet1` (1000 x 100) when no snapshot. |
| FR-002 | OK      | Cell input/edit/delete provided by `UniverSheetsUIPlugin` (editor + clear-selection commands); snapshot round-trip covered by xlsx_io. |
| FR-003 | OK      | `UniverFormulaEnginePlugin` + `UniverSheetsFormulaPlugin` + `UniverSheetsFormulaUIPlugin` evaluate the P0 function set (SUM/IF/VLOOKUP/...). Round-trip preserves formula text and cached `v`. |
| FR-004 | OK      | Sheet add / delete / rename / reorder from the Univer footer tabs; xlsx_io preserves `sheetOrder` + per-sheet name. |
| FR-005 | OK      | Per-cell number formats (A2), borders, fonts, fills round-trip via xlsx_io. Univer's toolbar surfaces the editing UI. |
| FR-006 | OK      | Merge / unmerge via `add-worksheet-merge.command`; frozen panes round-trip (commit `c561abd`); both preserved in snapshot. |
| FR-007 | OK      | Univer clipboard service exposes Ctrl+C / Ctrl+X / Ctrl+V plus paste-special (values / formats / values+formats) via the right-click menu. |
| FR-008 | OK      | Auto-fill is built into `UniverSheetsUIPlugin` (`AutoFillController` — see `node_modules/@univerjs/sheets-ui/lib/types/controllers/auto-fill.controller.d.ts`). Drag the fill handle for numeric series, date series, copy-down. |
| FR-009 | TODO    | Auto-filter and sort UI are **not registered**. Round-trip preservation for auto-filter exists (commit `74594d0`), but no `@univerjs/sheets-filter` / `sheets-sort` plugin is mounted on the Univer instance. Inline TODO in `EditorScreen.tsx`. |
| FR-010 | OK      | `UniverFindReplacePlugin` + `UniverSheetsFindReplacePlugin` registered (commit `852ac45`); Ctrl+F / Ctrl+H. |
| FR-011 | TODO    | Univer's default `LocalUndoRedoService` caps the undo stack at **20** items (`CE = 20` in `@univerjs/core/lib/es/index.js`); requirement asks for 100. Ctrl+Z / Ctrl+Y are correctly *not* preventDefaulted so the keys reach Univer. Inline TODO in `EditorScreen.tsx`. |
| FR-012 | OK      | `promptSaveAs` offers xlsx (default) and `.coco` (SQLite) filters; `saveAs` routes by extension to `workbook_export_xlsx` or `workbook_save_as`. Auto-save handled by `useAutoSave`. |
| FR-013 | OK      | `HomeScreen` renders the recents list (up to 10 in backend), each row has a "見つかりません" badge when `!f.exists` and a `recent-remove` (×) button calling `removeRecent`. |
| FR-014 | OK      | `xlsx_io.rs` emits a `XLSM_MACROS_DISCARDED` warning on `.xlsm` import. `App.tsx` watches `importWarnings` and pops `XlsmMacroLossDialog` once per workbookId; the same warning also appears in the editor banner. |

## What was changed in this audit pass

- Added inline `TODO(FR-009)` and `TODO(FR-011)` markers in `src/components/EditorScreen.tsx` near
  the Univer plugin registration block to flag the two behavioral gaps for follow-up.

## Out of scope (left to a separate cut)

- Wiring `@univerjs/sheets-filter` (and a sort UI) into the editor — the package is available
  but registering it changes the toolbar surface and locale bundles; a focused task should land that.
- Raising Univer's undo limit from 20 to 100 — requires a `DependencyOverride` for
  `IUndoRedoService` (subclass `LocalUndoRedoService` with a higher cap). Tractable but risky for
  this audit pass given it touches batching semantics.
