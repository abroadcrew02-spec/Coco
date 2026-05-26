import { useEffect, useMemo, useState } from "react";
import type { SlicerEntry } from "../store/slicers";
import "./InsertSlicerDialog.css";

interface AvailableTable {
  /** Workbook-unique table name (from `_tables[].name`). */
  name: string;
  /** Sheet id hosting the table — used by the caller to attach the slicer. */
  sheetId: string;
  /** Column header names; the user picks the slicer's "field" from this list. */
  columns: string[];
}

interface AvailablePivot {
  /** Workbook-unique pivot name (from `_pivots[].name`). */
  name: string;
  /** Sheet id hosting the pivot (typically the source sheet). */
  sheetId: string;
  /**
   * Field names the user can filter on. For a pivot this is the union of
   * source header names (rows + cols + filters + values + any raw source col).
   */
  columns: string[];
}

type SourceKind = "table" | "pivot";

interface Props {
  /** Tables a slicer can target — flattened from the workbook's `_tables`. */
  availableTables: AvailableTable[];
  /** Pivots a slicer can target — flattened from the workbook's `_pivots`. */
  availablePivots?: AvailablePivot[];
  /**
   * Called when the user clicks "作成". `sheetId` is the host sheet of the
   * target table / pivot — the slicer is stored there (workbook-wide
   * `_slicers` would have made the filter pipeline harder to reason about).
   */
  onApply: (entry: SlicerEntry, sheetId: string) => void;
  onClose: () => void;
}

export default function InsertSlicerDialog({
  availableTables,
  availablePivots = [],
  onApply,
  onClose,
}: Props) {
  // Default to "table" when any tables exist, otherwise "pivot" if pivots exist.
  const initialKind: SourceKind = availableTables.length > 0 ? "table" : "pivot";
  const [sourceKind, setSourceKind] = useState<SourceKind>(initialKind);
  const [tableName, setTableName] = useState<string>(() =>
    availableTables[0]?.name ?? "",
  );
  const [pivotName, setPivotName] = useState<string>(() =>
    availablePivots[0]?.name ?? "",
  );
  const [field, setField] = useState<string>(() => {
    if (initialKind === "table") return availableTables[0]?.columns[0] ?? "";
    return availablePivots[0]?.columns[0] ?? "";
  });
  const [error, setError] = useState<string | null>(null);

  const selectedTable = useMemo(
    () => availableTables.find((t) => t.name === tableName) ?? null,
    [availableTables, tableName],
  );
  const selectedPivot = useMemo(
    () => availablePivots.find((p) => p.name === pivotName) ?? null,
    [availablePivots, pivotName],
  );
  const activeColumns = sourceKind === "table"
    ? (selectedTable?.columns ?? [])
    : (selectedPivot?.columns ?? []);

  // Switching source kind / target resets the field to the first valid column
  // so a stale name from the previous selection doesn't sneak through.
  useEffect(() => {
    if (activeColumns.length === 0) {
      setField("");
      return;
    }
    if (!activeColumns.includes(field)) {
      setField(activeColumns[0] ?? "");
    }
  }, [activeColumns, field]);

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

  const submit = () => {
    if (sourceKind === "table" && !selectedTable) {
      setError("対象テーブルを選択してください");
      return;
    }
    if (sourceKind === "pivot" && !selectedPivot) {
      setError("対象ピボットを選択してください");
      return;
    }
    const fieldTrim = field.trim();
    if (!fieldTrim) {
      setError("フィールドを選択してください");
      return;
    }
    if (!activeColumns.includes(fieldTrim)) {
      setError(sourceKind === "table"
        ? "選択したフィールドはテーブルに存在しません"
        : "選択したフィールドはピボットのソースに存在しません");
      return;
    }
    setError(null);
    const target = sourceKind === "table" ? selectedTable! : selectedPivot!;
    const entry: SlicerEntry = {
      name: "",
      targetTable: target.name,
      targetKind: sourceKind,
      field: fieldTrim,
      selectedValues: [],
    };
    onApply(entry, target.sheetId);
    onClose();
  };

  const empty = availableTables.length === 0 && availablePivots.length === 0;
  const hasBoth = availableTables.length > 0 && availablePivots.length > 0;

  return (
    <div className="isd-backdrop" onClick={onClose}>
      <div
        className="isd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="isd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="isd-header">
          <h2 id="isd-title" className="isd-title">スライサーの挿入</h2>
          <button type="button" className="isd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="isd-body">
          {empty ? (
            <p className="isd-empty">
              このブックにはテーブルもピボットもありません。先に [挿入] → [テーブル]
              または [挿入] → [ピボットテーブル] で対象を作成してください。
            </p>
          ) : (
            <>
              {hasBoth && (
                <div className="isd-field">
                  <span className="isd-field-label">ソース種別</span>
                  <div className="isd-radio-row">
                    <label className="isd-radio">
                      <input
                        type="radio"
                        value="table"
                        checked={sourceKind === "table"}
                        onChange={() => setSourceKind("table")}
                      />
                      <span>テーブル</span>
                    </label>
                    <label className="isd-radio">
                      <input
                        type="radio"
                        value="pivot"
                        checked={sourceKind === "pivot"}
                        onChange={() => setSourceKind("pivot")}
                      />
                      <span>ピボット</span>
                    </label>
                  </div>
                </div>
              )}
              {sourceKind === "table" ? (
                <label className="isd-field">
                  <span className="isd-field-label">対象テーブル</span>
                  <select
                    className="isd-select"
                    value={tableName}
                    onChange={(e) => setTableName(e.target.value)}
                    autoFocus
                  >
                    {availableTables.map((t) => (
                      <option key={`${t.sheetId}:${t.name}`} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="isd-field">
                  <span className="isd-field-label">対象ピボット</span>
                  <select
                    className="isd-select"
                    value={pivotName}
                    onChange={(e) => setPivotName(e.target.value)}
                    autoFocus
                  >
                    {availablePivots.map((p) => (
                      <option key={`${p.sheetId}:${p.name}`} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="isd-field">
                <span className="isd-field-label">フィールド (列)</span>
                <select
                  className="isd-select"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  disabled={activeColumns.length === 0}
                >
                  {activeColumns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </label>
              {error && <p className="isd-error">{error}</p>}
            </>
          )}
        </div>
        <footer className="isd-footer">
          <p className="isd-hint">
            選択したフィールドの値ごとにボタンを表示します。ボタンをクリックして
            対象テーブルの行をフィルタできます (Excel のスライサー相当)。
          </p>
          <div className="isd-footer-actions">
            <button type="button" className="isd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="isd-btn isd-btn--primary"
              onClick={submit}
              disabled={empty}
            >
              作成
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
