// A single ribbon button — issue #198, compacted in #200, dropdowns in #202.
//
// Presentational + a small amount of open/close state for dropdowns. It
// renders an icon + label and forwards the declared action to the parent on
// click. Keyboard activation is handled natively by the underlying <button>
// (Enter / Space), and roving-tabindex focus order inside a group is owned by
// `Ribbon.tsx`.
//
// Two Excel-style variants (#200): `large` is a tall vertical button (big
// icon above, label below); `small` is a compact horizontal button (small
// icon left, single-line label right). The visible label may be abbreviated
// while `title` / `aria-label` carry the full description via `tooltipKey`.
//
// #202: `small` buttons may also be `iconOnly` — the visible label is dropped
// entirely (Excel's compact B/I/U, alignment, number controls) but the full
// description is still announced via `title` / `aria-label`.
//
// #202 Phase 3: a button may own a `dropdown`. It then renders a caret (▾);
// clicking it opens a `RibbonDropdown` popover (a menu or a color palette).
// The bare `action` still fires on a plain click of the button body — Excel's
// split-button behaviour.

import { useCallback, useRef, useState } from "react";
import { t } from "../../i18n/locale";
import type { RibbonAction, RibbonButtonDef } from "./ribbonDefs";
import RibbonDropdown from "./RibbonDropdown";

interface Props {
  def: RibbonButtonDef;
  /** Roving-tabindex: only the active button in a panel is tab-reachable. */
  tabIndex: number;
  onActivate: (def: RibbonButtonDef) => void;
  /** #202 Phase 3: fires a dropdown item's action (carries an optional color
   *  for color-palette swatches). */
  onDropdownSelect: (action: RibbonAction) => void;
}

export default function RibbonButton({
  def,
  tabIndex,
  onActivate,
  onDropdownSelect,
}: Props) {
  const label = t(def.labelKey);
  const tooltip = t(def.tooltipKey ?? def.labelKey);
  const size = def.size ?? "small";
  // `iconOnly` only applies to compact (`small`) buttons; large buttons always
  // keep their label. The full description survives in title / aria-label.
  const iconOnly = size === "small" && def.iconOnly === true;
  const hasDropdown = def.dropdown != null;

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleSelect = useCallback(
    (action: RibbonAction) => {
      onDropdownSelect(action);
    },
    [onDropdownSelect],
  );

  return (
    <div
      ref={wrapRef}
      className={
        "ribbon-btn-wrap" + (hasDropdown ? " ribbon-btn-wrap--dropdown" : "")
      }
    >
      <button
        ref={triggerRef}
        type="button"
        className={
          "ribbon-btn ribbon-btn--" +
          size +
          (iconOnly ? " ribbon-btn--icon-only" : "") +
          (hasDropdown ? " ribbon-btn--has-caret" : "")
        }
        data-ribbon-btn={def.id}
        tabIndex={tabIndex}
        title={tooltip}
        aria-label={tooltip}
        {...(hasDropdown ? { "aria-haspopup": "menu" as const, "aria-expanded": open } : {})}
        onClick={() => {
          if (hasDropdown) setOpen((v) => !v);
          else onActivate(def);
        }}
      >
        {def.icon && (
          <span className="ribbon-btn__icon" aria-hidden="true">
            {def.icon}
          </span>
        )}
        {!iconOnly && <span className="ribbon-btn__label">{label}</span>}
        {hasDropdown && (
          <span className="ribbon-btn__caret" aria-hidden="true">
            ▾
          </span>
        )}
      </button>
      {hasDropdown && open && (
        <RibbonDropdown
          def={def}
          onSelect={handleSelect}
          onClose={closeDropdown}
        />
      )}
    </div>
  );
}
