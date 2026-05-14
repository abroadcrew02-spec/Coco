# Changelog

All notable changes to Coco are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-05-14

Initial internal release. Covers Phase 0 foundation, the full Phase 1 MVP (FR-001..FR-014, FR-101..FR-105, FR-201..FR-204, FR-301..FR-304), and Phase 2 authoring entry points in preview.

### xlsx round-trip

- Preserve named ranges (workbook + sheet scope) through import → snapshot → export.
- Preserve cell styles: font, fill, alignment.
- Preserve per-cell borders.
- Preserve per-cell number formats.
- Preserve merged cell ranges per sheet.
- Preserve column widths and row heights per sheet.
- Preserve rich-text runs (per-character formatting in a cell).
- Preserve data validation rules.
- Preserve conditional formatting (cellIs, colorScale, dataBar, iconSet), later extended to top10 and duplicate / unique rules.
- Preserve hyperlinks (external + internal).
- Preserve cell comments including author.
- Preserve charts byte-for-byte (blob mode).
- Preserve pivot tables (blob mode).
- Preserve embedded images under `xl/media/`.
- Preserve external link parts (cached values only; no auto-fetch).
- Preserve print / page setup.
- Preserve frozen panes and sheet visibility.
- Preserve sheet tab colors and auto-filter ranges.
- Preserve sheet protection flags.
- Deduplicate colliding sheet names with `_2`, `_3`, ... on import.
- Harden CF / DV scanner; detect data validation in worksheet XML feature scan.

### xlsx authoring UI (Phase 1)

- Register Univer find-replace plugin (Ctrl+F / Ctrl+H).
- Register Univer sheets-filter plugin (closes FR-009 auto-filter gap).
- Add Sort dialog.
- Raise Univer undo cap from 20 to 100 via `CappedUndoRedoService` (FR-011).
- Enforce sheet protection live: block mutations on protected sheets.
- Group editor toolbar; refresh HelpDialog with Phase 2 shortcuts.

### xlsx authoring UI (Phase 2 preview)

These dialogs capture authoring intent into the snapshot and survive xlsx round-trip. Full visual rendering of the resulting elements is still in progress.

- Named Ranges CRUD dialog.
- Data Validation authoring dialog.
- Conditional Formatting authoring dialog.
- Insert Hyperlink dialog (Ctrl+K).
- Insert / Edit Comment dialog (Shift+F2).
- Insert Chart dialog.
- Insert Image dialog with `file_io` Tauri command.
- Number Format dialog (Ctrl+1).
- Sheet protection toggle UI.

### Home and recents

- HomeScreen with recents list, "見つかりません" badge for missing files.
- P key toggles pin on the focused recent.
- Drag-to-reorder pinned recents.
- HomeScreen filter and edge-case coverage.

### Recovery and safety

- xlsm macro-loss modal dialog on `.xlsm` import.
- `.bak.1`..`.bak.5` rotation before overwriting an opened xlsx.
- Atomic `.coco` save via temp-file + integrity check + rename.
- Recovery candidates surfaced on startup with end-to-end flow tests.
- CompatibilityWarningsDialog for xlsx import warnings.

### Build and distribution

- `npm run pack` script: `tauri build` followed by `scripts/pack-distbin.mjs` staging signed / unsigned artifacts into `./distbin/`.
- `pack-distbin.mjs` emits `SHA256SUMS.txt` and `manifest.json` (per requirements.md §5.6).
- Distbin README template under `docs/DISTBIN_README_TEMPLATE.md`, copied to `distbin/README.md` on each pack.

### Tests

- 18 edge-case tests for frontend gaps (items 1-19 of the audit).
- `useWorkbookStore` action-path coverage.
- HomeScreen recents / pin / drag / filter coverage.
- SettingsDialog interactions and edge cases.
- CSV / TSV encoding round-trip edge cases.
- FR-105 representative 10-file P0 compatibility suite.
- P0 formula round-trip suite (FR-003 + §4.4).
- P1 formula round-trip suite (13 common P1 formulas).
- `CappedUndoRedoService` keeps the FR-011 100-entry cap.
- End-to-end recovery candidate flow tests (§6.5).
- Excluded `.claude/worktrees` from vitest discovery.

### Documentation

- `docs/MVP1_AUDIT.md`: FR-001..FR-014 coverage report with inline TODO markers for known gaps.
- `README.md` (this release): project overview, features, quick start, build instructions.
- `CHANGELOG.md` (this file).

[0.1.0]: https://example.invalid/coco/releases/tag/v0.1.0
