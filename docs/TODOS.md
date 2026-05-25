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

### medium-cf-dxf-emit (closed)
- **Title**: Emit dxf-referenced visual format on CF export
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:3361` (parse), `src-tauri/src/commands/xlsx_io.rs:3595` (build_cf_rule_format), `src-tauri/src/commands/xlsx_io.rs:3697` (apply)
- **Resolution**: Fully implemented in v0.1.0. Import parses `xl/styles.xml <dxfs>` via `parse_dxfs_from_styles`, resolves `dxfId` per rule, and stores bold/italic/fontColor/bgColor in the snapshot `style` bag. Export converts the bag to a `rust_xlsxwriter::Format` via `build_cf_rule_format`, which serializes it as a `<dxf>` entry in styles.xml with a `dxfId` back-reference. Tests: `cf_rule_style_emits_dxf_on_export` and `cf_rule_without_style_keeps_dxfs_empty` in `src-tauri/tests/xlsx_conditional_formatting.rs`. (Stale doc comment on `ConditionalFormattingEntry` removed in the same commit as `medium-cf-more-rule-types`.)

### medium-cf-more-rule-types (closed)
- **Title**: Reconstruct colorScale / dataBar / iconSet / aboveAverage / timePeriod CF rules on export
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:3488` (raw rules), `src-tauri/src/commands/xlsx_io.rs:3500-3530` (aboveAverage / timePeriod import), `src-tauri/src/commands/xlsx_io.rs:3811`/`:3843` (typed export)
- **Resolution**: colorScale / dataBar / iconSet round-trip via raw-XML post-save splice (`rewrite_extra_cf_in_zip`) — tests `color_scale_round_trips` / `data_bar_round_trips` / `icon_set_round_trips` in `xlsx_conditional_formatting.rs`. aboveAverage / timePeriod previously dropped silently on import (export side was ready, import side never captured the attributes); now fixed: `ConditionalFormattingEntry` carries `below`, `equal_average`, `time_period`, `parse_sheet_conditional_formatting` extracts `cfRule@aboveAverage` / `cfRule@equalAverage` / `cfRule@timePeriod`, and the snapshot serializer emits the matching `{aboveAverage:{below, equalAverage}}` / `timePeriod` keys the export path already expected. Tests: `above_average_round_trip_with_below_and_equal_average` (4 variants) and `time_period_round_trip_preserves_period_string` (`today` + `last7Days`).

### medium-cf-comment-falsepositive (closed)
- **Title**: Strip XML comments before CF / DV substring scan
- **Refs**: `.claude/audit-findings.md` MINOR-1
- **Resolution**: `worksheet_contains_marker` in `src-tauri/src/commands/xlsx_io.rs` now drives a small `<!-- ... -->`-aware state machine instead of a flat substring search. `in_comment` state is carried across the 64 KiB chunk boundary via a tracked overlap-start mirror so a comment that straddles a chunk still suppresses the match. Tests in `src-tauri/tests/xlsx_feature_detection.rs` cover commented CF, commented DV, mixed commented + real CF, and a chunk-straddling commented CF.

### medium-detect-streaming (closed)
- **Title**: Stream `detect_unsupported_features` worksheet XML instead of `read_to_string`
- **Refs**: `.claude/audit-findings.md` CRITICAL-1, `src-tauri/src/commands/xlsx_io.rs:~1437`
- **Resolution**: Per-sheet body scan was already streamed via `worksheet_contains_marker` (64 KiB chunks, 16 MiB cap). The remaining slurp — `std::fs::read` into a `Vec<u8>` before `ZipArchive::new` — is now replaced with `BufReader<File>` in the public `detect_unsupported_features` wrapper. `detect_unsupported_features_in` is generalized to `R: Read + Seek` so both the BufReader and the in-memory `Cursor` call-site from `import_xlsx_core` continue to work.

### medium-split-panes (closed)
- **Title**: Round-trip split panes (live-drag variant), not just frozen
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:861` (parse), `src-tauri/src/commands/xlsx_io.rs:2731` (rewrite), `src-tauri/tests/xlsx_panes_visibility.rs:219`
- **Resolution**: `parse_sheet_freeze_pane` handles both `state="frozen"` and `state="split"`. On export, `rewrite_split_panes_in_zip` does a post-save zip rewrite to emit `state="split"` with xSplit / ySplit pixel offsets + topLeftCell verbatim (rust_xlsxwriter 0.77 only natively emits frozen). Tests: `split_panes_round_trip` and `mixed_frozen_and_split_round_trip` in `xlsx_panes_visibility.rs`.

### medium-number-format-richtext-styles (closed)
- **Title**: Promote number formats + rich text into the normalized `CellStyle` extractor
- **Refs**: `src-tauri/src/commands/xlsx_io.rs:37-49`
- **Resolution**: `num_format: Option<String>` added to `CellStyle`; because the struct derives `Hash + Eq`, number formats now participate in the workbook-level `styles_dedup` hash automatically. `resolve_xf` populates the field; `build_format` uses it as a fallback behind the per-cell `_fmt` override. Rich-text runs (`_richRuns`) remain on the per-cell path **by design** — run text and run formatting are inseparable, so cross-cell dedup is not meaningful (documented in the comment at `xlsx_io.rs:32-35`). Number-format coverage: 5 tests in `src-tauri/tests/xlsx_num_formats.rs`; rich text covered separately by `src-tauri/tests/xlsx_rich_text.rs`.

### medium-security-row-col-formula-caps (closed)
- **Title**: §5.3.2 row / column / formula limit checks in `security_scan_xlsx`
- **Refs**: `src-tauri/src/commands/security.rs:44`, `src-tauri/src/commands/security.rs:113`, COVERAGE.md FR-104
- **Effort**: M
- **Resolution**: `security_scan_xlsx` now streams worksheet XML to enforce the 1,000,000 row and 16,384 column hard caps before import, and emits a soft warning when formula count exceeds 1,000,000. Tests in `src-tauri/tests/xlsx_security_caps.rs` cover dimension-based caps, boundary values, formula-heavy warnings, and streaming fallback without `<dimension>`.

### medium-concurrent-open-race (closed)
- **Title**: Request-token "newer wins" for `openCoco` / `importXlsx`
- **Refs**: `src/store/useWorkbookStore.test.ts` audit-item-14 suite, `.claude/audit-findings.md` item 14
- **Effort**: S
- **Resolution**: Module-level `openSeq` counter in `src/store/useWorkbookStore.ts`. Each open action (`newWorkbook`, `openCoco`, `importXlsx`, `importCsv`, `restoreCandidate`, `openSnapshot`) captures `++openSeq` on entry and discards its result if the counter has moved on by the time `invoke` resolves. Previously skipped test un-skipped and now passes.

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

### low-autosave-error-status (closed)
- **Title**: `autoSave` swallows invoke rejection without flipping `saveStatus`
- **Refs**: `.claude/audit-findings.md` item 15
- **Resolution**: Already implemented at `src/store/useWorkbookStore.ts:624-631` — failed autosaves flip `saveStatus` to `"error"` for both the `.coco` and the temp/xlsx-route paths. Regression coverage at `src/store/useWorkbookStore.test.ts:1395-1427`.

### low-autosave-interval-validation (closed)
- **Title**: `setAutoSaveInterval` ignores NaN / Infinity
- **Refs**: `.claude/audit-findings.md` item 16
- **Resolution**: Already implemented at `src/store/useWorkbookStore.ts:1080-1092` — `Number.isFinite` guard + `MIN_AUTOSAVE_MS` floor + range cap. Added 2 supplementary regression tests for the sub-floor and good-then-bad-call cases.

### low-pinned-paths-array-guard (closed)
- **Title**: `loadPinnedPaths` handles non-array JSON safely
- **Refs**: `.claude/audit-findings.md` item 17
- **Resolution**: Array validation already present; added a single `console.warn` per malformed payload at `src/store/useWorkbookStore.ts:1152-1162` so the silent discard is observable. Regression tests in `useWorkbookStore.test.ts` cover `null`, plain objects, and the single-warn contract.

### low-path-router-edge-cases (closed)
- **Title**: Path router handles multi-dot filenames and CJK / emoji names without mangling
- **Refs**: `.claude/audit-findings.md` items 18-19
- **Resolution**: Implementation in `src/store/pathRouter.ts` already handles both correctly — `lastIndexOf(".")` for extension extraction (multi-dot safe) and `toLowerCase()` only on the ASCII suffix comparison (no-op on CJK / emoji; surrogate pairs unaffected since `.` is BMP). Regression suite expanded to 7 new cases in `pathRouter.test.ts` including emoji-then-known-ext, non-ASCII extensions, multi-dot + CJK + emoji, and a Windows-path round-trip.

### low-csv-import-edge-cases (closed)
- **Title**: Missing CSV import edge-case tests (full-width digits, Excel 1900 leap bug, mixed line endings, RFC4180 quoting…)
- **Refs**: `.claude/audit-findings.md` items 1-9
- **Resolution**: Audit items 1-9 are covered by tests in `src-tauri/tests/csv_import.rs` (`iso_date_with_trailing_whitespace_stays_string`, `fullwidth_digit_percentage_stays_string`, `excel_1900_leap_bug_serial_60_handled`, `extreme_dates_9999_and_1900_01_01`, `percent_minus_100_and_tiny_fraction`, `time_out_of_range_rejected`, `cr_only_line_endings_old_mac_csv`, `mixed_crlf_and_lf_in_same_file`, `quoted_field_with_internal_doublequote_and_newline`). Additional boundary edge cases now in `src-tauri/tests/csv_io.rs`: single-cell without trailing newline, BOM-only file, zero-byte file, RFC 4180 hardest case (quote+comma+newline combined), locale decimal comma stays text (bare + quoted), 32,767-char field at the Excel cell-text cap.

### low-xlsx-roundtrip-edge-cases (closed)
- **Title**: Missing xlsx round-trip tests (empty workbook export rejected, name-collision after sanitization, cross-sheet formula, 31-char sheet name)
- **Refs**: `.claude/audit-findings.md` items 10-13
- **Resolution**: Audit items 10-13 covered in `src-tauri/tests/xlsx_roundtrip.rs` (`empty_workbook_export_rejected`, `sheet_name_collision_after_sanitization` + three-way + dedup-skips-existing-suffix, `cross_sheet_formula_round_trip`, `sheet_with_31_char_name_not_truncated`). Additional boundary cases added: `max_corner_cell_xfd1048576_roundtrip` (last cell at the Excel grid corner), `number_as_text_format_preserved_through_roundtrip` (text "123" stays text vs numeric 123), `formula_referencing_missing_sheet_preserves_formula_text` (dangling `=Ghost!A1` keeps formula text + cached value), `unicode_sheet_name_japanese_chinese_emoji_roundtrip`.

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
