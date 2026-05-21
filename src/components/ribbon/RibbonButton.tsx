// A single ribbon button — issue #198.
//
// Presentational only: it renders an icon + label and forwards the declared
// action to the parent on click. Keyboard activation is handled natively by
// the underlying <button> (Enter / Space), and roving-tabindex focus order
// inside a group is owned by `Ribbon.tsx`.

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
  return (
    <button
      type="button"
      className="ribbon-btn"
      data-ribbon-btn={def.id}
      tabIndex={tabIndex}
      title={label}
      aria-label={label}
      onClick={() => onActivate(def)}
    >
      {def.icon && (
        <span className="ribbon-btn__icon" aria-hidden="true">
          {def.icon}
        </span>
      )}
      <span className="ribbon-btn__label">{label}</span>
    </button>
  );
}
