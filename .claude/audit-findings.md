# Audit findings (T1 + T2) — 2026-05-13

## T1: Critical bugs to fix

**CRITICAL-1**: `detect_unsupported_features` reads each worksheet XML fully into memory via `read_to_string`. A 50MB compressed sheet can exceed 500MB decompressed. The `is_ok()` short-circuit silently returns Ok on OOM/decode failure, producing a false-negative for feature detection on exactly the workbooks that need it most.

Location: `src-tauri/src/commands/xlsx_io.rs` ~ line 94
Fix: Stream via BufReader looking for the literal substring with read_until, or cap reads at ~5 MB per sheet.

**MINOR-1**: Comment false-positive in CF/data-validation substring scans.
`<!-- <conditionalFormatting --> ` would be matched. Either reject commented occurrences (do a quick comment-strip pass) or document the false-positive acceptance in a test.

## T2: Missing edge-case tests

CSV import (`src-tauri/tests/csv_import.rs`):
1. `iso_date_with_trailing_whitespace` — "2026-05-13 " stays string (verifies strict full-match parsing)
2. `fullwidth_digit_percentage_stays_string` — "５０％" (full-width chars) doesn't become 0.5
3. `excel_1900_leap_bug_serial_60_handled` — 1900-02-28 → 59 and 1900-03-01 → 61
4. `extreme_dates_9999_and_1900_01_01` — extreme dates round-trip
5. `percent_minus_100_and_tiny_fraction` — "-100%", "0.0001%", "1000%"
6. `time_24_00_rejected_but_23_59_60_too` — out-of-range times stay strings
7. `cr_only_line_endings_old_mac_csv` — bytes b"a,b\rc,d\r" produces two rows
8. `mixed_crlf_and_lf_in_same_file` — heterogeneous line endings
9. `quoted_field_with_internal_doublequote_and_newline` — RFC4180 quoting

xlsx round-trip (`src-tauri/tests/xlsx_roundtrip.rs`):
10. `empty_workbook_export_rejected` — XLSX_EMPTY_SNAPSHOT + no zero-byte file on disk
11. `sheet_name_collision_after_sanitization` — two sheets that collide after sanitize
12. `cross_sheet_formula_round_trip` — =Sheet2!A1 cross-sheet ref preserved
13. `sheet_with_31_char_name_not_truncated` — exact-boundary test

Frontend store (`src/store/useWorkbookStore.test.ts`):
14. Concurrent openCoco vs importXlsx race — newer wins
15. autoSave swallows invoke rejection without flipping saveStatus
16. setAutoSaveInterval ignores NaN and Infinity
17. loadPinnedPaths handles non-array JSON

Path router (`src/store/pathRouter.test.ts`):
18. Multi-dot filename `my..weird..name.xlsx` routes correctly
19. CJK / emoji filenames don't get mangled by toLowerCase
