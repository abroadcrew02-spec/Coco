# Coco — current state

Snapshot 2026-05-14 against `main` (HEAD `2b6eb76`).

## Headline

**MVP-1 functionally complete; Phase 2 authoring UI delivered.** All MVP-1 (FR-001..FR-014), MVP-2 import (FR-101..FR-105), MVP-3 export (FR-201..FR-204), and CSV (FR-301..FR-304) feature IDs verdict OK in `docs/COVERAGE.md`. Phase 2 ships 10 authoring dialogs + 2 toolbar tools; 9 of 12 entries render live in-grid.

## Key counts

| | Count | Source |
|-|-|-|
| Vitest test files | 50 | `npx vitest --run` |
| Vitest tests passing | 768 (+1 skipped) | same run, 260 s |
| Cargo integration test files | 47 | `src-tauri/tests/` |
| Cargo `#[test]` / `#[tokio::test]` annotations | 309 | grep across `src-tauri/tests/` + `src-tauri/src/` |
| Distbin artifacts produced by `npm run pack` | Windows: `Coco.exe` + `.msi` + `.exe` (NSIS) + `SHA256SUMS.txt` + `manifest.json` + `README.md`; macOS: `.dmg` + raw `Coco` binary + same metadata; Linux: `.deb` / `.AppImage` / `.rpm` + same metadata | `scripts/pack-distbin.mjs` |
| Phase 2 dialogs + toolbar tools | 10 + 2 | `docs/COVERAGE.md` Phase 2 table |
| Post-J3 merges to main | 17 (K, L, M, N, O, P, Q tiers) | `git log 56a1341..HEAD` |

## What works end-to-end

- New / open / edit / save / Save As xlsx (atomic temp + rename) and `.coco` (PRAGMA integrity_check) round-trip.
- Auto-save every 30 s; `.bak.1..5` rotation; recovery candidates on startup.
- xlsx round-trip preserves: named ranges, styles, borders, number formats, merges, column / row dims, rich text, data validation, conditional formatting (cellIs / top10 / duplicate / unique typed + colorScale / dataBar / iconSet raw-XML), hyperlinks, comments, charts (blob), pivots (blob), images, external links (cached), page setup, frozen panes, split panes, tab color, auto-filter, sheet protection, sheet visibility, xlsm warning.
- CSV export with UTF-8 BOM or Shift_JIS, format-code rendering (date / datetime / time / percent / currency / `@` text), injection-guard prefix.
- Authoring dialogs (live in-grid): named ranges, data validation, conditional formatting, hyperlink, comment, number format, sort, tab color, sheet protection, format painter.
- Sidebar preview (round-trip preserves, no canvas overlay): chart insertion, image insertion.
- Find / Replace (Ctrl+F / Ctrl+H), undo cap 100, filter, sort, frozen panes, paste-special, autofill, sheet protection live enforcement.
- Security scan: 50 MB / 300 MB / 2,000 entries / 100-200 sheets / 1 M rows / 16,384 columns hard-blocked; 1 M formulas warning; xlsm macros discarded with modal.
- Performance: 1 MB / 10% formulas xlsx import in 3,565 ms (under §5.1 5,000 ms p95 ceiling) — measured by `perf_smoke.rs`.
- Cross-platform menu accelerators (Cmd vs Ctrl); macOS minimumSystemVersion = 12.0 declared.

## What's sidebar-preview-only (round-trip safe, no canvas overlay)

- Chart in-grid rendering — `ChartPreviewPanel` shows SVG previews in a left sidebar; clicking jumps to the source range. True overlay deferred (Univer 0.5.x has no public pixel API for an A1 range).
- Image in-grid rendering — `ImagePreviewPanel` shows thumbnails decoded from `xl/media/` in a left sidebar; click jumps to the anchor cell. Same Univer pixel-API limitation.

## Outstanding TODOs (link → `docs/TODOS.md`)

- **Blocker**: none.
- **High** (visible UX gaps): chart / image live in-grid canvas overlay. `high-chart-live`, `high-image-live`.
- **Medium** (round-trip / power-user): CF dxf import-side reconstruction; more CF rule types (aboveAverage / timePeriod) on export; streaming `detect_unsupported_features`; promote number-formats + rich-text into `CellStyle`; concurrent open race token.
- **Low** (polish): perf bench multi-fixture harness; CSV import edge-case tests; xlsx round-trip edge-case tests.
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
npx vitest --run            # 768 + 1 skipped
cargo test --tests          # 309 cargo tests
```

## References

- `CHANGELOG.md` — 0.1.0 release notes.
- `docs/COVERAGE.md` — full FR coverage audit.
- `docs/TODOS.md` — deferred-work catalog grouped by tier.
- `docs/CROSS_PLATFORM_PREFLIGHT.md` — §12.3 macOS / Linux preflight.
- `requirements.md` — original specification.
