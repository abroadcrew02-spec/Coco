import { useEffect, useState } from "react";
import type { AdvancedFilterParams } from "../store/advancedFilter";
import "./AdvancedFilterDialog.css";

interface Props {
  /** Default A1 source range (typically derived from the active selection). */
  initialSourceRange: string;
  onApply: (params: AdvancedFilterParams) => void;
  onClose: () => void;
}

// Rectangular A1 range (multi-cell) optionally sheet-qualified — single cells
// rejected because filtering a single cell is meaningless.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*$/;
// A1 single cell (the destination input for "copyTo").
const CELL_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*$/;

// Same A1 helpers as elsewhere in the codebase. Kept local so the dialog has
// no dependency on store internals beyond the params type.
function colLetterToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseRectangle(
  a1: string,
): { r1: number; c1: number; r2: number; c2: number } | null {
  // Strip optional sheet prefix; we let the host decide which sheet to apply to.
  const bare = a1.includes("!") ? a1.split("!").slice(1).join("!") : a1;
  const m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(bare);
  if (!m) return null;
  const c1 = colLetterToIndex(m[1].toUpperCase());
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = colLetterToIndex(m[3].toUpperCase());
  const r2 = parseInt(m[4], 10) - 1;
  if (c1 < 0 || c2 < 0 || r1 < 0 || r2 < 0) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

function parseCell(a1: string): { row: number; col: number } | null {
  const bare = a1.includes("!") ? a1.split("!").slice(1).join("!") : a1;
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(bare);
  if (!m) return null;
  const col = colLetterToIndex(m[1].toUpperCase());
  const row = parseInt(m[2], 10) - 1;
  if (col < 0 || row < 0) return null;
  return { row, col };
}

export default function AdvancedFilterDialog({
  initialSourceRange,
  onApply,
  onClose,
}: Props) {
  const [sourceRange, setSourceRange] = useState(initialSourceRange);
  const [criteriaRange, setCriteriaRange] = useState("");
  const [mode, setMode] = useState<"inPlace" | "copyTo">("inPlace");
  const [destination, setDestination] = useState("");
  const [uniqueRecordsOnly, setUniqueRecordsOnly] = useState(false);
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
    const src = sourceRange.trim();
    if (!src || !RANGE_RE.test(src)) {
      setError("リスト範囲は複数セルの A1 形式で指定してください (例: A1:C10)");
      return;
    }
    const crit = criteriaRange.trim();
    if (!crit || !RANGE_RE.test(crit)) {
      setError("検索条件範囲は複数セルの A1 形式で指定してください (例: E1:F2)");
      return;
    }
    const srcRect = parseRectangle(src);
    const critRect = parseRectangle(crit);
    if (!srcRect || !critRect) {
      setError("範囲の解析に失敗しました");
      return;
    }

    let destCell: { row: number; col: number } | undefined;
    if (mode === "copyTo") {
      const dst = destination.trim();
      if (!dst || !CELL_RE.test(dst)) {
        setError("抽出先は単一セルの A1 形式で指定してください (例: H1)");
        return;
      }
      const parsed = parseCell(dst);
      if (!parsed) {
        setError("抽出先の解析に失敗しました");
        return;
      }
      destCell = parsed;
    }

    setError(null);
    onApply({
      sourceRange: srcRect,
      criteriaRange: critRect,
      mode,
      destination: destCell,
      uniqueRecordsOnly,
    });
    onClose();
  };

  return (
    <div className="af-backdrop" onClick={onClose}>
      <div
        className="af-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="af-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="af-header">
          <h2 id="af-title" className="af-title">フィルターの詳細設定</h2>
          <button
            type="button"
            className="af-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="af-body">
          <fieldset className="af-mode">
            <legend className="af-field-label">抽出の方法</legend>
            <label className="af-radio">
              <input
                type="radio"
                name="af-mode"
                value="inPlace"
                checked={mode === "inPlace"}
                onChange={() => setMode("inPlace")}
              />
              <span>選択範囲内で絞り込む</span>
            </label>
            <label className="af-radio">
              <input
                type="radio"
                name="af-mode"
                value="copyTo"
                checked={mode === "copyTo"}
                onChange={() => setMode("copyTo")}
              />
              <span>指定した範囲に抽出する</span>
            </label>
          </fieldset>
          <label className="af-field">
            <span className="af-field-label">リスト範囲</span>
            <input
              type="text"
              className="af-input"
              value={sourceRange}
              onChange={(e) => setSourceRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <label className="af-field">
            <span className="af-field-label">検索条件範囲</span>
            <input
              type="text"
              className="af-input"
              value={criteriaRange}
              onChange={(e) => setCriteriaRange(e.target.value)}
              placeholder="E1:F2"
            />
          </label>
          {mode === "copyTo" && (
            <label className="af-field">
              <span className="af-field-label">抽出先 (左上セル)</span>
              <input
                type="text"
                className="af-input"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="H1"
              />
            </label>
          )}
          <label className="af-checkbox">
            <input
              type="checkbox"
              checked={uniqueRecordsOnly}
              onChange={(e) => setUniqueRecordsOnly(e.target.checked)}
            />
            <span>重複するレコードは無視する</span>
          </label>
          {error && <p className="af-error">{error}</p>}
        </div>
        <footer className="af-footer">
          <p className="af-hint">
            検索条件範囲の 1 行目に列見出し（リスト範囲の見出しと一致）を、
            2 行目以降に条件を入力します。同じ行の複数条件は AND、別の行は OR
            として評価されます (例: <code>&gt;25</code>, <code>&lt;&gt;Tokyo</code>)。
          </p>
          <div className="af-footer-actions">
            <button type="button" className="af-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="af-btn af-btn--primary"
              onClick={submit}
            >
              OK
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
