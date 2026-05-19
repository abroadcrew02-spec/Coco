import { useEffect } from "react";
import "./FlashFillDialog.css";

interface PreviewRow {
  source: string;
  filled: string;
}

interface Props {
  /** Plain-language description of the inferred transformation, e.g.
   *  "Extract everything before '@'" — produced by `describeTransform`. */
  transformDescription: string;
  /** Up to 5 source → filled pairs to show the user before they commit. */
  preview: PreviewRow[];
  onAccept: () => void;
  onClose: () => void;
}

// Mirrors the SortDialog `sd-*` convention but uses an `ff-*` namespace to
// keep the stylesheets independent.
export default function FlashFillDialog({
  transformDescription,
  preview,
  onAccept,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onAccept();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAccept, onClose]);

  return (
    <div className="ff-backdrop" onClick={onClose}>
      <div
        className="ff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ff-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ff-header">
          <h2 id="ff-title" className="ff-title">フラッシュフィル</h2>
          <button
            type="button"
            className="ff-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="ff-body">
          <p className="ff-description">
            <span className="ff-description-label">検出されたパターン:</span>{" "}
            <span className="ff-description-text">{transformDescription}</span>
          </p>
          {preview.length === 0 ? (
            <p className="ff-empty">プレビューする行がありません。</p>
          ) : (
            <div className="ff-preview-wrap">
              <table className="ff-preview" aria-label="フラッシュフィル プレビュー">
                <thead>
                  <tr>
                    <th>元の値</th>
                    <th>自動入力</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, idx) => (
                    <tr key={idx}>
                      <td className="ff-cell ff-cell--source">{row.source}</td>
                      <td className="ff-cell ff-cell--filled">{row.filled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <footer className="ff-footer">
          <p className="ff-hint">
            適用すると、対象列の空セルにこのパターンを書き込みます。
            元に戻す場合は Ctrl+Z で取り消せます。
          </p>
          <div className="ff-footer-actions">
            <button type="button" className="ff-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ff-btn ff-btn--primary"
              onClick={onAccept}
              autoFocus
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
