# Coco

Coco is a local-first spreadsheet desktop application for internal use, built on Tauri v2, Rust, React, TypeScript, and Univer. It reads and writes Excel `.xlsx` as the primary work format and exposes an optional SQLite-backed `.coco` format via **Save As**.

The full requirements specification lives in [`requirements.md`](./requirements.md). This README is the contributor-facing quick start.

## Project status

- **Phase 0**: technical foundation — complete.
- **Phase 1 (MVP-1, MVP-2, MVP-3)**: Workbook authoring on xlsx, xlsx import / export with round-trip preservation, CSV export, recents, recovery candidates — complete. See [`docs/MVP1_AUDIT.md`](./docs/MVP1_AUDIT.md) for the FR-001..FR-014 coverage matrix.
- **Phase 2**: Authoring entry points for named ranges, data validation, conditional formatting, charts, images, hyperlinks, comments, sort, number format, sheet protection, snapshot history — **preview**. The xlsx side preserves these elements through round-trip; the UI dialogs capture user intent into the snapshot but full WYSIWYG rendering of every element is not yet complete.

## Features

### xlsx round-trip preservation

Round-trip means *open xlsx → edit in Coco → save back to xlsx without losing the listed element*. The xlsx I/O adapter preserves:

- Cell values, formulas, and cached formula results (P0 function set: `SUM`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN`, `MAX`, `IF`, `AND`, `OR`, `NOT`, `VLOOKUP`, `INDEX`, `MATCH`, `CONCAT`, `LEFT`, `RIGHT`, `MID`, `LEN`, `TODAY`, `DATE`, `YEAR`, `MONTH`, `DAY`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `ABS`)
- Cell styles: font, fill, alignment, per-cell borders
- Per-cell number formats
- Merged cells, frozen panes, sheet visibility, sheet tab colors
- Column widths and row heights
- Rich-text runs (per-character formatting within a cell)
- Data validation rules
- Conditional formatting (cellIs, colorScale, dataBar, iconSet, top10, duplicate/unique)
- Hyperlinks (external + internal)
- Cell comments (text + author)
- Named ranges (workbook + sheet scope)
- Auto-filter ranges
- Print / page setup
- Embedded images under `xl/media/`
- Charts (preserved byte-for-byte as opaque blob)
- Pivot tables (preserved as opaque blob)
- External link parts (cached values only; no auto-fetch)
- Sheet protection flags

Sheet name collisions on import are deduplicated with `_2`, `_3`, ... suffixes.

### Authoring UI (Phase 1)

- New workbook, open `.xlsx` / `.xlsm` / `.coco`, save, save-as, CSV export
- Cell input / edit / delete, multi-sheet (add / delete / rename / reorder)
- Univer formula bar, autofill, clipboard with paste-special
- Find / replace (Ctrl+F / Ctrl+H) via Univer find-replace plugin
- Sort dialog
- Auto-filter (Univer sheets-filter plugin registered)
- Undo / Redo with 100-entry cap (raised from Univer's default 20)
- Recents list (10 entries, pin, drag-to-reorder, P-to-pin)
- Crash recovery candidates on startup
- xlsm macro-loss warning dialog
- xlsx import compatibility warnings dialog
- Help dialog covering shortcuts
- Sheet protection toggle (enforced live: mutations on protected sheets are blocked)

### Authoring UI (Phase 2 preview)

These dialogs capture user input into the workbook snapshot and survive xlsx round-trip, but full visual rendering and runtime enforcement of every feature is still in progress:

- Named Ranges CRUD dialog
- Data Validation authoring dialog
- Conditional Formatting authoring dialog
- Insert Hyperlink (Ctrl+K)
- Insert / Edit Comment (Shift+F2)
- Insert Chart dialog
- Insert Image dialog
- Number Format dialog (Ctrl+1)

### Save and recovery

- Auto-save to a temporary recovery area
- `.bak.1`..`.bak.5` rotation before overwriting an opened xlsx
- Atomic `.coco` save (temp file → `PRAGMA integrity_check` → rename)
- Recovery candidates surfaced on next launch

## Quick start

Requirements: Node.js 18+, Rust toolchain (stable), platform Tauri prerequisites (see <https://tauri.app/start/prerequisites/>).

```sh
npm install
npm run tauri dev
```

This launches the Tauri development host with Vite HMR for the React frontend.

## Tests

```sh
npm test           # one-shot vitest run
npm run test:watch # watch mode
```

The Rust side has its own `cargo test` suite under `src-tauri/`.

## Build and package

```sh
npm run pack
```

This runs `tauri build` then `scripts/pack-distbin.mjs`, which stages signed and unsigned artifacts (MSI, NSIS, raw `.exe`, or DMG / AppImage on other platforms) into `./distbin/` with `SHA256SUMS.txt`, `manifest.json`, and an installer README. See [`distbin/README.md`](./distbin/README.md) after running pack.

To stage artifacts without rebuilding:

```sh
npm run pack:stage
```

## Repository layout

- `src/` — React frontend (components, stores, hooks, xlsx adapter glue)
- `src-tauri/` — Rust backend (Tauri commands, xlsx I/O via `calamine` + `rust_xlsxwriter`, SQLite for `.coco`)
- `docs/` — design notes, audit reports, distbin README template
- `scripts/pack-distbin.mjs` — release packaging
- `requirements.md` — authoritative spec

## License

Coco is intended to ship under **Apache-2.0** (see §1.3 of `requirements.md`). Per-dependency licenses are reviewed before each release; bundled OSS notices are produced as part of the distribution package.
