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

### cfb.rs: allocation bounds

| # | Place | Upstream behavior | Change |
|---|---|---|---|
| 18 | `Sectors::get` | A sector id from the file grows the buffer to `id * sector_size` bytes (up to terabytes) | `Sectors` knows how many bytes it can address (file size minus header, or the mini stream size). A sector that starts at or past that is an `InvalidData` error; a short last sector still reads to EOF as before |
| 19 | `Sectors::get_chain` | `with_capacity(len)` with a stream size from the directory; a FAT loop grows the chain forever | Capacity capped at the addressable size; a chain longer than the addressable size is an error |
| 20 | `Cfb::new` | `with_capacity(fat_len)` from the header; a DIFAT loop runs forever | Capacity capped at 65,536; DIFAT or FAT larger than the file is an error |
| 21 | `Header::from_reader` | `with_capacity(difat_len)` from header bytes | Capacity capped at 65,536 |

Normal files read the same as before: real files never reference sectors
outside themselves and their counts are far below the caps.

Not changed (known): `decompress_stream` (VBA source decompression) has no
output limit. A crafted VBA stream can still expand far beyond the file size.

## Upstream

The formula issues (1-13) are present unchanged in calamine 0.36.1 (checked
2026-10-08: `0x0C => ">"` and PtgStr `rgce = &rgce[2 + cch..]` still there).
Upstream locations in 0.24.0 `src/xls.rs`: `parse_formula`,
`parse_defined_names`, `read_unicode_string_no_cch`, `parse_workbook`
(Lbl, ExternSheet, DIMENSIONS, `Range::from_sparse`), `parse_sst`. In
`src/cfb.rs`: `Cfb::new`, `Header::from_reader`, `Sectors::get`,
`Sectors::get_chain`.

## Verifying

From `src-tauri/`:

```sh
# Only xls.rs and cfb.rs differ from the registry source
diff -rq --strip-trailing-cr \
  "${CARGO_HOME:-$HOME/.cargo}/registry/src/index.crates.io-1949cf8c6b5b557f/calamine-0.24.0/src" \
  vendor/calamine-xls/src

# Regression tests (Excel-made fixtures plus byte-patched crafted files)
cargo test --test xls_import
```

Fixtures are regenerated with `tests/fixtures/xls/make_fixtures.ps1`
(needs desktop Excel).

## Getting out

When upstream fixes the formula decoder: delete `vendor/calamine-xls`, remove
the `calamine_xls` line from `Cargo.toml`, change `use calamine_xls::` to
`use calamine::` in `src/commands/xls_io.rs`, and run `cargo test --test
xls_import`. Check the allocation bounds (14-21) upstream as well before
dropping the copy.
