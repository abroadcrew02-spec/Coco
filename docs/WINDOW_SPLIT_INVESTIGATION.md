# Window split follow-up investigation (issue #178)

Follow-up to #156 ("表示 → 分割" / View → Split). Three residual items.

Date: 2026-05-21. Univer: 0.5.x (`@univerjs/sheets-ui`, `@univerjs/core`,
`@univerjs/sheets`).

## Summary of dispositions

| # | Item | Disposition |
|---|------|-------------|
| 1 | Draggable split bar | Partially native; dedicated split bar upstream-blocked |
| 2 | Fully independent 4 panes | Univer constraint — approximation kept |
| 3 | Immediate visual reflection on direct xlsx open | **Implemented** |

---

## Item 3 — immediate visual reflection on direct xlsx open (implemented)

### Problem

Univer's freeze renderer (`HeaderFreezeRenderController` in
`@univerjs/sheets-ui`) only activates when a worksheet snapshot carries a
populated `IWorksheetData.freeze` field
(`{ xSplit, ySplit, startRow, startColumn }`). Coco's xlsx import path
(`src-tauri/src/commands/xlsx_io.rs`) historically wrote only the Coco-private
`_freezePane` marker (`{ row, col, state, topLeft? }`) and never the native
`freeze` field. Result: opening an xlsx that already contains a frozen / split
pane showed **no visual freeze** until the user re-toggled it through the View
menu.

### Fix

Added a pure helper `freeze_field_for_pane(row, col, row_count, col_count)` in
`xlsx_io.rs` that projects `_freezePane` onto Univer's `IFreeze` shape, and
wired it into the import path right after `sheet_obj["_freezePane"]` is set. So
`sheets.<id>.freeze` is now populated on direct open and the renderer activates
immediately.

`_freezePane` still drives the xlsx round-trip (it carries the `state`
discriminator that distinguishes `frozen` vs `split`); `freeze` is purely the
in-app visual projection.

### Semantics & bounds handling

* `state="frozen"` — `row`/`col` are fixed row/column counts → direct mapping.
* `state="split"` — `row`/`col` carry the raw `xSplit`/`ySplit` verbatim.
  Coco-authored splits store row/col **indices** here (see #156's
  `splitPane.ts` write side); Excel-authored splits store **pixel/twip
  offsets**. Univer 0.5.x has no split renderer, so the freeze renderer is the
  visual approximation in both cases.
* An anchor at or beyond the sheet's `row_count` / `column_count` (e.g. an
  Excel pixel-offset split that dwarfs the sheet) is **rejected** — the
  projection is skipped rather than clamped, since clamping would silently
  shift the freeze line. The `_freezePane` marker still round-trips in that
  case; only the visual is dropped (the file opens un-split, same as before
  this change).
* Univer's "no freeze on this axis" sentinel is `startRow`/`startColumn = -1`,
  used for horizontal-only (`col=0`) and vertical-only (`row=0`) panes.

This also fixes the common case for **frozen** panes — previously a frozen-pane
xlsx was likewise only visualized after a toggle.

---

## Item 1 — draggable split bar

### Finding

Univer 0.5.x's `HeaderFreezeRenderController`
(`@univerjs/sheets-ui/lib/types/controllers/render-controllers/freeze.render-controller.d.ts`)
**does** implement freeze-line dragging natively: it owns `_freezeDown`,
`_scenePointerMoveSub`, `_scenePointerUpSub`, `_changeToRow`,
`_changeToColumn`, `_changeToOffsetX/Y`, and renders draggable
`_rowFreezeHeaderRect` / `_columnFreezeHeaderRect` handles.

Because Coco's split feature uses `FWorksheet.setFreeze` as its renderer
(Univer exposes no dedicated split renderer), **the freeze line that Coco's
split produces is already draggable** through Univer's built-in handles — the
user can drag it to reposition the split.

### Residual gap

What Univer 0.5.x still lacks is a *dedicated split bar* visually distinct from
the freeze handle (Excel draws a thicker, separate split bar with a different
affordance, and `state="split"` panes have no locked top-left region — see
item 2). There is no public API to render or drag such a bar independently of
freeze. That part remains **upstream-blocked**, as the issue notes.

No code change for item 1: native freeze-line drag already covers the
practical need; a separate split bar would require Univer core changes
(out of scope — no patch-package core edits).

---

## Item 2 — fully independent 4 panes

### Finding

Excel's `state="split"` cuts the sheet into 2 or 4 viewports where **every**
pane (including top-left) scrolls independently — there is no locked region.

Univer 0.5.x's only multi-viewport primitive is `setFreeze` / `IFreeze`, whose
contract is inherently asymmetric: `startRow`/`startColumn` define the *first
scrollable* cell, and everything above/left of it is a **fixed** region. The
freeze renderer always treats the top-left quadrant as locked. There is no
`IFreeze` variant, facade method, or render controller in 0.5.x that produces
four independently-scrolling viewports.

### Disposition

Univer constraint. Coco keeps the `setFreeze`-based approximation (top-left
fixed) for the in-app view, while `_freezePane state="split"` preserves Excel's
true semantics through the xlsx round-trip. Achieving fully-independent panes
would require a Univer core feature (a split render controller) — out of scope
for #178 and not addressable without core changes.
