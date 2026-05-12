import { useEffect } from "react";
import "./SaveFailureDialog.css";

interface Props {
  path: string | null;
  errorMessage: string | null;
  onRetry: () => void;
  onSaveAs: () => void;
  onClose: () => void;
}

export default function SaveFailureDialog({
  path,
  errorMessage,
  onRetry,
  onSaveAs,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onRetry();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRetry, onClose]);

  const displayPath = path ?? "（未保存のワークブック）";

  return (
    <div className="save-fail-backdrop" onClick={onClose}>
      <div
        className="save-fail-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-fail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="save-fail-icon" aria-hidden="true">!</div>
        <div className="save-fail-body">
          <h2 id="save-fail-title" className="save-fail-title">
            保存に失敗しました
          </h2>
          <p className="save-fail-path">{displayPath}</p>
          {errorMessage && (
            <pre className="save-fail-detail">{errorMessage}</pre>
          )}
          <p className="save-fail-hint">
            元のファイルは変更されていません。再試行、別のパスに保存、または閉じて編集を続けられます。
          </p>
          <div className="save-fail-actions">
            <button type="button" className="save-fail-btn" onClick={onClose}>
              閉じる
            </button>
            <button type="button" className="save-fail-btn" onClick={onSaveAs}>
              別名保存
            </button>
            <button
              type="button"
              className="save-fail-btn save-fail-btn--primary"
              onClick={onRetry}
              autoFocus
            >
              再試行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
