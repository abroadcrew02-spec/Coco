import { useEffect, useMemo, useState } from "react";
import type { PivotAggregator, PivotConfig, PivotValueField } from "../store/pivots";
import { parseA1Cell, parseA1Range } from "../store/pivots";
import "./InsertPivotDialog.css";

const AGG_OPTIONS: PivotAggregator[] = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"];

type FieldRole = "rows" | "cols" | "values" | "filters" | null;

interface FieldDraft {
  /** Field display name (from source header). */
  name: string;
  role: FieldRole;
  /** Only relevant when role === "values". */
  agg: PivotAggregator;
  /** Comma-separated allowed values when role === "filters". */
  filterValues: string;
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
  onApply: (config: PivotConfig) => void;
  onClose: () => void;
}

export default function InsertPivotDialog({
  initialSourceRange,
  initialDestination,
  sourceFieldNames,
  sourceSheetId,
  onApply,
  onClose,
}: Props) {
  const [sourceRange, setSourceRange] = useState(initialSourceRange);
  const [destination, setDestination] = useState(initialDestination);
  const [hasHeader, setHasHeader] = useState(true);
  const [fields, setFields] = useState<FieldDraft[]>(() =>
    sourceFieldNames.map((n) => ({
      name: n,
      role: null,
      agg: "SUM" as PivotAggregator,
      filterValues: "",
    })),
  );
  const [error, setError] = useState<string | null>(null);

  // ESC to close — same convention as SubtotalDialog.
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

  // When the parent refreshes inferred field names (rare; e.g. after the user
  // edits the source range and the parent re-infers), merge the new list while
  // preserving existing role/agg choices for fields that still exist.
  useEffect(() => {
    setFields((prev) => {
      const byName = new Map(prev.map((f) => [f.name, f]));
      return sourceFieldNames.map(
        (n) =>
          byName.get(n) ?? {
            name: n,
            role: null as FieldRole,
            agg: "SUM" as PivotAggregator,
            filterValues: "",
          },
      );
    });
  }, [sourceFieldNames]);

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

  const submit = () => {
    if (!parsedSource) {
      setError("ソース範囲は A1 形式で指定してください (例: Sheet1!A1:D20)");
      return;
    }
    if (!parsedDest) {
      setError("出力先セルは A1 形式で指定してください (例: F1)");
      return;
    }
    const rows = fields.filter((f) => f.role === "rows").map((f) => f.name);
    const cols = fields.filter((f) => f.role === "cols").map((f) => f.name);
    const values: PivotValueField[] = fields
      .filter((f) => f.role === "values")
      .map((f) => ({ field: f.name, agg: f.agg }));
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
      source: { sheetId: sourceSheetId, range: parsedSource.range },
      destination: { row: parsedDest.row, col: parsedDest.col },
      rows,
      cols,
      values,
      filters: filters.length ? filters : undefined,
      hasHeader,
    });
    onClose();
  };

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
          <h2 id="ipd-title" className="ipd-title">ピボットテーブルの作成</h2>
          <button type="button" className="ipd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ipd-body">
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

          <fieldset className="ipd-fields">
            <legend>フィールドの割り当て</legend>
            {fields.length === 0 && (
              <p className="ipd-hint">ソース範囲を正しく入力すると、列の一覧が表示されます。</p>
            )}
            <table className="ipd-table">
              <thead>
                <tr>
                  <th className="ipd-th-name">フィールド</th>
                  <th>行</th>
                  <th>列</th>
                  <th>値</th>
                  <th>集計</th>
                  <th>フィルター</th>
                  <th className="ipd-th-vals">許可値 (カンマ区切り)</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f, idx) => (
                  <tr key={f.name + idx}>
                    <td className="ipd-cell-name" title={f.name}>{f.name}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={f.role === "rows"}
                        onChange={() => setRole(idx, "rows")}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={f.role === "cols"}
                        onChange={() => setRole(idx, "cols")}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={f.role === "values"}
                        onChange={() => setRole(idx, "values")}
                      />
                    </td>
                    <td>
                      <select
                        className="ipd-select-sm"
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
                    </td>
                    <td>
                      <input
                        type="checkbox"
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
          </fieldset>

          <p className="ipd-info">
            ヒント: 行・列はグループ化に、値は集計に使用されます。フィルターはカンマ区切りで「含める値」を指定してください。
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
              作成
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
