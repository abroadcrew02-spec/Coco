import { useMemo, useState, useRef, useCallback } from "react";
import type { StoredMeasure, StoredCalculatedColumn } from "../store/cocoDataModel";
import { readDataModel } from "../store/cocoDataModel";
import type { ModelTable } from "../store/daxEngine";
import "./MeasureListPanel.css";

interface Props {
  workbookSnapshotJson: string;
  /** Remove a measure or calculated column by id. */
  onDelete: (id: string, kind: "measure" | "calculatedColumn") => void;
  /** Open the editor to create a new measure. */
  onAdd?: () => void;
  /** Open the editor to edit an existing measure. */
  onEdit?: (measure: StoredMeasure) => void;
  /** Open the editor to create a new calculated column. */
  onAddCalculatedColumn?: () => void;
  /** Open the editor to edit an existing calculated column. */
  onEditCalculatedColumn?: (col: StoredCalculatedColumn) => void;
  /** Remove a table from the data model by name. */
  onDeleteTable?: (name: string) => void;
  /**
   * Rename a measure. Returns `{ nameChanged, collided }`. When `collided` is
   * true the panel shows an inline error; caller persists on `nameChanged`.
   */
  onRenameMeasure?: (
    oldName: string,
    newName: string,
  ) => { nameChanged: boolean; collided: boolean };
  /**
   * Rename a calculated column. Same contract as `onRenameMeasure` but
   * identifies the column by `id` (not name, because the name is the value
   * being changed).
   */
  onRenameCalculatedColumn?: (
    id: string,
    newColumnName: string,
  ) => { nameChanged: boolean; collided: boolean };
}

interface MeasureRow {
  id: string;
  name: string;
  tableId: string;
  expression: string;
  kind: "measure" | "calculatedColumn";
}

interface RenameState {
  id: string;
  value: string;
  error: string | null;
}

export default function MeasureListPanel({
  workbookSnapshotJson,
  onDelete,
  onAdd,
  onEdit,
  onAddCalculatedColumn,
  onEditCalculatedColumn,
  onDeleteTable,
  onRenameMeasure,
  onRenameCalculatedColumn,
}: Props) {
  const { tables, measures, calculatedColumns } = useMemo(() => {
    const empty = {
      tables: [] as ModelTable[],
      measures: [] as StoredMeasure[],
      calculatedColumns: [] as StoredCalculatedColumn[],
    };
    if (!workbookSnapshotJson) return empty;
    try {
      const snap = JSON.parse(workbookSnapshotJson) as unknown;
      const model = readDataModel(snap);
      return {
        tables: model.tables,
        measures: model.measures,
        calculatedColumns: model.calculatedColumns,
      };
    } catch {
      return empty;
    }
  }, [workbookSnapshotJson]);

  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = useCallback((row: MeasureRow) => {
    setRenaming({ id: row.id, value: row.name, error: null });
    // Focus after the render cycle.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    (row: MeasureRow) => {
      if (!renaming) return;
      const newName = renaming.value.trim();
      if (!newName) {
        setRenaming((r) => r && { ...r, error: "名前を入力してください" });
        return;
      }
      if (row.kind === "measure") {
        if (!onRenameMeasure) { setRenaming(null); return; }
        const result = onRenameMeasure(row.name, newName);
        if (result.collided) {
          setRenaming((r) => r && { ...r, error: "この名前は既に使われています" });
          return;
        }
      } else {
        if (!onRenameCalculatedColumn) { setRenaming(null); return; }
        const result = onRenameCalculatedColumn(row.id, newName);
        if (result.collided) {
          setRenaming((r) => r && { ...r, error: "この名前は既に使われています" });
          return;
        }
      }
      setRenaming(null);
    },
    [renaming, onRenameMeasure, onRenameCalculatedColumn],
  );

  const isEmpty =
    tables.length === 0 && measures.length === 0 && calculatedColumns.length === 0;

  if (isEmpty) {
    return (
      <div className="mlp-root">
        <div className="mlp-header">
          <span>データモデル</span>
          {onAdd && (
            <button
              type="button"
              className="mlp-add"
              onClick={onAdd}
              aria-label="新規メジャー"
              title="新規メジャー"
            >
              +
            </button>
          )}
        </div>
        <p className="mlp-empty">
          データモデルは空です。テーブルパネルから「📊 データモデルへ追加」でテーブルを追加してください。
        </p>
      </div>
    );
  }

  const renderMeasureInfo = (row: MeasureRow) => (
    <span className="mlp-info-inner">
      <span className="mlp-name">{row.name}</span>
      <span className="mlp-meta">
        {row.tableId && <span className="mlp-badge">{row.tableId}</span>}
        <span className="mlp-expr" title={row.expression}>{row.expression}</span>
      </span>
    </span>
  );

  const renderRow = (row: MeasureRow) => {
    const isMeasure = row.kind === "measure";
    const measure = isMeasure ? measures.find((m) => m.id === row.id) : undefined;
    const calcCol = !isMeasure ? calculatedColumns.find((c) => c.id === row.id) : undefined;
    const canEditMeasure = isMeasure && !!onEdit && !!measure;
    const canEditCalcCol = !isMeasure && !!onEditCalculatedColumn && !!calcCol;
    const canRenameMeasure = isMeasure && !!onRenameMeasure;
    const canRenameCalcCol = !isMeasure && !!onRenameCalculatedColumn;
    const isRenaming = renaming?.id === row.id;

    if (isRenaming && renaming) {
      return (
        <li key={row.id} className="mlp-row mlp-row--renaming">
          <div className="mlp-rename-wrap">
            <input
              ref={inputRef}
              className={`mlp-rename-input${renaming.error ? " mlp-rename-input--error" : ""}`}
              value={renaming.value}
              onChange={(e) =>
                setRenaming((r) => r && { ...r, value: e.target.value, error: null })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(row);
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={() => commitRename(row)}
              aria-label="新しい名前"
            />
            {renaming.error && (
              <span className="mlp-rename-error" role="alert">{renaming.error}</span>
            )}
          </div>
          <button
            type="button"
            className="mlp-delete"
            onClick={cancelRename}
            aria-label="名前変更をキャンセル"
            title="キャンセル"
          >
            ×
          </button>
        </li>
      );
    }

    return (
      <li key={row.id} className="mlp-row">
        {canEditMeasure ? (
          <button
            type="button"
            className="mlp-info mlp-info--editable"
            onClick={() => onEdit!(measure!)}
            aria-label={`${row.name} を編集`}
          >
            {renderMeasureInfo(row)}
          </button>
        ) : canEditCalcCol ? (
          <button
            type="button"
            className="mlp-info mlp-info--editable"
            onClick={() => onEditCalculatedColumn!(calcCol!)}
            aria-label={`${row.name} を編集`}
          >
            {renderMeasureInfo(row)}
          </button>
        ) : (
          <div className="mlp-info">
            {renderMeasureInfo(row)}
          </div>
        )}
        {(canRenameMeasure || canRenameCalcCol) && (
          <button
            type="button"
            className="mlp-rename"
            onClick={() => startRename(row)}
            aria-label={`${row.name} の名前を変更`}
            title="名前変更"
          >
            ✏
          </button>
        )}
        <button
          type="button"
          className="mlp-delete"
          onClick={() => onDelete(row.id, row.kind)}
          aria-label={`${row.name} を削除`}
          title="削除"
        >
          ×
        </button>
      </li>
    );
  };

  const measureRows: MeasureRow[] = measures.map((m) => ({ ...m, kind: "measure" as const }));
  const calcColRows: MeasureRow[] = calculatedColumns.map((c) => ({ ...c, kind: "calculatedColumn" as const }));

  return (
    <div className="mlp-root">
      <div className="mlp-header">
        <span>データモデル ({tables.length} テーブル / {measures.length + calculatedColumns.length} メジャー)</span>
        {onAdd && (
          <button
            type="button"
            className="mlp-add"
            onClick={onAdd}
            aria-label="新規メジャー"
            title="新規メジャー"
          >
            +
          </button>
        )}
      </div>
      {tables.length > 0 && (
        <>
          <div className="mlp-section-label">テーブル</div>
          <ul className="mlp-list">
            {tables.map((t) => (
              <li key={t.name} className="mlp-row">
                <div className="mlp-info">
                  <span className="mlp-info-inner">
                    <span className="mlp-name">{t.name}</span>
                    <span className="mlp-meta">
                      <span className="mlp-badge">{t.columns.length} 列</span>
                      <span className="mlp-expr">{t.rows.length} 行</span>
                    </span>
                  </span>
                </div>
                {onDeleteTable && (
                  <button
                    type="button"
                    className="mlp-delete"
                    onClick={() => onDeleteTable(t.name)}
                    aria-label={`${t.name} を削除`}
                    title="削除"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {measures.length > 0 && (
        <>
          <div className="mlp-section-label">メジャー</div>
          <ul className="mlp-list">{measureRows.map(renderRow)}</ul>
        </>
      )}
      {(calculatedColumns.length > 0 || onAddCalculatedColumn) && (
        <>
          <div className="mlp-section-label">
            <span>計算列</span>
            {onAddCalculatedColumn && (
              <button
                type="button"
                className="mlp-add"
                onClick={onAddCalculatedColumn}
                aria-label="新規計算列"
                title="新規計算列"
              >
                +
              </button>
            )}
          </div>
          {calculatedColumns.length > 0 && (
            <ul className="mlp-list">{calcColRows.map(renderRow)}</ul>
          )}
        </>
      )}
    </div>
  );
}
