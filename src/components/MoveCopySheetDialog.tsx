import { useEffect, useMemo, useState } from "react";
import "./MoveCopySheetDialog.css";

interface Props {
  /** Source sheet id (the one being moved/copied). */
  sheetId: string;
  /** Source sheet display name, shown read-only in the header. */
  sheetName: string;
  /** All sheets in tab order, used to populate the position dropdown. */
  sheets: Array<{ sheetId: string; name: string }>;
  /**
   * Fired with the chosen target index (0-based in the final sheetOrder, where
   * `sheets.length` means "move to end") and whether the source should be
   * duplicated instead of moved. The dialog calls onClose afterward.
   */
  onApply: (params: { targetIndex: number; createCopy: boolean }) => void;
  onClose: () => void;
}

// Special sentinel for the "(end)" option. -1 keeps real indices intact.
const END_SENTINEL = -1;

export default function MoveCopySheetDialog({
  sheetId,
  sheetName,
  sheets,
  onApply,
  onClose,
}: Props) {
  // Default position = current position of the source sheet (no-op when the
  // user clicks Apply without changes, matching Excel's defaults).
  const currentIndex = useMemo(
    () => sheets.findIndex((s) => s.sheetId === sheetId),
    [sheets, sheetId],
  );
  const [beforeId, setBeforeId] = useState<string | number>(() => {
    // Default: place "before" the next sibling, or end-sentinel if it is the
    // last sheet.
    if (currentIndex < 0) return END_SENTINEL;
    if (currentIndex >= sheets.length - 1) return END_SENTINEL;
    return sheets[currentIndex + 1]?.sheetId ?? END_SENTINEL;
  });
  const [createCopy, setCreateCopy] = useState<boolean>(false);

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

  const apply = () => {
    // Translate the dropdown choice into a final sheetOrder index.
    //   END_SENTINEL    → length (caller clamps; effectively "append")
    //   any sheetId     → index of that sheet (we want to insert *before* it)
    // When moving (not copying) we need to account for the source being
    // removed first; the moveSheet helper handles that internally so we just
    // report the desired final-array index here.
    let targetIndex: number;
    if (beforeId === END_SENTINEL) {
      targetIndex = createCopy ? sheets.length : sheets.length - 1;
    } else {
      const idx = sheets.findIndex((s) => s.sheetId === beforeId);
      if (idx < 0) {
        targetIndex = sheets.length;
      } else if (createCopy) {
        targetIndex = idx;
      } else {
        // Moving: if the target sits after the source, removing the source
        // shifts everything left by one, so subtract to land "before" the
        // chosen sibling in the post-removal array.
        targetIndex = idx > currentIndex ? idx - 1 : idx;
      }
    }
    onApply({ targetIndex, createCopy });
    onClose();
  };

  return (
    <div className="mcs-backdrop" onClick={onClose}>
      <div
        className="mcs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcs-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mcs-header">
          <h2 id="mcs-title" className="mcs-title">
            シートの移動 / コピー: {sheetName}
          </h2>
          <button
            type="button"
            className="mcs-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="mcs-body">
          <label className="mcs-field">
            <span className="mcs-field-label">挿入先 (この前に挿入)</span>
            <select
              className="mcs-input"
              value={String(beforeId)}
              onChange={(e) => {
                const v = e.target.value;
                setBeforeId(v === String(END_SENTINEL) ? END_SENTINEL : v);
              }}
              data-testid="mcs-position"
            >
              {sheets.map((s) => (
                <option key={s.sheetId} value={s.sheetId}>
                  {s.name}
                </option>
              ))}
              <option value={String(END_SENTINEL)}>(末尾へ移動)</option>
            </select>
          </label>
          <label className="mcs-checkbox-row">
            <input
              type="checkbox"
              checked={createCopy}
              onChange={(e) => setCreateCopy(e.target.checked)}
              data-testid="mcs-copy"
            />
            <span>コピーを作成する</span>
          </label>
        </div>
        <footer className="mcs-footer">
          <button type="button" className="mcs-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="mcs-btn mcs-btn--primary"
            onClick={apply}
            data-testid="mcs-apply"
          >
            OK
          </button>
        </footer>
      </div>
    </div>
  );
}
