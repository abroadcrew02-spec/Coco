import { useEffect, useMemo, useRef, useState } from "react";
import {
  FUNCTION_CATALOG,
  FUNCTION_CATEGORY_LABELS,
  FUNCTION_CATEGORY_ORDER,
  buildInsertTemplate,
  filterFunctions,
  type FunctionCategory,
  type FunctionInfo,
} from "../store/functionCatalog";
import "./InsertFunctionDialog.css";

interface Props {
  /** Receives the formula template (e.g. "=SUM(") when the user confirms. */
  onInsert: (text: string) => void;
  onClose: () => void;
}

type CategoryFilter = FunctionCategory | "all";

export default function InsertFunctionDialog({ onInsert, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Filter is pure; recompute on any change to the inputs.
  const filtered = useMemo(
    () => filterFunctions(FUNCTION_CATALOG, category, query),
    [category, query],
  );

  const selected: FunctionInfo | null = filtered[activeIndex] ?? null;

  // Clamp the highlighted row whenever the filter shrinks the list.
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  // Reset highlight to the top whenever the user changes the query or
  // category — same convention as CommandPalette.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, category]);

  // Autofocus the search box so the user can start typing immediately.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Global Escape: close. Window-level so it fires even when focus is on
  // the inner list (where local handlers might not see it).
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

  // Scroll the highlighted row into view as the user navigates with the
  // keyboard. Best-effort: scrollIntoView is missing in some JSDOM builds.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLLIElement>(
      `li[data-index="${activeIndex}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const confirmInsert = (fn: FunctionInfo | null) => {
    if (!fn) return;
    onInsert(buildInsertTemplate(fn));
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirmInsert(selected);
    }
  };

  return (
    <div className="ifd-backdrop" onClick={onClose}>
      <div
        className="ifd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ifd-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="ifd-header">
          <h2 id="ifd-title" className="ifd-title">関数の挿入</h2>
          <button
            type="button"
            className="ifd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="ifd-toolbar">
          <input
            ref={searchRef}
            type="text"
            className="ifd-input"
            placeholder="関数名で検索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="関数を検索"
          />
          <select
            className="ifd-select"
            value={category}
            onChange={(e) => setCategory(e.target.value as CategoryFilter)}
            aria-label="カテゴリ"
          >
            <option value="all">すべて</option>
            {FUNCTION_CATEGORY_ORDER.map((cat) => (
              <option key={cat} value={cat}>
                {FUNCTION_CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>
        </div>

        <div className="ifd-body">
          {filtered.length === 0 ? (
            <p className="ifd-empty">該当する関数はありません</p>
          ) : (
            <ul
              ref={listRef}
              className="ifd-list"
              role="listbox"
              aria-label="関数一覧"
            >
              {filtered.map((fn, idx) => {
                const isActive = idx === activeIndex;
                return (
                  <li
                    key={fn.name}
                    data-index={idx}
                    data-testid={`ifd-row-${fn.name}`}
                    className={"ifd-row" + (isActive ? " ifd-row--active" : "")}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => setActiveIndex(idx)}
                    onDoubleClick={() => confirmInsert(fn)}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <span className="ifd-row-name">{fn.name}</span>
                    <span className="ifd-row-cat">
                      {FUNCTION_CATEGORY_LABELS[fn.category]}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <aside className="ifd-detail" aria-live="polite">
            {selected ? (
              <>
                <div className="ifd-detail-signature">{selected.signature}</div>
                <p className="ifd-detail-description">{selected.description}</p>
                <p className="ifd-detail-example">
                  <span className="ifd-detail-example-label">例:</span>
                  <code>{selected.example}</code>
                </p>
              </>
            ) : (
              <p className="ifd-detail-placeholder">
                関数を選択すると、書式と説明が表示されます。
              </p>
            )}
          </aside>
        </div>

        <footer className="ifd-footer">
          <span className="ifd-hint">
            ↑↓ で選択 · Enter / ダブルクリックで挿入 · ESC で閉じる
          </span>
          <div className="ifd-footer-actions">
            <button type="button" className="ifd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ifd-btn ifd-btn--primary"
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
