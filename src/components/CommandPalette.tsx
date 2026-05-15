import { useEffect, useMemo, useRef, useState } from "react";
import "./CommandPalette.css";

export interface PaletteCommand {
  /** Stable id used by tests and for React keys. */
  id: string;
  /** Visible label rendered as the primary line of the row. */
  label: string;
  /** Optional grouping tag rendered as a small badge on the right. */
  category?: string;
  /** Optional shortcut hint (e.g. "Ctrl+S"). Displayed right-aligned. */
  shortcut?: string;
  /** Extra search keywords that don't appear in the label (e.g. English aliases). */
  keywords?: string;
  /** Invoked when the row is activated (Enter / click). */
  run: () => void;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

/**
 * Case-insensitive substring filter over `label + category + keywords`. We
 * keep this intentionally simple (no fuzzy scoring) — VS Code's palette also
 * works well with plain substring matching when the action list is < ~50
 * entries, which is where Coco sits.
 */
function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return commands;
  return commands.filter((cmd) => {
    const haystack = [cmd.label, cmd.category ?? "", cmd.keywords ?? ""]
      .join(" ")
      .toLowerCase();
    return haystack.includes(trimmed);
  });
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Clamp the highlighted row whenever the filtered list shrinks so the
  // selection never points past the end of the visible rows.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(0);
    }
  }, [filtered.length, activeIndex]);

  // Reset highlight to the top whenever the user changes the query — matches
  // the VS Code / Slack convention.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Autofocus the search field on open so the user can start typing
  // immediately without an extra click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlighted row scrolled into view as the user navigates with
  // ArrowUp/Down. Best-effort: scrollIntoView is missing in some test JSDOM
  // builds so we guard the call.
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
      const cmd = filtered[activeIndex];
      if (!cmd) return;
      // Close first so the action runs in a clean state (e.g. opening another
      // dialog doesn't fight the palette for focus).
      onClose();
      cmd.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const handleRowClick = (cmd: PaletteCommand) => {
    onClose();
    cmd.run();
  };

  return (
    <div className="cp-backdrop" onClick={onClose}>
      <div
        className="cp-modal"
        role="dialog"
        aria-modal="true"
        aria-label="コマンドパレット"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="cp-search">
          <input
            ref={inputRef}
            type="text"
            className="cp-input"
            placeholder="コマンドを検索..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="コマンド検索"
            aria-controls="cp-list"
            aria-activedescendant={
              filtered[activeIndex] ? `cp-row-${filtered[activeIndex].id}` : undefined
            }
          />
        </div>
        {filtered.length === 0 ? (
          <p className="cp-empty">該当するコマンドはありません</p>
        ) : (
          <ul
            id="cp-list"
            ref={listRef}
            className="cp-list"
            role="listbox"
            aria-label="利用可能なコマンド"
          >
            {filtered.map((cmd, idx) => {
              const isActive = idx === activeIndex;
              return (
                <li
                  key={cmd.id}
                  id={`cp-row-${cmd.id}`}
                  data-index={idx}
                  data-testid={`cp-row-${cmd.id}`}
                  className={"cp-row" + (isActive ? " cp-row--active" : "")}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleRowClick(cmd)}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <span className="cp-row-label">{cmd.label}</span>
                  <span className="cp-row-meta">
                    {cmd.category && (
                      <span className="cp-row-category">{cmd.category}</span>
                    )}
                    {cmd.shortcut && (
                      <span className="cp-row-shortcut">{cmd.shortcut}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <footer className="cp-footer">
          <span className="cp-hint">↑↓ で選択 · Enter で実行 · ESC で閉じる</span>
        </footer>
      </div>
    </div>
  );
}
