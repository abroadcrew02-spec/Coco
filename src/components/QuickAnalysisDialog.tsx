import { useEffect, useMemo, useState } from "react";
import {
  optionsByCategory,
  QUICK_ANALYSIS_OPTIONS,
  type QuickAnalysisCategory,
  type QuickAnalysisOption,
} from "../store/quickAnalysis";
import "./QuickAnalysisDialog.css";

interface Props {
  /** Human-readable label for the active range, e.g. "A1:C10" or "Sheet1!A1:C10". */
  rangeLabel: string;
  /** Total cells covered by the selection. Shown in the header. */
  cellCount: number;
  /** Subset returned by recommendForRange(); badged in the UI. */
  recommended: QuickAnalysisOption[];
  /** Active sheet id at open time — passed through to onSelect for routing. */
  sheetId: string;
  /** A1 range string at open time — passed through to onSelect for routing. */
  range: string;
  onSelect: (option: QuickAnalysisOption) => void;
  onClose: () => void;
}

const TAB_LABELS: Record<QuickAnalysisCategory, string> = {
  format: "書式",
  chart: "グラフ",
  total: "合計",
  table: "テーブル",
  sparkline: "スパーク",
};

// Tiny inline glyphs per category — keeps the dialog self-contained without
// pulling in an icon font.
const CATEGORY_GLYPH: Record<QuickAnalysisCategory, string> = {
  format: "🎨",
  chart: "📊",
  total: "Σ",
  table: "▦",
  sparkline: "📈",
};

export default function QuickAnalysisDialog({
  rangeLabel,
  cellCount,
  recommended,
  onSelect,
  onClose,
}: Props) {
  const grouped = useMemo(() => optionsByCategory(QUICK_ANALYSIS_OPTIONS), []);
  // Pick the first non-empty tab as default; defaults to "format" if all
  // tabs are populated (the typical case).
  const [activeTab, setActiveTab] = useState<QuickAnalysisCategory>(() => {
    const order: QuickAnalysisCategory[] = [
      "format",
      "chart",
      "total",
      "table",
      "sparkline",
    ];
    return order.find((c) => grouped[c].length > 0) ?? "format";
  });

  // Fast lookup of recommended ids for badging.
  const recommendedIds = useMemo(
    () => new Set(recommended.map((o) => o.id)),
    [recommended],
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

  const handlePick = (option: QuickAnalysisOption) => {
    // Defer to the integrator (EditorScreen) for the actual side-effect.
    onSelect(option);
    onClose();
  };

  const tabs: QuickAnalysisCategory[] = [
    "format",
    "chart",
    "total",
    "table",
    "sparkline",
  ];

  return (
    <div className="qa-backdrop" onClick={onClose}>
      <div
        className="qa-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qa-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="qa-header">
          <div>
            <h2 id="qa-title" className="qa-title">
              クイック分析
            </h2>
            <p className="qa-subtitle">
              <span className="qa-range">{rangeLabel}</span>
              <span className="qa-sep">·</span>
              <span className="qa-count">{cellCount} セル</span>
            </p>
          </div>
          <button
            type="button"
            className="qa-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <nav className="qa-tabs" role="tablist" aria-label="分析カテゴリ">
          {tabs.map((tab) => {
            const count = grouped[tab].length;
            const recCount = grouped[tab].filter((o) =>
              recommendedIds.has(o.id),
            ).length;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={`qa-tab${activeTab === tab ? " qa-tab--active" : ""}`}
                onClick={() => setActiveTab(tab)}
                disabled={count === 0}
              >
                <span className="qa-tab-glyph" aria-hidden="true">
                  {CATEGORY_GLYPH[tab]}
                </span>
                <span className="qa-tab-label">{TAB_LABELS[tab]}</span>
                {recCount > 0 && (
                  <span
                    className="qa-tab-badge"
                    aria-label={`${recCount} 件のおすすめ`}
                  >
                    {recCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div
          className="qa-body"
          role="tabpanel"
          aria-labelledby={`qa-tab-${activeTab}`}
        >
          {grouped[activeTab].length === 0 ? (
            <p className="qa-empty">
              このカテゴリで利用できる項目はありません。
            </p>
          ) : (
            <div className="qa-grid">
              {grouped[activeTab].map((opt) => {
                const isRec = recommendedIds.has(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`qa-option${isRec ? " qa-option--recommended" : ""}`}
                    onClick={() => handlePick(opt)}
                    data-testid={`qa-option-${opt.id}`}
                  >
                    <span className="qa-option-glyph" aria-hidden="true">
                      {CATEGORY_GLYPH[opt.category]}
                    </span>
                    <span className="qa-option-text">
                      <span className="qa-option-label">{opt.label}</span>
                      <span className="qa-option-desc">{opt.description}</span>
                    </span>
                    {isRec && (
                      <span
                        className="qa-option-badge"
                        aria-label="おすすめ"
                        title="このデータに適した候補"
                      >
                        ★
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <footer className="qa-footer">
          <p className="qa-hint">
            ★ はデータの形状に基づくおすすめ項目です。Esc
            キーで閉じます。
          </p>
          <div className="qa-footer-actions">
            <button type="button" className="qa-btn" onClick={onClose}>
              キャンセル
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
