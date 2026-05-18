import { useEffect, useMemo, useState } from "react";
import {
  BLANK_VALUE_SENTINEL,
  listColumnDistinctValues,
  type FilterSearchParams,
} from "../store/filterSearch";
import "./FilterSearchDialog.css";

interface Props {
  /** Default A1 range (typically derived from the active selection). */
  initialRange: string;
  /** Active sheet id — passed through unchanged for the host to use on apply. */
  sheetId: string;
  /**
   * Snapshot of the active sheet (cellData). Enumerated to discover the
   * distinct values that appear in the chosen column.
   */
  sheetSnapshot: { cellData?: Record<string, Record<string, unknown>> };
  onApply: (params: FilterSearchParams) => void;
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

export default function FilterSearchDialog({
  initialRange,
  sheetId: _sheetId,
  sheetSnapshot,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  // Column is 1-based in the UI (A=1) to match SortDialog / FilterByColorDialog.
  const [columnInput, setColumnInput] = useState("1");
  const [search, setSearch] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  // Set of value strings the user has ticked. Re-seeded from `distinctValues`
  // whenever the underlying value list changes (range / column edits).
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

  // Parsed rectangle (memoised so we don't re-parse on every keystroke).
  const rect = useMemo(() => parseRectangle(range.trim()), [range]);

  // Column index (0-based) — only valid when the parsed rect contains it.
  const columnIndex = useMemo(() => {
    const n = parseInt(columnInput, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n - 1;
  }, [columnInput]);

  // Enumerate distinct values + counts for the chosen column. The list
  // already includes a BLANK sentinel when applicable.
  const distinctValues = useMemo<Array<{ value: string; count: number }>>(() => {
    if (!rect || columnIndex === null) return [];
    if (columnIndex < rect.c1 || columnIndex > rect.c2) return [];
    return listColumnDistinctValues(
      sheetSnapshot.cellData as Parameters<typeof listColumnDistinctValues>[0],
      rect,
      columnIndex,
    );
  }, [rect, columnIndex, sheetSnapshot]);

  // Default selection: every distinct value (= "all visible"). Recompute
  // whenever the underlying values set changes.
  useEffect(() => {
    setSelected(new Set(distinctValues.map((d) => d.value)));
  }, [distinctValues]);

  // Apply the search-box filter against the displayed list. The search is
  // always case-insensitive on the UI side regardless of the apply-time
  // `caseSensitive` setting — typing "app" should still surface "Apple".
  const filteredValues = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return distinctValues;
    return distinctValues.filter((d) => {
      if (d.value === BLANK_VALUE_SENTINEL) return false;
      return d.value.toLowerCase().includes(q);
    });
  }, [distinctValues, search]);

  // Max count drives the visual-frequency bar so we can normalise width.
  const maxCount = useMemo(() => {
    let m = 0;
    for (const d of distinctValues) {
      if (d.count > m) m = d.count;
    }
    return m;
  }, [distinctValues]);

  const toggleValue = (value: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  // "Select all" / "clear all" operate on the *currently displayed* (search-
  // filtered) list — this matches Excel's autofilter behaviour where the
  // checkbox above the search box only toggles visible entries.
  const selectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const d of filteredValues) next.add(d.value);
      return next;
    });
  };
  const clearAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const d of filteredValues) next.delete(d.value);
      return next;
    });
  };

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
      setError("値を 1 つ以上選択してください");
      return;
    }
    setError(null);
    onApply({
      range: rect,
      column: columnIndex,
      selectedValues: Array.from(selected),
      caseSensitive,
    });
    onClose();
  };

  return (
    <div className="fsd-backdrop" onClick={onClose}>
      <div
        className="fsd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fsd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fsd-header">
          <h2 id="fsd-title" className="fsd-title">値で検索フィルター</h2>
          <button
            type="button"
            className="fsd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="fsd-body">
          <label className="fsd-field">
            <span className="fsd-field-label">フィルター範囲</span>
            <input
              type="text"
              className="fsd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <label className="fsd-field">
            <span className="fsd-field-label">対象列 (A=1)</span>
            <input
              type="number"
              className="fsd-input fsd-input--num"
              min={1}
              value={columnInput}
              onChange={(e) => setColumnInput(e.target.value)}
              aria-label="対象列"
            />
          </label>
          <label className="fsd-checkbox">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            <span>大文字 / 小文字を区別する</span>
          </label>
          <fieldset className="fsd-values">
            <legend className="fsd-field-label">
              値を選択 (該当する行のみ表示)
            </legend>
            <input
              type="search"
              className="fsd-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="値を絞り込む..."
              aria-label="値の検索"
            />
            <div className="fsd-value-actions">
              <button
                type="button"
                className="fsd-btn fsd-btn--mini"
                onClick={selectAll}
                disabled={filteredValues.length === 0}
              >
                全選択
              </button>
              <button
                type="button"
                className="fsd-btn fsd-btn--mini"
                onClick={clearAll}
                disabled={filteredValues.length === 0}
              >
                全クリア
              </button>
              <span className="fsd-value-count">
                {distinctValues.length} 値 / {selected.size} 選択
                {search.trim() && ` / ${filteredValues.length} 該当`}
              </span>
            </div>
            {distinctValues.length === 0 ? (
              <p className="fsd-empty">
                対象列にデータがありません。
              </p>
            ) : filteredValues.length === 0 ? (
              <p className="fsd-empty">
                検索条件に一致する値がありません。
              </p>
            ) : (
              <div className="fsd-list" role="listbox" aria-multiselectable="true">
                {filteredValues.map((d) => {
                  const isBlank = d.value === BLANK_VALUE_SENTINEL;
                  const checked = selected.has(d.value);
                  const widthPct = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
                  return (
                    <label
                      key={d.value}
                      className={`fsd-item ${checked ? "fsd-item--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleValue(d.value)}
                      />
                      <span
                        className={`fsd-item-label ${isBlank ? "fsd-item-label--blank" : ""}`}
                        title={isBlank ? "空白セル" : d.value}
                      >
                        {isBlank ? "(空白)" : d.value}
                      </span>
                      <span className="fsd-item-bar" aria-hidden>
                        <span
                          className="fsd-item-bar-fill"
                          style={{ width: `${widthPct}%` }}
                        />
                      </span>
                      <span className="fsd-item-count">{d.count}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          {error && <p className="fsd-error">{error}</p>}
        </div>
        <footer className="fsd-footer">
          <p className="fsd-hint">
            選択した値を含む行のみを表示し、それ以外の行は非表示
            (rowData.hd) になります。ヘッダー行は常に表示されます。
          </p>
          <div className="fsd-footer-actions">
            <button type="button" className="fsd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="fsd-btn fsd-btn--primary"
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
