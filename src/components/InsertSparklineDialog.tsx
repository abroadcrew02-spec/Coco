import { useEffect, useState } from "react";
import {
  DEFAULT_SPARKLINE_COLOR,
  DEFAULT_SPARKLINE_NEGATIVE_COLOR,
  parseA1Range,
  type SparklineEntry,
  type SparklineType,
} from "../store/sparklines";
import "./InsertSparklineDialog.css";

interface Props {
  /** Default A1 source range — typically derived from current selection. */
  initialSourceRange: string;
  /** Default A1 anchor cell — typically one cell adjacent to the source. */
  initialAnchorCell: string;
  onApply: (sparkline: SparklineEntry) => void;
  onClose: () => void;
}

// Single-cell A1 anchor (bare or sheet-qualified is rejected — sparklines
// anchor on the current sheet's grid, the qualifier belongs on the source).
const ANCHOR_RE = /^\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateAnchor(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return "アンカーセルは必須です";
  if (!ANCHOR_RE.test(trimmed))
    return "アンカーは単一のセル参照で指定してください (例: D5)";
  return null;
}

function validateSourceRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return "データ範囲は必須です";
  const parsed = parseA1Range(trimmed);
  if (!parsed) return "データ範囲は A1 形式で指定してください (例: A5:C5)";
  const rows = parsed.r2 - parsed.r1 + 1;
  const cols = parsed.c2 - parsed.c1 + 1;
  if (rows !== 1 && cols !== 1) {
    return "データ範囲は 1 行または 1 列で指定してください";
  }
  return null;
}

export default function InsertSparklineDialog({
  initialSourceRange,
  initialAnchorCell,
  onApply,
  onClose,
}: Props) {
  const [sourceRange, setSourceRange] = useState(initialSourceRange);
  const [anchorCell, setAnchorCell] = useState(initialAnchorCell);
  const [type, setType] = useState<SparklineType>("line");
  const [color, setColor] = useState(DEFAULT_SPARKLINE_COLOR);
  const [negativeColor, setNegativeColor] = useState(DEFAULT_SPARKLINE_NEGATIVE_COLOR);
  const [showMarkers, setShowMarkers] = useState(false);
  const [axis, setAxis] = useState(false);
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
    const sourceErr = validateSourceRange(sourceRange);
    if (sourceErr) {
      setError(sourceErr);
      return;
    }
    const anchorErr = validateAnchor(anchorCell);
    if (anchorErr) {
      setError(anchorErr);
      return;
    }
    setError(null);
    const entry: SparklineEntry = {
      cell: anchorCell.trim(),
      sourceRange: sourceRange.trim(),
      type,
      color: color.trim() || DEFAULT_SPARKLINE_COLOR,
    };
    if (type === "winloss") {
      entry.negativeColor = negativeColor.trim() || DEFAULT_SPARKLINE_NEGATIVE_COLOR;
      if (axis) entry.axis = true;
    }
    if (type === "line" && showMarkers) {
      entry.showMarkers = true;
    }
    onApply(entry);
    onClose();
  };

  return (
    <div className="isp-backdrop" onClick={onClose}>
      <div
        className="isp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="isp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="isp-header">
          <h2 id="isp-title" className="isp-title">スパークラインの挿入</h2>
          <button type="button" className="isp-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="isp-body">
          <label className="isp-field">
            <span className="isp-field-label">データ範囲</span>
            <input
              type="text"
              className="isp-input"
              value={sourceRange}
              onChange={(e) => setSourceRange(e.target.value)}
              placeholder="A5:C5 または Sheet1!A5:C5"
              autoFocus
            />
          </label>
          <label className="isp-field">
            <span className="isp-field-label">アンカーセル</span>
            <input
              type="text"
              className="isp-input"
              value={anchorCell}
              onChange={(e) => setAnchorCell(e.target.value)}
              placeholder="D5"
            />
          </label>
          <label className="isp-field">
            <span className="isp-field-label">種類</span>
            <select
              className="isp-select"
              value={type}
              onChange={(e) => setType(e.target.value as SparklineType)}
            >
              <option value="line">折れ線</option>
              <option value="column">縦棒</option>
              <option value="winloss">勝敗</option>
            </select>
          </label>
          <label className="isp-field isp-field--inline">
            <span className="isp-field-label">色</span>
            <input
              type="color"
              className="isp-color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
            <input
              type="text"
              className="isp-input isp-input--hex"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          {type === "winloss" && (
            <label className="isp-field isp-field--inline">
              <span className="isp-field-label">負の値の色</span>
              <input
                type="color"
                className="isp-color"
                value={negativeColor}
                onChange={(e) => setNegativeColor(e.target.value)}
              />
              <input
                type="text"
                className="isp-input isp-input--hex"
                value={negativeColor}
                onChange={(e) => setNegativeColor(e.target.value)}
              />
            </label>
          )}
          {type === "line" && (
            <label className="isp-checkbox">
              <input
                type="checkbox"
                checked={showMarkers}
                onChange={(e) => setShowMarkers(e.target.checked)}
              />
              <span>高値・安値マーカーを表示</span>
            </label>
          )}
          {type === "winloss" && (
            <label className="isp-checkbox">
              <input
                type="checkbox"
                checked={axis}
                onChange={(e) => setAxis(e.target.checked)}
              />
              <span>ゼロ軸を表示</span>
            </label>
          )}
          {error && <p className="isp-error">{error}</p>}
        </div>
        <footer className="isp-footer">
          <p className="isp-hint">
            データ範囲は 1 行または 1 列の連続セルを指定します。
            アンカーセルにユニコードブロック文字でミニチャートを描画します。
          </p>
          <div className="isp-footer-actions">
            <button type="button" className="isp-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="isp-btn isp-btn--primary" onClick={submit}>
              挿入
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
