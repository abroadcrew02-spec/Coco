import { useEffect, useState } from "react";
import "./InsertCommentDialog.css";

export interface CommentEntry {
  cell: string;
  author?: string;
  text: string;
}

interface Props {
  cellRef: string;
  initialEntry: CommentEntry | null;
  defaultAuthor: string;
  onApply: (entry: CommentEntry) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function InsertCommentDialog({
  cellRef,
  initialEntry,
  defaultAuthor,
  onApply,
  onDelete,
  onClose,
}: Props) {
  const isEditing = initialEntry !== null;
  const [text, setText] = useState(initialEntry?.text ?? "");
  // Pre-fill author from the existing comment when editing; otherwise use the
  // OS-derived default so first-time users don't have to retype each time.
  const [author, setAuthor] = useState(
    initialEntry?.author && initialEntry.author.length > 0
      ? initialEntry.author
      : defaultAuthor,
  );
  const [error, setError] = useState<string | null>(null);

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
    const trimmedText = text.trim();
    if (!trimmedText) {
      setError("コメントを入力してください");
      return;
    }
    const trimmedAuthor = author.trim();
    onApply({
      cell: cellRef,
      // Omit author when empty so the snapshot stays minimal (Rust side
      // defaults to "Author" on write when the field is missing).
      ...(trimmedAuthor ? { author: trimmedAuthor } : {}),
      text: trimmedText,
    });
    onClose();
  };

  const handleDelete = () => {
    onDelete();
    onClose();
  };

  return (
    <div className="ic-backdrop" onClick={onClose}>
      <div
        className="ic-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ic-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ic-header">
          <h2 id="ic-title" className="ic-title">
            {isEditing ? "コメントを編集" : "コメントを挿入"}
          </h2>
          <button type="button" className="ic-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ic-body">
          <div className="ic-cell-label">
            セル: <span className="ic-cell-ref">{cellRef}</span>
          </div>
          <label className="ic-field">
            <span className="ic-field-label">作成者</span>
            <input
              type="text"
              className="ic-input"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Author"
            />
          </label>
          <label className="ic-field">
            <span className="ic-field-label">コメント</span>
            <textarea
              className="ic-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="コメントを入力..."
              autoFocus
            />
          </label>
          {error && <p className="ic-error">{error}</p>}
        </div>
        <footer className="ic-footer">
          <div className="ic-footer-left">
            {isEditing && (
              <button
                type="button"
                className="ic-btn ic-btn--danger"
                onClick={handleDelete}
              >
                削除
              </button>
            )}
          </div>
          <div className="ic-footer-right">
            <button type="button" className="ic-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ic-btn ic-btn--primary"
              onClick={submit}
            >
              {isEditing ? "更新" : "追加"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
