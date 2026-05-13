import { useEffect } from "react";
import "./XlsmMacroLossDialog.css";

interface Props {
  onClose: () => void;
}

// req 5.3.2 / AD-02b: when an .xlsm file is opened, the user MUST be aware
// that VBA macros are discarded and that a subsequent save will produce a
// plain .xlsx. The same fact is also shown as a banner entry, but a banner
// is easy to miss — this modal forces an explicit acknowledgement once per
// imported workbook.
export default function XlsmMacroLossDialog({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="xlsm-macro-loss-backdrop" onClick={onClose}>
      <div
        className="xlsm-macro-loss-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="xlsm-macro-loss-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="xlsm-macro-loss-header">
          <h2 id="xlsm-macro-loss-title" className="xlsm-macro-loss-title">
            マクロは読み込まれません
          </h2>
          <button
            type="button"
            className="xlsm-macro-loss-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="xlsm-macro-loss-body">
          <p className="xlsm-macro-loss-hint">
            VBA マクロは読み込まれず、保存時は .xlsx 形式になります。
          </p>
          <p className="xlsm-macro-loss-detail">
            元の .xlsm ファイルは変更されません。マクロを残したい場合は
            別途オリジナルを保管してください。
          </p>
        </div>
        <div className="xlsm-macro-loss-actions">
          <button
            type="button"
            className="xlsm-macro-loss-btn xlsm-macro-loss-btn--primary"
            onClick={onClose}
            autoFocus
          >
            了解
          </button>
        </div>
      </div>
    </div>
  );
}
