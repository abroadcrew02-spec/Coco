import type { ModelTable } from "../store/daxEngine";
import "./DaxColumnRefChips.css";

interface Props {
  tables: ModelTable[];
  /** Called with the snippet "TableName[ColumnName]" to insert at caret. */
  onInsert: (snippet: string) => void;
}

export default function DaxColumnRefChips({ tables, onInsert }: Props) {
  if (tables.length === 0) {
    return (
      <div className="dcrc-root dcrc-empty" aria-label="列参照チップス">
        データモデルテーブルがありません
      </div>
    );
  }

  return (
    <div className="dcrc-root" aria-label="列参照チップス">
      {tables.map((table) => (
        <details key={table.name} className="dcrc-group" open>
          <summary className="dcrc-summary">
            {table.name}
            <span className="dcrc-count">({table.columns.length} 列)</span>
          </summary>
          <div className="dcrc-chips">
            {table.columns.map((col) => (
              <button
                key={col.name}
                type="button"
                className="dcrc-chip"
                title={col.type}
                onClick={() => onInsert(`${table.name}[${col.name}]`)}
              >
                {col.name}
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
