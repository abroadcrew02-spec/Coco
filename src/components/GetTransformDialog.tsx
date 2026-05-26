// #238 Step 2 — Get & Transform UI dialog (MVP).
//
// Provides a modal "データの取得と変換" dialog that lets the user:
//   1. Choose a local file source (json / csv / sqlite / tsv) via Tauri dialog.
//   2. Preview the first 50 rows from the source.
//   3. Build a transform pipeline (add / remove / reorder steps).
//   4. Preview the pipeline result after each step change.
//   5. Apply the result to the workbook and save the query definition.
//
// Wires into: Step 1 (runPipeline), Step 5 (cocoQueries CRUD), Step 7 (runQuery + applyQueryResultToSnapshot).

import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { runPipeline } from "../store/getAndTransform";
import type {
  TransformStep,
  FilterOp,
  PipelineResult,
  ConditionalOp,
} from "../store/getAndTransform";
import type { QuerySource, SavedQuery } from "../store/cocoQueries";
import { generateQueryName, readQueries } from "../store/cocoQueries";
import {
  createTauriSourceFetcher,
  applyQueryResultToSnapshot,
  runQuery,
} from "../store/queryExecutor";
import "./GetTransformDialog.css";

const PREVIEW_ROWS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceKind = "csv" | "json" | "jsonl" | "sqlite" | "tsv";

interface SourceState {
  kind: SourceKind;
  path: string;
  sqliteQuery: string;
}

type DialogPhase = "source" | "transform";

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: ">", label: "より大きい (>)" },
  { value: "<", label: "より小さい (<)" },
  { value: ">=", label: "以上 (>=)" },
  { value: "<=", label: "以下 (<=)" },
  { value: "==", label: "等しい (==)" },
  { value: "!=", label: "等しくない (!=)" },
  { value: "contains", label: "含む" },
  { value: "startsWith", label: "で始まる" },
  { value: "endsWith", label: "で終わる" },
  { value: "regex", label: "正規表現" },
  { value: "isEmpty", label: "空白" },
  { value: "isNotEmpty", label: "空白でない" },
];

const STEP_KINDS: { value: TransformStep["kind"]; label: string }[] = [
  { value: "selectColumns", label: "列の選択" },
  { value: "dropColumns", label: "列の削除" },
  { value: "filterRows", label: "行のフィルター" },
  { value: "sort", label: "並べ替え" },
  { value: "rename", label: "列名の変更" },
  { value: "groupBy", label: "グループ化" },
  { value: "changeType", label: "データ型の変換" },
  { value: "fillMissing", label: "空白の補完" },
  { value: "conditionalColumn", label: "条件列の追加" },
  { value: "replaceValue", label: "値の置換" },
  { value: "splitColumn", label: "列の分割" },
  { value: "mergeColumns", label: "列の結合" },
  { value: "addIndexColumn", label: "インデックス列の追加" },
];

const CONDITIONAL_OPS: { value: ConditionalOp; label: string }[] = [
  { value: ">", label: "より大きい (>)" },
  { value: "<", label: "より小さい (<)" },
  { value: ">=", label: "以上 (>=)" },
  { value: "<=", label: "以下 (<=)" },
  { value: "==", label: "等しい (==)" },
  { value: "!=", label: "等しくない (!=)" },
  { value: "contains", label: "含む" },
  { value: "isEmpty", label: "空白" },
  { value: "isNotEmpty", label: "空白でない" },
];

function makeBlankStep(kind: TransformStep["kind"]): TransformStep {
  switch (kind) {
    case "selectColumns": return { kind, columns: [] };
    case "dropColumns": return { kind, columns: [] };
    case "filterRows": return { kind, column: "", op: "==", value: "" };
    case "sort": return { kind, column: "", descending: false };
    case "rename": return { kind, from: "", to: "" };
    case "groupBy": return { kind, key: "", agg: [] };
    case "changeType": return { kind, column: "", targetType: "string", onError: "keep" };
    case "fillMissing": return { kind, column: "", direction: "forward" };
    case "conditionalColumn": return { kind, newColumn: "", column: "", op: "==", value: "", thenValue: "", elseValue: "" };
    case "replaceValue": return { kind, column: "", find: "", replace: "", useRegex: false };
    case "splitColumn": return { kind, column: "", delimiter: ",", expand: "columns" };
    case "mergeColumns": return { kind, columns: [], delimiter: " ", newColumn: "", dropSources: true };
    case "addIndexColumn": return { kind, columnName: "Index", startAt: 0, increment: 1 };
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GetTransformDialogProps {
  /** Current workbook snapshot JSON string. */
  snapshotJson: string | null;
  /** Called when the user clicks Apply — writes the result + saves the query. */
  onApply: (newSnapshotJson: string) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GetTransformDialog({
  snapshotJson,
  onApply,
  onClose,
}: GetTransformDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>("source");
  const [source, setSource] = useState<SourceState>({
    kind: "csv",
    path: "",
    sqliteQuery: "SELECT * FROM ",
  });
  const [queryName, setQueryName] = useState<string>(() => {
    if (!snapshotJson) return "Query1";
    try {
      const snap = JSON.parse(snapshotJson) as Record<string, unknown>;
      return generateQueryName(readQueries(snap));
    } catch {
      return "Query1";
    }
  });
  const [outputSheet, setOutputSheet] = useState<string>("");

  // Raw rows fetched from source (before pipeline)
  const [sourceRows, setSourceRows] = useState<Array<Record<string, unknown>>>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([]);

  const [steps, setSteps] = useState<TransformStep[]>([]);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // ---------------------------------------------------------------------------
  // Re-run pipeline whenever steps or source data change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (sourceRows.length === 0 && sourceColumns.length === 0) {
      setPipelineResult(null);
      return;
    }
    const result = runPipeline(sourceRows.slice(0, PREVIEW_ROWS), steps, sourceColumns);
    setPipelineResult(result);
  }, [sourceRows, sourceColumns, steps]);

  // ---------------------------------------------------------------------------
  // Keyboard: Escape closes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // ---------------------------------------------------------------------------
  // File picker
  // ---------------------------------------------------------------------------
  const handleBrowseFile = useCallback(async () => {
    setError(null);
    const selected = await openFileDialog({
      multiple: false,
      filters: [
        { name: "データファイル", extensions: ["csv", "tsv", "json", "jsonl"] },
        { name: "CSV / TSV", extensions: ["csv", "tsv"] },
        { name: "JSON / JSONL", extensions: ["json", "jsonl"] },
      ],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const lower = path.toLowerCase();
    let kind: SourceKind = "csv";
    if (lower.endsWith(".jsonl")) kind = "jsonl";
    else if (lower.endsWith(".json")) kind = "json";
    else if (lower.endsWith(".tsv")) kind = "tsv";
    const baseName = path.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Query";
    setSource((s) => ({ ...s, kind, path }));
    if (!outputSheet) setOutputSheet(baseName);
    if (queryName === "Query1" || queryName.startsWith("Query")) {
      setQueryName(baseName);
    }
  }, [outputSheet, queryName]);

  const handleBrowseSqlite = useCallback(async () => {
    setError(null);
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "SQLite データベース", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const baseName = path.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Query";
    setSource((s) => ({ ...s, kind: "sqlite", path }));
    if (!outputSheet) setOutputSheet(baseName);
    if (queryName === "Query1" || queryName.startsWith("Query")) {
      setQueryName(baseName);
    }
  }, [outputSheet, queryName]);

  // ---------------------------------------------------------------------------
  // Fetch source preview
  // ---------------------------------------------------------------------------
  const handleFetchPreview = useCallback(async () => {
    if (!source.path) {
      setError("ファイルを選択してください");
      return;
    }
    if (source.kind === "sqlite" && !source.sqliteQuery.trim()) {
      setError("SQL クエリを入力してください");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fetcher = createTauriSourceFetcher(
        <T,>(cmd: string, args?: Record<string, unknown>) =>
          invoke<T>(cmd, args),
      );
      const querySource: QuerySource =
        source.kind === "sqlite"
          ? { kind: "sqlite", path: source.path, query: source.sqliteQuery }
          : source.kind === "tsv"
          ? { kind: "csv", path: source.path }
          : source.kind === "jsonl"
          ? { kind: "jsonl", path: source.path }
          : { kind: source.kind as "csv" | "json", path: source.path };

      const fetched = await fetcher.fetch(querySource);
      setSourceRows(fetched.rows);
      setSourceColumns(fetched.columns ?? []);
      setSourceWarnings(fetched.warnings ?? []);
      setPhase("transform");
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [source]);

  // ---------------------------------------------------------------------------
  // Step management
  // ---------------------------------------------------------------------------
  const addStep = (kind: TransformStep["kind"]) => {
    setSteps((s) => [...s, makeBlankStep(kind)]);
  };

  const removeStep = (idx: number) => {
    setSteps((s) => s.filter((_, i) => i !== idx));
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    setSteps((s) => {
      const j = idx + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const patchStep = (idx: number, patch: Partial<TransformStep>) => {
    setSteps((s) =>
      s.map((st, i) => (i === idx ? ({ ...st, ...patch } as TransformStep) : st)),
    );
  };

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------
  const handleApply = useCallback(async () => {
    if (!snapshotJson) {
      setError("ワークブックが開かれていません");
      return;
    }
    if (!source.path) {
      setError("ファイルを選択してください");
      return;
    }
    const finalOutputSheet = outputSheet.trim() || queryName.trim() || "QueryOutput";
    const finalName = queryName.trim() || "Query1";

    setApplying(true);
    setError(null);
    try {
      const querySource: QuerySource =
        source.kind === "sqlite"
          ? { kind: "sqlite", path: source.path, query: source.sqliteQuery }
          : source.kind === "tsv"
          ? { kind: "csv", path: source.path }
          : source.kind === "jsonl"
          ? { kind: "jsonl", path: source.path }
          : { kind: source.kind as "csv" | "json", path: source.path };

      const query: SavedQuery = {
        id: crypto.randomUUID(),
        name: finalName,
        source: querySource,
        steps,
        outputSheet: finalOutputSheet,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const fetcher = createTauriSourceFetcher(
        <T,>(cmd: string, args?: Record<string, unknown>) =>
          invoke<T>(cmd, args),
      );
      const result = await runQuery(query, { fetcher });
      const snap = JSON.parse(snapshotJson) as Record<string, unknown>;
      const newSnap = applyQueryResultToSnapshot(snap, query, result);
      onApply(JSON.stringify(newSnap));
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setApplying(false);
    }
  }, [snapshotJson, source, outputSheet, queryName, steps, onApply]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const previewData = pipelineResult ?? {
    columns: sourceColumns,
    rows: sourceRows.slice(0, PREVIEW_ROWS),
    warnings: sourceWarnings,
  };

  const totalWarnings = [
    ...sourceWarnings,
    ...(pipelineResult?.warnings ?? []),
  ];

  return (
    <div className="gtd-backdrop" onClick={loading || applying ? undefined : onClose}>
      <div
        className="gtd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gtd-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="gtd-header">
          <h2 id="gtd-title" className="gtd-title">データの取得と変換</h2>
          <button
            type="button"
            className="gtd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        {/* Body: two-column layout */}
        <div className="gtd-body">
          {/* Left pane */}
          <div className="gtd-left">
            {/* Source section */}
            <section className="gtd-section">
              <h3 className="gtd-section-title">データソース</h3>

              {/* Source kind tabs */}
              <div className="gtd-source-tabs">
                {(["csv", "tsv", "json", "jsonl", "sqlite"] as SourceKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`gtd-source-tab ${source.kind === k ? "gtd-source-tab--active" : ""}`}
                    onClick={() => setSource((s) => ({ ...s, kind: k }))}
                  >
                    {k.toUpperCase()}
                  </button>
                ))}
              </div>

              {/* File picker (csv / tsv / json) */}
              {source.kind !== "sqlite" && (
                <div className="gtd-field">
                  <span className="gtd-field-label">ファイル</span>
                  <div className="gtd-field-row">
                    <input
                      type="text"
                      className="gtd-input"
                      value={source.path}
                      readOnly
                      placeholder="ファイルを選択してください"
                      data-testid="gtd-file-path"
                    />
                    <button
                      type="button"
                      className="gtd-btn"
                      onClick={() => void handleBrowseFile()}
                      data-testid="gtd-browse-file"
                    >
                      参照...
                    </button>
                  </div>
                </div>
              )}

              {/* SQLite */}
              {source.kind === "sqlite" && (
                <>
                  <div className="gtd-field">
                    <span className="gtd-field-label">データベース</span>
                    <div className="gtd-field-row">
                      <input
                        type="text"
                        className="gtd-input"
                        value={source.path}
                        readOnly
                        placeholder="SQLite ファイルを選択してください"
                        data-testid="gtd-sqlite-path"
                      />
                      <button
                        type="button"
                        className="gtd-btn"
                        onClick={() => void handleBrowseSqlite()}
                        data-testid="gtd-browse-sqlite"
                      >
                        参照...
                      </button>
                    </div>
                  </div>
                  <div className="gtd-field">
                    <span className="gtd-field-label">SQL クエリ (SELECT のみ)</span>
                    <textarea
                      className="gtd-input gtd-textarea"
                      value={source.sqliteQuery}
                      onChange={(e) =>
                        setSource((s) => ({ ...s, sqliteQuery: e.target.value }))
                      }
                      data-testid="gtd-sqlite-query"
                    />
                  </div>
                </>
              )}

              <button
                type="button"
                className="gtd-btn gtd-btn--primary"
                onClick={() => void handleFetchPreview()}
                disabled={loading || !source.path}
                data-testid="gtd-fetch-preview"
              >
                {loading ? "読み込み中..." : "プレビューを更新"}
              </button>
            </section>

            {/* Transform steps section */}
            {phase === "transform" && (
              <section className="gtd-section">
                <div className="gtd-section-head">
                  <h3 className="gtd-section-title">変換ステップ</h3>
                  <select
                    className="gtd-input gtd-input--inline"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        addStep(e.target.value as TransformStep["kind"]);
                        e.target.value = "";
                      }
                    }}
                    data-testid="gtd-step-add"
                  >
                    <option value="">+ ステップを追加</option>
                    {STEP_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>{k.label}</option>
                    ))}
                  </select>
                </div>

                {steps.length === 0 ? (
                  <p className="gtd-hint">
                    ステップなし — 元データがそのまま出力されます。
                  </p>
                ) : (
                  <ol className="gtd-steps" data-testid="gtd-steps">
                    {steps.map((step, idx) => (
                      <li key={idx} className="gtd-step">
                        <div className="gtd-step-head">
                          <span className="gtd-step-label">{idx + 1}. {step.kind}</span>
                          <div className="gtd-step-actions">
                            <button
                              type="button"
                              className="gtd-btn gtd-btn--icon"
                              onClick={() => moveStep(idx, -1)}
                              disabled={idx === 0}
                              aria-label="上へ"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="gtd-btn gtd-btn--icon"
                              onClick={() => moveStep(idx, 1)}
                              disabled={idx === steps.length - 1}
                              aria-label="下へ"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="gtd-btn gtd-btn--icon gtd-btn--danger"
                              onClick={() => removeStep(idx)}
                              aria-label="削除"
                              data-testid={`gtd-step-remove-${idx}`}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                        <div className="gtd-step-body">
                          <StepEditor
                            step={step}
                            columns={pipelineResult?.columns ?? sourceColumns}
                            onChange={(patch) => patchStep(idx, patch)}
                          />
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}

            {/* Query metadata */}
            {phase === "transform" && (
              <section className="gtd-section">
                <h3 className="gtd-section-title">出力設定</h3>
                <div className="gtd-field">
                  <span className="gtd-field-label">クエリ名</span>
                  <input
                    type="text"
                    className="gtd-input"
                    value={queryName}
                    onChange={(e) => setQueryName(e.target.value)}
                    data-testid="gtd-query-name"
                  />
                </div>
                <div className="gtd-field">
                  <span className="gtd-field-label">出力先シート名</span>
                  <input
                    type="text"
                    className="gtd-input"
                    value={outputSheet}
                    onChange={(e) => setOutputSheet(e.target.value)}
                    placeholder={queryName || "QueryOutput"}
                    data-testid="gtd-output-sheet"
                  />
                </div>
              </section>
            )}
          </div>

          {/* Right pane: preview table */}
          <div className="gtd-right">
            <div className="gtd-preview-header">
              <span className="gtd-section-title">プレビュー</span>
              {phase === "transform" && previewData.columns.length > 0 && (
                <span className="gtd-preview-meta">
                  {previewData.rows.length} 行 × {previewData.columns.length} 列
                  {sourceRows.length > PREVIEW_ROWS && (
                    <> (先頭 {PREVIEW_ROWS} 行を表示)</>
                  )}
                </span>
              )}
            </div>

            {totalWarnings.length > 0 && (
              <div className="gtd-warnings" data-testid="gtd-warnings">
                {totalWarnings.map((w, i) => (
                  <div key={i} className="gtd-warning">{w}</div>
                ))}
              </div>
            )}

            {phase === "source" && !source.path && (
              <div className="gtd-preview-empty">
                ファイルを選択してプレビューを更新してください
              </div>
            )}

            {phase === "source" && source.path && (
              <div className="gtd-preview-empty">
                「プレビューを更新」をクリックしてデータを読み込んでください
              </div>
            )}

            {phase === "transform" && previewData.columns.length === 0 && (
              <div className="gtd-preview-empty">データがありません</div>
            )}

            {phase === "transform" && previewData.columns.length > 0 && (
              <div className="gtd-table-wrap" data-testid="gtd-preview-table">
                <table className="gtd-table">
                  <thead>
                    <tr>
                      {previewData.columns.map((col) => (
                        <th key={col} className="gtd-th">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.rows.map((row, ri) => (
                      <tr key={ri}>
                        {previewData.columns.map((col) => (
                          <td key={col} className="gtd-td">
                            {row[col] === undefined || row[col] === null
                              ? ""
                              : String(row[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Error bar */}
        {error && (
          <div className="gtd-error" data-testid="gtd-error">
            {error}
          </div>
        )}

        {/* Footer */}
        <footer className="gtd-footer">
          <button type="button" className="gtd-btn" onClick={onClose}>
            キャンセル
          </button>
          {phase === "source" && (
            <button
              type="button"
              className="gtd-btn gtd-btn--primary"
              onClick={() => void handleFetchPreview()}
              disabled={loading || !source.path}
              data-testid="gtd-next"
            >
              {loading ? "読み込み中..." : "次へ"}
            </button>
          )}
          {phase === "transform" && (
            <button
              type="button"
              className="gtd-btn gtd-btn--primary"
              onClick={() => void handleApply()}
              disabled={applying || !source.path}
              data-testid="gtd-apply"
            >
              {applying ? "適用中..." : "適用してシートに配置"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepEditor sub-component
// ---------------------------------------------------------------------------

interface StepEditorProps {
  step: TransformStep;
  columns: string[];
  onChange: (patch: Partial<TransformStep>) => void;
}

function StepEditor({ step, columns, onChange }: StepEditorProps) {
  const colOptions = columns.map((c) => (
    <option key={c} value={c}>{c}</option>
  ));

  switch (step.kind) {
    case "selectColumns":
    case "dropColumns":
      return (
        <input
          type="text"
          className="gtd-input"
          placeholder="列名をカンマ区切りで (例: name, age)"
          value={step.columns.join(", ")}
          onChange={(e) =>
            onChange({
              columns: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      );

    case "filterRows":
      return (
        <>
          <select
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">列を選択</option>
            {colOptions}
          </select>
          <select
            className="gtd-input gtd-input--inline"
            value={step.op}
            onChange={(e) => onChange({ op: e.target.value as FilterOp })}
          >
            {FILTER_OPS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {step.op !== "isEmpty" && step.op !== "isNotEmpty" && (
            <input
              type="text"
              className="gtd-input gtd-input--inline"
              placeholder="値"
              value={step.value ?? ""}
              onChange={(e) => onChange({ value: e.target.value })}
            />
          )}
        </>
      );

    case "sort":
      return (
        <>
          <select
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">列を選択</option>
            {colOptions}
          </select>
          <select
            className="gtd-input gtd-input--inline"
            value={step.descending ? "desc" : "asc"}
            onChange={(e) => onChange({ descending: e.target.value === "desc" })}
          >
            <option value="asc">昇順</option>
            <option value="desc">降順</option>
          </select>
        </>
      );

    case "rename":
      return (
        <>
          <select
            className="gtd-input gtd-input--inline"
            value={step.from}
            onChange={(e) => onChange({ from: e.target.value })}
          >
            <option value="">元の列名</option>
            {colOptions}
          </select>
          <span className="gtd-step-arrow">→</span>
          <input
            type="text"
            className="gtd-input gtd-input--inline"
            placeholder="新しい列名"
            value={step.to}
            onChange={(e) => onChange({ to: e.target.value })}
          />
        </>
      );

    case "groupBy":
      return (
        <>
          <select
            className="gtd-input gtd-input--inline"
            value={step.key}
            onChange={(e) => onChange({ key: e.target.value })}
          >
            <option value="">キー列を選択</option>
            {colOptions}
          </select>
          <span className="gtd-hint gtd-hint--inline">
            集計列: {step.agg.length > 0 ? step.agg.map((a) => `${a.fn}(${a.column})`).join(", ") : "なし"}
          </span>
          <button
            type="button"
            className="gtd-btn gtd-btn--icon"
            onClick={() => {
              const firstCol = columns[0] ?? "";
              onChange({
                agg: [...step.agg, { column: firstCol, fn: "count" as const }],
              });
            }}
          >
            + 集計
          </button>
        </>
      );

    case "changeType":
      return (
        <>
          <select
            title="変換対象列"
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">列を選択</option>
            {colOptions}
          </select>
          <select
            title="変換先の型"
            className="gtd-input gtd-input--inline"
            value={step.targetType}
            onChange={(e) => onChange({ targetType: e.target.value as "string" | "number" | "boolean" | "date" })}
          >
            <option value="string">テキスト (string)</option>
            <option value="number">数値 (number)</option>
            <option value="boolean">真偽値 (boolean)</option>
            <option value="date">日付 (date)</option>
          </select>
          <select
            title="変換失敗時の動作"
            className="gtd-input gtd-input--inline"
            value={step.onError ?? "keep"}
            onChange={(e) => onChange({ onError: e.target.value as "error" | "null" | "keep" })}
          >
            <option value="keep">失敗時: そのまま</option>
            <option value="null">失敗時: null に</option>
            <option value="error">失敗時: 警告 (値を保持)</option>
          </select>
        </>
      );

    case "fillMissing":
      return (
        <>
          <select
            title="補完対象列"
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">列を選択</option>
            {colOptions}
          </select>
          <select
            title="補完方向"
            className="gtd-input gtd-input--inline"
            value={step.direction}
            onChange={(e) => onChange({ direction: e.target.value as "forward" | "backward" | "fixed" })}
          >
            <option value="forward">前方補完</option>
            <option value="backward">後方補完</option>
            <option value="fixed">固定値</option>
          </select>
          {step.direction === "fixed" && (
            <input
              type="text"
              title="固定補完値"
              className="gtd-input gtd-input--inline"
              placeholder="補完値"
              value={step.fixedValue ?? ""}
              onChange={(e) => onChange({ fixedValue: e.target.value })}
            />
          )}
        </>
      );

    case "conditionalColumn":
      return (
        <>
          <input
            type="text"
            title="新しい列名"
            className="gtd-input gtd-input--inline"
            placeholder="新列名"
            value={step.newColumn}
            onChange={(e) => onChange({ newColumn: e.target.value })}
          />
          <select
            title="条件判定に使う列"
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">条件列</option>
            {colOptions}
          </select>
          <select
            title="比較演算子"
            className="gtd-input gtd-input--inline"
            value={step.op}
            onChange={(e) => onChange({ op: e.target.value as ConditionalOp })}
          >
            {CONDITIONAL_OPS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {step.op !== "isEmpty" && step.op !== "isNotEmpty" && (
            <input
              type="text"
              title="比較値"
              className="gtd-input gtd-input--inline"
              placeholder="比較値"
              value={step.value ?? ""}
              onChange={(e) => onChange({ value: e.target.value })}
            />
          )}
          <input
            type="text"
            title="条件が真の場合の値"
            className="gtd-input gtd-input--inline"
            placeholder="真の場合"
            value={step.thenValue}
            onChange={(e) => onChange({ thenValue: e.target.value })}
          />
          <input
            type="text"
            title="条件が偽の場合の値"
            className="gtd-input gtd-input--inline"
            placeholder="偽の場合"
            value={step.elseValue}
            onChange={(e) => onChange({ elseValue: e.target.value })}
          />
        </>
      );

    case "replaceValue":
      return (
        <>
          <select
            title="置換対象列"
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">列を選択</option>
            {colOptions}
          </select>
          <input
            type="text"
            title="検索値"
            className="gtd-input gtd-input--inline"
            placeholder="検索値"
            value={step.find}
            onChange={(e) => onChange({ find: e.target.value })}
          />
          <input
            type="text"
            title="置換後の値"
            className="gtd-input gtd-input--inline"
            placeholder="置換値"
            value={step.replace}
            onChange={(e) => onChange({ replace: e.target.value })}
          />
          <label className="gtd-inline-label">
            <input
              type="checkbox"
              title="正規表現を使う"
              checked={step.useRegex ?? false}
              onChange={(e) => onChange({ useRegex: e.target.checked })}
            />
            {" "}正規表現
          </label>
        </>
      );

    case "splitColumn":
      return (
        <>
          <select
            title="分割対象列"
            className="gtd-input gtd-input--inline"
            value={step.column}
            onChange={(e) => onChange({ column: e.target.value })}
          >
            <option value="">列を選択</option>
            {colOptions}
          </select>
          <input
            type="text"
            title="区切り文字"
            className="gtd-input gtd-input--inline"
            placeholder="区切り文字"
            value={step.delimiter}
            onChange={(e) => onChange({ delimiter: e.target.value })}
          />
          <select
            title="展開方向"
            className="gtd-input gtd-input--inline"
            value={step.expand ?? "columns"}
            onChange={(e) => onChange({ expand: e.target.value as "columns" | "rows" })}
          >
            <option value="columns">列展開</option>
            <option value="rows">行展開</option>
          </select>
        </>
      );

    case "mergeColumns":
      return (
        <>
          <input
            type="text"
            title="結合する列名 (カンマ区切り)"
            className="gtd-input gtd-input--inline"
            placeholder="結合する列 (カンマ区切り)"
            value={step.columns.join(", ")}
            onChange={(e) =>
              onChange({
                columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <input
            type="text"
            title="結合後の新しい列名"
            className="gtd-input gtd-input--inline"
            placeholder="新列名"
            value={step.newColumn}
            onChange={(e) => onChange({ newColumn: e.target.value })}
          />
          <input
            type="text"
            title="列間の区切り文字"
            className="gtd-input gtd-input--inline"
            placeholder="区切り文字 (デフォルト: スペース)"
            value={step.delimiter ?? " "}
            onChange={(e) => onChange({ delimiter: e.target.value })}
          />
        </>
      );

    case "addIndexColumn":
      return (
        <>
          <input
            type="text"
            title="インデックス列名"
            className="gtd-input gtd-input--inline"
            placeholder="列名 (デフォルト: Index)"
            value={step.columnName ?? "Index"}
            onChange={(e) => onChange({ columnName: e.target.value })}
          />
          <input
            type="number"
            title="開始値"
            className="gtd-input gtd-input--inline"
            placeholder="開始値 (デフォルト: 0)"
            value={step.startAt ?? 0}
            onChange={(e) => onChange({ startAt: Number(e.target.value) })}
          />
          <input
            type="number"
            title="増分"
            className="gtd-input gtd-input--inline"
            placeholder="増分 (デフォルト: 1)"
            value={step.increment ?? 1}
            onChange={(e) => onChange({ increment: Number(e.target.value) })}
          />
        </>
      );
  }
}
