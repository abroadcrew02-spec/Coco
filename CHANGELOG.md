# Changelog

All notable changes to Coco are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.3] - 2026-05-25

Patch release: conditional-formatting improvements (closes #193-adjacent CF gaps).

### Added

- **In-session live re-paint for conditional-formatting rule edits.** Authoring or editing CF rules in the dialog now updates the grid immediately, no save+reopen needed. `applyCfRules` drives the Univer facade imperatively via a new `computeCfRepaint` helper that diffs base/prev/after snapshots and emits per-cell `set` / `clear` actions (plus an optional `value` for iconSet glyph cells). Mirrors the proven `applyHyperlink` re-style pattern. Handles add / modify / remove / range-shrink. (Closes `high-cf-live-render` in `docs/TODOS.md`.)

### Fixed

- **Imported `aboveAverage` / `timePeriod` CF rules no longer silently dropped on re-export.** The export path already read `entry.get("aboveAverage")` / `entry.get("timePeriod")`, but import had never extracted the `cfRule@aboveAverage` / `cfRule@equalAverage` / `cfRule@timePeriod` attributes. Now: `ConditionalFormattingEntry` carries `below`, `equal_average`, `time_period`; parser extracts the attrs; serializer emits the matching `{aboveAverage:{below, equalAverage}}` / `timePeriod` keys. New round-trip tests cover all 4 above/below × strict/equal variants and 2 timePeriod periods.

### Tests

- +29 vitest cases — fills the audit-flagged coverage gap for `evaluateDataBar` / `evaluateColorScale` / `evaluateIconSet` / `evaluateExpression`, adds 1 `patchCfRenders` integration test per advanced rule type, and 8 `computeCfRepaint` edge-case tests (add / modify / remove / shrink / identical / iconSet value / missing sheet / malformed JSON).

### Documentation

- `docs/TODOS.md` brought back into sync with the implementation — `medium-cf-dxf-emit`, `medium-cf-more-rule-types`, `medium-split-panes`, `medium-number-format-richtext-styles`, `high-comment-live`, and `high-cf-live-render` all marked (closed). `high-chart-live` / `high-image-live` rescoped to (partial) with sidebar-shipped state + the remaining `@univerjs/sheets-chart` / `sheets-drawing` plugin blocker called out explicitly. Stale inline TODO comments removed where the feature has landed.

## [0.4.2] - 2026-05-25

Patch release — security fix for UrlFetch, `tauri dev` blank-grid fix, several bug fixes, and follow-up cleanup. Includes the previously-unreleased `.coco` save-option removal.

### Security

- DNS-rebinding TOCTOU SSRF closed in `http_fetch` / `http_fetch_stream` / `ws_connect` / `sse_connect`. New `is_blocked_ip` + `resolve_and_screen` pre-resolve the host and screen every A/AAAA record (fail-closed if any resolved IP is internal — loopback, private, link-local incl. metadata `169.254.169.254`, CGNAT, IPv6 ULA/link-local, IPv4-mapped). Reqwest is pinned via `resolve_to_addrs` so the actual connection cannot re-resolve to a different IP; the WebSocket connect is done manually through a screened `TcpStream` with TLS SNI / `Host` header preserved. Allow-listed domains under attacker DNS control can no longer pivot to internal services. (#195)

### Fixed

- `tauri dev` blank spreadsheet grid: React StrictMode's dev-only double-invoke of the Univer mount effect disposed the `redi` DI injector, then the disposed instance's async `_initWorkbookListener` threw `[redi]: Injector cannot be accessed after it was disposed` — the grid renderer was never created. Now the effect uses a deferred-dispose pattern (`setTimeout(0)` stashed in a `univerStashRef`); a synchronous StrictMode remount cancels the pending disposal and reuses the live instance, while a genuine unmount still disposes. Dev-only; production builds were unaffected. (PR #206)
- Power Query: data-connection refreshes serialize through a promise queue, eliminating the last-write-wins race that silently dropped one connection's sheet update when two `onOpen` connections fired in parallel. (#196 item 1)
- Rust `check_sqlite_query` now strips a leading `--` / `/* */` SQL comment before the prefix check, matching the frontend `validateSqliteQuery`. Queries with a leading comment no longer fail backend validation after passing the dialog. (#196 item 2)
- Literal-aware `;` scanner in both Rust and TS: a `;` inside a single-quoted string literal (e.g. `SELECT ';' AS x`) no longer trips the multi-statement guard. Real multi-statement queries are still rejected. (#196 item 3)
- Date-only `cast` strings (`YYYY-MM-DD` / `YYYY/MM/DD`) are parsed via `Date.UTC` so the resulting Excel serial no longer drifts ±1 day by the local timezone. (#196 item 5)

### Added

- Import-side detection warning for Excel-authored form controls. When an xlsx contains `xl/ctrlProps/` parts, a `XLSX_FORM_CONTROLS_NOT_RENDERED` compatibility warning surfaces on import so the decoration loss is observable to the user (linked cell values still import). (#194 partial)
- Draw-pipeline glyph-collision fix: the checkbox / form-control glyphs (`☑ ☐ ◉ ○ ▲▼ ◀▮▶`) are now in the known-decoration set so the conditional-formatting iconSet branch skips a cell that already hosts a form control. (#194 partial)

### Changed

- CI: `actions/checkout`, `actions/setup-node`, `actions/cache` bumped to `@v5` (Node 24 runtime) in `ci.yml` and `release.yml`. `release.yml` build job pinned explicitly to `windows-2025` ahead of the 2026-06-15 `windows-latest` redirect. (#201)

### Removed

- User-visible `.coco` save option; `.xlsx` is now the only user-selectable format (AD-02 / 2026-05-15). The Save As dialog, Open dialog filters, HelpDialog format list, SettingsDialog hint, EditorScreen toolbar tooltips, and DropOverlay hint no longer advertise `.coco`. Crash-recovery snapshots still use SQLite internally, and existing `.coco` files already in the recents list remain openable so no prior work is lost. (Previously listed under Unreleased.)

### Reverted

- #193 Univer grid-canvas dark theme — runtime verification showed the row/column header gutter (and the top-left select-all corner) cannot be recolored via the Univer 0.5.x facade (`customizeColumnHeader` / `customizeRowHeader` have no observable effect, even after the `LifecycleStages.Rendered` gate). The half-applied result — dark cells + light headers — looks worse than no dark grid. Removed `univerDarkTheme.ts` and the #193 theme effect from `EditorScreen.tsx`. Shell dark mode (#191) is unaffected. Issue #193 has been re-opened with the findings. (PR #206)

### Tests

- +11 regression tests across `loadPinnedPaths` non-array JSON guard, `setAutoSaveInterval` finite-value validation, and `pathRouter` multi-dot / CJK / emoji / surrogate-pair filename handling. Four stale `docs/TODOS.md` Low items were audited and confirmed already implemented in code — entries closed with resolution notes. (PR #207)

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
- Preserve conditional formatting (cellIs, top10, duplicate / unique rules) with typed APIs.
- Preserve colorScale / dataBar / iconSet CF rules via raw-XML round-trip (visual payload, cfvo / color stops, icon set name).
- Emit authored CF rule styles as `<dxf>` entries on export (M1 follow-up) so Excel renders bold / italic / fontColor / bgColor visibly.
- Preserve hyperlinks (external + internal).
- Preserve cell comments including author.
- Preserve charts byte-for-byte (blob mode).
- Preserve pivot tables (blob mode).
- Preserve embedded images under `xl/media/`.
- Preserve external link parts (cached values only; no auto-fetch).
- Preserve print / page setup.
- Preserve frozen panes and sheet visibility; later extended to split panes (`state="split"`) with xSplit / ySplit + topLeftCell preserved via post-save zip rewrite.
- Preserve sheet tab colors and auto-filter ranges.
- Preserve sheet protection flags.
- Deduplicate colliding sheet names with `_2`, `_3`, ... on import.
- Harden CF / DV scanner; detect data validation in worksheet XML feature scan.
- Comment-aware CF / DV substring scanner: `<!-- ... -->` regions are skipped (chunk-boundary state machine) so commented-out markup never trips a false-positive warning.

### xlsx authoring UI (Phase 1)

- Register Univer find-replace plugin (Ctrl+F / Ctrl+H).
- Register Univer sheets-filter plugin (closes FR-009 auto-filter gap).
- Add Sort dialog.
- Raise Univer undo cap from 20 to 100 via `CappedUndoRedoService` (FR-011).
- Enforce sheet protection live: block mutations on protected sheets.
- Group editor toolbar; refresh HelpDialog with Phase 2 shortcuts.

### xlsx authoring UI (Phase 2)

Authoring dialogs capture intent into the snapshot and survive xlsx round-trip. Many entries now also render live in-grid.

- Named Ranges CRUD dialog (Ctrl+F3, live via Univer facade).
- Data Validation authoring dialog (live enforcement via `onBeforeCommandExecute` guard).
- Conditional Formatting authoring dialog with in-grid live rendering (`patchCfRenders`): cellIs / containsText / top10 / duplicate / unique evaluated against current cell values, highlight style merged into inline `s` field at createUnit time; rule-priority precedence preserved.
- Insert Hyperlink dialog (Ctrl+K) with in-grid rendering, click-to-open routing (external → `open_url` Tauri command with scheme allowlist; internal `#Sheet!A1` → facade `setActiveSheet` + `setActiveRange`), and live re-style on apply.
- Insert / Edit Comment dialog (Shift+F2) with in-grid red-triangle indicators + hover tooltip via DOM-overlay panel tracking scroll / zoom.
- Insert Chart dialog plus `ChartPreviewPanel`: floating sidebar lists each `_charts` entry as an inline SVG (bar / line / pie) rendered from snapshot data; click-to-jump to source range.
- Insert Image dialog plus `ImagePreviewPanel`: floating sidebar of thumbnails decoded from `_preservedParts` / `xl/media/`, click-to-jump to anchor cell.
- Number Format dialog (Ctrl+1, live).
- Sheet protection toggle UI (live enforcement).
- Format Painter (書式コピー) toolbar tool: single-shot click or double-click for sticky mode; ESC cancels. Captures source style from selection anchor, applies via snapshot walk; handles inline + interned style-id refs.

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
- Native menu accelerator labels use a `cfg`-gated `CmdOrCtrl` MOD const (renders as "Cmd" on macOS, "Ctrl" elsewhere) so menu hints match platform convention.
- Declared `bundle.macOS.minimumSystemVersion = "12.0"` in `tauri.conf.json` to align with §12.3 OS matrix.

### Security

- §5.3.2 row / column / formula caps enforced in `security_scan_xlsx`: streaming scan of each worksheet's dimension / row tags + `<f>` count; blocks at row > 1,000,000 or column > 16,384; emits `XLSX_FORMULA_HEAVY` warning at 1,000,000 formulas.

### Tests

- 18 edge-case tests for frontend gaps (items 1-19 of the audit).
- `useWorkbookStore` action-path coverage.
- HomeScreen recents / pin / drag / filter coverage.
- SettingsDialog interactions and edge cases.
- CSV / TSV encoding round-trip edge cases plus 3 new format-code tests (US-style slash date, `@` text format, currency symbol).
- FR-105 representative 10-file P0 compatibility suite.
- P0 formula round-trip suite (FR-003 + §4.4).
- P1 formula round-trip suite (13 common P1 formulas).
- `CappedUndoRedoService` keeps the FR-011 100-entry cap; stability hardened (Q tier).
- End-to-end recovery candidate flow tests (§6.5).
- Excluded `.claude/worktrees` from vitest discovery.
- Comment-aware CF / DV scanner: 4 regression tests (commented CF, commented DV, mixed commented+real CF, chunk-straddling commented CF).
- colorScale / dataBar / iconSet CF round-trip tests with raw-`<cfRule>` injection helper.
- Split pane round-trip + mixed frozen+split workbook tests.
- CF dxf emission tests (styled rule produces non-empty `<dxfs>` + `dxfId`; unstyled keeps `<dxfs>` empty).
- 13 chart preview tests (range parsing, series extraction, numeric coercion, malformed-input tolerance).
- 13 image preview tests (base64 decode incl. UTF-8 multibyte, rels parse, anchor parse, media-path resolution, mime mapping, A1 conversion).
- 13 Format Painter tests (null / malformed input, sheet / cell lookup, id resolution, rectangle apply, style aliasing).
- 15 hyperlink render tests (`patchHyperlinkRenders`, `parseA1`, `lookupHyperlink`, `classifyHyperlink`) + 3 Rust `open_url` scheme-allowlist tests.
- CF render unit tests (cellIs operators, top10 modes, duplicate / uniqueValues, sqref parser, rule priority).
- xlsx perf smoke test: 1 MB / 10% formulas import on Windows release lands at 3565 ms (was 7891 ms), well below §5.1 5,000 ms p95 ceiling.

### Documentation

- `docs/COVERAGE.md`: full FR coverage audit (§4.1 / §4.2 / §4.3 / §4.7 + Phase 2 + non-functional gates). Supersedes the earlier MVP1_AUDIT.md draft.
- `docs/TODOS.md`: single source of truth for deferred work, grouped by Blocker / High / Medium / Low / Wontfix with effort estimates and inline `TODO(category): description (see docs/TODOS.md#anchor)` cross-references.
- `docs/CROSS_PLATFORM_PREFLIGHT.md`: §12.3 macOS / Linux build preflight audit (0 BLOCKER, 3 WARNING, 7 NOTE).
- `docs/STATE.md`: single-page current-state snapshot of the project.
- `README.md` (this release): project overview, features, quick start, build instructions.
- `CHANGELOG.md` (this file).

### Performance

- xlsx import shared-archive refactor: 16 parse helpers + `detect_unsupported_features` + security scan now share one `ZipArchive` and a sheet-XML `HashMap`, eliminating redundant central-directory parses and per-sheet decompression. 1 MB / 10% formulas fixture: 7,891 ms → 3,565 ms (-55%, -4,326 ms wall-clock).
- Helper timings collapsed from 70-100 ms each to 0-25 ms; rich_text 733 → 209 ms; styles 552 → 147 ms.

### Changed

- Hyperlink `applyHyperlink` now drives the Univer facade imperatively after snapshot patch (live blue+underline restyle) instead of waiting for the next createUnit pass.
- CF authoring style bag is wired into a `rust_xlsxwriter::Format` and emitted as `<dxf>` on export with matching `dxfId` reference.
- CSV export honors `_fmt` per cell via shared token-substitution renderer: `yyyy/yy/mm/m/dd/d/hh/h/mm/m/ss/s` walk, US-style `m/d/yyyy` and `mm/dd/yyyy`, `@` text, currency `$ / ¥ / € / £ / [$X-409]` with thousands grouping + decimal precision from the format string. Exponential / fraction / multi-letter month / elapsed-time still pass through as plain numeric.

[0.1.0]: https://example.invalid/coco/releases/tag/v0.1.0
