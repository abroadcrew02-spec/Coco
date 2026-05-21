import { useEffect, useState } from "react";
import type { ShapeKind } from "../store/textBoxes";
import "./InsertShapeDialog.css";

export interface ShapeFormValue {
  /** Shape kind (#188): text box / rectangle / ellipse / line. */
  type: ShapeKind;
  /** Anchor cell in A1 notation (single cell, top-left). */
  cell: string;
  /** Width in column units (cells). */
  w: number;
  /** Height in row units (cells). */
  h: number;
  /** Display text. Empty for `line`; optional for `rect` / `ellipse`. */
  text: string;
  /** CSS font-family (may be empty for the default). */
  fontFamily: string;
  /** Font size in points. */
  fontSize: number;
  /** `#rrggbb`. */
  color: string;
  /** `#rrggbb` or "transparent". */
  backgroundColor: string;
  /** `#rrggbb` or "transparent". */
  borderColor: string;
}

interface Props {
  initialCell: string;
  /**
   * Return null on success (dialog closes), or a localized error string to
   * keep the dialog open and surface the message inline. Same contract as
   * InsertImageDialog — keeps the rejection UX consistent.
   */
  onApply: (value: ShapeFormValue) => string | null;
  onClose: () => void;
}

// Same A1 single-cell regex as InsertImageDialog so anchor validation stays
// behaviour-identical across the insert dialogs.
const A1_RE = /^\$?[A-Za-z]+\$?[1-9]\d*$/;

const FONT_FAMILIES = [
  "Calibri",
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Courier New",
  "Meiryo",
  "Yu Gothic",
  "MS Gothic",
];

// Shape kinds the dialog can insert (#188). `textbox` is the #146 MVP shape.
const SHAPE_KINDS: { value: ShapeKind; label: string }[] = [
  { value: "textbox", label: "テキストボックス" },
  { value: "rect", label: "矩形" },
  { value: "ellipse", label: "円 / 楕円" },
  { value: "line", label: "矢印 / 線" },
];

function validateCell(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return "セル参照は必須です";
  if (!A1_RE.test(trimmed)) return "セル参照は A1 形式の単一セルで指定してください";
  return null;
}

export default function InsertShapeDialog({
  initialCell,
  onApply,
  onClose,
}: Props) {
  const [type, setType] = useState<ShapeKind>("rect");
  const [cell, setCell] = useState(initialCell);
  const [w, setW] = useState(4);
  const [h, setH] = useState(3);
  const [text, setText] = useState("");
  const [fontFamily, setFontFamily] = useState("Calibri");
  const [fontSize, setFontSize] = useState(11);
  const [color, setColor] = useState("#000000");
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [borderColor, setBorderColor] = useState("#000000");
  const [error, setError] = useState<string | null>(null);

  // A line carries no fill / text body; a text box always carries text.
  const isLine = type === "line";
  const isTextBox = type === "textbox";

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
    const cellErr = validateCell(cell);
    if (cellErr) {
      setError(cellErr);
      return;
    }
    if (!Number.isFinite(w) || w < 1 || w > 100) {
      setError("幅は 1〜100 セルの範囲で指定してください");
      return;
    }
    if (!Number.isFinite(h) || h < 1 || h > 100) {
      setError("高さは 1〜100 セルの範囲で指定してください");
      return;
    }
    if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 72) {
      setError("フォントサイズは 6〜72 pt の範囲で指定してください");
      return;
    }
    // Text is mandatory only for the text box; rect / ellipse may carry an
    // optional label and a line carries none.
    if (isTextBox && !text.trim()) {
      setError("テキストを入力してください");
      return;
    }
    setError(null);
    const applyErr = onApply({
      type,
      cell: cell.trim(),
      w: Math.floor(w),
      h: Math.floor(h),
      text: isLine ? "" : text,
      fontFamily,
      fontSize: Math.floor(fontSize),
      color,
      backgroundColor,
      borderColor,
    });
    if (applyErr) {
      setError(applyErr);
      return;
    }
    onClose();
  };

  return (
    <div className="ishp-backdrop" onClick={onClose}>
      <div
        className="ishp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ishp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ishp-header">
          <h2 id="ishp-title" className="ishp-title">図形の挿入</h2>
          <button
            type="button"
            className="ishp-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="ishp-body">
          <label className="ishp-field">
            <span className="ishp-field-label">図形の種類</span>
            <select
              className="ishp-input"
              value={type}
              onChange={(e) => setType(e.target.value as ShapeKind)}
              aria-label="図形の種類"
            >
              {SHAPE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          {!isLine && (
            <label className="ishp-field">
              <span className="ishp-field-label">
                テキスト{isTextBox ? "" : "（任意）"}
              </span>
              <textarea
                className="ishp-textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder={
                  isTextBox
                    ? "ここにテキストを入力..."
                    : "図形内に表示するラベル（省略可）"
                }
                aria-label="テキスト"
              />
            </label>
          )}
          <div className="ishp-row">
            <label className="ishp-field">
              <span className="ishp-field-label">アンカーセル</span>
              <input
                type="text"
                className="ishp-input"
                value={cell}
                onChange={(e) => setCell(e.target.value)}
                placeholder="A1"
                aria-label="アンカーセル"
              />
            </label>
            <label className="ishp-field">
              <span className="ishp-field-label">幅 (列数)</span>
              <input
                type="number"
                className="ishp-input"
                min={1}
                max={100}
                value={w}
                onChange={(e) => setW(Number.parseInt(e.target.value, 10) || 1)}
                aria-label="幅"
              />
            </label>
            <label className="ishp-field">
              <span className="ishp-field-label">高さ (行数)</span>
              <input
                type="number"
                className="ishp-input"
                min={1}
                max={100}
                value={h}
                onChange={(e) => setH(Number.parseInt(e.target.value, 10) || 1)}
                aria-label="高さ"
              />
            </label>
          </div>
          {!isLine && (
            <div className="ishp-row">
              <label className="ishp-field">
                <span className="ishp-field-label">フォント</span>
                <select
                  className="ishp-input"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  aria-label="フォント"
                >
                  {FONT_FAMILIES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ishp-field">
                <span className="ishp-field-label">サイズ (pt)</span>
                <input
                  type="number"
                  className="ishp-input"
                  min={6}
                  max={72}
                  value={fontSize}
                  onChange={(e) =>
                    setFontSize(Number.parseInt(e.target.value, 10) || 11)
                  }
                  aria-label="サイズ"
                />
              </label>
            </div>
          )}
          <div className="ishp-row">
            {!isLine && (
              <label className="ishp-field">
                <span className="ishp-field-label">文字色</span>
                <input
                  type="color"
                  className="ishp-color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  aria-label="文字色"
                />
              </label>
            )}
            {!isLine && (
              <label className="ishp-field">
                <span className="ishp-field-label">塗りつぶし色</span>
                <input
                  type="color"
                  className="ishp-color"
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  aria-label="塗りつぶし色"
                />
              </label>
            )}
            <label className="ishp-field">
              <span className="ishp-field-label">
                {isLine ? "線の色" : "枠線色"}
              </span>
              <input
                type="color"
                className="ishp-color"
                value={borderColor}
                onChange={(e) => setBorderColor(e.target.value)}
                aria-label={isLine ? "線の色" : "枠線色"}
              />
            </label>
          </div>
          {error && <p className="ishp-error">{error}</p>}
        </div>
        <footer className="ishp-footer">
          <p className="ishp-hint">
            図形はセル位置にアンカーされ、xlsx として保存時にシートの図形として書き出されます。
          </p>
          <div className="ishp-footer-actions">
            <button type="button" className="ishp-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ishp-btn ishp-btn--primary"
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
