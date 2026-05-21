# Screen Reader Testing — Manual Regression Procedure

Issue #177 (follow-up to #155). Screen-reader behavior cannot be verified by
automated tests alone — the announcement *content* is unit-tested
(`src/store/announce.test.ts`), and the live-region / focus-trap *mechanics*
are tested with happy-dom (`src/components/LiveRegion.test.tsx`,
`src/hooks/useFocusTrap.test.tsx`), but how an actual screen reader voices
those changes must be checked by hand. Run this procedure before any release
that touches the editor shell, dialogs, status bar, or selection handling.

## Scope of automation

| Concern | Covered automatically? | Where |
| --- | --- | --- |
| Announcement message strings (ja/en) | Yes | `src/store/announce.test.ts` |
| Live region renders + updates | Yes (happy-dom) | `src/components/LiveRegion.test.tsx` |
| Focus trap / Tab cycle / Escape / restore | Yes (happy-dom) | `src/hooks/useFocusTrap.test.tsx` |
| Actual speech output (NVDA / JAWS / Narrator) | **No — manual** | this document |
| Univer grid's own a11y (cell editor, formula bar) | No — upstream | n/a |

## Tested screen readers

- **NVDA** (NonVisual Desktop Access) — free, the primary target. Download:
  <https://www.nvaccess.org/download/>
- **JAWS** — commercial; test with a trial or licensed copy if available.
- **Windows Narrator** — built into Windows (`Ctrl + Win + Enter` to toggle).

Test in a release or `tauri dev` build. Browser-only (`npm run dev` in a
tab) is acceptable for a first pass but the Tauri webview is the shipping
surface, so confirm at least once there.

## General setup

1. Start the screen reader **before** launching Coco.
2. Open a workbook with a mix of text, numbers, and a few empty cells.
3. Put the screen reader in "focus" / "forms" mode where applicable so key
   presses reach the app.

---

## AC1 — Cell navigation announces "column X row Y: value"

1. Click a cell in the grid, then move with arrow keys.
2. **Expected:** on each move the screen reader speaks
   `column <letter> row <number>: <value>` (English locale) or
   `列<letter> 行<number>: <値>` (Japanese locale). Empty cells say
   `empty cell` / `空のセル`.
3. Select a multi-cell range with Shift+Arrow.
   **Expected:** speaks `Range A1:C4 selected, 12 cells` / `範囲 A1:C4 を選択、12 セル`.

Notes: the announcement is driven by polling Univer's active range
(`EditorScreen.tsx`, the `#177` selection-announce effect) and routed through
the polite live region. The very first selection after opening is intentionally
silent (baseline).

## AC2 — Edit-mode transitions are announced

1. Select a cell and press F2 or start typing.
   **Expected:** the screen reader says `Edit mode` / `編集モード`.
2. Press Enter to commit.
   **Expected:** `Committed` / `確定しました`.
3. Start another edit and press Escape.
   **Expected:** `Edit cancelled` / `編集を取り消しました`.

Notes: `buildEditModeAnnouncement()` produces these strings. Univer owns the
in-cell editor; if a build of Univer does not surface edit-mode events, this
falls back to the generic value re-announce after the commit — still audible.

## AC3 — Errors are spoken via an assertive live region

1. Trigger an editor operation error (e.g. run Sort on an invalid range, or
   take a snapshot when none is available).
2. **Expected:** the screen reader **interrupts** and speaks the error text
   immediately (assertive region), matching the red status-bar message.
3. Trigger a save failure (e.g. make the target path read-only, Ctrl+S).
   **Expected:** speaks `Save failed` / `保存に失敗しました`.

## AC4 — Keyboard-only dialog operation (focus trap)

Repeat for each dialog below:

1. Open the dialog **by keyboard** where possible (e.g. `Ctrl+,` Settings,
   `F1` Help) or by tabbing to and activating the trigger button.
2. **Expected:** focus lands on the first control inside the dialog.
3. Press Tab repeatedly to the last control, then Tab once more.
   **Expected:** focus wraps to the first control (does not escape to the
   page behind the dialog).
4. Press Shift+Tab from the first control.
   **Expected:** focus wraps to the last control.
5. Press Escape.
   **Expected:** the dialog closes and focus returns to the element that
   opened it.

Dialogs wired with the shared `useFocusTrap` hook (verify all):

- Settings (`Ctrl+,`)
- Help (`F1` / `Ctrl+/`)
- Sort
- Number Format (`Ctrl+1`)
- Named Ranges (`Ctrl+F3`)
- Goal Seek

Other dialogs use a per-dialog Escape handler; spot-check a few for
Escape-to-close and that focus is not visually lost.

## AC5 — Visible focus ring

1. Using only the keyboard (Tab), move focus across toolbar buttons, status
   bar controls, and dialog inputs.
2. **Expected:** a clear focus outline (`--coco-focus-ring`, themed for light
   and dark) is visible on the focused element.
3. Click the same controls with the mouse.
   **Expected:** no focus ring is drawn on pointer interaction
   (`:focus-visible` heuristic).
4. Toggle dark mode (Settings → Theme) and re-check the ring is still
   visible against the dark surfaces.

## Toolbar / status bar roles

1. With the screen reader running, navigate to the editor toolbar.
   **Expected:** announced as a toolbar named "Editor toolbar" /
   "エディタツールバー"; the Home button is announced with its label.
2. Navigate to the status bar.
   **Expected:** announced as a status region named "Status bar" /
   "ステータスバー".

---

## Recording results

For each release, note: screen reader + version, OS build, Coco version, and
pass/fail per AC above. File any regression as a new issue referencing #177.
