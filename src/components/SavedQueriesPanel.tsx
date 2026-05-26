import { useMemo } from "react";
import type { SavedQuery } from "../store/cocoQueries";
import { readQueries } from "../store/cocoQueries";
import "./SavedQueriesPanel.css";

interface Props {
  workbookSnapshotJson: string;
  /** Re-run the saved query against its source + write to output sheet. */
  onRefresh: (queryId: string) => void;
  /** Remove the query definition (does NOT delete the output sheet). */
  onDelete: (queryId: string) => void;
  /** Jump to the output sheet's A1. */
  onJumpTo: (outputSheet: string) => void;
}

export default function SavedQueriesPanel({
  workbookSnapshotJson,
  onRefresh,
  onDelete,
  onJumpTo,
}: Props) {
  const queries = useMemo<SavedQuery[]>(() => {
    if (!workbookSnapshotJson) return [];
    try {
      const snap = JSON.parse(workbookSnapshotJson) as unknown;
      return readQueries(snap);
    } catch {
      return [];
    }
  }, [workbookSnapshotJson]);

  if (queries.length === 0) {
    return (
      <div className="sqp-root">
        <div className="sqp-header">クエリ一覧</div>
        <p className="sqp-empty">保存されたクエリはありません。</p>
      </div>
    );
  }

  return (
    <div className="sqp-root">
      <div className="sqp-header">クエリ一覧 ({queries.length})</div>
      <ul className="sqp-list">
        {queries.map((query) => {
          const updatedAt = (() => {
            try {
              return new Date(query.updatedAt).toLocaleString("ja-JP", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
            } catch {
              return query.updatedAt;
            }
          })();
          return (
            <li key={query.id} className="sqp-row">
              <button
                type="button"
                className="sqp-jump"
                onClick={() => onJumpTo(query.outputSheet)}
                title={`${query.outputSheet} へジャンプ`}
                aria-label={`${query.name} の出力シート ${query.outputSheet} へジャンプ`}
              >
                <span className="sqp-name">{query.name}</span>
                <span className="sqp-meta">
                  <span className="sqp-badge">{query.source.kind}</span>
                  <span className="sqp-output">{query.outputSheet}</span>
                </span>
                <span className="sqp-updated">更新: {updatedAt}</span>
              </button>
              <button
                type="button"
                className="sqp-refresh"
                onClick={() => onRefresh(query.id)}
                aria-label={`${query.name} を更新`}
                title="更新"
              >
                ⟳
              </button>
              <button
                type="button"
                className="sqp-delete"
                onClick={() => onDelete(query.id)}
                aria-label={`${query.name} を削除`}
                title="削除"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
