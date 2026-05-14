import { useEffect, useState } from "react";
import "./InsertChartDialog.css";

export type ChartType = "bar" | "line" | "pie";

export interface ChartFormValue {
  range: string;
  chartType: ChartType;
  title: string;
}

interface Props {
  /** Default A1 range for the new chart (typically the active selection). */
  initialRange: string;
  onApply: (value: ChartFormValue) => void;
  onClose: () => void;
}

// A1 range: single cell or "A1:B2" style rectangular range. Sheet-qualified
// refs ("Sheet1!A1:B2") are also accepted so a chart can pull from a sibling
// sheet, mirroring Excel's chart-source convention.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

function validateRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return "データ範囲は必須です";
  if (!RANGE_RE.test(trimmed)) return "データ範囲は A1 形式で指定してください (例: A1:B10)";
  return null;
}

export default function InsertChartDialog({
  initialRange,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [title, setTitle] = useState("");
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
    const rangeErr = validateRange(range);
    if (rangeErr) {
      setError(rangeErr);
      return;
    }
    setError(null);
    onApply({
      range: range.trim(),
      chartType,
      title: title.trim(),
    });
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
          <h2 id="ic-title" className="ic-title">グラフの挿入</h2>
          <button type="button" className="ic-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ic-body">
          <label className="ic-field">
            <span className="ic-field-label">データ範囲</span>
            <input
              type="text"
              className="ic-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:B10"
              autoFocus
            />
          </label>
          <fieldset className="ic-field ic-field--types">
            <legend className="ic-field-label">グラフの種類</legend>
            <label className="ic-radio">
              <input
                type="radio"
                name="chartType"
                value="bar"
                checked={chartType === "bar"}
                onChange={() => setChartType("bar")}
              />
              <span>縦棒 (bar)</span>
            </label>
            <label className="ic-radio">
              <input
                type="radio"
                name="chartType"
                value="line"
                checked={chartType === "line"}
                onChange={() => setChartType("line")}
              />
              <span>折れ線 (line)</span>
            </label>
            <label className="ic-radio">
              <input
                type="radio"
                name="chartType"
                value="pie"
                checked={chartType === "pie"}
                onChange={() => setChartType("pie")}
              />
              <span>円 (pie)</span>
            </label>
          </fieldset>
          <label className="ic-field">
            <span className="ic-field-label">タイトル</span>
            <input
              type="text"
              className="ic-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="(省略可)"
            />
          </label>
          {error && <p className="ic-error">{error}</p>}
        </div>
        <footer className="ic-footer">
          <p className="ic-hint">
            このビルドではグラフ描画プラグインを同梱していないため、グラフは保存時に
            スナップショットへ書き出され、再オープン時に表示されない場合があります。
            既存ファイルのグラフはバイト単位で保持されます。
          </p>
          <div className="ic-footer-actions">
            <button type="button" className="ic-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ic-btn ic-btn--primary"
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
