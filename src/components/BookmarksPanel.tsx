import { useEffect, useState } from "react";
import {
  addBookmark,
  loadBookmarks,
  removeBookmark,
  renameBookmark,
  saveBookmarks,
  setColor,
  type BookmarkEntry,
} from "../store/bookmarks";
import "./BookmarksPanel.css";

interface Props {
  /** Per-workbook bookmark namespace (typically `currentHandle?.path`
   *  with a "default" fallback). Used as the localStorage key suffix so
   *  different files keep separate lists. Changing this prop reloads
   *  the panel from storage. */
  workbookId: string;
  /** Map of sheetId → sheetName, sourced from the snapshot in the parent.
   *  Used to render readable sheet labels and to refresh names after a
   *  rename without forcing the user to re-add the bookmark. */
  sheetNamesById: Record<string, string>;
  /** Click handler: jumps Univer's selection to (sheetId, cellRef). */
  onJumpTo: (sheetId: string, cellRef: string) => void;
  /** Optional: invoked by the "+ Add bookmark" button when the parent
   *  wants to drive the add-current-cell flow itself (e.g. so it can
   *  read the active selection). When omitted, the panel falls back to
   *  an inline form that asks for sheet + cell ref. */
  onRequestAddCurrent?: () => void;
}

// Palette for the inline color picker. Keep this short (6 + clear) so
// the picker stays a single row in the panel.
const COLOR_PALETTE: string[] = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#10b981", // green
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#6b7280", // gray
];

/** Cheap A1 sanity check: one-or-more letters followed by one-or-more
 *  digits. Accepts optional `$` anchors so users can paste copied refs. */
function isValidA1(ref: string): boolean {
  return /^\$?[A-Za-z]+\$?\d+$/.test(ref.trim());
}

/**
 * Sidebar panel listing every bookmark the user has saved for the
 * current workbook. Each row renders the label, sheet name, cell ref
 * and a color dot; clicking the row jumps the editor selection.
 *
 * State lives in localStorage keyed by workbookId — opening a different
 * file swaps the list automatically via the prop-change effect below.
 */
export default function BookmarksPanel({
  workbookId,
  sheetNamesById,
  onJumpTo,
  onRequestAddCurrent,
}: Props) {
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() =>
    loadBookmarks(workbookId),
  );
  const [collapsed, setCollapsed] = useState(false);
  // Inline rename state — only one row can be in edit mode at a time so
  // we just track which id (or null).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>("");
  // Inline color picker state.
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  // Inline add-form state (only used when onRequestAddCurrent isn't given
  // or when the user clicks the + button on an empty list).
  const [adding, setAdding] = useState(false);
  const [formLabel, setFormLabel] = useState("");
  const [formSheetId, setFormSheetId] = useState("");
  const [formCellRef, setFormCellRef] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Reload from storage when the workbookId prop changes — this happens
  // whenever the user opens a different file, so the panel needs to
  // show that file's list rather than the previous one.
  useEffect(() => {
    setBookmarks(loadBookmarks(workbookId));
    setEditingId(null);
    setColorPickerId(null);
    setAdding(false);
  }, [workbookId]);

  const handleRemove = (id: string) => {
    setBookmarks((prev) => {
      const next = removeBookmark(prev, id);
      if (next !== prev) saveBookmarks(workbookId, next);
      return next;
    });
    if (editingId === id) setEditingId(null);
    if (colorPickerId === id) setColorPickerId(null);
  };

  const beginRename = (entry: BookmarkEntry) => {
    setEditingId(entry.id);
    setEditingLabel(entry.label);
  };

  const commitRename = () => {
    if (editingId === null) return;
    const label = editingLabel.trim();
    if (label.length > 0) {
      setBookmarks((prev) => {
        const next = renameBookmark(prev, editingId, label);
        if (next !== prev) saveBookmarks(workbookId, next);
        return next;
      });
    }
    setEditingId(null);
  };

  const handleSetColor = (id: string, color: string | null) => {
    setBookmarks((prev) => {
      const next = setColor(prev, id, color);
      if (next !== prev) saveBookmarks(workbookId, next);
      return next;
    });
    setColorPickerId(null);
  };

  const handleOpenAddForm = () => {
    if (onRequestAddCurrent) {
      onRequestAddCurrent();
      return;
    }
    const sheetIds = Object.keys(sheetNamesById);
    if (!formSheetId && sheetIds.length > 0) {
      setFormSheetId(sheetIds[0]);
    }
    setFormLabel("");
    setFormCellRef("");
    setFormError(null);
    setAdding(true);
  };

  const handleSubmitAdd = () => {
    const label = formLabel.trim();
    const sheetId = formSheetId.trim();
    const cellRef = formCellRef.trim();
    if (!label) {
      setFormError("ラベルを入力してください。");
      return;
    }
    if (!sheetId) {
      setFormError("シートを選択してください。");
      return;
    }
    if (!isValidA1(cellRef)) {
      setFormError("セル参照は A1 形式で入力してください。");
      return;
    }
    setBookmarks((prev) => {
      const next = addBookmark(prev, { label, sheetId, cellRef });
      saveBookmarks(workbookId, next);
      return next;
    });
    setFormLabel("");
    setFormCellRef("");
    setFormError(null);
    setAdding(false);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="bmp-badge"
        onClick={() => setCollapsed(false)}
        title={`ブックマーク ${bookmarks.length} 件（クリックで展開）`}
        aria-label={`ブックマーク ${bookmarks.length} 件を表示`}
      >
        <span className="bmp-glyph" aria-hidden="true">★</span>
        <span className="bmp-badge-count">{bookmarks.length}</span>
      </button>
    );
  }

  const sheetIds = Object.keys(sheetNamesById);

  return (
    <aside className="bmp-panel" role="region" aria-label="ブックマーク">
      <header className="bmp-header">
        <span className="bmp-title">
          <span className="bmp-glyph" aria-hidden="true">★</span>
          ブックマーク ({bookmarks.length})
        </span>
        <span className="bmp-header-actions">
          <button
            type="button"
            className="bmp-add"
            onClick={handleOpenAddForm}
            aria-label="ブックマークを追加"
            title="現在のセルをブックマーク (Ctrl+D)"
          >
            +
          </button>
          <button
            type="button"
            className="bmp-collapse"
            onClick={() => setCollapsed(true)}
            aria-label="最小化"
            title="最小化"
          >
            −
          </button>
        </span>
      </header>
      {adding && (
        <div className="bmp-add-form">
          <label className="bmp-add-row">
            <span className="bmp-add-label">ラベル</span>
            <input
              className="bmp-add-input"
              type="text"
              placeholder="お気に入りのセル"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              autoFocus
            />
          </label>
          <label className="bmp-add-row">
            <span className="bmp-add-label">シート</span>
            <select
              className="bmp-add-select"
              value={formSheetId}
              onChange={(e) => setFormSheetId(e.target.value)}
            >
              {sheetIds.length === 0 && <option value="">(なし)</option>}
              {sheetIds.map((id) => (
                <option key={id} value={id}>
                  {sheetNamesById[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          <label className="bmp-add-row">
            <span className="bmp-add-label">セル</span>
            <input
              className="bmp-add-input bmp-add-input--mono"
              type="text"
              placeholder="A1"
              value={formCellRef}
              onChange={(e) => setFormCellRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSubmitAdd();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAdding(false);
                  setFormError(null);
                }
              }}
            />
          </label>
          {formError && <div className="bmp-add-error">{formError}</div>}
          <div className="bmp-add-buttons">
            <button type="button" className="bmp-add-submit" onClick={handleSubmitAdd}>
              追加
            </button>
            <button
              type="button"
              className="bmp-add-cancel"
              onClick={() => {
                setAdding(false);
                setFormError(null);
              }}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
      {bookmarks.length === 0 ? (
        <div className="bmp-empty">
          ブックマークはまだありません。「+」または Ctrl+D で追加できます。
        </div>
      ) : (
        <ul className="bmp-list">
          {bookmarks.map((entry) => {
            const sheetName = sheetNamesById[entry.sheetId] ?? entry.sheetId;
            const isEditing = editingId === entry.id;
            const isColorOpen = colorPickerId === entry.id;
            return (
              <li key={entry.id} className="bmp-item">
                <div className="bmp-item-main">
                  <button
                    type="button"
                    className="bmp-color-dot"
                    style={{
                      background: entry.color ?? "transparent",
                      borderColor: entry.color ?? "#d1d5db",
                    }}
                    onClick={() =>
                      setColorPickerId((cur) => (cur === entry.id ? null : entry.id))
                    }
                    aria-label="色を変更"
                    title="色タグを変更"
                  />
                  {isEditing ? (
                    <input
                      className="bmp-rename-input"
                      type="text"
                      value={editingLabel}
                      onChange={(e) => setEditingLabel(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      type="button"
                      className="bmp-jump"
                      onClick={() => onJumpTo(entry.sheetId, entry.cellRef)}
                      onDoubleClick={() => beginRename(entry)}
                      title={`${sheetName}!${entry.cellRef} に移動（ダブルクリックで名前変更）`}
                    >
                      <span className="bmp-label">{entry.label}</span>
                      <span className="bmp-target">
                        {sheetName}!{entry.cellRef}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="bmp-remove"
                    onClick={() => handleRemove(entry.id)}
                    aria-label={`${entry.label} を削除`}
                    title="削除"
                  >
                    ×
                  </button>
                </div>
                {isColorOpen && (
                  <div className="bmp-color-picker" role="group" aria-label="色を選択">
                    {COLOR_PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className="bmp-color-swatch"
                        style={{ background: c }}
                        onClick={() => handleSetColor(entry.id, c)}
                        aria-label={`色 ${c}`}
                        title={c}
                      />
                    ))}
                    <button
                      type="button"
                      className="bmp-color-clear"
                      onClick={() => handleSetColor(entry.id, null)}
                      aria-label="色を消す"
                      title="色なし"
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
