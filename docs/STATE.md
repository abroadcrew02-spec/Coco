# Coco — current state

Snapshot 2026-05-27 against `main` (HEAD `abb2c09`).

## Headline

**MVP-1 functionally complete; Phase 2 authoring UI delivered; Phase 3 "最強Excel" roadmap in flight.** All MVP-1 (FR-001..FR-014), MVP-2 import (FR-101..FR-105), MVP-3 export (FR-201..FR-204), and CSV (FR-301..FR-304) feature IDs verdict OK in `docs/COVERAGE.md`. Phase 3 (issues #236 / #238 / #239 / #241 under meta #248) ships in-grid chart CRUD, Power Query end-to-end, a DAX engine with measure / calculated-column authoring UI, **Pivot×DAX measure 統合 (Step 7)**, and CF live re-paint with sidecar + iconSet.

## Key counts

| | Count | Source |
|-|-|-|
| Vitest test files | 125 | `npx vitest --run` |
| Vitest tests passing | 2,641 | same run |
| Cargo integration test files | 55 | `src-tauri/tests/` |
| Cargo `#[test]` / `#[tokio::test]` annotations | 496 | grep across `src-tauri/tests/` + `src-tauri/src/` |
| Distbin artifacts produced by `npm run pack` | Windows: `Coco.exe` + `.msi` + `.exe` (NSIS) + `SHA256SUMS.txt` + `manifest.json` + `README.md`; macOS: `.dmg` + raw `Coco` binary + same metadata; Linux: `.deb` / `.AppImage` / `.rpm` + same metadata | `scripts/pack-distbin.mjs` |
| Phase 2 dialogs + toolbar tools | 10 + 2 | `docs/COVERAGE.md` Phase 2 table |
| Commits to main since 2026-05-14 snapshot | 276 | `git log --since="2026-05-14"` |

## Phase 3 progress (issues #236 / #238 / #239 / #241)

| Issue | Status |
|---|---|
| **#236 In-grid Chart** | Insert / move / resize / **double-click edit** / **Delete-key delete** all shipped (PRs #263, #273, #279, #284, #286, #288, #290–#292). InsertChartDialog exposes all 6 chart types + advanced options (legend / labels / stacked / header-row/col). |
| **#238 Power Query** | Step 1-7 pipeline engine + 13 transforms, dialog UI with json / csv / sqlite / jsonl / tsv sources, snapshot storage, executor, and **SavedQueriesPanel** (list + refresh + delete, ribbon `クエリの管理`) shipped (PRs #264, #272, #281, #285, #289, #293). |
| **#239 Power Pivot / DAX** | Engine: 17 DAX functions (SUM/AVG/MIN/MAX/COUNT/COUNTROWS/DISTINCTCOUNT/IF/ALL/RELATED/SUMX/AVERAGEX/MINX/MAXX/COUNTX/FILTER/CALCULATE), measure + calculated-column storage and evaluation. UI: **MeasureListPanel** with three sections (tables / measures / calc cols), **MeasureEditorDialog** + **CalculatedColumnEditorDialog** (author + edit + unique-name validation + DAX function/column chips + live preview), and **"📊 データモデルへ追加"** action on TableInfoPanel rows to populate the model from existing workbook tables (PRs #265-#267, #271, #283, #287, #294-#297, #298-#302). **Step 7 Pivot×Measure 統合**: `PivotSource` / `PivotValueField` を discriminated union 化、`computeModelPivot` でモデル table を source にして per-cell filter context で measure を評価。InsertPivotDialog に「データソース: シート範囲 / データモデル」モードトグル + measure 値フィールド追加 (新 PR). |
| **#241 CF live re-paint** | Sidecar foundation, computeCfApplyPlan, range batching, iconSet decoration channel (numeric values intact), e2e integration test all shipped (PRs #262, #268, #269, #274, #282, #288). |

## What works end-to-end

- New / open / edit / save / Save As xlsx (atomic temp + rename) and `.coco` (PRAGMA integrity_check) round-trip.
- Auto-save every 30 s; `.bak.1..5` rotation; recovery candidates on startup.
- xlsx round-trip preserves: named ranges, styles, borders, number formats, merges, column / row dims, rich text, data validation, conditional formatting (cellIs / top10 / duplicate / unique typed + colorScale / dataBar / iconSet raw-XML), hyperlinks, comments, charts (blob), pivots (blob), images, external links (cached), page setup, frozen panes, split panes, tab color, auto-filter, sheet protection, sheet visibility, xlsm warning, **`xl/model/*` (Data Model byte-preserve)**, **`xl/queryTables/*`**, **`xl/ctrlProps/*`**, **`xl/embeddings/*`**.
- CSV export with UTF-8 BOM or Shift_JIS, format-code rendering (date / datetime / time / percent / currency / `@` text), injection-guard prefix.
- Authoring dialogs (live in-grid): named ranges, data validation, conditional formatting, hyperlink, comment, number format, sort, tab color, sheet protection, format painter, **in-grid chart (insert / move / resize / double-click edit / Delete-key delete; 6 chart types + axis labels / legend / stacked / header-row/col)**.
- **Power Query**: ribbon → 「データの取得と変換」dialog → json / csv / sqlite / jsonl / tsv source → 13-step transform pipeline (selectColumns / dropColumns / filterRows / sort / rename / groupBy / changeType / fillMissing / conditionalColumn / replaceValue / splitColumn / mergeColumns / addIndexColumn) → expand to sheet. Queries persist in `_cocoQueries`; **SavedQueriesPanel** (ribbon 📋) lists / refreshes / deletes.
- **Power Pivot / DAX**: 17 functions evaluable (SUM / AVERAGE / MIN / MAX / COUNT / COUNTROWS / DISTINCTCOUNT / IF / ALL / RELATED / SUMX / AVERAGEX / MINX / MAXX / COUNTX / FILTER / CALCULATE). **MeasureListPanel** (ribbon Σ) shows tables + measures + calculated columns, each with author / edit / delete; **TableInfoPanel** has 📊 「データモデルへ追加」for promoting Excel tables to ModelTables. **Pivot×Measure 統合**: InsertPivotDialog の「データモデル」モードで model table を source にできる + 値フィールドに measure を割り当て可能 (Step 7).
- **CF live re-paint**: sidecar + apply-plan + range batching + iconSet decoration channel; numeric values intact when iconSet glyphs render.
- CSV export with UTF-8 BOM or Shift_JIS, format-code rendering (date / datetime / time / percent / currency / `@` text), injection-guard prefix.
- Sidebar preview (round-trip preserves, fallback for legacy charts): chart blob preview, image insertion.
- Find / Replace (Ctrl+F / Ctrl+H), undo cap 100, filter, sort, frozen panes, paste-special, autofill, sheet protection live enforcement.
- Security scan: 50 MB / 300 MB / 2,000 entries / 100-200 sheets / 1 M rows / 16,384 columns hard-blocked; 1 M formulas warning; xlsm macros discarded with modal.
- Performance: 1 MB / 10% formulas xlsx import in 3,565 ms (under §5.1 5,000 ms p95 ceiling) — measured by `perf_smoke.rs`.
- Cross-platform menu accelerators (Cmd vs Ctrl); macOS minimumSystemVersion = 12.0 declared.

## What's sidebar-preview-only (round-trip safe, no canvas overlay)

- **Excel-format chart blob preview** — `ChartPreviewPanel` shows SVG previews for legacy `_charts` blob entries in a left sidebar; clicking jumps to the source range. The in-grid `_charts` Coco-authored entries are rendered via `InGridChartLayer` (canvas overlay) since #236 Step 3.
- Image in-grid rendering — `ImagePreviewPanel` shows thumbnails decoded from `xl/media/` in a left sidebar; click jumps to the anchor cell. Same Univer pixel-API limitation as charts had before #236.

## Outstanding TODOs (link → `docs/TODOS.md`)

- **Blocker**: none.
- **High** (visible UX gaps): image live in-grid canvas overlay (`high-image-live` — chart equivalent shipped via #236); DAX autocomplete in `MeasureEditorDialog` / `CalculatedColumnEditorDialog`; calculated column を Pivot rows/cols として直接扱う UI (Step 7 後の課題).
- **Medium** (round-trip / power-user): CF dxf import-side reconstruction; more CF rule types (aboveAverage / timePeriod) on export; streaming `detect_unsupported_features`; promote number-formats + rich-text into `CellStyle`; concurrent open race token; Form Control OOXML native round-trip (#194).
- **Low** (polish): perf bench multi-fixture harness; CSV import edge-case tests; xlsx round-trip edge-case tests; verify + likely-remove the StrictMode×Univer deferred-dispose guard on Univer 0.24 (#232).
- **Open methodology questions**: Stock / Geography Linked Data Types — server-dependent, requires local-first decision (#244).
- **Wontfix / out of scope**: VBA execution; real-time collab; `.coco` encryption (DG-04); audit log (§5.3.5); automated signing / notarization (process-gated on credentials); external-link auto-fetch.

## Build + install

### Prerequisites

- Node 20+, npm 10+.
- Rust stable (latest), with the Tauri v2 prerequisites for the host OS (https://v2.tauri.app/start/prerequisites/).

### Dev loop

```
npm install
npm run tauri dev    # launches the Tauri shell + Vite dev server
```

### Release build (signed / unsigned bundle into ./distbin/)

```
npm install
npm run pack         # = tauri build + scripts/pack-distbin.mjs
```

Outputs to `./distbin/`: platform installer(s), raw executable, `SHA256SUMS.txt`, `manifest.json`, and `README.md` derived from `docs/DISTBIN_README_TEMPLATE.md` per requirements.md §5.6.

### Install

- **Windows**: run `./distbin/coco_*-x64-setup.exe` (NSIS) or `./distbin/coco_*-x64_en-US.msi` (MSI).
- **macOS**: mount `./distbin/Coco_*_aarch64.dmg` (Apple Silicon) or `..._x64.dmg` (Intel), drag `Coco.app` to `/Applications`. Bundle is unsigned today (Gatekeeper warning expected until signing credentials arrive).
- **Linux**: install `./distbin/coco_*_amd64.deb` or run `./distbin/coco_*_amd64.AppImage` directly.

### Verification

```
npx tsc --noEmit            # frontend type-check
cd src-tauri && cargo check # Rust check
npx vitest --run            # 2,641 tests across 125 files
cargo test --tests          # 496 cargo test annotations across 55 files
```

## References

- `CHANGELOG.md` — 0.1.0 release notes.
- `docs/COVERAGE.md` — full FR coverage audit.
- `docs/TODOS.md` — deferred-work catalog grouped by tier.
- `docs/CROSS_PLATFORM_PREFLIGHT.md` — §12.3 macOS / Linux preflight.
- `requirements.md` — original specification.
