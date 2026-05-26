import { useMemo, useState } from "react";
import {
  listAllTables,
  rangeToA1,
  type TableListing,
  type WorkbookTableSnapshot,
} from "../store/tables";
import "./TableInfoPanel.css";

interface Props {
  /** Stringified workbook snapshot (FWorkbook.save() / store cache). */
  workbookSnapshotJson: string;
  /** Jump the active selection to a table's range on a given sheet. */
  onJumpTo: (sheetId: string, a1Range: string) => void;
  /** Workbook-wide rename. Returns false (no-op) when the new name collides. */
  onRename: (oldName: string, newName: string) => void;
  /** Drop a table from a specific sheet. */
  onDelete: (sheetId: string, name: string) => void;
  /** Import the table into the Coco Data Model. */
  onAddToDataModel?: (sheetId: string, tableName: string) => void;
}

export default function TableInfoPanel({
  workbookSnapshotJson,
  onJumpTo,
  onRename,
  onDelete,
  onAddToDataModel,
}: Props) {
  // Inline-edit state: which table name is being typed, and the in-flight
  // draft. We track by table name (workbook-unique) so the input doesn't
  // jump if the underlying list re-sorts mid-edit.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Recompute the listing on every render — patchTableRenders runs upstream
  // and the snapshot JSON only updates on commit, so this stays cheap.
  const listings: TableListing[] = useMemo(() => {
    if (!workbookSnapshotJson) return [];
    let parsed: WorkbookTableSnapshot;
    try {
      parsed = JSON.parse(workbookSnapshotJson) as WorkbookTableSnapshot;
    } catch {
      return [];
    }
    return listAllTables(parsed);
  }, [workbookSnapshotJson]);

  const beginRename = (name: string) => {
    setEditingName(name);
    setDraft(name);
  };

  const commitRename = (oldName: string) => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingName(null);
      setDraft("");
      return;
    }
    onRename(oldName, trimmed);
    setEditingName(null);
    setDraft("");
  };

  const cancelRename = () => {
    setEditingName(null);
    setDraft("");
  };

  return (
    <aside className="tip-root" aria-label="テーブル一覧">
      <header className="tip-header">
        <h3 className="tip-title">テーブル</h3>
        <span className="tip-count">{listings.length}</span>
      </header>
      {listings.length === 0 ? (
        <p className="tip-empty">
          このブックにはテーブルがありません。範囲を選択して [挿入] → [テーブル]
          で作成できます。
        </p>
      ) : (
        <ul className="tip-list">
          {listings.map(({ sheetId, sheetName, table }) => {
            const a1 = rangeToA1(table.range);
            const isEditing = editingName === table.name;
            return (
              <li key={`${sheetId}:${table.name}`} className="tip-item">
                <div className="tip-item-head">
                  {isEditing ? (
                    <input
                      type="text"
                      className="tip-rename-input"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(table.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename(table.name);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      aria-label={`${table.name} の名前を変更`}
                    />
                  ) : (
                    <button
                      type="button"
                      className="tip-name"
                      onClick={() => onJumpTo(sheetId, a1)}
                      title="クリックでテーブル範囲にジャンプ"
                    >
                      {table.name}
                    </button>
                  )}
                  <div className="tip-actions">
                    {!isEditing && (
                      <button
                        type="button"
                        className="tip-btn tip-btn--ghost"
                        onClick={() => beginRename(table.name)}
                        aria-label={`${table.name} の名前を変更`}
                      >
                        名前
                      </button>
                    )}
                    <button
                      type="button"
                      className="tip-btn tip-btn--danger"
                      onClick={() => onDelete(sheetId, table.name)}
                      aria-label={`${table.name} を削除`}
                    >
                      削除
                    </button>
                    {onAddToDataModel && (
                      <button
                        type="button"
                        className="tip-btn tip-btn--model"
                        onClick={() => onAddToDataModel(sheetId, table.name)}
                        aria-label={`${table.name} をデータモデルへ追加`}
                      >
                        📊 データモデルへ追加
                      </button>
                    )}
                  </div>
                </div>
                <div className="tip-meta">
                  <span className="tip-sheet">{sheetName}</span>
                  <span className="tip-sep">/</span>
                  <span className="tip-range">{a1}</span>
                  <span className="tip-sep">/</span>
                  <span className="tip-cols">
                    {table.columns.length} 列
                  </span>
                </div>
                {table.columns.length > 0 && (
                  <ul className="tip-cols-list">
                    {table.columns.map((col, idx) => (
                      <li key={idx} className="tip-col-chip" title={col.name}>
                        {col.name}
                      </li>
                    ))}
                  </ul>
                )}
                <code className="tip-ref-sample" aria-label="構造化参照のサンプル">
                  {table.name}[{table.columns[0]?.name ?? "Column1"}]
                </code>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
