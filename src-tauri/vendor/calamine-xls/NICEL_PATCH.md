# nicel-calamine-xls

A copy of [calamine](https://github.com/tafia/calamine) 0.24.0 (MIT, see
`LICENSE-MIT.md`) used only by `src/commands/xls_io.rs` to read Excel 97-2003
(.xls, BIFF8) files. The xlsx import keeps using the registry `calamine`.

The package is renamed (`nicel-calamine-xls`, library `calamine_xls`) so both
versions live in one binary without `[patch]`. Tests, benches and examples of
the upstream crate are not copied; doc tests are off.

## What differs from upstream

Only `src/xls.rs` and `src/cfb.rs`. Every other file under `src/` is byte for
byte the registry 0.24.0 source (line endings aside).

### xls.rs: formula decoding

Without these, a workbook with one formula containing a non-ASCII string
literal (`=IF(B2>5,"多い","少ない")`) fails to open with a panic, and many
references come out wrong.

| # | Place | Upstream behavior | Change |
|---|---|---|---|
| 1 | `read_unicode_string_no_cch` | Decodes `len` bytes, not `len` characters | Decodes `len` characters, returns bytes consumed |
| 2 | PtgStr (0x17) | Advances by `2 + cch` bytes, wrong for UTF-16 text; panics on Japanese literals | Advances by the bytes actually consumed |
| 3 | PtgGt / PtgGe (0x0D / 0x0C) | `>` and `>=` swapped | `0x0C => ">="`, `0x0D => ">"` |
| 4 | new `push_ref` / `push_sheet` / `sheet_of` | | ColRelU bits 14/15 (column/row relative) decide `$`; sheet names quoted when needed (`'My Sheet'!`, `''` escaping); XTI resolved to a sheet name |
| 5 | PtgRef (0x24) | `$` on row and column swapped | `push_ref` |
| 6 | PtgArea (0x25) | Always absolute | `push_ref` on both corners |
| 7 | PtgRef3d (0x3A) | Relative flags left in the column number (`$USN$2`) | `sheet_of` + `push_ref` |
| 8 | PtgArea3d (0x3B) | Sheet looked up by XTI index instead of through the XTI; flags in the column | `sheet_of` + `push_ref` |
| 9 | PtgRefErr3d / PtgAreaErr3d | Sheet looked up by XTI index | `sheet_of` |
| 10 | PtgExp (0x01, shared/array formula reference) | Ignored, producing an empty or wrong formula | Returns `XlsError::Unrecognized`, so the cell keeps its cached value and the caller can count it |
| 11 | Defined names (Lbl) | Name read by bytes (`合計数量` became `合計`); 3D refs always absolute, sheet unquoted | Name read by characters; `push_ref` / `push_sheet` |
| 12 | `push_sheet` | | Also quotes names that read as a cell address: A1 style (`R5`, `H30`, `FY2024`) and R1C1 style (`R`, `C`, `RC`, `R5C3`) |
| 13 | SupBook (0x01AE) | Not read; an XTI pointing at another workbook resolved against this workbook's sheets (`=[other.xls]Data!A1` became `=Sheet1!A1`) | SupBook records are collected; XTIs whose SupBook is not this workbook (`cch == 0x0401`) resolve to `#REF`, so the formula is reported as unreadable and the cached value is kept |
| 22 | `push_ref` column letters | `utils::push_column` drops the leading letter from column 26 on (`=AA1` became `=A1`, `=IV1` became `=V1`, `SUM(Z1:AB1)` became `SUM(Z1:B1)`) | New `push_col` in xls.rs (bijective base 26); `utils.rs` is left as upstream. Upstream fix belongs in `utils::push_column` |
| 23 | ExternSheet (0x0017) | `itab_last` ignored; a sheet span (`SUM('Jan:Mar'!B2)`) resolved to its first sheet only (`SUM('Jan'!B2)`, a different result) | An XTI with `itab_first != itab_last` resolves to `#REF`, like an external one: the formula keeps its cached value, a defined name on a span is dropped |
| 24 | PtgFuncVar `User` (iftab 255) | Functions newer than BIFF8 came out as `User(_xlfn.IFERROR,1/0,"x")`, which recalculates to `#NAME?` | When the first argument is `_xlfn.NAME` and NAME is in `XLFN_FUNCTIONS` (functions the Nicel engine evaluates; source in the comment), written as `NAME(args)`. Any other `User` call (VBA, add-in, unknown `_xlfn.`) is `XlsError::Unrecognized`, so the cached value is kept. Nicel-specific: upstream would only drop the `User(_xlfn.` wrapper |
| 25 | PtgStr (0x17) | A `"` inside the literal was written as is (`="say "hi""`), which does not parse | Written twice (`="say ""hi"""`) |
| 26 | PtgFunc (0x21) | `iftab > FTAB_LEN` let `iftab == FTAB_LEN` index past `FTAB_ARGC` (a panic that loses the whole workbook) | `iftab >= FTAB_LEN` is `XlsError::IfTab` |

### xls.rs: allocation bounds

A crafted file under the 50 MiB import limit could make these allocate many
gigabytes. Allocation failure aborts the process (it is not a panic and cannot
be caught).

| # | Place | Upstream behavior | Change |
|---|---|---|---|
| 14 | Worksheet cells | Any column number accepted; `Range::from_sparse` allocates rows x columns | A cell or formula at column 256 or more (past IV) makes the sheet fail with `XlsError::Len` before the range is built |
| 15 | DIMENSIONS (0x0200) | `reserve(rows * cols)` from file values; `end - start` can underflow | `saturating_sub`, reservation capped at 65,536 |
| 16 | Before `Range::from_sparse` | Cells passed in file order; `from_sparse` assumes the first and last cells bound the rows. Out-of-order rows underflow `row_end - row_start` (panic in debug, huge allocation and abort in release) | Cells and formulas stably sorted by row first |
| 17 | SST (0x00FC) | `with_capacity(count)` from the file; a negative count panics in `unwrap` | Negative count is `XlsError::Len`; reservation capped at 65,536 |
| 27 | Before `Range::from_sparse`, whole workbook | Each BoundSheet allocates its bounding rectangle (up to 2^24 cells, about 0.5 GB of values); many sheets with a cell in A1 and IV65536, or many BoundSheet records pointing at one such sheet, multiply that | The value and formula rectangles of every sheet are added up; past `MAX_WORKBOOK_CELLS` (2^25: one full sheet of values plus one of formulas) the reader returns the new `XlsError::TooManyCells` before allocating that sheet |
| 28 | `Reader::worksheet_range` / `worksheet_formula` | Return clones, so the caller briefly holds two copies of a large sheet | New `Xls::take_worksheet` moves both ranges out; `xls_io.rs` uses it |

### xls.rs: VBA

| # | Place | Upstream behavior | Change |
|---|---|---|---|
| 29 | `Xls::new_with_options` | `VbaProject::from_cfb` reads and decompresses the whole VBA project; `decompress_stream` has no output limit, and a project that fails to parse makes the workbook fail to open | Only `cfb.has_directory("_VBA_PROJECT_CUR")` is recorded, exposed as `Xls::has_vba_project()`. `vba_project()` returns `None`. VBA code is never read |

### cfb.rs: allocation bounds

| # | Place | Upstream behavior | Change |
|---|---|---|---|
| 18 | `Sectors::get` | A sector id from the file grows the buffer to `id * sector_size` bytes (up to terabytes) | `Sectors` knows how many bytes it can address (file size minus header, or the mini stream size). A sector that starts at or past that is an `InvalidData` error; a short last sector still reads to EOF as before |
| 19 | `Sectors::get_chain` | `with_capacity(len)` with a stream size from the directory; a FAT loop grows the chain forever | Capacity capped at the addressable size; a chain longer than the addressable size is an error |
| 20 | `Cfb::new` | `with_capacity(fat_len)` from the header; a DIFAT loop runs forever | Capacity capped at 65,536; DIFAT or FAT larger than the file is an error |
| 21 | `Header::from_reader` | `with_capacity(difat_len)` from header bytes | Capacity capped at 65,536 |

Normal files read the same as before: real files never reference sectors
outside themselves and their counts are far below the caps.

Not changed (known): `decompress_stream` (VBA source decompression) still has
no output limit, but the .xls path no longer reaches it (29). What is left for
#422 is the overall memory bound: a legitimate full-size sheet still takes
about 0.5 GB, and the xlsx import (registry calamine) has no cell budget.

## Upstream

The formula issues (1-13) are present unchanged in calamine 0.36.1 (checked
2026-10-08: `0x0C => ">"` and PtgStr `rgce = &rgce[2 + cch..]` still there).
Upstream locations in 0.24.0 `src/xls.rs`: `parse_formula`,
`parse_defined_names`, `read_unicode_string_no_cch`, `parse_workbook`
(Lbl, ExternSheet, DIMENSIONS, `Range::from_sparse`), `parse_sst`. In
`src/cfb.rs`: `Cfb::new`, `Header::from_reader`, `Sectors::get`,
`Sectors::get_chain`. Items 22-29 were added later and have not been checked
against 0.36.1 yet; for 22 the upstream location is `utils::push_column`.

## Verifying

From `src-tauri/`:

```sh
# Only xls.rs and cfb.rs differ from the registry source
diff -rq --strip-trailing-cr \
  "${CARGO_HOME:-$HOME/.cargo}/registry/src/index.crates.io-1949cf8c6b5b557f/calamine-0.24.0/src" \
  vendor/calamine-xls/src

# Regression tests (Excel-made fixtures plus byte-patched crafted files)
cargo test --test xls_import --test xls_contract
```

Fixtures are regenerated with `tests/fixtures/xls/make_fixtures.ps1` and
`make_more_fixtures.ps1` (need desktop Excel).

## Getting out

When upstream fixes the formula decoder: delete `vendor/calamine-xls`, remove
the `calamine_xls` line from `Cargo.toml`, change `use calamine_xls::` to
`use calamine::` in `src/commands/xls_io.rs`, and run `cargo test --test
xls_import`. Check the allocation bounds (14-21, 27) and the VBA change (29)
upstream as well before dropping the copy. `xls_io.rs` calls
`take_worksheet` and `has_vba_project`, which upstream does not have; switch
back to `worksheet_range` / `worksheet_formula` / `vba_project().is_some()`
(and accept that reading the VBA project can fail the import again).
