import { useEffect, useState } from "react";
import "./SheetPickerModal.css";

interface Props {
  sheets: string[];
  onConfirm: (index: number) => void;
  onCancel: () => void;
  /** Optional handler for "export every sheet at once" — when provided
   *  the picker renders an extra primary button. Multi-sheet workbooks only. */
  onExportAll?: () => void;
}

export default function SheetPickerModal({ sheets, onConfirm, onCancel, onExportAll }: Props) {
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onConfirm, onCancel]);

  return (
    <div className="sheet-picker-backdrop" onClick={onCancel}>
      <div
        className="sheet-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="sheet-picker-title" className="sheet-picker-title">
          CSV に出力するシートを選択
        </h2>
        <p className="sheet-picker-hint">
          CSV は 1 シートを 1 ファイルに書き出します。複数シートをまとめて出力するには「全シートを出力」をご利用ください。
        </p>
        <ul className="sheet-picker-list">
          {sheets.map((name, i) => (
            <li key={i}>
              <button
                type="button"
                className={`sheet-picker-item ${i === selected ? "sheet-picker-item--active" : ""}`}
                onClick={() => setSelected(i)}
                onDoubleClick={() => onConfirm(i)}
              >
                <span className="sheet-picker-item__index">{i + 1}</span>
                <span className="sheet-picker-item__name">{name}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sheet-picker-actions">
          <button type="button" className="sheet-picker-btn" onClick={onCancel}>
            キャンセル
          </button>
          {onExportAll && (
            <button
              type="button"
              className="sheet-picker-btn"
              onClick={onExportAll}
              disabled={sheets.length === 0}
              title="フォルダを選んで全シートを個別の CSV として出力"
            >
              全シートを出力
            </button>
          )}
          <button
            type="button"
            className="sheet-picker-btn sheet-picker-btn--primary"
            onClick={() => onConfirm(selected)}
            disabled={sheets.length === 0}
          >
            選択
          </button>
        </div>
      </div>
    </div>
  );
}
