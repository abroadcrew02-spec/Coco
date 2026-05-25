# Dynamic-array formulas (SPILL) on Coco — Univer 0.24 support matrix

Snapshot date 2026-05-25. Issue #241.

## Headline

**No engine work required.** Univer 0.24 implements every Excel-365 dynamic-array
function listed in the original tasking. Coco's only gap was the JA `abstract`
text for 15 of them in `FUNCTION_LIST_JA_ABSTRACT`; the PR that adds this doc
also fills those slots.

The remaining work is a **runtime smoke test** to confirm the engine actually
spills and the JA tooltip shows up — tracked separately as `#241 follow-up`.

## What Univer 0.24 ships (verified via `node_modules` enum walk)

| Category | Function | Univer enum location | Coco JA `abstract` |
| --- | --- | --- | --- |
| Lookup | `FILTER` | `FunctionLookupName` | ✅ existed |
| Lookup | `SORT` | `FunctionLookupName` | ✅ existed |
| Lookup | `SORTBY` | `FunctionLookupName` | ✅ existed |
| Lookup | `UNIQUE` | `FunctionLookupName` | ✅ existed |
| Lookup | `XLOOKUP` | `FunctionLookupName` | ✅ existed |
| Lookup | `XMATCH` | `FunctionLookupName` | ✅ existed |
| Lookup | `TAKE` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `DROP` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `HSTACK` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `VSTACK` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `TOROW` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `TOCOL` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `WRAPROWS` | `FunctionLookupName` | 🟡 added in this PR |
| Lookup | `WRAPCOLS` | `FunctionLookupName` | 🟡 added in this PR |
| Math | `SEQUENCE` | `FunctionMathName` | ✅ existed |
| Math | `RANDARRAY` | `FunctionMathName` | ✅ existed |
| Logical | `LAMBDA` | `FunctionLogicalName` | ✅ existed |
| Logical | `LET` | `FunctionLogicalName` | 🟡 added in this PR |
| Logical | `BYROW` | `FunctionLogicalName` | 🟡 added in this PR |
| Logical | `BYCOL` | `FunctionLogicalName` | 🟡 added in this PR |
| Logical | `MAP` | `FunctionLogicalName` | 🟡 added in this PR |
| Logical | `REDUCE` | `FunctionLogicalName` | 🟡 added in this PR |
| Logical | `SCAN` | `FunctionLogicalName` | 🟡 added in this PR |
| Logical | `MAKEARRAY` | `FunctionLogicalName` | 🟡 added in this PR |

**Coverage**: 24 / 24 functions implemented in engine. After this PR, **24 / 24 with JA `abstract` overrides** as well.

## Things that need an in-app runtime smoke

(`tauri dev` + manual entry — tracked as a follow-up because the WebView2
CDP env conflict still blocks automation.)

- `=SEQUENCE(5)` spills into A1:A5 with 1..5.
- `=UNIQUE(A1:A10)` spills into the cells directly below the formula cell.
- `=SORT(A1:A10)` spills sorted ascending.
- `=FILTER(A1:A10, B1:B10>0)` spills only matching rows.
- `=XLOOKUP("foo", A:A, B:B)` returns the matching cell.
- `=LET(x, 5, x*2)` returns 10 in a single cell (no spill).
- `=MAP({1,2,3}, LAMBDA(v, v*v))` spills `{1,4,9}` horizontally.
- `=BYROW(A1:C3, LAMBDA(r, SUM(r)))` spills 3 row-sums vertically.
- `#SPILL!` error: type a value in the spill landing zone first; the spill
  formula should produce `#SPILL!`.

## Why no engine work was needed

Excel introduced dynamic arrays in mid-2018 (Office 365 calc-engine v2). Univer
re-implemented the spill behavior from scratch when its formula engine was
first opened to the public (~2024). By Univer 0.20+ the engine ships
TypeScript classes for every published Excel 365 array primitive.

This is in contrast to **#235 (Power Query)** and **#240 (Power Pivot / DAX)**,
where Univer has no comparable engine and Coco would need to build the entire
runtime from scratch.

## Out of scope (intentionally)

- Excel 2024+ `GROUPBY` / `PIVOTBY` — not in the Univer 0.24 enum walk.
  If those land in Univer 0.25+ we can add JA `abstract` entries with a small
  PR.
- Cross-language formula entry quirks (e.g., function-name autocomplete
  showing JA glosses without breaking commit-on-enter) — exists in the
  formula-picker UI today; the JA `abstract` map is just a richer hover.

## Related

- Issue #241
- Issue #247 (Formula autocomplete tooltip enhance) — would build on this
  layer to surface usage examples, not just `abstract`.
- `src/components/univerFunctionListJa.ts` — the JA `abstract` overlay.
- `src/components/cocoUniverLocale.ts` — `mergeLocales` wiring.
