import { useEffect, useState } from "react";
import type { ChartRecommendation } from "../store/recommendedCharts";
import "./RecommendedChartsDialog.css";

interface Props {
  /** Pre-scored gallery (top 5-8) produced by analyzeRange. */
  recommendations: ChartRecommendation[];
  /** A1 range string the picker was opened against; shown read-only. */
  sourceRange: string;
  /** Called with the chosen chart type + the source range on commit. */
  onApply: (type: string, range: string) => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  line: "折れ線",
  bar: "横棒",
  column: "縦棒",
  pie: "円",
  area: "面",
  scatter: "散布図",
  doughnut: "ドーナツ",
};

export default function RecommendedChartsDialog({
  recommendations,
  sourceRange,
  onApply,
  onClose,
}: Props) {
  // Default to the top-scoring recommendation so [Enter] / 作成 is a one-key
  // confirm when the user is happy with the first suggestion.
  const [selectedIdx, setSelectedIdx] = useState<number>(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        const rec = recommendations[selectedIdx];
        if (rec) {
          e.preventDefault();
          onApply(rec.type, sourceRange);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onApply, recommendations, selectedIdx, sourceRange]);

  const handleApply = () => {
    const rec = recommendations[selectedIdx];
    if (!rec) return;
    onApply(rec.type, sourceRange);
    onClose();
  };

  return (
    <div className="rc-backdrop" onClick={onClose}>
      <div
        className="rc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rc-header">
          <h2 id="rc-title" className="rc-title">おすすめグラフ</h2>
          <button
            type="button"
            className="rc-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="rc-body">
          <p className="rc-range">
            データ範囲: <code>{sourceRange}</code>
          </p>
          {recommendations.length === 0 ? (
            <p className="rc-empty">
              選択範囲からおすすめできるグラフが見つかりませんでした。範囲を見直してください。
            </p>
          ) : (
            <ul className="rc-grid">
              {recommendations.map((rec, i) => {
                const selected = i === selectedIdx;
                return (
                  <li
                    key={`${rec.type}-${i}`}
                    className={
                      selected ? "rc-card rc-card--selected" : "rc-card"
                    }
                  >
                    <button
                      type="button"
                      className="rc-card-btn"
                      onClick={() => setSelectedIdx(i)}
                      onDoubleClick={() => {
                        setSelectedIdx(i);
                        onApply(rec.type, sourceRange);
                        onClose();
                      }}
                      aria-pressed={selected}
                    >
                      <div
                        className="rc-preview"
                        // SVG markup is produced internally by chartRender.ts
                        // (no user content interpolated unsanitized).
                        dangerouslySetInnerHTML={{ __html: rec.svgPreview }}
                      />
                      <div className="rc-card-meta">
                        <span className="rc-card-type">
                          {TYPE_LABELS[rec.type] ?? rec.type}
                        </span>
                        <span className="rc-card-reason">{rec.reason}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="rc-footer">
          <p className="rc-hint">
            選択すると、その種類のグラフが範囲に基づいて作成されます。
          </p>
          <div className="rc-footer-actions">
            <button type="button" className="rc-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="rc-btn rc-btn--primary"
              onClick={handleApply}
              disabled={recommendations.length === 0}
            >
              作成
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
