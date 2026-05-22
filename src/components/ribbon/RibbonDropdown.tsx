// Ribbon dropdown popover — issue #202 Phase 3 (Excel-like dropdown buttons).
//
// Renders the popover that opens below a `RibbonButtonDef` that owns a
// `dropdown`. Two shapes are supported, picked by `def.dropdown.kind`:
//
//   menu     — a vertical `role="menu"` list of `RibbonDropdownItemDef` rows.
//              Selecting a row fires its `RibbonAction` and closes.
//   palette  — a color-swatch grid (#199). Each swatch fires the button's own
//              `fontColor` / `fillColor` Univer op with the picked color; an
//              "other color" button opens a native `<input type=color>` for
//              anything off-grid.
//
// Closing: Escape, Tab, an outside click/focus, or selecting an item. Keyboard
// navigation inside the popover follows the WAI-ARIA menu pattern (↑/↓/Home/
// End move, Enter/Space activate, Esc closes and restores focus to the
// owning button). All colors use `--coco-*` tokens so dark mode is automatic.

import { useCallback, useEffect, useRef } from "react";
import { t } from "../../i18n/locale";
import {
  RIBBON_COLOR_SWATCHES,
  type RibbonAction,
  type RibbonButtonDef,
} from "./ribbonDefs";

/** Why the popover is closing — drives whether focus returns to the trigger. */
export type DropdownCloseReason = "esc" | "select" | "tab" | "outside";

interface Props {
  /** The button that owns this dropdown — `def.dropdown` is required here. */
  def: RibbonButtonDef;
  /** The owning trigger button. An outside pointer-down landing on the trigger
   *  (or its children) must NOT close here — the trigger's own `click` toggle
   *  handles that, so #203 C1 (re-click can't close) is avoided. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Fires the chosen action. The optional `color` is supplied by palette
   *  swatches so the parent can forward it to the `univer` op. */
  onSelect: (action: RibbonAction) => void;
  /** Closes the popover. Called on Escape, Tab, outside click, or after a
   *  select. The `reason` lets the parent decide whether to restore focus. */
  onClose: (reason: DropdownCloseReason) => void;
}

export default function RibbonDropdown({
  def,
  triggerRef,
  onSelect,
  onClose,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const dropdown = def.dropdown;

  // Close on an outside pointer-down or focus leaving the popover. A
  // pointer-down on the trigger itself is NOT "outside": the trigger's own
  // click toggle closes it instead, so re-clicking the trigger toggles
  // correctly rather than closing-then-reopening (#203 C1).
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose("outside");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose, triggerRef]);

  // Focus the first interactive element when the popover opens.
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>(
      "[data-ribbon-dropdown-item]",
    );
    first?.focus();
  }, []);

  // Roving focus across the popover's items (WAI-ARIA menu keyboard model).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose("esc");
        return;
      }
      // Tab moves focus out of the popover; don't leave it orphaned-open
      // (#203 M3). The default Tab focus move is preserved (no preventDefault).
      if (e.key === "Tab") {
        onClose("tab");
        return;
      }
      const items = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>(
          "[data-ribbon-dropdown-item]",
        ) ?? [],
      );
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: number | null = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight")
        next = (current + 1 + items.length) % items.length;
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
        next = (current - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      if (next === null) return;
      e.preventDefault();
      // Stop the arrow / Home / End keys here: the popover renders inside
      // ribbon__panel, whose own onKeyDown roving-nav would otherwise also
      // fire and yank focus out of the open dropdown (#202 review C1).
      e.stopPropagation();
      items[next]?.focus();
    },
    [onClose],
  );

  const select = useCallback(
    (action: RibbonAction) => {
      onSelect(action);
      onClose("select");
    },
    [onSelect, onClose],
  );

  if (!dropdown) return null;

  return (
    <div
      ref={rootRef}
      className="ribbon-dropdown"
      role="menu"
      aria-label={t(def.tooltipKey ?? def.labelKey)}
      onKeyDown={handleKeyDown}
    >
      {dropdown.kind === "menu" ? (
        dropdown.items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-ribbon-dropdown-item={item.id}
            className="ribbon-dropdown__item"
            onClick={() => select(item.action)}
          >
            {item.icon && (
              <span className="ribbon-dropdown__item-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="ribbon-dropdown__item-label">
              {t(item.labelKey)}
            </span>
          </button>
        ))
      ) : (
        <>
          <div className="ribbon-dropdown__swatches" role="group">
            {RIBBON_COLOR_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-ribbon-dropdown-item={color}
                className="ribbon-dropdown__swatch"
                style={{ backgroundColor: color }}
                title={color}
                aria-label={color}
                onClick={() =>
                  select({ kind: "univer", op: dropdown.op, color })
                }
              />
            ))}
          </div>
          {/* "Other color": a real menuitem button that opens a native color
           *  picker. The <input> is kept off the menu tree (aria-hidden +
           *  visually hidden) so `role="menu"` only ever holds menuitems
           *  (#203 M2). */}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-ribbon-dropdown-item="more"
            className="ribbon-dropdown__more"
            onClick={() => colorInputRef.current?.click()}
          >
            {t("ribbon.menu.color.more")}
          </button>
          <input
            ref={colorInputRef}
            type="color"
            aria-hidden="true"
            tabIndex={-1}
            className="ribbon-dropdown__more-input"
            onChange={(e) =>
              select({ kind: "univer", op: dropdown.op, color: e.target.value })
            }
          />
        </>
      )}
    </div>
  );
}
