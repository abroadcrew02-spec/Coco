# Coco — current state

Snapshot 2026-05-28 against `main` (HEAD `c382297`).

## Headline

**MVP-1/2/3 functionally complete; Phase 2 authoring UI delivered; Phase 3 "最強Excel" 15-feature roadmap (meta #248) fully closed.** All MVP-1 (FR-001..FR-014), MVP-2 import (FR-101..FR-105), MVP-3 export (FR-201..FR-204), and CSV (FR-301..FR-304) feature IDs verdict OK in `docs/COVERAGE.md`. **Meta #248 の 15 features は全件クローズ済み** — in-grid chart CRUD, Power Query end-to-end, DAX engine (Pivot×measure 統合 + autocomplete + cross-measure refs + rename cascade), CF live re-paint (sidecar + iconSet + polluted-snapshot recovery), Form Control OOXML round-trip (preserve + Coco-authored emit), local CSV/SQLite Linked Data Types, and in-grid **image** canvas overlay all shipped.

## Key counts

| | Count | Source |
|-|-|-|
| Vitest test files | 134 | `npx vitest --run` |
| Vitest tests passing | 2,844 | same run |
| Cargo integration test files | 57 | `src-tauri/tests/` |
| Cargo `#[test]` / `#[tokio::test]` annotations | 537 | grep across `src-tauri/tests/` + `src-tauri/src/` |
| Distbin artifacts produced by `npm run pack` | Windows: `Coco.exe` + `.msi` + `.exe` (NSIS) + `SHA256SUMS.txt` + `manifest.json` + `README.md`; macOS: `.dmg` + raw `Coco` binary + same metadata; Linux: `.deb` / `.AppImage` / `.rpm` + same metadata | `scripts/pack-distbin.mjs` |
| Phase 2 dialogs + toolbar tools | 10 + 2 | `docs/COVERAGE.md` Phase 2 table |

## Phase 3 — meta #248 全 15 features クローズ済み

| Issue | Status |
|---|---|
| **#236 In-grid Chart** | ✅ closed. Insert / move / resize / double-click edit / Delete-key delete、6 chart types + 高度オプション (PRs #263–#292)。 |
| **#238 Power Query** | ✅ closed. 13 transforms + json/csv/sqlite/jsonl/tsv source + SavedQueriesPanel (PRs #264–#293)。 |
| **#239 Power Pivot / DAX** | ✅ closed. 17 DAX functions + measure/calc-col 編集 UI、**Step 7 Pivot×Measure 統合** (`computeModelPivot` + per-cell filter context, PR #303)、**DAX autocomplete** (`useDaxAutocomplete`) + **measure/calc-col rename cascade** (PR #308)、**cross-measure references** (`[MeasureName]` syntax, PR #317)。 |
| **#241 CF live re-paint** | ✅ closed. Sidecar + computeCfApplyPlan + range batching + iconSet decoration channel + **polluted-snapshot recovery** (`recoverNumericFromPolluted`, PR #315) + live-loop integration test。 |
| **#194 Form Control round-trip** | ✅ closed. Excel 由来は byte-preserve (PR #306)、**Coco 新規 CheckBox の OOXML ネイティブ emit** (ctrlProps + vmlDrawing + rels + Content_Types, PR #318)。 |
| **#244 Linked Data Types** | ✅ closed. ローカル CSV/SQLite ベース (serverless)、lookup + カード + セル展開、in-memory cache、Shift_JIS 自動検出 (PRs #307 / #314 / #316)。 |
| **#312 Image in-grid overlay** | ✅ closed. 自前 `_images` snapshot key + `InGridImageLayer` overlay (drag/resize/delete) + import 正規化 + export 再生成 (PR #319)。 |

## What works end-to-end

- New / open / edit / save / Save As xlsx (atomic temp + rename) and `.coco` (PRAGMA integrity_check) round-trip.
- Auto-save every 30 s; `.bak.1..5` rotation; recovery candidates on startup.
- xlsx round-trip preserves: named ranges, styles, borders, number formats, merges, column / row dims, rich text, data validation, conditional formatting (cellIs / top10 / duplicate / unique typed + colorScale / dataBar / iconSet raw-XML), hyperlinks, comments, charts (blob), pivots (blob), images, external links (cached), page setup, frozen panes, split panes, tab color, auto-filter, sheet protection, sheet visibility, xlsm warning, **`xl/model/*` (Data Model byte-preserve)**, **`xl/queryTables/*`**, **`xl/ctrlProps/*`**, **`xl/embeddings/*`**.
- CSV export with UTF-8 BOM or Shift_JIS, format-code rendering (date / datetime / time / percent / currency / `@` text), injection-guard prefix.
- Authoring dialogs (live in-grid): named ranges, data validation, conditional formatting, hyperlink, comment, number format, sort, tab color, sheet protection, format painter, **in-grid chart (insert / move / resize / double-click edit / Delete-key delete; 6 chart types + axis labels / legend / stacked / header-row/col)**.
- **Power Query**: ribbon → 「データの取得と変換」dialog → json / csv / sqlite / jsonl / tsv source → 13-step transform pipeline (selectColumns / dropColumns / filterRows / sort / rename / groupBy / changeType / fillMissing / conditionalColumn / replaceValue / splitColumn / mergeColumns / addIndexColumn) → expand to sheet. Queries persist in `_cocoQueries`; **SavedQueriesPanel** (ribbon 📋) lists / refreshes / deletes.
- **Power Pivot / DAX**: 17 functions evaluable (SUM / AVERAGE / MIN / MAX / COUNT / COUNTROWS / DISTINCTCOUNT / IF / ALL / RELATED / SUMX / AVERAGEX / MINX / MAXX / COUNTX / FILTER / CALCULATE). **MeasureListPanel** (ribbon Σ) shows tables + measures + calculated columns, each with author / edit / delete; **TableInfoPanel** has 📊 「データモデルへ追加」for promoting Excel tables to ModelTables. **Pivot×Measure 統合**: InsertPivotDialog の「データモデル」モードで model table を source にできる + 値フィールドに measure を割り当て可能 (Step 7).
- **CF live re-paint**: sidecar + apply-plan + range batching + iconSet decoration channel; numeric values intact when iconSet glyphs render.
- **Local Linked Data Types (#244)**: register local CSV files as data-type sources, look up the active cell value against the key column (case-insensitive), display matched row as a data card, expand to adjacent cells via `セルに展開`. Fully local / serverless — no external API calls. Sources and model persist in `_cocoDataTypes` snapshot key.
- CSV export with UTF-8 BOM or Shift_JIS, format-code rendering (date / datetime / time / percent / currency / `@` text), injection-guard prefix.
- Sidebar preview (round-trip preserves, fallback for legacy charts): chart blob preview, image insertion.
- Find / Replace (Ctrl+F / Ctrl+H), undo cap 100, filter, sort, frozen panes, paste-special, autofill, sheet protection live enforcement.
- Security scan: 50 MB / 300 MB / 2,000 entries / 100-200 sheets / 1 M rows / 16,384 columns hard-blocked; 1 M formulas warning; xlsm macros discarded with modal.
- Performance: 1 MB / 10% formulas xlsx import in 3,565 ms (under §5.1 5,000 ms p95 ceiling) — measured by `perf_smoke.rs`.
- Cross-platform menu accelerators (Cmd vs Ctrl); macOS minimumSystemVersion = 12.0 declared.

## In-grid canvas overlays (no longer sidebar-only)

- **Chart** — Coco-authored `_charts` entries render via `InGridChartLayer` (canvas overlay) since #236 Step 3. `ChartPreviewPanel` (sidebar) kept for legacy `_charts` blob preview + click-to-jump.
- **Image** — Coco's `_images` entries render via `InGridImageLayer` (canvas overlay) since #312, with drag / resize / delete. `ImagePreviewPanel` (sidebar) reads `_images` first, falls back to `_preservedParts` for legacy. xlsx round-trip via import normalisation (`_preservedParts` → `_images`, XOR invariant) + export regen.

## Outstanding TODOs (link → `docs/TODOS.md`)

- **Blocker**: none.
- **Meta #248 (15 features)**: ✅ 全件クローズ済み (2026-05-28)。
- **Follow-up issues #321–#324** (meta #248 完了後に切り出した残課題): ✅ 全件クローズ済み (2026-05-28)。
  - #321 DAX 構文エラーのインライン表示 + 関数シグネチャツールチップ → shipped
  - #322 Form Control: Radio / Spinner / ScrollBar の OOXML emit → shipped
  - #323 Linked Data Types: 複数キー同時 lookup + 展開列選択 → shipped
  - #324 Image overlay: z-order + 90° 回転 → shipped
- **Medium / Low**: `docs/TODOS.md` の Medium / Low は全項目 (closed)。
- **Remaining out-of-scope (untracked / wontfix)**:
  - Chart OOXML re-emit — Coco-authored `_charts` を Excel が認識する OOXML 出力 (image は #312 で対応済み、chart は未対応)
  - Image: フィルタ / トリミング / SVG・WMF・EMF / 大量画像の base64 → IndexedDB 退避 (#324 で z-order + 回転は対応済み、これらは費用対効果低で wontfix)
- **Wontfix / out of scope**: VBA execution; real-time collab; `.coco` encryption (DG-04); audit log (§5.3.5); automated signing / notarization (process-gated on credentials); external-link auto-fetch; Excel-compatible cloud Linked Data Types (Bing / Refinitiv — API-dependent).

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
