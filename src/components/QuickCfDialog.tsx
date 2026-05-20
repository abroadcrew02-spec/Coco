import { useEffect, useMemo, useState } from "react";
import {
  QUICK_CF_PRESETS,
  presetsByCategory,
  type QuickCfPreset,
} from "../store/quickCfPresets";
import "./QuickCfDialog.css";

interface Props {
  /** A1 range prefilled into the range field — usually the user's active
   *  selection. Empty is allowed so the dialog can also be invoked when
   *  there's no live selection. */
  initialRange: string;
  /** The sheet the new rule will attach to. Passed straight through to
   *  onApply so the parent component knows where to splice the rule in
   *  without re-deriving the active sheet from Univer. */
  sheetId: string;
  /** Invoked when the user clicks Apply on a valid preset+range. The parent
   *  is responsible for calling applyQuickCfPreset and pushing the result
   *  via updateSnapshot — the dialog itself doesn't touch the workbook. */
  onApply: (range: string, presetId: string) => void;
  onClose: () => void;
}

// Mirrors ConditionalFormattingDialog's loose sqref grammar: one or more
// A1 single-cell or range tokens separated by whitespace, no sheet qualifier.
const SQREF_PIECE = /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/;
function isValidSqref(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).every((p) => SQREF_PIECE.test(p));
}

const CATEGORY_LABELS: Record<QuickCfPreset["category"], string> = {
  topBottom: "上位 / 下位",
  aboveBelowAvg: "平均値より上 / 下",
  duplicateUnique: "重複 / 一意",
  dateRange: "日付",
};

// Render the preset's defaultStyle as a tiny inline-style chip preview so the
// user gets immediate visual feedback on what color the rule will paint.
function previewStyle(p: QuickCfPreset): React.CSSProperties {
  return {
    backgroundColor: p.defaultStyle.bgColor,
    color: p.defaultStyle.fontColor ?? "inherit",
  };
}

export default function QuickCfDialog({
  initialRange,
  sheetId,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [presetId, setPresetId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Escape closes the dialog. Mirrors the convention used by every other
  // modal in this codebase (Settings, ConditionalFormatting, etc.).
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

  // Memoise the categorised list — the catalog is `readonly` so this is a
  // one-time computation but the lint rule prefers the explicit memo.
  const grouped = useMemo(() => presetsByCategory(), []);

  const apply = () => {
    if (!isValidSqref(range)) {
      setError("範囲は A1 / A1:C5 / 複数区切り（半角スペース）で指定してください");
      return;
    }
    if (!presetId) {
      setError("プリセットを選択してください");
      return;
    }
    setError(null);
    onApply(range.trim(), presetId);
  };

  return (
    <div className="qcf-backdrop" onClick={onClose}>
      <div
        className="qcf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qcf-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="qcf-header">
          <h2 id="qcf-title" className="qcf-title">条件付き書式: クイックプリセット</h2>
          <button
            type="button"
            className="qcf-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="qcf-body">
          <label className="qcf-field">
            <span className="qcf-field-label">範囲 (sqref)</span>
            <input
              type="text"
              className="qcf-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:A100"
              autoFocus
              data-sheet-id={sheetId}
            />
          </label>
          {(Object.keys(grouped) as QuickCfPreset["category"][]).map((cat) => {
            const items = grouped[cat];
            if (items.length === 0) return null;
            return (
              <section key={cat} className="qcf-section">
                <h3 className="qcf-section-title">{CATEGORY_LABELS[cat]}</h3>
                <div className="qcf-grid" role="radiogroup" aria-label={CATEGORY_LABELS[cat]}>
                  {items.map((p) => {
                    const isActive = presetId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        className={`qcf-preset${isActive ? " qcf-preset--active" : ""}`}
                        onClick={() => setPresetId(p.id)}
                      >
                        <span className="qcf-preset-swatch" style={previewStyle(p)}>
                          Aa
                        </span>
                        <span className="qcf-preset-label">{p.nameJa}</span>
                        <span className="qcf-preset-sub">{p.nameEn}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {error && <p className="qcf-error">{error}</p>}
        </div>
        <footer className="qcf-footer">
          <p className="qcf-hint">
            プリセットは選択範囲に対して条件付き書式ルールを 1 件追加します。
            既存ルールが残っている場合、新しいルールは最も低い優先度で末尾に追加されます。
          </p>
          <div className="qcf-footer-actions">
            <button type="button" className="qcf-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="qcf-btn qcf-btn--primary"
              onClick={apply}
              disabled={!presetId || !range.trim()}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// Re-export the catalog so callers (CommandPalette, etc.) can list presets
// without pulling from the store module directly.
export { QUICK_CF_PRESETS };
