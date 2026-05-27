import { useEffect, useMemo, useState } from "react";
import type { PivotAggregator, PivotConfig, PivotEntry, PivotValueField } from "../store/pivots";
import { parseA1Cell, parseA1Range } from "../store/pivots";
import "./InsertPivotDialog.css";

const AGG_OPTIONS: PivotAggregator[] = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"];

type FieldRole = "rows" | "cols" | "values" | "filters" | null;

interface FieldDraft {
  /** Field display name (from source header). */
  name: string;
  role: FieldRole;
  /** Only relevant when role === "values" and valueKind === "column". */
  agg: PivotAggregator;
  /** Comma-separated allowed values when role === "filters". */
  filterValues: string;
  /**
   * "column" = classic aggregate, "measure" = DAX measure.
   * Only used when role === "values".
   */
  valueKind: "column" | "measure";
  /** Measure name when valueKind === "measure". */
  measureName: string;
}

export interface ModelTableInfo {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

export interface MeasureInfo {
  name: string;
  tableId: string;
}

interface Props {
  /** Pre-filled source range, e.g. "Sheet1!A1:D20" or "A1:D20". */
  initialSourceRange: string;
  /** Pre-filled destination top-left A1 cell, e.g. "F1". */
  initialDestination: string;
  /** Header names inferred from the source range. */
  sourceFieldNames: string[];
  /** Source sheet id — threaded in by the caller and re-emitted on apply. */
  sourceSheetId: string;
  /**
   * When provided, the dialog opens in "edit" mode: all fields are
   * pre-populated from the existing entry, the title reads
   * "ピボットの編集", and the primary button reads "更新".
   */
  initialEntry?: PivotEntry;
  /**
   * Data Model tables available for model-source pivots.
   * When undefined, the model mode toggle is hidden.
   */
  modelTables?: ModelTableInfo[];
  /**
   * DAX measures available as value fields in model mode.
   * When undefined, measure options are omitted from the values column.
   */
  availableMeasures?: MeasureInfo[];
  onApply: (config: PivotConfig) => void;
  onClose: () => void;
}

type SourceMode = "sheet" | "model";

function buildInitialFields(
  names: string[],
  entry: PivotEntry | undefined,
): FieldDraft[] {
  if (entry) {
    return names.map((n) => {
      let role: FieldRole = null;
      let agg: PivotAggregator = "SUM";
      let filterValues = "";
      let valueKind: "column" | "measure" = "column";
      let measureName = "";
      if (entry.rows.includes(n)) {
        role = "rows";
      } else if (entry.cols.includes(n)) {
        role = "cols";
      } else {
        const vf = entry.values.find((v) => v.kind === "column" && v.field === n);
        if (vf && vf.kind === "column") {
          role = "values";
          agg = vf.agg;
          valueKind = "column";
        } else {
          const ff = entry.filters?.find((f) => f.field === n);
          if (ff) {
            role = "filters";
            filterValues = ff.values.join(", ");
          }
        }
      }
      return { name: n, role, agg, filterValues, valueKind, measureName };
    });
  }
  return names.map((n) => ({
    name: n,
    role: null as FieldRole,
    agg: "SUM" as PivotAggregator,
    filterValues: "",
    valueKind: "column" as const,
    measureName: "",
  }));
}

export default function InsertPivotDialog({
  initialSourceRange,
  initialDestination,
  sourceFieldNames,
  sourceSheetId,
  initialEntry,
  modelTables,
  availableMeasures,
  onApply,
  onClose,
}: Props) {
  const isEditMode = initialEntry !== undefined;
  const hasModelSupport = modelTables !== undefined && modelTables.length > 0;

  // Determine initial source mode from the entry when editing.
  const initialSourceMode: SourceMode =
    initialEntry?.source.kind === "model" ? "model" : "sheet";

  const [sourceMode, setSourceMode] = useState<SourceMode>(initialSourceMode);
  const [sourceRange, setSourceRange] = useState(initialSourceRange);
  const [destination, setDestination] = useState(initialDestination);
  const [hasHeader, setHasHeader] = useState(initialEntry?.hasHeader ?? true);

  // Model mode: selected table name.
  const [selectedTableName, setSelectedTableName] = useState<string>(() => {
    if (initialEntry?.source.kind === "model") return initialEntry.source.tableName;
    return modelTables?.[0]?.name ?? "";
  });

  const [fields, setFields] = useState<FieldDraft[]>(() =>
    buildInitialFields(sourceFieldNames, initialEntry),
  );

  // Measure-only value rows (model mode): rows that represent a measure (not a column field).
  // These are separate from column-based fields because they don't come from the column list.
  const [measureValueRows, setMeasureValueRows] = useState<Array<{ id: string; measureName: string }>>(() => {
    if (initialEntry) {
      return initialEntry.values
        .filter((v) => v.kind === "measure")
        .map((v) => ({ id: crypto.randomUUID(), measureName: (v as { kind: "measure"; measureName: string }).measureName }));
    }
    return [];
  });

  const [error, setError] = useState<string | null>(null);

  // The active model table (resolves columns for field list in model mode).
  const activeModelTable = useMemo(
    () => modelTables?.find((t) => t.name === selectedTableName) ?? modelTables?.[0],
    [modelTables, selectedTableName],
  );

  // ESC to close.
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

  // When the parent refreshes inferred field names (sheet mode), merge while
  // preserving existing role/agg choices for fields that still exist.
  useEffect(() => {
    if (sourceMode !== "sheet") return;
    setFields((prev) => {
      const byName = new Map(prev.map((f) => [f.name, f]));
      return sourceFieldNames.map(
        (n) =>
          byName.get(n) ?? {
            name: n,
            role: null as FieldRole,
            agg: "SUM" as PivotAggregator,
            filterValues: "",
            valueKind: "column" as const,
            measureName: "",
          },
      );
    });
  }, [sourceFieldNames, sourceMode]);

  // When model table selection changes, reset field assignments.
  useEffect(() => {
    if (sourceMode !== "model" || !activeModelTable) return;
    setFields(
      activeModelTable.columns.map((col) => ({
        name: col.name,
        role: null as FieldRole,
        agg: "SUM" as PivotAggregator,
        filterValues: "",
        valueKind: "column" as const,
        measureName: "",
      })),
    );
    setMeasureValueRows([]);
  }, [activeModelTable, sourceMode]);

  const parsedSource = useMemo(() => parseA1Range(sourceRange), [sourceRange]);
  const parsedDest = useMemo(() => parseA1Cell(destination), [destination]);

  const setRole = (idx: number, role: FieldRole) => {
    setFields((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, role: f.role === role ? null : role } : f)),
    );
  };
  const setAgg = (idx: number, agg: PivotAggregator) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, agg } : f)));
  };
  const setFilterVals = (idx: number, v: string) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, filterValues: v } : f)));
  };
  const setValueKind = (idx: number, valueKind: "column" | "measure", measureName: string) => {
    setFields((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, valueKind, measureName } : f)),
    );
  };

  const addMeasureRow = () => {
    const first = availableMeasures?.[0]?.name ?? "";
    setMeasureValueRows((prev) => [...prev, { id: crypto.randomUUID(), measureName: first }]);
  };

  const removeMeasureRow = (id: string) => {
    setMeasureValueRows((prev) => prev.filter((r) => r.id !== id));
  };

  const setMeasureRowName = (id: string, name: string) => {
    setMeasureValueRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, measureName: name } : r)),
    );
  };

  const submit = () => {
    if (!parsedDest) {
      setError("出力先セルは A1 形式で指定してください (例: F1)");
      return;
    }

    if (sourceMode === "sheet") {
      if (!parsedSource) {
        setError("ソース範囲は A1 形式で指定してください (例: Sheet1!A1:D20)");
        return;
      }
      const rows = fields.filter((f) => f.role === "rows").map((f) => f.name);
      const cols = fields.filter((f) => f.role === "cols").map((f) => f.name);
      const values: PivotValueField[] = fields
        .filter((f) => f.role === "values")
        .map((f) => ({ kind: "column" as const, field: f.name, agg: f.agg }));
      const filters = fields
        .filter((f) => f.role === "filters")
        .map((f) => ({
          field: f.name,
          values: f.filterValues
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
        }))
        .filter((f) => f.values.length > 0);

      if (rows.length === 0 && cols.length === 0) {
        setError("行または列に少なくとも 1 つフィールドを割り当ててください");
        return;
      }
      if (values.length === 0) {
        setError("値に少なくとも 1 つフィールドを割り当ててください");
        return;
      }
      setError(null);
      onApply({
        source: { kind: "sheet" as const, sheetId: sourceSheetId, range: parsedSource.range },
        destination: { row: parsedDest.row, col: parsedDest.col },
        rows,
        cols,
        values,
        filters: filters.length ? filters : undefined,
        hasHeader,
      });
      onClose();
      return;
    }

    // Model mode
    if (!selectedTableName) {
      setError("テーブルを選択してください");
      return;
    }
    const rows = fields.filter((f) => f.role === "rows").map((f) => f.name);
    const cols = fields.filter((f) => f.role === "cols").map((f) => f.name);
    const columnValues: PivotValueField[] = fields
      .filter((f) => f.role === "values")
      .map((f) =>
        f.valueKind === "measure" && f.measureName
          ? ({ kind: "measure" as const, measureName: f.measureName } as PivotValueField)
          : ({ kind: "column" as const, field: f.name, agg: f.agg } as PivotValueField),
      );
    const standaloneValues: PivotValueField[] = measureValueRows
      .filter((r) => r.measureName)
      .map((r) => ({ kind: "measure" as const, measureName: r.measureName }));
    const values: PivotValueField[] = [...columnValues, ...standaloneValues];

    const filters = fields
      .filter((f) => f.role === "filters")
      .map((f) => ({
        field: f.name,
        values: f.filterValues
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      }))
      .filter((f) => f.values.length > 0);

    if (rows.length === 0 && cols.length === 0) {
      setError("行または列に少なくとも 1 つフィールドを割り当ててください");
      return;
    }
    if (values.length === 0) {
      setError("値に少なくとも 1 つフィールドを割り当ててください");
      return;
    }
    setError(null);
    onApply({
      source: { kind: "model" as const, tableName: selectedTableName },
      destination: { row: parsedDest.row, col: parsedDest.col },
      rows,
      cols,
      values,
      filters: filters.length ? filters : undefined,
      hasHeader: false,
    });
    onClose();
  };

  // Field list to show in the table (depends on source mode).
  const displayFields =
    sourceMode === "model" && activeModelTable
      ? fields.filter((f) =>
          activeModelTable.columns.some((c) => c.name === f.name),
        )
      : fields;

  return (
    <div className="ipd-backdrop" onClick={onClose}>
      <div
        className="ipd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ipd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ipd-header">
          <h2 id="ipd-title" className="ipd-title">
            {isEditMode ? "ピボットの編集" : "ピボットテーブルの作成"}
          </h2>
          <button type="button" className="ipd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ipd-body">
          {/* Source mode toggle — only shown when model support is available */}
          {hasModelSupport && (
            <fieldset className="ipd-mode-toggle">
              <legend className="ipd-field-label">データソース</legend>
              <div className="ipd-mode-options">
                <label className="ipd-mode-option">
                  <input
                    type="radio"
                    name="sourceMode"
                    value="sheet"
                    checked={sourceMode === "sheet"}
                    onChange={() => setSourceMode("sheet")}
                  />
                  <span>シート範囲</span>
                </label>
                <label className="ipd-mode-option">
                  <input
                    type="radio"
                    name="sourceMode"
                    value="model"
                    checked={sourceMode === "model"}
                    onChange={() => setSourceMode("model")}
                  />
                  <span>データモデル</span>
                </label>
              </div>
            </fieldset>
          )}

          {/* Source inputs — differ by mode */}
          {sourceMode === "sheet" ? (
            <>
              <label className="ipd-field">
                <span className="ipd-field-label">ソース範囲</span>
                <input
                  type="text"
                  className="ipd-input"
                  value={sourceRange}
                  onChange={(e) => setSourceRange(e.target.value)}
                  placeholder="Sheet1!A1:D20"
                  autoFocus
                />
              </label>
              <label className="ipd-field">
                <span className="ipd-field-label">出力先セル (左上)</span>
                <input
                  type="text"
                  className="ipd-input"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="F1"
                />
              </label>
              <label className="ipd-checkbox">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                />
                <span>先頭行をヘッダーとして扱う</span>
              </label>
            </>
          ) : (
            <>
              <label className="ipd-field">
                <span className="ipd-field-label">モデルテーブル</span>
                <select
                  className="ipd-input ipd-select-full"
                  value={selectedTableName}
                  onChange={(e) => setSelectedTableName(e.target.value)}
                  autoFocus
                >
                  {(modelTables ?? []).map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ipd-field">
                <span className="ipd-field-label">出力先セル (左上)</span>
                <input
                  type="text"
                  className="ipd-input"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="F1"
                />
              </label>
            </>
          )}

          <fieldset className="ipd-fields">
            <legend>フィールドの割り当て</legend>
            {displayFields.length === 0 && (
              <p className="ipd-hint">
                {sourceMode === "sheet"
                  ? "ソース範囲を正しく入力すると、列の一覧が表示されます。"
                  : "テーブルを選択すると、列の一覧が表示されます。"}
              </p>
            )}
            {displayFields.length > 0 && (
              <table className="ipd-table">
                <thead>
                  <tr>
                    <th className="ipd-th-name">フィールド</th>
                    <th>行</th>
                    <th>列</th>
                    <th>値</th>
                    <th>集計 / メジャー</th>
                    <th>フィルター</th>
                    <th className="ipd-th-vals">許可値 (カンマ区切り)</th>
                  </tr>
                </thead>
                <tbody>
                  {displayFields.map((f, idx) => (
                    <tr key={f.name + idx}>
                      <td className="ipd-cell-name" title={f.name}>{f.name}</td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${f.name} を行フィールドに割り当て`}
                          checked={f.role === "rows"}
                          onChange={() => setRole(idx, "rows")}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${f.name} を列フィールドに割り当て`}
                          checked={f.role === "cols"}
                          onChange={() => setRole(idx, "cols")}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${f.name} を値フィールドに割り当て`}
                          checked={f.role === "values"}
                          onChange={() => setRole(idx, "values")}
                        />
                      </td>
                      <td>
                        {sourceMode === "model" && f.role === "values" && availableMeasures && availableMeasures.length > 0 ? (
                          <select
                            className="ipd-select-sm ipd-select-agg"
                            aria-label={`${f.name} の集計方法またはメジャーを選択`}
                            value={f.valueKind === "measure" ? `__measure__${f.measureName}` : f.agg}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val.startsWith("__measure__")) {
                                setValueKind(idx, "measure", val.slice("__measure__".length));
                              } else {
                                setValueKind(idx, "column", "");
                                setAgg(idx, val as PivotAggregator);
                              }
                            }}
                            disabled={f.role !== "values"}
                          >
                            <optgroup label="集計">
                              {AGG_OPTIONS.map((op) => (
                                <option key={op} value={op}>
                                  {op}
                                </option>
                              ))}
                            </optgroup>
                            <optgroup label="メジャー">
                              {availableMeasures.map((m) => (
                                <option key={m.name} value={`__measure__${m.name}`}>
                                  [{m.tableId}] {m.name}
                                </option>
                              ))}
                            </optgroup>
                          </select>
                        ) : (
                          <select
                            className="ipd-select-sm"
                            aria-label={`${f.name} の集計方法を選択`}
                            value={f.agg}
                            onChange={(e) => setAgg(idx, e.target.value as PivotAggregator)}
                            disabled={f.role !== "values"}
                          >
                            {AGG_OPTIONS.map((op) => (
                              <option key={op} value={op}>
                                {op}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${f.name} をフィルターフィールドに割り当て`}
                          checked={f.role === "filters"}
                          onChange={() => setRole(idx, "filters")}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="ipd-input-sm"
                          value={f.filterValues}
                          onChange={(e) => setFilterVals(idx, e.target.value)}
                          placeholder="例: North, South"
                          disabled={f.role !== "filters"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Standalone measure value rows (model mode) */}
            {sourceMode === "model" && availableMeasures && availableMeasures.length > 0 && (
              <div className="ipd-measure-rows">
                {measureValueRows.map((row) => (
                  <div key={row.id} className="ipd-measure-row">
                    <span className="ipd-measure-row-label">メジャー値</span>
                    <select
                      className="ipd-select-sm"
                      aria-label="値フィールドに追加するメジャーを選択"
                      value={row.measureName}
                      onChange={(e) => setMeasureRowName(row.id, e.target.value)}
                    >
                      {availableMeasures.map((m) => (
                        <option key={m.name} value={m.name}>
                          [{m.tableId}] {m.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ipd-btn-icon"
                      onClick={() => removeMeasureRow(row.id)}
                      aria-label="このメジャー値行を削除"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ipd-btn ipd-btn--add"
                  onClick={addMeasureRow}
                >
                  + メジャーを値フィールドに追加
                </button>
              </div>
            )}
          </fieldset>

          <p className="ipd-info">
            {sourceMode === "sheet"
              ? "ヒント: 行・列はグループ化に、値は集計に使用されます。フィルターはカンマ区切りで「含める値」を指定してください。"
              : "ヒント: データモデルテーブルの列を行・列・値に割り当てます。DAX メジャーは値フィールドとして追加できます。"}
          </p>
          {error && <p className="ipd-error">{error}</p>}
        </div>
        <footer className="ipd-footer">
          <p className="ipd-hint">
            ピボット表は出力先セルから書き込まれます。元に戻すには Ctrl+Alt+Z でスナップショットを復元してください。
          </p>
          <div className="ipd-footer-actions">
            <button type="button" className="ipd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="ipd-btn ipd-btn--primary" onClick={submit}>
              {isEditMode ? "更新" : "作成"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
