import { useEffect, useState } from "react";
import "./UnhideSheetDialog.css";

interface HiddenSheet {
  sheetId: string;
  name: string;
}

interface Props {
  /** Currently-hidden sheets, in sheetOrder. Empty array shows the empty state. */
  hiddenSheets: HiddenSheet[];
  /**
   * Called with the sheetId of the row the user picked. The parent is
   * responsible for clearing `_sheetState` and applying the mutated snapshot;
   * the dialog still calls onClose afterward.
   */
  onUnhide: (sheetId: string) => void;
  onClose: () => void;
}

export default function UnhideSheetDialog({ hiddenSheets, onUnhide, onClose }: Props) {
  // Default to the first hidden sheet so Enter immediately submits (matches
  // Excel's Unhide dialog behaviour). Falls back to null when there's nothing
  // to pick.
  const [selectedId, setSelectedId] = useState<string | null>(
    hiddenSheets.length > 0 ? hiddenSheets[0].sheetId : null,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (!selectedId) return;
    onUnhide(selectedId);
    onClose();
  };

  const isEmpty = hiddenSheets.length === 0;

  return (
    <div className="ush-backdrop" onClick={onClose}>
      <div
        className="ush-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ush-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ush-header">
          <h2 id="ush-title" className="ush-title">シートの再表示</h2>
          <button
            type="button"
            className="ush-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="ush-body">
          {isEmpty ? (
            <p className="ush-empty">非表示のシートはありません。</p>
          ) : (
            <ul className="ush-list" role="listbox" aria-label="非表示シート">
              {hiddenSheets.map((sheet, index) => {
                const isSelected = sheet.sheetId === selectedId;
                return (
                  <li key={sheet.sheetId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={
                        "ush-row" + (isSelected ? " ush-row--active" : "")
                      }
                      onClick={() => setSelectedId(sheet.sheetId)}
                      onDoubleClick={() => {
                        setSelectedId(sheet.sheetId);
                        onUnhide(sheet.sheetId);
                        onClose();
                      }}
                      data-testid={`ush-row-${sheet.sheetId}`}
                    >
                      <span className="ush-row-index">{index + 1}.</span>
                      <span className="ush-row-name">{sheet.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="ush-footer">
          <button type="button" className="ush-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="ush-btn ush-btn--primary"
            onClick={submit}
            disabled={isEmpty || !selectedId}
            data-testid="ush-apply"
          >
            表示
          </button>
        </footer>
      </div>
    </div>
  );
}
