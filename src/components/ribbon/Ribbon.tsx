// Excel-like ribbon — issue #198.
//
// Renders the declarative `RIBBON_TABS` model: a `role="tablist"` strip plus
// one `role="tabpanel"` per tab. Only the active panel is mounted. Buttons
// dispatch one of three action kinds:
//
//   editorCommand — re-emits `coco:editor-command` so the existing 108-command
//                   surface in EditorScreen handles it. No new ids invented.
//   univer        — forwarded to `onUniverAction`, which EditorScreen wires
//                   to facade calls (FRange.setFontWeight, FWorkbook.undo...).
//   menuAction    — emits the `menu-action` window event (#202): the File tab
//                   uses this to drive new/open/save/export/settings through
//                   the existing `useMenuActions` dispatcher, now that the
//                   Tauri native menu bar has been removed.
//   goHome        — in-app navigation back to the start screen (#204): the
//                   File tab's "Back to Home" button calls the `onGoHome` prop.
//
// Accessibility (#177): the tablist supports ←/→/Home/End; tabs use a roving
// tabindex; each panel uses a roving tabindex across its buttons so Tab moves
// in/out of the ribbon as a single stop. All labels are i18n via `t()`.

import { useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../../i18n/locale";
import {
  RIBBON_TABS,
  type RibbonAction,
  type RibbonButtonDef,
  type UniverActionId,
} from "./ribbonDefs";
import RibbonButton from "./RibbonButton";
import "./Ribbon.css";

interface Props {
  /** Invoked for `kind: "univer"` buttons. EditorScreen maps the op id to a
   *  facade call. Kept as a prop so all `fUniverRef` plumbing stays there.
   *  #202 Phase 3: `color` is supplied by color-palette dropdown swatches. */
  onUniverAction: (op: UniverActionId, color?: string) => void;
  /** "Back to Home" navigation. #204: invoked by the File tab's `goHome`
   *  button (previously a standalone strip button). */
  onGoHome: () => void;
  /** Active workbook file label, shown at the tab strip's right edge. */
  fileLabel: string;
  /** Absolute path of the open file, used as the file-label tooltip. */
  filePath?: string;
}

export default function Ribbon({
  onUniverAction,
  onGoHome,
  fileLabel,
  filePath,
}: Props) {
  // #204: default to the Home tab. The File tab sits first in `RIBBON_TABS`
  // (#202), but Home is the expected landing tab — fall back to the first tab
  // only if Home is somehow absent.
  const [activeTabId, setActiveTabId] = useState(
    () => (RIBBON_TABS.find((tab) => tab.id === "home") ?? RIBBON_TABS[0]).id,
  );
  // Roving tabindex within the active panel — index of the focusable button.
  const [activeBtnIndex, setActiveBtnIndex] = useState(0);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activeTabIdx = Math.max(
    0,
    RIBBON_TABS.findIndex((tab) => tab.id === activeTabId),
  );
  const activeTab = RIBBON_TABS[activeTabIdx];

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setActiveBtnIndex(0);
  }, []);

  // Arrow-key navigation across the tab strip (#177 / WAI-ARIA tabs pattern).
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (activeTabIdx + 1) % RIBBON_TABS.length;
    else if (e.key === "ArrowLeft")
      nextIdx = (activeTabIdx - 1 + RIBBON_TABS.length) % RIBBON_TABS.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = RIBBON_TABS.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = RIBBON_TABS[nextIdx];
    selectTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  // Flatten the active panel's buttons so a roving tabindex can span groups.
  const panelButtons: RibbonButtonDef[] = activeTab.groups.flatMap(
    (g) => g.buttons,
  );

  // Dispatch a single `RibbonAction` — shared by top-level button clicks and
  // dropdown item / color-palette selections (#202 Phase 3).
  const runAction = useCallback(
    (action: RibbonAction) => {
      if (action.kind === "editorCommand") {
        window.dispatchEvent(
          new CustomEvent("coco:editor-command", { detail: action.commandId }),
        );
      } else if (action.kind === "menuAction") {
        // #202: re-emit the same `menu-action` event the native menu fired so
        // `useMenuActions` handles file/store operations without duplication.
        void getCurrentWindow()
          .emit("menu-action", action.menuId)
          .catch(() => undefined);
      } else if (action.kind === "goHome") {
        // #204: in-app navigation back to the start screen (unsaved-changes
        // guarded by EditorScreen's `goHomeAfterConfirm`).
        onGoHome();
      } else {
        onUniverAction(action.op, action.color);
      }
    },
    [onUniverAction, onGoHome],
  );

  const handleButton = useCallback(
    (def: RibbonButtonDef) => runAction(def.action),
    [runAction],
  );

  // Arrow-key navigation across the active panel's buttons.
  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (panelButtons.length === 0) return;
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      nextIdx = (activeBtnIndex + 1) % panelButtons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      nextIdx = (activeBtnIndex - 1 + panelButtons.length) % panelButtons.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = panelButtons.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    setActiveBtnIndex(nextIdx);
    const target = e.currentTarget.querySelector<HTMLButtonElement>(
      `[data-ribbon-btn="${panelButtons[nextIdx].id}"]`,
    );
    target?.focus();
  };

  let runningBtnIndex = -1;

  return (
    <div className="ribbon" role="region" aria-label={t("ribbon.a11y.ribbon")}>
      <div className="ribbon__strip">
        <div
          className="ribbon__tablist"
          role="tablist"
          aria-label={t("ribbon.a11y.tablist")}
        >
          {RIBBON_TABS.map((tab) => {
          const selected = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`ribbon-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`ribbon-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={"ribbon__tab" + (selected ? " ribbon__tab--active" : "")}
              onClick={() => selectTab(tab.id)}
              onKeyDown={handleTabKeyDown}
            >
              {t(tab.labelKey)}
            </button>
          );
        })}
        </div>
        <span className="ribbon__filename" title={filePath}>
          {fileLabel}
        </span>
      </div>
      <div
        className="ribbon__panel"
        role="tabpanel"
        id={`ribbon-panel-${activeTab.id}`}
        aria-labelledby={`ribbon-tab-${activeTab.id}`}
        onKeyDown={handlePanelKeyDown}
      >
        {activeTab.groups.map((group) => (
          <div
            key={group.id}
            className="ribbon__group"
            role="group"
            aria-label={t(group.labelKey)}
          >
            <div className="ribbon__group-buttons">
              {group.buttons.map((btn) => {
                runningBtnIndex += 1;
                const idx = runningBtnIndex;
                return (
                  <RibbonButton
                    key={btn.id}
                    def={btn}
                    tabIndex={idx === activeBtnIndex ? 0 : -1}
                    onActivate={handleButton}
                    onDropdownSelect={runAction}
                  />
                );
              })}
            </div>
            <div className="ribbon__group-label">{t(group.labelKey)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
