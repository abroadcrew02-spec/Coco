import { useEffect, useState } from "react";
import "./EnhancedChartDialog.css";

export type EnhancedChartType =
  | "bar"
  | "line"
  | "pie"
  | "scatter"
  | "area"
  | "doughnut";

export interface EnhancedChartFormValue {
  range: string;
  chartType: EnhancedChartType;
  title: string;
  xAxisLabel: string;
  yAxisLabel: string;
  showLegend: boolean;
  showDataLabels: boolean;
  stacked: boolean;
  seriesColors: string[];
  hasHeaderRow: boolean;
  hasHeaderCol: boolean;
}

interface Props {
  initialRange: string;
  onApply: (value: EnhancedChartFormValue) => void;
  onClose: () => void;
  /** Optional seed values when editing an existing chart. All fields are
   *  partial so callers can override only the bits they have. */
  initial?: Partial<EnhancedChartFormValue>;
}

const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

const DEFAULT_PALETTE = [
  "#5B9BD5",
  "#ED7D31",
  "#A5A5A5",
  "#FFC000",
  "#4472C4",
  "#70AD47",
];

function validateRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return "データ範囲は必須です";
  if (!RANGE_RE.test(trimmed)) return "データ範囲は A1 形式で指定してください (例: A1:B10)";
  return null;
}

/**
 * Expanded version of InsertChartDialog. Backwards-source-compatible —
 * the existing dialog is untouched; the integrator can swap when ready.
 *
 * New fields vs. InsertChartDialog:
 *   - chart types: scatter / area / doughnut in addition to bar/line/pie
 *   - x/y axis labels
 *   - legend visibility toggle
 *   - data label toggle
 *   - stacked toggle (bar only — hidden for other types)
 *   - 6 series color pickers, seeded from the default Excel-ish palette
 *   - hasHeaderRow / hasHeaderCol toggles so the user can describe layouts
 *     where the first row/col is data rather than labels
 *
 * Note: this dialog only collects the values; persisting them into the
 * sheet's `_charts` array is the integrator's responsibility, since the
 * snapshot mutation lives in EditorScreen / useMenuActions today.
 */
export default function EnhancedChartDialog({
  initialRange,
  onApply,
  onClose,
  initial,
}: Props) {
  const [range, setRange] = useState(initial?.range ?? initialRange);
  const [chartType, setChartType] = useState<EnhancedChartType>(
    initial?.chartType ?? "bar",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [xAxisLabel, setXAxisLabel] = useState(initial?.xAxisLabel ?? "");
  const [yAxisLabel, setYAxisLabel] = useState(initial?.yAxisLabel ?? "");
  const [showLegend, setShowLegend] = useState(initial?.showLegend ?? true);
  const [showDataLabels, setShowDataLabels] = useState(
    initial?.showDataLabels ?? false,
  );
  const [stacked, setStacked] = useState(initial?.stacked ?? false);
  const [hasHeaderRow, setHasHeaderRow] = useState(initial?.hasHeaderRow ?? true);
  const [hasHeaderCol, setHasHeaderCol] = useState(initial?.hasHeaderCol ?? true);
  const [seriesColors, setSeriesColors] = useState<string[]>(() => {
    const seed = Array.isArray(initial?.seriesColors) ? initial!.seriesColors : [];
    return DEFAULT_PALETTE.map((c, i) => seed[i] ?? c);
  });
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
      xAxisLabel: xAxisLabel.trim(),
      yAxisLabel: yAxisLabel.trim(),
      showLegend,
      showDataLabels,
      // Stacked is meaningless outside of bar; force-false so the
      // snapshot doesn't carry a noise flag through round-trips.
      stacked: chartType === "bar" ? stacked : false,
      seriesColors: seriesColors.slice(),
      hasHeaderRow,
      hasHeaderCol,
    });
    onClose();
  };

  const updateColor = (idx: number, color: string) => {
    setSeriesColors((prev) => {
      const next = prev.slice();
      next[idx] = color;
      return next;
    });
  };

  return (
    <div className="ecd-backdrop" onClick={onClose}>
      <div
        className="ecd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ecd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ecd-header">
          <h2 id="ecd-title" className="ecd-title">グラフの挿入 (詳細)</h2>
          <button type="button" className="ecd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ecd-body">
          <label className="ecd-field">
            <span className="ecd-field-label">データ範囲</span>
            <input
              type="text"
              className="ecd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:B10"
              autoFocus
            />
          </label>

          <fieldset className="ecd-field ecd-field--types">
            <legend className="ecd-field-label">グラフの種類</legend>
            {(
              [
                ["bar", "縦棒 (bar)"],
                ["line", "折れ線 (line)"],
                ["pie", "円 (pie)"],
                ["doughnut", "ドーナツ (doughnut)"],
                ["area", "面 (area)"],
                ["scatter", "散布図 (scatter)"],
              ] as Array<[EnhancedChartType, string]>
            ).map(([value, label]) => (
              <label className="ecd-radio" key={value}>
                <input
                  type="radio"
                  name="chartType"
                  value={value}
                  checked={chartType === value}
                  onChange={() => setChartType(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>

          <label className="ecd-field">
            <span className="ecd-field-label">タイトル</span>
            <input
              type="text"
              className="ecd-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="(省略可)"
            />
          </label>

          <div className="ecd-row">
            <label className="ecd-field ecd-field--half">
              <span className="ecd-field-label">X 軸ラベル</span>
              <input
                type="text"
                className="ecd-input"
                value={xAxisLabel}
                onChange={(e) => setXAxisLabel(e.target.value)}
                placeholder="(省略可)"
              />
            </label>
            <label className="ecd-field ecd-field--half">
              <span className="ecd-field-label">Y 軸ラベル</span>
              <input
                type="text"
                className="ecd-input"
                value={yAxisLabel}
                onChange={(e) => setYAxisLabel(e.target.value)}
                placeholder="(省略可)"
              />
            </label>
          </div>

          <div className="ecd-row ecd-row--checks">
            <label className="ecd-check">
              <input
                type="checkbox"
                checked={showLegend}
                onChange={(e) => setShowLegend(e.target.checked)}
              />
              <span>凡例を表示</span>
            </label>
            <label className="ecd-check">
              <input
                type="checkbox"
                checked={showDataLabels}
                onChange={(e) => setShowDataLabels(e.target.checked)}
              />
              <span>データラベル</span>
            </label>
            {chartType === "bar" && (
              <label className="ecd-check">
                <input
                  type="checkbox"
                  checked={stacked}
                  onChange={(e) => setStacked(e.target.checked)}
                />
                <span>積み上げ</span>
              </label>
            )}
          </div>

          <div className="ecd-row ecd-row--checks">
            <label className="ecd-check">
              <input
                type="checkbox"
                checked={hasHeaderRow}
                onChange={(e) => setHasHeaderRow(e.target.checked)}
              />
              <span>1 行目を系列名に</span>
            </label>
            <label className="ecd-check">
              <input
                type="checkbox"
                checked={hasHeaderCol}
                onChange={(e) => setHasHeaderCol(e.target.checked)}
              />
              <span>1 列目をカテゴリに</span>
            </label>
          </div>

          <fieldset className="ecd-field ecd-field--colors">
            <legend className="ecd-field-label">系列の色 (最大 6)</legend>
            <div className="ecd-colors">
              {seriesColors.map((c, i) => (
                <label key={i} className="ecd-color">
                  <span className="ecd-color-label">{i + 1}</span>
                  <input
                    type="color"
                    value={c}
                    onChange={(e) => updateColor(i, e.target.value)}
                    aria-label={`系列 ${i + 1} の色`}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          {error && <p className="ecd-error">{error}</p>}
        </div>
        <footer className="ecd-footer">
          <p className="ecd-hint">
            ライブグラフ表示パネル (ChartCanvasPanel) で挿入後すぐに描画されます。
            既存ファイルのグラフはバイト単位で保持されます。
          </p>
          <div className="ecd-footer-actions">
            <button type="button" className="ecd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ecd-btn ecd-btn--primary"
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
