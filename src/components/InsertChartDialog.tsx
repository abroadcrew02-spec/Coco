import { useEffect, useState } from "react";
import "./InsertChartDialog.css";
import type { LiveChartType } from "../store/chartRender";

export type ChartType = LiveChartType;

export interface ChartFormValue {
  range: string;
  chartType: ChartType;
  title: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  showLegend?: boolean;
  showDataLabels?: boolean;
  stacked?: boolean;
  hasHeaderRow?: boolean;
  hasHeaderCol?: boolean;
}

interface Props {
  /** Default A1 range for the new chart (typically the active selection). */
  initialRange: string;
  /**
   * When provided, the dialog runs in edit mode: pre-populates all fields
   * from this entry, shows "グラフの編集" title and "更新" submit button.
   */
  initialValue?: ChartFormValue;
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

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "bar",      label: "縦棒 (bar)" },
  { value: "line",     label: "折れ線 (line)" },
  { value: "pie",      label: "円 (pie)" },
  { value: "scatter",  label: "散布図 (scatter)" },
  { value: "area",     label: "面 (area)" },
  { value: "doughnut", label: "ドーナツ (doughnut)" },
];

/** Chart types for which the "stacked" option is meaningful. */
const STACKED_TYPES = new Set<ChartType>(["bar", "line"]);

export default function InsertChartDialog({
  initialRange,
  initialValue,
  onApply,
  onClose,
}: Props) {
  const isEditMode = initialValue !== undefined;
  const [range, setRange] = useState(initialValue?.range || initialRange);
  const [chartType, setChartType] = useState<ChartType>(initialValue?.chartType ?? "bar");
  const [title, setTitle] = useState(initialValue?.title ?? "");
  const [xAxisLabel, setXAxisLabel] = useState(initialValue?.xAxisLabel ?? "");
  const [yAxisLabel, setYAxisLabel] = useState(initialValue?.yAxisLabel ?? "");
  const [showLegend, setShowLegend] = useState(initialValue?.showLegend ?? true);
  const [showDataLabels, setShowDataLabels] = useState(initialValue?.showDataLabels ?? false);
  const [stacked, setStacked] = useState(initialValue?.stacked ?? false);
  const [hasHeaderRow, setHasHeaderRow] = useState(initialValue?.hasHeaderRow ?? true);
  const [hasHeaderCol, setHasHeaderCol] = useState(initialValue?.hasHeaderCol ?? false);
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
    const value: ChartFormValue = {
      range: range.trim(),
      chartType,
      title: title.trim(),
      showLegend,
      showDataLabels,
      hasHeaderRow,
      hasHeaderCol,
    };
    if (xAxisLabel.trim()) value.xAxisLabel = xAxisLabel.trim();
    if (yAxisLabel.trim()) value.yAxisLabel = yAxisLabel.trim();
    if (STACKED_TYPES.has(chartType)) value.stacked = stacked;
    onApply(value);
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
          <h2 id="ic-title" className="ic-title">{isEditMode ? "グラフの編集" : "グラフの挿入"}</h2>
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
              title="データ範囲 (例: A1:B10)"
              autoFocus
            />
          </label>
          <fieldset className="ic-field ic-field--types">
            <legend className="ic-field-label">グラフの種類</legend>
            {CHART_TYPES.map(({ value, label }) => (
              <label key={value} className="ic-radio">
                <input
                  type="radio"
                  name="chartType"
                  value={value}
                  checked={chartType === value}
                  onChange={() => setChartType(value)}
                  title={label}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="ic-field">
            <span className="ic-field-label">タイトル</span>
            <input
              type="text"
              className="ic-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="(省略可)"
              title="グラフタイトル"
            />
          </label>
          <details className="ic-details">
            <summary className="ic-details-summary">詳細オプション</summary>
            <div className="ic-details-body">
              <label className="ic-field">
                <span className="ic-field-label">X軸タイトル</span>
                <input
                  type="text"
                  className="ic-input"
                  value={xAxisLabel}
                  onChange={(e) => setXAxisLabel(e.target.value)}
                  placeholder="(省略可)"
                  title="X軸タイトル"
                />
              </label>
              <label className="ic-field">
                <span className="ic-field-label">Y軸タイトル</span>
                <input
                  type="text"
                  className="ic-input"
                  value={yAxisLabel}
                  onChange={(e) => setYAxisLabel(e.target.value)}
                  placeholder="(省略可)"
                  title="Y軸タイトル"
                />
              </label>
              <label className="ic-checkbox">
                <input
                  type="checkbox"
                  checked={showLegend}
                  onChange={(e) => setShowLegend(e.target.checked)}
                  title="凡例を表示"
                />
                <span>凡例を表示</span>
              </label>
              <label className="ic-checkbox">
                <input
                  type="checkbox"
                  checked={showDataLabels}
                  onChange={(e) => setShowDataLabels(e.target.checked)}
                  title="データラベルを表示"
                />
                <span>データラベルを表示</span>
              </label>
              {STACKED_TYPES.has(chartType) && (
                <label className="ic-checkbox">
                  <input
                    type="checkbox"
                    checked={stacked}
                    onChange={(e) => setStacked(e.target.checked)}
                    title="積み上げ"
                  />
                  <span>積み上げ</span>
                </label>
              )}
              <label className="ic-checkbox">
                <input
                  type="checkbox"
                  checked={hasHeaderRow}
                  onChange={(e) => setHasHeaderRow(e.target.checked)}
                  title="ヘッダ行を含む"
                />
                <span>ヘッダ行を含む</span>
              </label>
              <label className="ic-checkbox">
                <input
                  type="checkbox"
                  checked={hasHeaderCol}
                  onChange={(e) => setHasHeaderCol(e.target.checked)}
                  title="ヘッダ列を含む"
                />
                <span>ヘッダ列を含む</span>
              </label>
            </div>
          </details>
          {error && <p className="ic-error">{error}</p>}
        </div>
        <footer className="ic-footer">
          <div className="ic-footer-actions">
            <button type="button" className="ic-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ic-btn ic-btn--primary"
              onClick={submit}
            >
              {isEditMode ? "更新" : "挿入"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
