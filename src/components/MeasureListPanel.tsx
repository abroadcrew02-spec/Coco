import { useMemo } from "react";
import type { StoredMeasure, StoredCalculatedColumn } from "../store/cocoDataModel";
import { readDataModel } from "../store/cocoDataModel";
import "./MeasureListPanel.css";

interface Props {
  workbookSnapshotJson: string;
  /** Remove a measure or calculated column by id. */
  onDelete: (id: string, kind: "measure" | "calculatedColumn") => void;
}

interface MeasureRow {
  id: string;
  name: string;
  tableId: string;
  expression: string;
  kind: "measure" | "calculatedColumn";
}

export default function MeasureListPanel({ workbookSnapshotJson, onDelete }: Props) {
  const { measures, calculatedColumns } = useMemo(() => {
    if (!workbookSnapshotJson) return { measures: [] as StoredMeasure[], calculatedColumns: [] as StoredCalculatedColumn[] };
    try {
      const snap = JSON.parse(workbookSnapshotJson) as unknown;
      const model = readDataModel(snap);
      return { measures: model.measures, calculatedColumns: model.calculatedColumns };
    } catch {
      return { measures: [] as StoredMeasure[], calculatedColumns: [] as StoredCalculatedColumn[] };
    }
  }, [workbookSnapshotJson]);

  const isEmpty = measures.length === 0 && calculatedColumns.length === 0;

  if (isEmpty) {
    return (
      <div className="mlp-root">
        <div className="mlp-header">メジャー一覧</div>
        <p className="mlp-empty">データモデルにメジャーはありません。</p>
      </div>
    );
  }

  const renderRow = (row: MeasureRow) => (
    <li key={row.id} className="mlp-row">
      <div className="mlp-info">
        <span className="mlp-name">{row.name}</span>
        <span className="mlp-meta">
          {row.tableId && <span className="mlp-badge">{row.tableId}</span>}
          <span className="mlp-expr" title={row.expression}>{row.expression}</span>
        </span>
      </div>
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

  const measureRows: MeasureRow[] = measures.map((m) => ({ ...m, kind: "measure" as const }));
  const calcColRows: MeasureRow[] = calculatedColumns.map((c) => ({ ...c, kind: "calculatedColumn" as const }));

  return (
    <div className="mlp-root">
      <div className="mlp-header">
        メジャー一覧 ({measures.length + calculatedColumns.length})
      </div>
      {measures.length > 0 && (
        <>
          <div className="mlp-section-label">メジャー</div>
          <ul className="mlp-list">{measureRows.map(renderRow)}</ul>
        </>
      )}
      {calculatedColumns.length > 0 && (
        <>
          <div className="mlp-section-label">計算列</div>
          <ul className="mlp-list">{calcColRows.map(renderRow)}</ul>
        </>
      )}
    </div>
  );
}
