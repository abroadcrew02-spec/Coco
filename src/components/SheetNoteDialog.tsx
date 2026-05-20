import { useEffect, useMemo, useState } from "react";
import type { SheetNote } from "../store/sheetNotes";
import "./SheetNoteDialog.css";

interface Props {
  sheetName: string;
  /** null = no note yet; otherwise the existing note for the sheet. */
  initial: SheetNote | null;
  /** Author auto-filled into the input on first save. */
  defaultAuthor: string;
  onSave: (text: string, author: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Tiny Markdown subset renderer. Intentionally NOT a full parser — the
// preview only needs to give the user a sense of what their note will
// look like rendered, and pulling in `marked`/`markdown-it` for a single
// dialog is overkill. Supports:
//   - paragraphs (blank-line separated)
//   - **bold** and *italic* inline (also __bold__ / _italic_)
//   - unordered lists (`- ` or `* ` line prefix)
//
// All HTML in the source is escaped before substitution so a malicious
// note body can't inject markup into the preview.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Bold first (longer marker) so `*` inside `**` doesn't get eaten.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$)/g, "$1<em>$2</em>");
  return out;
}

function renderMarkdown(src: string): string {
  if (!src.trim()) return "";
  const blocks = src.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const html: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const isList = lines.every((l) => /^[\s]*[-*]\s+/.test(l));
    if (isList) {
      const items = lines
        .map((l) => l.replace(/^[\s]*[-*]\s+/, ""))
        .map((l) => `<li>${renderInline(l)}</li>`)
        .join("");
      html.push(`<ul>${items}</ul>`);
    } else {
      const joined = lines.map((l) => renderInline(l)).join("<br/>");
      html.push(`<p>${joined}</p>`);
    }
  }
  return html.join("");
}

/**
 * Sheet-notes editor. Single textarea bound to local state, with the
 * Markdown preview rendered live underneath. Save / Delete / Close
 * mirror ThreadedCommentDialog's button layout for familiarity.
 *
 * Local state is buffered until the user clicks "保存"; only then do we
 * emit the final text via onSave. This matches the buffering convention
 * the threaded-comment dialog uses so users can cancel out of edits.
 */
export default function SheetNoteDialog({
  sheetName,
  initial,
  defaultAuthor,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const [text, setText] = useState<string>(initial?.text ?? "");
  const [author, setAuthor] = useState<string>(
    initial?.author ?? defaultAuthor,
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

  // Recompute the preview only when text changes — avoids re-running the
  // (cheap, but still) regex pipeline on every keystroke in the author
  // input.
  const previewHtml = useMemo(() => renderMarkdown(text), [text]);

  const handleSave = () => {
    onSave(text, author.trim());
    onClose();
  };

  const handleDelete = () => {
    onDelete();
    onClose();
  };

  const hasExisting = initial !== null;

  return (
    <div className="snd-backdrop" onClick={onClose}>
      <div
        className="snd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="snd-header">
          <h2 id="snd-title" className="snd-title">
            シートのメモ — <span className="snd-sheet-name">{sheetName}</span>
          </h2>
          <button
            type="button"
            className="snd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="snd-body">
          {initial?.updatedAt && (
            <div className="snd-meta">
              最終更新: <span className="snd-meta-time">{formatTimestamp(initial.updatedAt)}</span>
              {initial.author && (
                <>
                  {" "}・ <span className="snd-meta-author">{initial.author}</span>
                </>
              )}
            </div>
          )}
          <label className="snd-field">
            <span className="snd-field-label">作成者</span>
            <input
              type="text"
              className="snd-input"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Author"
            />
          </label>
          <label className="snd-field">
            <span className="snd-field-label">メモ本文 (Markdown)</span>
            <textarea
              className="snd-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="例: このシートはQ1売上データです。毎週Xが更新します。"
              autoFocus
            />
          </label>
          <div className="snd-preview-block">
            <div className="snd-preview-label">プレビュー</div>
            {text.trim() ? (
              <div
                className="snd-preview"
                // Preview HTML is constructed by renderMarkdown above,
                // which escapes all user input before substitution. Safe
                // to dangerouslySetInnerHTML.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <p className="snd-preview-empty">
                プレビューはここに表示されます
              </p>
            )}
          </div>
        </div>
        <footer className="snd-footer">
          <div className="snd-footer-left">
            {hasExisting && (
              <button
                type="button"
                className="snd-btn snd-btn--danger"
                onClick={handleDelete}
              >
                削除
              </button>
            )}
          </div>
          <div className="snd-footer-right">
            <button type="button" className="snd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="snd-btn snd-btn--primary"
              onClick={handleSave}
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
