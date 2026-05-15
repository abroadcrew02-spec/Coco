import { useEffect, useState } from "react";
import { t } from "../i18n/locale";
import "./SortDialog.css";

export interface SortLevel {
  /** 1-based column index (A = 1, B = 2, ...). */
  column: number;
  ascending: boolean;
}

export interface SortFormValue {
  /** A1 range string, e.g. "A1:C10" or "Sheet1!A1:C10". */
  range: string;
  /** Whether the first row of the range is a header (excluded from sort). */
  hasHeader: boolean;
  /** Ordered list of sort levels (primary first, up to 3). */
  levels: SortLevel[];
}

interface Props {
  /** Default A1 range (typically derived from the active selection). */
  initialRange: string;
  onApply: (value: SortFormValue) => void;
  onClose: () => void;
}

// Bare or sheet-qualified rectangular A1 range. Single-cell refs are rejected
// since sorting a single cell is meaningless.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return "並べ替え範囲は必須です";
  if (!RANGE_RE.test(trimmed))
    return "範囲は複数セルの A1 形式で指定してください (例: A1:C10)";
  return null;
}

function validateLevels(levels: SortLevel[]): string | null {
  for (const lv of levels) {
    if (!Number.isInteger(lv.column) || lv.column < 1) {
      return "列番号は 1 以上の整数で指定してください (A=1)";
    }
  }
  // Prevent duplicate columns across levels — Excel rejects identical keys too.
  const seen = new Set<number>();
  for (const lv of levels) {
    if (seen.has(lv.column)) return "同じ列を複数のレベルで指定することはできません";
    seen.add(lv.column);
  }
  return null;
}

const MAX_LEVELS = 3;

export default function SortDialog({ initialRange, onApply, onClose }: Props) {
  const [range, setRange] = useState(initialRange);
  const [hasHeader, setHasHeader] = useState(true);
  const [levels, setLevels] = useState<SortLevel[]>([
    { column: 1, ascending: true },
  ]);
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

  const updateLevel = (idx: number, patch: Partial<SortLevel>) => {
    setLevels((prev) => prev.map((lv, i) => (i === idx ? { ...lv, ...patch } : lv)));
  };

  const addLevel = () => {
    if (levels.length >= MAX_LEVELS) return;
    // Auto-pick the next free column so the user usually doesn't need to retype.
    const used = new Set(levels.map((lv) => lv.column));
    let nextCol = 1;
    while (used.has(nextCol)) nextCol++;
    setLevels([...levels, { column: nextCol, ascending: true }]);
  };

  const removeLevel = (idx: number) => {
    if (levels.length === 1) return;
    setLevels(levels.filter((_, i) => i !== idx));
  };

  const submit = () => {
    const rangeErr = validateRange(range);
    if (rangeErr) {
      setError(rangeErr);
      return;
    }
    const levelsErr = validateLevels(levels);
    if (levelsErr) {
      setError(levelsErr);
      return;
    }
    setError(null);
    onApply({
      range: range.trim(),
      hasHeader,
      levels: levels.map((lv) => ({ ...lv })),
    });
    onClose();
  };

  return (
    <div className="sd-backdrop" onClick={onClose}>
      <div
        className="sd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sd-header">
          <h2 id="sd-title" className="sd-title">{t("dialog.sort")}</h2>
          <button type="button" className="sd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="sd-body">
          <label className="sd-field">
            <span className="sd-field-label">並べ替え範囲</span>
            <input
              type="text"
              className="sd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <label className="sd-checkbox">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
            />
            <span>先頭行をヘッダーとして除外する</span>
          </label>
          <fieldset className="sd-levels">
            <legend className="sd-field-label">並べ替えキー（最大 3）</legend>
            {levels.map((lv, idx) => (
              <div key={idx} className="sd-level" data-testid={`sort-level-${idx}`}>
                <span className="sd-level-label">
                  {idx === 0 ? "優先" : `第 ${idx + 1}`}
                </span>
                <label className="sd-level-col">
                  <span>列 (A=1)</span>
                  <input
                    type="number"
                    className="sd-input sd-input--num"
                    min={1}
                    value={lv.column}
                    onChange={(e) =>
                      updateLevel(idx, { column: parseInt(e.target.value, 10) || 1 })
                    }
                    aria-label={`レベル ${idx + 1} の列番号`}
                  />
                </label>
                <label className="sd-level-dir">
                  <span>順序</span>
                  <select
                    className="sd-select"
                    value={lv.ascending ? "asc" : "desc"}
                    onChange={(e) =>
                      updateLevel(idx, { ascending: e.target.value === "asc" })
                    }
                    aria-label={`レベル ${idx + 1} の並び順`}
                  >
                    <option value="asc">昇順 (A→Z, 1→9)</option>
                    <option value="desc">降順 (Z→A, 9→1)</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="sd-btn sd-btn--danger"
                  onClick={() => removeLevel(idx)}
                  disabled={levels.length === 1}
                  aria-label={`レベル ${idx + 1} を削除`}
                >
                  削除
                </button>
              </div>
            ))}
            {levels.length < MAX_LEVELS && (
              <button
                type="button"
                className="sd-btn sd-btn--add"
                onClick={addLevel}
              >
                + キーを追加
              </button>
            )}
          </fieldset>
          {error && <p className="sd-error">{error}</p>}
        </div>
        <footer className="sd-footer">
          <p className="sd-hint">
            指定された範囲の行を、優先キーから順に比較して並べ替えます。
            このビルドでは Univer のソートプラグインを同梱していないため、
            スナップショットを直接書き換えて結果を反映します。
          </p>
          <div className="sd-footer-actions">
            <button type="button" className="sd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="sd-btn sd-btn--primary" onClick={submit}>
              並べ替え
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
