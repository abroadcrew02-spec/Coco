import { useEffect } from "react";
import "./CloseConfirmDialog.css";

interface Props {
  fileName: string;
  onChoice: (choice: "save" | "discard" | "cancel") => void;
}

// req 5.4.2: presented when the user attempts to close the window with an
// unsaved workbook. Three explicit choices — no implicit data loss.
export default function CloseConfirmDialog({ fileName, onChoice }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onChoice("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        onChoice("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChoice]);

  return (
    <div className="close-confirm-backdrop" onClick={() => onChoice("cancel")}>
      <div
        className="close-confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="close-confirm-title" className="close-confirm-title">
          未保存の変更があります
        </h2>
        <p className="close-confirm-file">{fileName}</p>
        <p className="close-confirm-hint">
          終了前に変更を保存しますか？
        </p>
        <div className="close-confirm-actions">
          <button type="button" className="close-confirm-btn" onClick={() => onChoice("cancel")}>
            キャンセル
          </button>
          <button
            type="button"
            className="close-confirm-btn close-confirm-btn--danger"
            onClick={() => onChoice("discard")}
          >
            破棄して終了
          </button>
          <button
            type="button"
            className="close-confirm-btn close-confirm-btn--primary"
            onClick={() => onChoice("save")}
            autoFocus
          >
            保存して終了
          </button>
        </div>
      </div>
    </div>
  );
}
