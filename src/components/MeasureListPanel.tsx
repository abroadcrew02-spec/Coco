import { useMemo } from "react";
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
}

interface MeasureRow {
  id: string;
  name: string;
  tableId: string;
  expression: string;
  kind: "measure" | "calculatedColumn";
}

export default function MeasureListPanel({
  workbookSnapshotJson,
  onDelete,
  onAdd,
  onEdit,
  onAddCalculatedColumn,
  onEditCalculatedColumn,
  onDeleteTable,
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
