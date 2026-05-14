import { useEffect, useMemo, useState } from "react";
import "./InsertHyperlinkDialog.css";

export interface HyperlinkFormValue {
  cell: string;
  target: string;
  display: string;
  tooltip: string;
}

interface Props {
  /** Default A1 cell ref for the new link (typically the active cell). */
  initialCell: string;
  /** Pre-filled display fallback (e.g. the current cell value). Optional. */
  initialDisplay?: string;
  onApply: (value: HyperlinkFormValue) => void;
  onClose: () => void;
}

// A1 ref: optional $, one or more letters (cols), optional $, one or more digits (rows).
// Only single-cell refs are accepted — hyperlinks attach to one cell per the OOXML
// model we re-emit (see HyperlinkEntry in xlsx_io.rs).
const A1_RE = /^\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return "リンク先 URL は必須です";
  // Internal "#Sheet2!A1" references map to rust_xlsxwriter's "internal:" prefix
  // on the export side. Everything else must be an externally-resolvable scheme.
  if (trimmed.startsWith("#")) {
    if (trimmed.length === 1) return "内部リンクのターゲットを指定してください (例: #Sheet2!A1)";
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return null;
  }
  return "URL は http://, https://, mailto:, または # で始める必要があります";
}

function validateCell(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return "セル参照は必須です";
  if (!A1_RE.test(trimmed)) return "セル参照は A1 形式の単一セルで指定してください";
  return null;
}

export default function InsertHyperlinkDialog({
  initialCell,
  initialDisplay,
  onApply,
  onClose,
}: Props) {
  const [cell, setCell] = useState(initialCell);
  const [target, setTarget] = useState("");
  const [display, setDisplay] = useState(initialDisplay ?? "");
  const [tooltip, setTooltip] = useState("");
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

  // Live preview of what we will store: display defaults to the target when the
  // user hasn't typed anything (mirrors Excel's Insert Hyperlink dialog).
  const effectiveDisplay = useMemo(
    () => (display.trim() ? display.trim() : target.trim()),
    [display, target],
  );

  const submit = () => {
    const cellErr = validateCell(cell);
    if (cellErr) {
      setError(cellErr);
      return;
    }
    const targetErr = validateTarget(target);
    if (targetErr) {
      setError(targetErr);
      return;
    }
    setError(null);
    onApply({
      cell: cell.trim(),
      target: target.trim(),
      display: effectiveDisplay,
      tooltip: tooltip.trim(),
    });
    onClose();
  };

  return (
    <div className="ih-backdrop" onClick={onClose}>
      <div
        className="ih-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ih-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ih-header">
          <h2 id="ih-title" className="ih-title">ハイパーリンクの挿入</h2>
          <button type="button" className="ih-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ih-body">
          <label className="ih-field">
            <span className="ih-field-label">セル</span>
            <input
              type="text"
              className="ih-input"
              value={cell}
              onChange={(e) => setCell(e.target.value)}
              placeholder="A1"
            />
          </label>
          <label className="ih-field">
            <span className="ih-field-label">リンク先</span>
            <input
              type="text"
              className="ih-input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://example.com または #Sheet2!A1"
              autoFocus
            />
          </label>
          <label className="ih-field">
            <span className="ih-field-label">表示テキスト</span>
            <input
              type="text"
              className="ih-input"
              value={display}
              onChange={(e) => setDisplay(e.target.value)}
              placeholder="(空欄の場合は URL を使用)"
            />
          </label>
          <label className="ih-field">
            <span className="ih-field-label">ヒント</span>
            <input
              type="text"
              className="ih-input"
              value={tooltip}
              onChange={(e) => setTooltip(e.target.value)}
              placeholder="ホバー時に表示するテキスト（省略可）"
            />
          </label>
          {error && <p className="ih-error">{error}</p>}
        </div>
        <footer className="ih-footer">
          <p className="ih-hint">
            外部 URL は http://, https://, mailto: で始める必要があります。
            ブック内リンクは # を付けて指定します（例: #Sheet2!A1）。
          </p>
          <div className="ih-footer-actions">
            <button type="button" className="ih-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ih-btn ih-btn--primary"
              onClick={submit}
            >
              挿入
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
