import { useEffect, useMemo, useState } from "react";
import type { FormatCodeEntry } from "../store/numberFormatManager";
import "./NumberFormatManagerDialog.css";

interface Props {
  /** Flattened list of every unique custom format code in the workbook. */
  entries: FormatCodeEntry[];
  /** A1 reference for the active selection (passed to `onApplyToRange`). */
  activeSelectionRange: string;
  /** Rewrites every cell whose `_fmt` matches `oldCode` to `newCode`. */
  onRename: (oldCode: string, newCode: string) => void;
  /** Apply `code` to the user's current selection — same path as the toolbar. */
  onApplyToRange: (code: string, range: string) => void;
  /** Strip every cell using `code` (resets to General). */
  onDelete: (code: string) => void;
  onClose: () => void;
}

export default function NumberFormatManagerDialog({
  entries,
  activeSelectionRange,
  onRename,
  onApplyToRange,
  onDelete,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  // Per-row edit state — only one row may be in edit mode at a time, so we
  // track the code being edited plus the in-flight buffer value.
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // When in edit mode, Escape cancels the row edit rather than closing
        // the dialog — matches Excel's per-row inline editor behavior.
        if (editingCode !== null) {
          setEditingCode(null);
          setEditBuffer("");
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editingCode]);

  const visible = useMemo(() => {
    if (!filter.trim()) return entries;
    const needle = filter.trim().toLowerCase();
    return entries.filter((entry) => entry.code.toLowerCase().includes(needle));
  }, [entries, filter]);

  const beginEdit = (code: string) => {
    setEditingCode(code);
    setEditBuffer(code);
  };

  const commitEdit = (originalCode: string) => {
    const next = editBuffer.trim();
    setEditingCode(null);
    setEditBuffer("");
    // Empty input → no-op (avoid accidentally wiping every cell when the
    // user clears the field by mistake). Use the explicit delete button for
    // that path so the intent is unambiguous.
    if (!next || next === originalCode) return;
    onRename(originalCode, next);
  };

  return (
    <div className="nfm-backdrop" onClick={onClose}>
      <div
        className="nfm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nfm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="nfm-header">
          <h2 id="nfm-title" className="nfm-title">表示形式: 一覧管理</h2>
          <button type="button" className="nfm-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="nfm-body">
          <div className="nfm-toolbar">
            <label className="nfm-filter">
              <span className="nfm-filter-label">検索:</span>
              <input
                type="text"
                className="nfm-filter-input"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="書式コード (例: #,##0)"
                aria-label="書式コードを検索"
              />
            </label>
            <span className="nfm-count">{entries.length} 件のユニーク書式</span>
          </div>
          {visible.length === 0 ? (
            <p className="nfm-empty">
              {entries.length === 0
                ? "カスタム書式コードはこのブックでは使われていません。"
                : "検索条件に一致する書式コードがありません。"}
            </p>
          ) : (
            <div className="nfm-table-wrap">
              <table className="nfm-table" aria-label="書式コード一覧">
                <thead>
                  <tr>
                    <th scope="col" className="nfm-col-code">書式コード</th>
                    <th scope="col" className="nfm-col-sample">サンプル</th>
                    <th scope="col" className="nfm-col-count">セル数</th>
                    <th scope="col" className="nfm-col-sheets">シート</th>
                    <th scope="col" className="nfm-col-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry) => {
                    const isEditing = editingCode === entry.code;
                    return (
                      <tr key={entry.code}>
                        <td className="nfm-cell-code">
                          {isEditing ? (
                            <input
                              type="text"
                              className="nfm-edit-input"
                              value={editBuffer}
                              onChange={(e) => setEditBuffer(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitEdit(entry.code);
                                }
                              }}
                              autoFocus
                              aria-label={`${entry.code} の新しい書式コード`}
                            />
                          ) : (
                            <code className="nfm-code-text">{entry.code}</code>
                          )}
                        </td>
                        <td className="nfm-cell-sample">{entry.sampleRender}</td>
                        <td className="nfm-cell-count">{entry.cellCount}</td>
                        <td className="nfm-cell-sheets">
                          {entry.sheetIds.length} シート
                        </td>
                        <td className="nfm-cell-actions">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                className="nfm-btn nfm-btn--primary"
                                onClick={() => commitEdit(entry.code)}
                              >
                                確定
                              </button>
                              <button
                                type="button"
                                className="nfm-btn"
                                onClick={() => {
                                  setEditingCode(null);
                                  setEditBuffer("");
                                }}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="nfm-btn"
                                onClick={() => beginEdit(entry.code)}
                                aria-label={`${entry.code} を編集`}
                              >
                                編集
                              </button>
                              <button
                                type="button"
                                className="nfm-btn"
                                onClick={() => onApplyToRange(entry.code, activeSelectionRange)}
                                aria-label={`${entry.code} を選択範囲に適用`}
                                disabled={!activeSelectionRange}
                                title={
                                  activeSelectionRange
                                    ? `${activeSelectionRange} に適用`
                                    : "選択範囲がありません"
                                }
                              >
                                選択範囲へ
                              </button>
                              <button
                                type="button"
                                className="nfm-btn nfm-btn--danger"
                                onClick={() => onDelete(entry.code)}
                                aria-label={`${entry.code} をすべて削除`}
                              >
                                削除
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <footer className="nfm-footer">
          <p className="nfm-hint">
            ブック内で使われている表示形式コードを一覧表示します。「編集」で同じコードのセルを一括書き換え、「削除」で標準に戻します。
          </p>
          <div className="nfm-footer-actions">
            <button type="button" className="nfm-btn" onClick={onClose}>
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
