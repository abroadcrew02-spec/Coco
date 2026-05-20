import { useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  filterSymbols,
  formatCodePoint,
  type SymbolCategory,
  type SymbolEntry,
} from "../store/insertSymbol";
import "./InsertSymbolDialog.css";

interface Props {
  /** Receives the literal character (or grapheme) to insert at the caret. */
  onInsert: (char: string) => void;
  onClose: () => void;
}

type CategoryFilter = SymbolCategory | "all";

export default function InsertSymbolDialog({ onInsert, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [selected, setSelected] = useState<SymbolEntry | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Pure filter; recompute when either input changes.
  const filtered = useMemo(
    () => filterSymbols(query, category === "all" ? null : category),
    [query, category],
  );

  // Reset the highlighted symbol when the filter shrinks past it.
  useEffect(() => {
    if (selected && !filtered.some((s) => s.char === selected.char)) {
      setSelected(null);
    }
  }, [filtered, selected]);

  // Autofocus search so the user can type to filter immediately.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Window-level Escape so it fires even when focus is in the grid.
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

  const confirmInsert = (entry: SymbolEntry | null) => {
    if (!entry) return;
    onInsert(entry.char);
    onClose();
  };

  return (
    <div className="isd-backdrop" onClick={onClose}>
      <div
        className="isd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="isd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="isd-header">
          <h2 id="isd-title" className="isd-title">記号 / シンボルの挿入</h2>
          <button
            type="button"
            className="isd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="isd-toolbar">
          <input
            ref={searchRef}
            type="text"
            className="isd-input"
            placeholder="名前で検索 (例: yen, infinity, arrow)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="記号を検索"
          />
          <select
            className="isd-select"
            value={category}
            onChange={(e) => setCategory(e.target.value as CategoryFilter)}
            aria-label="カテゴリ"
          >
            <option value="all">すべて</option>
            {CATEGORY_ORDER.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>
        </div>

        <div className="isd-body">
          {filtered.length === 0 ? (
            <p className="isd-empty">該当する記号はありません</p>
          ) : (
            <div
              className="isd-grid"
              role="listbox"
              aria-label="記号一覧"
            >
              {filtered.map((entry) => {
                const isActive = selected?.char === entry.char;
                return (
                  <button
                    key={entry.char + entry.name}
                    type="button"
                    data-testid={`isd-cell-${entry.name}`}
                    className={
                      "isd-cell" + (isActive ? " isd-cell--active" : "")
                    }
                    role="option"
                    aria-selected={isActive}
                    title={`${entry.name}  (${formatCodePoint(entry.char)})`}
                    onClick={() => setSelected(entry)}
                    onDoubleClick={() => confirmInsert(entry)}
                  >
                    <span className="isd-cell-glyph">{entry.char}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="isd-preview" aria-live="polite">
          {selected ? (
            <>
              <span className="isd-preview-glyph">{selected.char}</span>
              <div className="isd-preview-meta">
                <div className="isd-preview-name">{selected.name}</div>
                <div className="isd-preview-code">
                  {formatCodePoint(selected.char)}
                  <span className="isd-preview-cat">
                    {CATEGORY_LABELS[selected.category]}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <span className="isd-preview-placeholder">
              記号をクリックして選択 · ダブルクリックで即挿入
            </span>
          )}
        </div>

        <footer className="isd-footer">
          <span className="isd-hint">
            ESC で閉じる · 検索は名前 (英語) と一致する文字で動作します
          </span>
          <div className="isd-footer-actions">
            <button type="button" className="isd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="isd-btn isd-btn--primary"
              onClick={() => confirmInsert(selected)}
              disabled={!selected}
            >
              挿入
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
