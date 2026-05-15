# Coco — Deferred work catalog

Snapshot taken 2026-05-14 against `main`. Single source of truth for everything
that was intentionally left undone in the Phase 0 / Phase 1 MVP and Phase 2
preview. Cross-references `docs/COVERAGE.md`, `docs/CROSS_PLATFORM_PREFLIGHT.md`,
and `CHANGELOG.md` (0.1.0).

Effort legend: **S** ≤ 1 day, **M** 2-5 days, **L** > 1 week.

Inline TODO comments follow `TODO(category): description (see docs/TODOS.md#anchor)`
so a `grep -R "TODO(" src src-tauri` lists every linked deferral.

---

## Blocker — production blockers

None.

---

## High — visible UX gaps

### high-cf-live-render
- **Title**: Conditional formatting in-grid live rendering
- **Refs**: `src/components/EditorScreen.tsx:342`, `src/components/ConditionalFormattingDialog.tsx:20`
- **Effort**: L
- **Why deferred**: Univer's CF plugin uses an IRange + dxf-style IStyleBase model that differs from the OOXML shape we round-trip through `_conditionalFormatting`. Authoring writes into the snapshot and survives save/reopen, but live highlight needs a bidirectional dxf adapter.
- **Blocker for closing**: dxf table parsing in `src-tauri/src/commands/xlsx_io.rs` (see `medium-cf-dxf-emit`).

### high-hyperlink-live (closed)
- **Title**: Hyperlink in-grid live rendering after authoring (beyond `patchHyperlinkRenders` boot-time patch)
- **Refs**: `src/components/EditorScreen.tsx` (applyHyperlink), `src/components/hyperlinkRender.ts` (chooseHyperlinkRestyle)
- **Resolution**: `applyHyperlink` now drives the Univer facade imperatively after the snapshot patch — `getRange(cell).setFontColor("#1155cc").setFontLine("underline")` plus `setValue(label)` when the cell is empty. The decision of value/color/underline is centralized in `chooseHyperlinkRestyle` so it stays in lock step with the boot-time `patchHyperlinkRenders` patch.

### high-comment-live
- **Title**: Comment indicator + popover in-grid
- **Refs**: COVERAGE.md "Comment" row (PARTIAL snapshot-only)
- **Effort**: M
- **Why deferred**: Author + text stored in `_comments` and round-tripped, but no in-grid red triangle indicator or hover popover. Univer 0.5.x has no first-party comment renderer in this build.

### high-chart-live
- **Title**: Chart in-grid live rendering for newly authored charts
- **Refs**: `src/components/EditorScreen.tsx:734-739`, COVERAGE.md "Chart" row
- **Effort**: L
- **Why deferred**: `@univerjs/sheets-chart` plugin not in this build. Existing chart blobs round-trip byte-for-byte, but newly authored entries via `InsertChartDialog` are data-only — re-emitting chart OOXML and rendering them live is out of scope.

### high-image-live
- **Title**: Image in-grid live rendering for newly authored images
- **Refs**: COVERAGE.md "Image" row (PARTIAL snapshot-only)
- **Effort**: L
- **Why deferred**: Media bytes round-trip via `_preservedParts`, but newly inserted images don't render in the active workbook — same Univer plugin gap as charts.

---

## Medium — round-trip / power-user features

### medium-cf-dxf-emit
- **Title**: Emit dxf-referenced visual format on CF export
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:2764`, `src-tauri/src/commands/xlsx_io.rs:3090-3093`
- **Effort**: M
- **Why deferred**: PoC scope: rules round-trip their shape (sqref, type, operator, formulas), but the dxf-referenced visual format (`dxfId` → `styles.xml` `dxfs`) is dropped because `rust_xlsxwriter` expects a fresh `Format` per rule and we don't yet parse the dxf table on import.

### medium-cf-more-rule-types
- **Title**: Reconstruct colorScale / dataBar / iconSet / aboveAverage / timePeriod CF rules on export
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:3090-3093`
- **Effort**: M
- **Why deferred**: Need typed values we don't reconstruct yet; currently dropped silently. Authoring side only emits cellIs / containsText / top10 / duplicateValues / uniqueValues.

### medium-cf-comment-falsepositive (closed)
- **Title**: Strip XML comments before CF / DV substring scan
- **Refs**: `.claude/audit-findings.md` MINOR-1
- **Resolution**: `worksheet_contains_marker` in `src-tauri/src/commands/xlsx_io.rs` now drives a small `<!-- ... -->`-aware state machine instead of a flat substring search. `in_comment` state is carried across the 64 KiB chunk boundary via a tracked overlap-start mirror so a comment that straddles a chunk still suppresses the match. Tests in `src-tauri/tests/xlsx_feature_detection.rs` cover commented CF, commented DV, mixed commented + real CF, and a chunk-straddling commented CF.

### medium-detect-streaming (closed)
- **Title**: Stream `detect_unsupported_features` worksheet XML instead of `read_to_string`
- **Refs**: `.claude/audit-findings.md` CRITICAL-1, `src-tauri/src/commands/xlsx_io.rs:~1437`
- **Resolution**: Per-sheet body scan was already streamed via `worksheet_contains_marker` (64 KiB chunks, 16 MiB cap). The remaining slurp — `std::fs::read` into a `Vec<u8>` before `ZipArchive::new` — is now replaced with `BufReader<File>` in the public `detect_unsupported_features` wrapper. `detect_unsupported_features_in` is generalized to `R: Read + Seek` so both the BufReader and the in-memory `Cursor` call-site from `import_xlsx_core` continue to work.

### medium-split-panes
- **Title**: Round-trip split panes (live-drag variant), not just frozen
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:800`
- **Effort**: S
- **Why deferred**: Only `state="frozen"` is parsed today; `state="split"` panes are intentionally out of scope.

### medium-number-format-richtext-styles
- **Title**: Promote number formats + rich text into the normalized `CellStyle` extractor
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:25`
- **Effort**: M
- **Why deferred**: `CellStyle` scope is font / fill / alignment / borders. Number formats and rich text round-trip via separate paths (`_fmt`, rich-text runs B1) but are not deduplicated through the same style hash.

### medium-security-row-col-formula-caps
- **Title**: §5.3.2 row / column / formula limit checks in `security_scan_xlsx`
- **Refs**: `src-tauri/src/commands/security.rs:44`, `src-tauri/src/commands/security.rs:113`, COVERAGE.md FR-104
- **Effort**: M
- **Why deferred**: Currently emits the informational warning "Row/column/formula limits not yet checked (Phase 2)". Caps for file size / inflated size / entry count / per-XML size / sheet count are enforced.

### medium-concurrent-open-race
- **Title**: Request-token "newer wins" for `openCoco` / `importXlsx`
- **Refs**: `src/store/useWorkbookStore.test.ts:996` (`it.skip`), `.claude/audit-findings.md` item 14
- **Effort**: S
- **Why deferred**: A skipped test pins the bug as it stands. Store has no request-token, so an earlier-started invoke resolving last clobbers the newer state.

---

## Low — polish

### low-macos-minimum-system-version (closed)
- **Title**: Declare `bundle.macOS.minimumSystemVersion = "12.0"` in `tauri.conf.json`
- **Refs**: `docs/CROSS_PLATFORM_PREFLIGHT.md` WARNING #2
- **Resolution**: Added `bundle.macOS.minimumSystemVersion = "12.0"` to `src-tauri/tauri.conf.json`. Property name verified against Tauri v2 schema. A macOS build pass is still needed to confirm the linker honors it.

### low-perf-bench-harness
- **Title**: Wire performance acceptance numbers (60 fps scroll, 8 s 5 MB import) into CI
- **Refs**: COVERAGE.md §5.1 (PARTIAL unverified)
- **Effort**: M
- **Why deferred**: `src-tauri/tests/perf.rs` exists but no harness ties numbers to a gate.

### low-autosave-error-status
- **Title**: `autoSave` swallows invoke rejection without flipping `saveStatus`
- **Refs**: `.claude/audit-findings.md` item 15
- **Effort**: S

### low-autosave-interval-validation
- **Title**: `setAutoSaveInterval` ignores NaN / Infinity
- **Refs**: `.claude/audit-findings.md` item 16
- **Effort**: S

### low-pinned-paths-array-guard
- **Title**: `loadPinnedPaths` handles non-array JSON safely
- **Refs**: `.claude/audit-findings.md` item 17
- **Effort**: S

### low-path-router-edge-cases
- **Title**: Path router handles multi-dot filenames and CJK / emoji names without mangling
- **Refs**: `.claude/audit-findings.md` items 18-19
- **Effort**: S

### low-csv-import-edge-cases
- **Title**: Missing CSV import edge-case tests (full-width digits, Excel 1900 leap bug, mixed line endings, RFC4180 quoting…)
- **Refs**: `.claude/audit-findings.md` items 1-9
- **Effort**: M
- **Why deferred**: Per feedback_feature_first memory: ship MVP features, file issues for testing later.

### low-xlsx-roundtrip-edge-cases
- **Title**: Missing xlsx round-trip tests (empty workbook export rejected, name-collision after sanitization, cross-sheet formula, 31-char sheet name)
- **Refs**: `.claude/audit-findings.md` items 10-13
- **Effort**: S

---

## Wontfix / Out of scope

These are documented in `requirements.md` and the Phase 2 preview design — listed
here only so a future contributor doesn't reopen them by accident.

### wontfix-vba-execution
- **Title**: Execute Excel VBA / Google Apps Script
- **Refs**: `requirements.md:110`, `requirements.md:288`, `requirements.md:734`, OI-08 risk
- **Effort**: N/A
- **Why**: Explicit non-goal. `.xlsm` macros are discarded on import with `XLSM_MACROS_DISCARDED` warning + modal dialog.

### wontfix-realtime-collab
- **Title**: Real-time multi-user collaboration
- **Refs**: requirements.md has no collaborative-edit requirement
- **Effort**: N/A
- **Why**: Out of scope; Coco is a local-first single-user editor.

### wontfix-coco-encryption
- **Title**: `.coco` encryption (SQLCipher / SEE / app-layer)
- **Refs**: COVERAGE.md §5.3 (DG-04 deferred), `requirements.md:301-302`
- **Effort**: L if reinstated
- **Why**: Required only if data classification A/B is confirmed. Currently deferred.

### wontfix-audit-log
- **Title**: Local audit log (§5.3.5)
- **Refs**: COVERAGE.md §5.3
- **Effort**: M if reinstated
- **Why**: Not implemented; required only under tighter data-handling policy than current scope.

### wontfix-signing-notarization
- **Title**: Automated code signing / notarization / SHA-256 wiring in `npm run pack`
- **Refs**: COVERAGE.md §5.6, `docs/CROSS_PLATFORM_PREFLIGHT.md` WARNING #3, `requirements.md:389`
- **Effort**: M (when credentials arrive)
- **Why**: Blocked on Apple Developer credentials + Windows code-signing cert procurement. The packager stages artifacts but signing is out of scope until creds are available — this is a process gate, not engineering.

### wontfix-external-link-autofetch
- **Title**: Auto-fetch external workbook link values
- **Refs**: COVERAGE.md §5.3 (E2)
- **Effort**: N/A
- **Why**: External links are preserved as warnings + cached-value blob only; refresh-on-open is explicitly not implemented (offline-first per §5.2).

---

## Maintenance notes

- When closing an item, delete its entry from this file and any matching inline
  `TODO(category):` comment in the same commit.
- When adding a new deferred item, add an anchor here first, then the inline
  `TODO(category): description (see docs/TODOS.md#anchor)` so future greps stay
  linked.
- Categories used for the `TODO(...)` prefix: `cf`, `hyperlink`, `comment`,
  `chart`, `image`, `cross-platform`, `security`, `perf`, `xlsx-roundtrip`,
  `csv`, `store`.
