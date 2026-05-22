// A single ribbon button — issue #198, compacted in #200.
//
// Presentational only: it renders an icon + label and forwards the declared
// action to the parent on click. Keyboard activation is handled natively by
// the underlying <button> (Enter / Space), and roving-tabindex focus order
// inside a group is owned by `Ribbon.tsx`.
//
// Two Excel-style variants (#200): `large` is a tall vertical button (big
// icon above, label below); `small` is a compact horizontal button (small
// icon left, single-line label right). The visible label may be abbreviated
// while `title` / `aria-label` carry the full description via `tooltipKey`.
//
// #202: `small` buttons may also be `iconOnly` — the visible label is dropped
// entirely (Excel's compact B/I/U, alignment, number controls) but the full
// description is still announced via `title` / `aria-label`.

import { t } from "../../i18n/locale";
import type { RibbonButtonDef } from "./ribbonDefs";

interface Props {
  def: RibbonButtonDef;
  /** Roving-tabindex: only the active button in a panel is tab-reachable. */
  tabIndex: number;
  onActivate: (def: RibbonButtonDef) => void;
}

export default function RibbonButton({ def, tabIndex, onActivate }: Props) {
  const label = t(def.labelKey);
  const tooltip = t(def.tooltipKey ?? def.labelKey);
  const size = def.size ?? "small";
  // `iconOnly` only applies to compact (`small`) buttons; large buttons always
  // keep their label. The full description survives in title / aria-label.
  const iconOnly = size === "small" && def.iconOnly === true;
  return (
    <button
      type="button"
      className={
        "ribbon-btn ribbon-btn--" + size + (iconOnly ? " ribbon-btn--icon-only" : "")
      }
      data-ribbon-btn={def.id}
      tabIndex={tabIndex}
      title={tooltip}
      aria-label={tooltip}
      onClick={() => onActivate(def)}
    >
      {def.icon && (
        <span className="ribbon-btn__icon" aria-hidden="true">
          {def.icon}
        </span>
      )}
      {!iconOnly && <span className="ribbon-btn__label">{label}</span>}
    </button>
  );
}
