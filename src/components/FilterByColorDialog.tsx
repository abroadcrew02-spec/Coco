import { useEffect, useMemo, useState } from "react";
import {
  listDistinctColors,
  NO_COLOR_SENTINEL,
  type FilterByColorParams,
} from "../store/filterByColor";
import "./FilterByColorDialog.css";

interface Props {
  /** Default A1 range (typically derived from the active selection). */
  initialRange: string;
  /** Active sheet id — passed through unchanged for the host to use on apply. */
  sheetId: string;
  /**
   * Snapshot of the active sheet. We read `cellData` (and optionally a
   * workbook-level `styles` table forwarded via the same prop) to enumerate
   * the distinct colors that appear in the chosen column.
   */
  sheetSnapshot: { cellData?: Record<string, Record<string, unknown>> };
  onApply: (params: FilterByColorParams) => void;
  onClose: () => void;
}

// Rectangular A1 range (multi-cell), optionally sheet-qualified. Single-cell
// refs are rejected — filtering one row is pointless.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*$/;

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

export default function FilterByColorDialog({
  initialRange,
  sheetId: _sheetId,
  sheetSnapshot,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  // Column is 1-based in the UI (A=1) to match SortDialog's convention.
  const [columnInput, setColumnInput] = useState("1");
  const [kind, setKind] = useState<"fill" | "font">("fill");
  // Set of color hex strings the user has ticked. We start empty so the
  // distinct-colors list re-populates the selection lazily when the user
  // first sees the swatches (see effect below).
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  // Parsed rectangle (memoised so we don't re-parse on every keystroke change
  // of the column field).
  const rect = useMemo(() => parseRectangle(range.trim()), [range]);

  // Column index (0-based) — only valid when the parsed rect contains it.
  const columnIndex = useMemo(() => {
    const n = parseInt(columnInput, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n - 1;
  }, [columnInput]);

  // Enumerate distinct colors in the chosen column.
  // The `styles` table is forwarded transparently when present on the snapshot.
  const distinctColors = useMemo<string[]>(() => {
    if (!rect || columnIndex === null) return [];
    if (columnIndex < rect.c1 || columnIndex > rect.c2) return [];
    // Forward the workbook-level styles table if the host included it.
    const styles = (sheetSnapshot as { styles?: Record<string, Record<string, unknown>> }).styles;
    return listDistinctColors(
      sheetSnapshot.cellData as Parameters<typeof listDistinctColors>[0],
      rect,
      columnIndex,
      kind,
      styles,
    );
  }, [rect, columnIndex, kind, sheetSnapshot]);

  // Default selection: every color the column actually contains. Recompute
  // whenever the distinct-colors set changes (column / kind / range edits).
  useEffect(() => {
    setSelected(new Set(distinctColors));
  }, [distinctColors]);

  const toggleColor = (color: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(distinctColors));
  const clearAll = () => setSelected(new Set());

  const submit = () => {
    const trimmed = range.trim();
    if (!trimmed || !RANGE_RE.test(trimmed)) {
      setError("範囲は複数セルの A1 形式で指定してください (例: A1:C10)");
      return;
    }
    if (!rect) {
      setError("範囲の解析に失敗しました");
      return;
    }
    if (columnIndex === null) {
      setError("列番号は 1 以上の整数で指定してください (A=1)");
      return;
    }
    if (columnIndex < rect.c1 || columnIndex > rect.c2) {
      setError("指定された列が範囲外です");
      return;
    }
    if (selected.size === 0) {
      setError("色を 1 つ以上選択してください");
      return;
    }
    setError(null);
    onApply({
      range: rect,
      column: columnIndex,
      kind,
      selectedColors: Array.from(selected),
    });
    onClose();
  };

  return (
    <div className="fbc-backdrop" onClick={onClose}>
      <div
        className="fbc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fbc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fbc-header">
          <h2 id="fbc-title" className="fbc-title">色でフィルター</h2>
          <button
            type="button"
            className="fbc-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="fbc-body">
          <label className="fbc-field">
            <span className="fbc-field-label">フィルター範囲</span>
            <input
              type="text"
              className="fbc-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <label className="fbc-field">
            <span className="fbc-field-label">対象列 (A=1)</span>
            <input
              type="number"
              className="fbc-input fbc-input--num"
              min={1}
              value={columnInput}
              onChange={(e) => setColumnInput(e.target.value)}
              aria-label="対象列"
            />
          </label>
          <fieldset className="fbc-kind">
            <legend className="fbc-field-label">対象</legend>
            <label className="fbc-radio">
              <input
                type="radio"
                name="fbc-kind"
                value="fill"
                checked={kind === "fill"}
                onChange={() => setKind("fill")}
              />
              <span>セルの塗りつぶしの色</span>
            </label>
            <label className="fbc-radio">
              <input
                type="radio"
                name="fbc-kind"
                value="font"
                checked={kind === "font"}
                onChange={() => setKind("font")}
              />
              <span>フォントの色</span>
            </label>
          </fieldset>
          <fieldset className="fbc-colors">
            <legend className="fbc-field-label">
              色を選択 (該当する行のみ表示)
            </legend>
            <div className="fbc-color-actions">
              <button
                type="button"
                className="fbc-btn fbc-btn--mini"
                onClick={selectAll}
                disabled={distinctColors.length === 0}
              >
                全選択
              </button>
              <button
                type="button"
                className="fbc-btn fbc-btn--mini"
                onClick={clearAll}
                disabled={distinctColors.length === 0}
              >
                全クリア
              </button>
              <span className="fbc-color-count">
                {distinctColors.length} 色 / {selected.size} 選択
              </span>
            </div>
            {distinctColors.length === 0 ? (
              <p className="fbc-empty">
                対象列に色が設定されたセルがありません。
              </p>
            ) : (
              <div className="fbc-swatches">
                {distinctColors.map((color) => {
                  const isNone = color === NO_COLOR_SENTINEL;
                  const checked = selected.has(color);
                  return (
                    <label
                      key={color}
                      className={`fbc-swatch ${checked ? "fbc-swatch--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleColor(color)}
                      />
                      <span
                        className="fbc-swatch-chip"
                        style={
                          isNone
                            ? undefined
                            : { backgroundColor: color }
                        }
                        aria-hidden
                      >
                        {isNone ? "—" : ""}
                      </span>
                      <span className="fbc-swatch-label">
                        {isNone ? "色なし" : color}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          {error && <p className="fbc-error">{error}</p>}
        </div>
        <footer className="fbc-footer">
          <p className="fbc-hint">
            選択した色のセルを含む行のみを表示し、それ以外の行は非表示
            (rowData.hd) になります。ヘッダー行は常に表示されます。
          </p>
          <div className="fbc-footer-actions">
            <button type="button" className="fbc-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="fbc-btn fbc-btn--primary"
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
