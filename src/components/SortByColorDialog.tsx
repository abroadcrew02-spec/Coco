import { useEffect, useState } from "react";
import type { SortByColorMode, SortByColorParams } from "../store/sortByColor";
import "./SortByColorDialog.css";

interface Props {
  /** Default A1 range (typically derived from the active selection). */
  initialRange: string;
  /** Captured at open time so the apply targets the right sheet even if the
   *  user switches tabs while the dialog is open. */
  sheetId: string;
  onApply: (params: SortByColorParams) => void;
  onClose: () => void;
}

// Bare or sheet-qualified rectangular A1 range — single-cell refs rejected
// since color-sorting a single cell is meaningless.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*$/;

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseA1Range(
  range: string,
): { r1: number; c1: number; r2: number; c2: number } | null {
  const bare = range.includes("!") ? range.split("!")[1] : range;
  const m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(bare.trim());
  if (!m) return null;
  const c1 = colLetterToIndex(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = colLetterToIndex(m[3]);
  const r2 = parseInt(m[4], 10) - 1;
  if (![c1, r1, c2, r2].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

export default function SortByColorDialog({
  initialRange,
  sheetId: _sheetId,
  onApply,
  onClose,
}: Props) {
  // Mark sheetId as intentionally consumed by the parent's apply callback.
  void _sheetId;
  const [range, setRange] = useState(initialRange);
  // 1-based column number *within the range* — matches the standard SortDialog
  // convention so users don't switch mental models between the two dialogs.
  const [columnWithin, setColumnWithin] = useState(1);
  const [mode, setMode] = useState<SortByColorMode>("fillTop");
  const [pickedColor, setPickedColor] = useState("#ffeb9c");
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

  const needsPicked = mode === "fillTop" || mode === "fontTop";

  const submit = () => {
    const trimmed = range.trim();
    if (!trimmed) {
      setError("並べ替え範囲は必須です");
      return;
    }
    if (!RANGE_RE.test(trimmed)) {
      setError("範囲は複数セルの A1 形式で指定してください (例: A1:C10)");
      return;
    }
    const rect = parseA1Range(trimmed);
    if (!rect) {
      setError("範囲が解析できませんでした");
      return;
    }
    const width = rect.c2 - rect.c1 + 1;
    if (!Number.isInteger(columnWithin) || columnWithin < 1 || columnWithin > width) {
      setError(`色を読み取る列は 1〜${width} の範囲で指定してください`);
      return;
    }
    if (needsPicked) {
      // Browser color inputs always emit "#rrggbb" — guard against a malformed
      // value pasted into the hex text input by the user.
      if (!/^#[0-9a-fA-F]{6}$/.test(pickedColor.trim())) {
        setError("色は #RRGGBB 形式で指定してください");
        return;
      }
    }
    setError(null);
    onApply({
      range: rect,
      mode,
      column: rect.c1 + (columnWithin - 1),
      pickedColor: needsPicked ? pickedColor.trim().toLowerCase() : undefined,
    });
    onClose();
  };

  return (
    <div className="sbc-backdrop" onClick={onClose}>
      <div
        className="sbc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sbc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sbc-header">
          <h2 id="sbc-title" className="sbc-title">色で並べ替え</h2>
          <button type="button" className="sbc-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="sbc-body">
          <label className="sbc-field">
            <span className="sbc-field-label">並べ替え範囲</span>
            <input
              type="text"
              className="sbc-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>

          <label className="sbc-field">
            <span className="sbc-field-label">色を読み取る列 (範囲内, 1始まり)</span>
            <input
              type="number"
              className="sbc-input sbc-input--num"
              min={1}
              value={columnWithin}
              onChange={(e) => setColumnWithin(parseInt(e.target.value, 10) || 1)}
            />
          </label>

          <fieldset className="sbc-modes">
            <legend>並べ替え方法</legend>
            <label className="sbc-mode">
              <input
                type="radio"
                name="sbc-mode"
                value="fillTop"
                checked={mode === "fillTop"}
                onChange={() => setMode("fillTop")}
              />
              <span>選択した塗りつぶし色を上に</span>
            </label>
            <label className="sbc-mode">
              <input
                type="radio"
                name="sbc-mode"
                value="fontTop"
                checked={mode === "fontTop"}
                onChange={() => setMode("fontTop")}
              />
              <span>選択したフォント色を上に</span>
            </label>
            <label className="sbc-mode">
              <input
                type="radio"
                name="sbc-mode"
                value="fillOrder"
                checked={mode === "fillOrder"}
                onChange={() => setMode("fillOrder")}
              />
              <span>塗りつぶし色のリスト順 (出現順)</span>
            </label>
            <label className="sbc-mode">
              <input
                type="radio"
                name="sbc-mode"
                value="fontOrder"
                checked={mode === "fontOrder"}
                onChange={() => setMode("fontOrder")}
              />
              <span>フォント色のリスト順 (出現順)</span>
            </label>
          </fieldset>

          {needsPicked && (
            <label className="sbc-field">
              <span className="sbc-field-label">上に並べる色</span>
              <div className="sbc-color-row">
                <input
                  type="color"
                  value={pickedColor}
                  onChange={(e) => setPickedColor(e.target.value)}
                  aria-label="色を選択"
                />
                <input
                  type="text"
                  className="sbc-color-hex"
                  value={pickedColor}
                  onChange={(e) => setPickedColor(e.target.value)}
                  placeholder="#RRGGBB"
                  aria-label="色 (16進)"
                />
              </div>
            </label>
          )}

          {error && <p className="sbc-error">{error}</p>}
        </div>
        <footer className="sbc-footer">
          <p className="sbc-hint">
            指定した列のセル色を読み取り、行を並べ替えます。
            このビルドでは Univer の sort プラグインを同梱していないため、
            スナップショットを直接書き換えて結果を反映します。
          </p>
          <div className="sbc-footer-actions">
            <button type="button" className="sbc-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="sbc-btn sbc-btn--primary" onClick={submit}>
              並べ替え
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
