import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SelectionStatKey,
  type SelectionStats,
  DEFAULT_VISIBLE_STATS,
  SELECTION_STATS_STORAGE_KEY,
  SELECTION_STAT_ITEMS,
  formatStatValue,
  parseVisibleStats,
} from "../store/selectionStats";
import "./StatusBarStats.css";

interface Props {
  /**
   * Aggregates for the current Univer selection, or null when there is no
   * multi-cell selection worth summarizing (single cell / nothing selected).
   * EditorScreen passes null in those cases so the component renders nothing.
   */
  stats: SelectionStats | null;
}

/** Resolve a single aggregate to its display string, or null when N/A. */
function statText(key: SelectionStatKey, stats: SelectionStats): string | null {
  switch (key) {
    case "sum":
      return stats.sum === null ? null : `合計: ${formatStatValue(stats.sum)}`;
    case "average":
      return stats.average === null
        ? null
        : `平均: ${formatStatValue(stats.average)}`;
    case "count":
      return `データの個数: ${stats.count.toLocaleString("ja-JP")}`;
    case "numericCount":
      return `数値の個数: ${stats.numericCount.toLocaleString("ja-JP")}`;
    case "min":
      return stats.min === null ? null : `最小値: ${formatStatValue(stats.min)}`;
    case "max":
      return stats.max === null ? null : `最大値: ${formatStatValue(stats.max)}`;
  }
}

/**
 * Status-bar selection summary (#192). Mirrors Excel / Google Sheets: when the
 * user selects a range it shows 合計 / 平均 / データの個数 etc. on the bottom
 * bar. Clicking the area opens a small menu to toggle which items appear; the
 * choice is persisted to localStorage under `coco.selectionStats.visible`.
 *
 * Renders nothing when `stats` is null (single cell / no selection) so the
 * bar isn't cluttered when there's nothing to aggregate.
 */
export default function StatusBarStats({ stats }: Props) {
  const [visible, setVisible] = useState<SelectionStatKey[]>(() => {
    try {
      return parseVisibleStats(
        window.localStorage.getItem(SELECTION_STATS_STORAGE_KEY),
      );
    } catch {
      // localStorage may throw in private mode — fall back to defaults.
      return [...DEFAULT_VISIBLE_STATS];
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the customize menu on any outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const toggleItem = useCallback((key: SelectionStatKey) => {
    setVisible((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : // Keep the canonical Excel ordering rather than append order.
          SELECTION_STAT_ITEMS.map((item) => item.key).filter(
            (k) => k === key || prev.includes(k),
          );
      try {
        window.localStorage.setItem(
          SELECTION_STATS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Persist is best-effort; ignore quota / private-mode failures.
      }
      return next;
    });
  }, []);

  if (!stats) return null;

  const parts = visible
    .map((key) => statText(key, stats))
    .filter((text): text is string => text !== null);

  // Every visible item resolved to N/A (e.g. only sum/average chosen on a
  // text-only selection) — show nothing rather than an empty bar segment.
  if (parts.length === 0) return null;

  return (
    <div className="status-bar-stats" ref={rootRef}>
      <button
        type="button"
        className="status-bar-stats__summary"
        onClick={() => setMenuOpen((o) => !o)}
        title="クリックで表示項目をカスタマイズ"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {parts.map((text, i) => (
          <span key={i} className="status-bar-stats__item">
            {text}
          </span>
        ))}
      </button>
      {menuOpen && (
        <div className="status-bar-stats__menu" role="menu">
          {SELECTION_STAT_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={visible.includes(item.key)}
              className="status-bar-stats__menu-item"
              onClick={() => toggleItem(item.key)}
            >
              <span className="status-bar-stats__check" aria-hidden="true">
                {visible.includes(item.key) ? "✓" : ""}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
