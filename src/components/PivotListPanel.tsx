import { useMemo } from "react";
import type { PivotEntry, WorkbookPivotSnapshot } from "../store/pivots";
import { cellToA1, listAllPivots, rangeToA1 } from "../store/pivots";
import "./PivotListPanel.css";

interface PanelRow {
  sheetId: string;
  sheetName: string;
  pivot: PivotEntry;
}

interface Props {
  /** Stringified workbook snapshot. Re-parsed on each change. */
  workbookSnapshotJson: string;
  onRefresh: (name: string) => void;
  onDelete: (sheetId: string, name: string) => void;
  onJumpTo: (sheetId: string, cell: string) => void;
  /** When provided, an "edit" button is rendered for each pivot row. */
  onEdit?: (sheetId: string, pivot: PivotEntry) => void;
}

export default function PivotListPanel({
  workbookSnapshotJson,
  onRefresh,
  onDelete,
  onJumpTo,
  onEdit,
}: Props) {
  const rows = useMemo<PanelRow[]>(() => {
    if (!workbookSnapshotJson) return [];
    let snap: WorkbookPivotSnapshot;
    try {
      snap = JSON.parse(workbookSnapshotJson) as WorkbookPivotSnapshot;
    } catch {
      return [];
    }
    return listAllPivots(snap).map((e) => ({
      sheetId: e.sheetId,
      sheetName: e.sheetName,
      pivot: e.pivot,
    }));
  }, [workbookSnapshotJson]);

  if (rows.length === 0) {
    return (
      <div className="pvlp-root">
        <div className="pvlp-header">ピボット一覧</div>
        <p className="pvlp-empty">このブックにピボットテーブルはまだありません。</p>
      </div>
    );
  }

  return (
    <div className="pvlp-root">
      <div className="pvlp-header">ピボット一覧 ({rows.length})</div>
      <ul className="pvlp-list">
        {rows.map((row) => {
          const sourceA1 = row.pivot.source.kind === "sheet" ? rangeToA1(row.pivot.source.range) : row.pivot.source.tableName;
          const destA1 = cellToA1(row.pivot.destination.row, row.pivot.destination.col);
          const rowCount = row.pivot.rows.length;
          const colCount = row.pivot.cols.length;
          const valCount = row.pivot.values.length;
          return (
            <li key={`${row.sheetId}:${row.pivot.name}`} className="pvlp-row">
              <button
                type="button"
                className="pvlp-jump"
                onClick={() => onJumpTo(row.sheetId, destA1)}
                title={`${row.sheetName} の ${destA1} へジャンプ`}
              >
                <span className="pvlp-name">{row.pivot.name}</span>
                <span className="pvlp-meta">
                  <span className="pvlp-anchor">
                    {row.sheetName}!{sourceA1}
                  </span>
                  <span className="pvlp-arrow">→</span>
                  <span className="pvlp-dest">{destA1}</span>
                </span>
                <span className="pvlp-counts">
                  行 {rowCount} / 列 {colCount} / 値 {valCount}
                </span>
              </button>
              <button
                type="button"
                className="pvlp-refresh"
                onClick={() => onRefresh(row.pivot.name)}
                aria-label={`${row.pivot.name} を再計算`}
                title="再計算"
              >
                ⟳
              </button>
              {onEdit && (
                <button
                  type="button"
                  className="pvlp-edit"
                  onClick={() => onEdit(row.sheetId, row.pivot)}
                  aria-label={`${row.pivot.name} を編集`}
                  title="編集"
                >
                  ✎
                </button>
              )}
              <button
                type="button"
                className="pvlp-delete"
                onClick={() => onDelete(row.sheetId, row.pivot.name)}
                aria-label={`${row.pivot.name} を削除`}
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
