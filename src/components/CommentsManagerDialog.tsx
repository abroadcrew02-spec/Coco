import { useEffect, useMemo, useState } from "react";
import {
  bulkDeleteResolved,
  exportToCsv,
  exportToMarkdown,
  listAllComments,
  type CommentListing,
} from "../store/commentsManager";
import "./CommentsManagerDialog.css";

interface Props {
  /** JSON-serialized workbook snapshot — same string EditorScreen already holds. */
  workbookSnapshotJson: string;
  onResolveToggle: (sheetId: string, cellRef: string, resolved: boolean) => void;
  onDelete: (sheetId: string, cellRef: string) => void;
  onBulkDeleteResolved: () => void;
  onJumpToCell: (sheetId: string, cellRef: string) => void;
  onExportMarkdown: (text: string) => void;
  onExportCsv: (text: string) => void;
  onClose: () => void;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Workbook-wide comments view. Surfaces every cell comment across every
 * sheet so the user can audit, filter, bulk-resolve and export without
 * hunting cell-by-cell through the grid.
 *
 * Resolve / delete / jump are delegated to the integrator (EditorScreen)
 * via callbacks — this component owns the table render, filters, and
 * export formatting only. That keeps the snapshot mutation in one place
 * (EditorScreen.tsx) where the Univer state-update + undo-snapshot dance
 * is already wired up.
 *
 * Filters compose: text search ∩ author dropdown ∩ show-resolved toggle.
 * The author dropdown is rebuilt from the listing on every render so it
 * always reflects the current data without per-prop bookkeeping.
 */
export default function CommentsManagerDialog({
  workbookSnapshotJson,
  onResolveToggle,
  onDelete,
  onBulkDeleteResolved,
  onJumpToCell,
  onExportMarkdown,
  onExportCsv,
  onClose,
}: Props) {
  const [search, setSearch] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [showResolved, setShowResolved] = useState(true);

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

  const allComments = useMemo<CommentListing[]>(
    () => listAllComments(workbookSnapshotJson),
    [workbookSnapshotJson],
  );

  // Distinct, sorted author list for the dropdown. Empty-string authors
  // are bucketed under "—" so the dropdown surface is consistent with the
  // table render where missing authors show as "—".
  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const c of allComments) {
      if (c.author && c.author.trim()) set.add(c.author);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allComments]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allComments.filter((c) => {
      if (!showResolved && c.resolved) return false;
      if (authorFilter && (c.author ?? "") !== authorFilter) return false;
      if (!needle) return true;
      const hay = [
        c.sheetName,
        c.cellRef,
        c.author ?? "",
        c.body,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [allComments, search, authorFilter, showResolved]);

  const resolvedCount = useMemo(
    () => allComments.reduce((n, c) => (c.resolved ? n + 1 : n), 0),
    [allComments],
  );

  // Preview the bulk delete result before invoking the integrator — gives
  // us an accurate count for the confirm prompt without re-walking the
  // snapshot in EditorScreen.
  const handleBulkDelete = () => {
    if (resolvedCount === 0) return;
    const ok = window.confirm(
      `解決済みのコメント ${resolvedCount} 件を削除します。よろしいですか？`,
    );
    if (!ok) return;
    // We discard the preview snapshot; EditorScreen runs the same helper
    // against its own state for the actual mutation + undo snapshot.
    bulkDeleteResolved(workbookSnapshotJson);
    onBulkDeleteResolved();
  };

  const handleResolveAllVisible = () => {
    // "Resolve all visible" is implemented as N per-row toggles so the
    // integrator's undo / event pipeline observes each as a discrete
    // change — no new bulk API needed on the EditorScreen side.
    for (const c of filtered) {
      if (!c.resolved) onResolveToggle(c.sheetId, c.cellRef, true);
    }
  };

  const handleExportMd = () => {
    onExportMarkdown(exportToMarkdown(filtered));
  };

  const handleExportCsv = () => {
    onExportCsv(exportToCsv(filtered));
  };

  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <div
        className="cmd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cmd-header">
          <h2 id="cmd-title" className="cmd-title">
            コメント一覧 ({filtered.length}/{allComments.length})
          </h2>
          <button
            type="button"
            className="cmd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="cmd-filters">
          <input
            type="search"
            className="cmd-search"
            placeholder="検索 (シート / セル / 作成者 / 本文)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="コメント検索"
          />
          <select
            className="cmd-author-select"
            value={authorFilter}
            onChange={(e) => setAuthorFilter(e.target.value)}
            aria-label="作成者フィルター"
          >
            <option value="">すべての作成者</option>
            {authors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <label className="cmd-show-resolved">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            解決済みも表示
          </label>
        </div>

        <div className="cmd-body">
          {filtered.length === 0 ? (
            <p className="cmd-empty">表示するコメントがありません</p>
          ) : (
            <table className="cmd-table">
              <thead>
                <tr>
                  <th>シート</th>
                  <th>セル</th>
                  <th>作成者</th>
                  <th>本文</th>
                  <th>作成日時</th>
                  <th>返信</th>
                  <th>状態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const key = `${c.sheetId}!${c.cellRef}`;
                  return (
                    <tr
                      key={key}
                      className={c.resolved ? "cmd-row cmd-row--resolved" : "cmd-row"}
                    >
                      <td className="cmd-cell-sheet">{c.sheetName}</td>
                      <td className="cmd-cell-ref">{c.cellRef}</td>
                      <td className="cmd-cell-author">{c.author || "—"}</td>
                      <td className="cmd-cell-body" title={c.body}>
                        {c.body}
                      </td>
                      <td className="cmd-cell-time">
                        {formatTimestamp(c.createdAt)}
                      </td>
                      <td className="cmd-cell-replies">{c.replies}</td>
                      <td className="cmd-cell-status">
                        {c.resolved ? (
                          <span className="cmd-badge cmd-badge--resolved">
                            解決済み
                          </span>
                        ) : (
                          <span className="cmd-badge">未解決</span>
                        )}
                      </td>
                      <td className="cmd-cell-actions">
                        <button
                          type="button"
                          className="cmd-mini-btn"
                          onClick={() => onJumpToCell(c.sheetId, c.cellRef)}
                          title="このセルへ移動"
                        >
                          移動
                        </button>
                        <button
                          type="button"
                          className="cmd-mini-btn"
                          onClick={() =>
                            onResolveToggle(c.sheetId, c.cellRef, !c.resolved)
                          }
                          title={c.resolved ? "解決を解除" : "解決にする"}
                        >
                          {c.resolved ? "再開" : "解決"}
                        </button>
                        <button
                          type="button"
                          className="cmd-mini-btn cmd-mini-btn--danger"
                          onClick={() => {
                            if (window.confirm("このコメントを削除しますか？")) {
                              onDelete(c.sheetId, c.cellRef);
                            }
                          }}
                          title="削除"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="cmd-footer">
          <div className="cmd-footer-left">
            <button
              type="button"
              className="cmd-btn"
              onClick={handleResolveAllVisible}
              disabled={filtered.every((c) => c.resolved)}
              title="表示中のコメントをすべて解決済みにする"
            >
              表示中をすべて解決
            </button>
            <button
              type="button"
              className="cmd-btn cmd-btn--danger"
              onClick={handleBulkDelete}
              disabled={resolvedCount === 0}
              title="解決済みのコメントを一括削除"
            >
              解決済みを一括削除 ({resolvedCount})
            </button>
          </div>
          <div className="cmd-footer-right">
            <button type="button" className="cmd-btn" onClick={handleExportMd}>
              Markdown で書き出し
            </button>
            <button type="button" className="cmd-btn" onClick={handleExportCsv}>
              CSV で書き出し
            </button>
            <button
              type="button"
              className="cmd-btn cmd-btn--primary"
              onClick={onClose}
            >
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
