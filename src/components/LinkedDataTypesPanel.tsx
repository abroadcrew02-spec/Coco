// #244 — LinkedDataTypesPanel
// #310 — SQLite source type added.
// #323 — Multi-key range lookup + selectable expand columns.
//
// Ribbon panel for local CSV / SQLite linked data types. Three sections:
//   1. Registered source list (name, key column, column count, delete)
//   2. Register new source (file picker → header read → key column + name)
//      CSV:    file picker → read_csv_header → key column selector
//      SQLite: file picker → read_sqlite_tables → table selector → read_sqlite_columns → key column selector
//   3. Cell lookup card — shows data for the currently selected cell value
//      + "範囲を一括展開" button for multi-row selections
//
// No external API calls: fully local / serverless per Coco's policy.

import { useState, useCallback, useRef } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  type CocoLinkedDataTypes,
  type LinkedDataTypeSource,
  addSource,
  removeSource,
  updateSource,
  listSources,
  lookupInSource,
} from "../store/linkedDataTypes";
import "./LinkedDataTypesPanel.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LookupResult {
  source: LinkedDataTypeSource;
  row: Record<string, string>;
}

interface Props {
  /** Current registered model (derived from snapshot). */
  model: CocoLinkedDataTypes;
  /** Called when the model changes (caller persists to snapshot). */
  onModelChange: (next: CocoLinkedDataTypes) => void;
  /** Cell value to look up (typically the active cell's text). */
  activeCellValue: string;
  /**
   * Called when the user clicks "セルに展開". Caller writes adjacent cells.
   * `result` is the full matched row; `source` provides column ordering.
   */
  onExpandToCells: (result: LookupResult) => void;
  /**
   * #323 — Called when the user clicks "範囲を一括展開".
   * Caller reads the current selection range, bulk-looks up each key, and
   * writes results into adjacent cells.
   */
  onExpandRangeToCells: (
    sourceRows: Array<Record<string, string>>,
    source: LinkedDataTypeSource,
  ) => void;
  /** Close the panel. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Registration form state
// ---------------------------------------------------------------------------

type SourceKind = "csv" | "sqlite";

interface RegForm {
  kind: SourceKind;
  filePath: string;
  /** CSV: header columns. SQLite: columns of the selected table. */
  headers: string[];
  keyColumn: string;
  sourceName: string;
  /** SQLite only: table names returned by read_sqlite_tables. */
  sqliteTables: string[];
  /** SQLite only: the selected table name. */
  sqliteTable: string;
}

const EMPTY_FORM: RegForm = {
  kind: "csv",
  filePath: "",
  headers: [],
  keyColumn: "",
  sourceName: "",
  sqliteTables: [],
  sqliteTable: "",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LinkedDataTypesPanel({
  model,
  onModelChange,
  activeCellValue,
  onExpandToCells,
  onExpandRangeToCells,
  onClose,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RegForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [lookupData, setLookupData] = useState<Array<Record<string, string>> | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupSourceId, setLookupSourceId] = useState<string | null>(null);
  // #323 — Track which source's expand-column editor is open.
  const [expandColsEditId, setExpandColsEditId] = useState<string | null>(null);

  // #310 — In-memory CSV cache to avoid re-reading the same source on every
  // lookup. Keyed by source.id; entries are evicted when the source is removed
  // or when CACHE_TTL_MS has elapsed since the last fetch.
  const csvCacheRef = useRef<
    Map<string, { ts: number; rows: Array<Record<string, string>> }>
  >(new Map());

  const sources = listSources(model);

  // ---- file picker ---------------------------------------------------------

  const handlePickFile = useCallback(async () => {
    try {
      const isSqlite = form.kind === "sqlite";
      const result = await openFileDialog({
        filters: isSqlite
          ? [{ name: "SQLite データベース", extensions: ["db", "sqlite", "sqlite3"] }]
          : [{ name: "CSV ファイル", extensions: ["csv", "tsv"] }],
        multiple: false,
      });
      if (!result || Array.isArray(result)) return;
      const filePath = result as string;

      // Auto-fill source name from file basename.
      const basename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
      const nameSuggestion = basename.replace(/\.(csv|tsv|db|sqlite|sqlite3)$/i, "");

      if (isSqlite) {
        // SQLite: first read table list; columns are fetched after table selection.
        let tables: string[] = [];
        try {
          tables = await invoke<string[]>("read_sqlite_tables", { path: filePath });
        } catch (e) {
          setFormError(`テーブル一覧の取得に失敗しました: ${String(e)}`);
          return;
        }
        if (tables.length === 0) {
          setFormError("データベースにテーブルが見つかりませんでした。");
          return;
        }
        setForm((f) => ({
          ...f,
          filePath,
          sourceName: nameSuggestion,
          sqliteTables: tables,
          sqliteTable: tables[0],
          headers: [],
          keyColumn: "",
        }));
        setFormError("");
        // Fetch columns for the first table immediately.
        handleSqliteTableChange(filePath, tables[0]);
      } else {
        // CSV: read header row.
        let headers: string[] = [];
        try {
          headers = await invoke<string[]>("read_csv_header", { path: filePath });
        } catch (e) {
          setFormError(`ヘッダーの読み取りに失敗しました: ${String(e)}`);
          return;
        }
        if (headers.length === 0) {
          setFormError("CSV にヘッダー行が見つかりませんでした。");
          return;
        }
        setForm((f) => ({
          ...f,
          filePath,
          headers,
          keyColumn: headers[0],
          sourceName: nameSuggestion,
        }));
        setFormError("");
      }
    } catch {
      // User cancelled the dialog — no action needed.
    }
  }, [form.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- SQLite table selector -----------------------------------------------

  const handleSqliteTableChange = useCallback(
    async (filePath: string, table: string) => {
      if (!filePath || !table) return;
      try {
        const cols = await invoke<string[]>("read_sqlite_columns", {
          path: filePath,
          table,
        });
        setForm((f) => ({
          ...f,
          sqliteTable: table,
          headers: cols,
          keyColumn: cols[0] ?? "",
        }));
        setFormError("");
      } catch (e) {
        setFormError(`列情報の取得に失敗しました: ${String(e)}`);
      }
    },
    [],
  );

  // ---- register form submit ------------------------------------------------

  const handleRegister = useCallback(() => {
    if (!form.filePath) {
      setFormError("ファイルを選択してください。");
      return;
    }
    if (!form.sourceName.trim()) {
      setFormError("ソース名を入力してください。");
      return;
    }
    if (!form.keyColumn) {
      setFormError("キー列を選択してください。");
      return;
    }
    if (form.kind === "sqlite" && !form.sqliteTable) {
      setFormError("テーブルを選択してください。");
      return;
    }

    const newSource: LinkedDataTypeSource = {
      id: crypto.randomUUID(),
      name: form.sourceName.trim(),
      sourcePath: form.filePath,
      keyColumn: form.keyColumn,
      columns: form.headers,
      updatedAt: new Date().toISOString(),
      kind: form.kind,
      ...(form.kind === "sqlite" ? { sqliteTable: form.sqliteTable } : {}),
    };

    onModelChange(addSource(model, newSource));
    setForm(EMPTY_FORM);
    setShowForm(false);
    setFormError("");
  }, [form, model, onModelChange]);

  // ---- remove source -------------------------------------------------------

  const handleRemove = useCallback(
    (id: string) => {
      onModelChange(removeSource(model, id));
      csvCacheRef.current.delete(id);
      if (lookupSourceId === id) {
        setLookupData(null);
        setLookupSourceId(null);
      }
    },
    [model, onModelChange, lookupSourceId],
  );

  // ---- #323 expand-columns editor ------------------------------------------

  /** Toggle a column in source.expandColumns. Persists via onModelChange. */
  const handleToggleExpandColumn = useCallback(
    (source: LinkedDataTypeSource, col: string, checked: boolean) => {
      const current = source.expandColumns ?? [];
      const next = checked
        ? current.includes(col) ? current : [...current, col]
        : current.filter((c) => c !== col);
      onModelChange(updateSource(model, source.id, { expandColumns: next.length > 0 ? next : [] }));
    },
    [model, onModelChange],
  );

  // ---- #323 range bulk-expand ----------------------------------------------

  /**
   * Load source data (using cache) then invoke the caller's range handler.
   * The caller (EditorScreen) reads the active selection and writes results.
   */
  const handleExpandRange = useCallback(
    async (source: LinkedDataTypeSource) => {
      setFormError("");
      const CACHE_TTL_MS = 5 * 60 * 1000;
      const cached = csvCacheRef.current.get(source.id);
      let rows: Array<Record<string, string>>;

      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        rows = cached.rows;
      } else {
        setLookupLoading(true);
        try {
          const effectiveKind = source.kind ?? "csv";
          if (effectiveKind === "sqlite") {
            rows = await invoke<Array<Record<string, string>>>("read_sqlite_rows", {
              path: source.sourcePath,
              table: source.sqliteTable ?? "",
              maxRows: 1000,
            });
          } else {
            rows = await invoke<Array<Record<string, string>>>("read_csv_rows", {
              path: source.sourcePath,
              maxRows: 1000,
            });
          }
          csvCacheRef.current.set(source.id, { ts: Date.now(), rows });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setFormError(`ソース "${source.name}" の読込に失敗しました: ${msg}`);
          setLookupLoading(false);
          return;
        } finally {
          setLookupLoading(false);
        }
      }

      onExpandRangeToCells(rows, source);
    },
    [onExpandRangeToCells],
  );

  // ---- lookup active cell against all sources ------------------------------

  const handleLookup = useCallback(
    async (source: LinkedDataTypeSource) => {
      const key = activeCellValue.trim();
      if (!key) return;

      setLookupSourceId(source.id);
      setFormError("");

      // #310 — Hit the in-memory cache first when the entry is fresh.
      const CACHE_TTL_MS = 5 * 60 * 1000;
      const cached = csvCacheRef.current.get(source.id);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        setLookupData(cached.rows);
        return;
      }

      setLookupLoading(true);
      try {
        let rows: Array<Record<string, string>>;
        const effectiveKind = source.kind ?? "csv";

        if (effectiveKind === "sqlite") {
          // SQLite source: use read_sqlite_rows.
          rows = await invoke<Array<Record<string, string>>>("read_sqlite_rows", {
            path: source.sourcePath,
            table: source.sqliteTable ?? "",
            maxRows: 1000,
          });
        } else {
          // CSV source (default): use read_csv_rows.
          rows = await invoke<Array<Record<string, string>>>("read_csv_rows", {
            path: source.sourcePath,
            maxRows: 1000,
          });
        }

        csvCacheRef.current.set(source.id, { ts: Date.now(), rows });
        setLookupData(rows);
      } catch (err) {
        setLookupData(null);
        const msg = err instanceof Error ? err.message : String(err);
        setFormError(`ソース "${source.name}" の読込に失敗しました: ${msg}`);
      } finally {
        setLookupLoading(false);
      }
    },
    [activeCellValue],
  );

  // ---- compute lookup result -----------------------------------------------

  const lookupResult: LookupResult | null = (() => {
    if (!lookupData || !lookupSourceId || !activeCellValue.trim()) return null;
    const source = sources.find((s) => s.id === lookupSourceId);
    if (!source) return null;
    const row = lookupInSource(lookupData, activeCellValue, source);
    if (!row) return null;
    return { source, row };
  })();

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="ldtp-root">
      {/* Header */}
      <div className="ldtp-header">
        <h2 className="ldtp-title">リンクされたデータ型</h2>
        <button
          type="button"
          className="ldtp-header-close"
          onClick={onClose}
          aria-label="パネルを閉じる"
          title="閉じる"
        >
          ×
        </button>
      </div>

      {/* Section 1: Registered sources */}
      <div className="ldtp-section">
        <span>登録済みソース ({sources.length})</span>
      </div>
      {sources.length === 0 ? (
        <p className="ldtp-empty">
          CSV ファイルをソースとして登録すると、セル値でデータを検索できます。
        </p>
      ) : (
        <ul className="ldtp-sources">
          {sources.map((src) => (
            <li key={src.id} className="ldtp-source-item">
              <div className="ldtp-source-info">
                <div className="ldtp-source-name">{src.name}</div>
                <div className="ldtp-source-meta">
                  キー列: {src.keyColumn} / {src.columns.length} 列
                  {src.expandColumns && src.expandColumns.length > 0
                    ? ` / 展開列: ${src.expandColumns.length} 列選択中`
                    : " / 全列展開"}
                </div>
              </div>
              <div className="ldtp-source-actions">
                {activeCellValue.trim() && (
                  <button
                    type="button"
                    className="ldtp-form-btn"
                    onClick={() => handleLookup(src)}
                    aria-label={`${src.name} で検索`}
                    title="このソースで検索"
                    disabled={lookupLoading}
                  >
                    検索
                  </button>
                )}
                {/* #323 — Bulk expand button: available regardless of activeCellValue */}
                <button
                  type="button"
                  className="ldtp-form-btn"
                  onClick={() => handleExpandRange(src)}
                  aria-label={`${src.name} で範囲を一括展開`}
                  title="選択範囲の各行をこのソースで一括展開"
                  disabled={lookupLoading}
                >
                  範囲を一括展開
                </button>
                {/* #323 — Toggle expand-columns editor */}
                <button
                  type="button"
                  className="ldtp-form-btn"
                  onClick={() =>
                    setExpandColsEditId(expandColsEditId === src.id ? null : src.id)
                  }
                  aria-label={`${src.name} の展開列を設定`}
                  title="展開する列を選択"
                >
                  展開列設定
                </button>
                <button
                  type="button"
                  className="ldtp-remove-btn"
                  onClick={() => handleRemove(src.id)}
                  aria-label={`${src.name} を削除`}
                  title="削除"
                >
                  ×
                </button>
              </div>
              {/* #323 — Expand-columns editor (inline, shown when toggled) */}
              {expandColsEditId === src.id && (
                <div className="ldtp-expand-cols-editor">
                  <div className="ldtp-expand-cols-label">
                    展開する列（未選択 = 全列展開）
                  </div>
                  <ul className="ldtp-expand-cols-list">
                    {src.columns
                      .filter((c) => c !== src.keyColumn)
                      .map((col) => {
                        // When expandColumns is empty/absent (all columns mode), show all checked.
                        const isExplicitlySelected =
                          src.expandColumns &&
                          src.expandColumns.length > 0
                            ? src.expandColumns.includes(col)
                            : true;
                        return (
                          <li key={col} className="ldtp-expand-cols-item">
                            <label className="ldtp-expand-cols-check-label">
                              <input
                                type="checkbox"
                                checked={isExplicitlySelected}
                                onChange={(e) =>
                                  handleToggleExpandColumn(src, col, e.target.checked)
                                }
                              />
                              {col}
                            </label>
                          </li>
                        );
                      })}
                  </ul>
                  {src.expandColumns && src.expandColumns.length > 0 && (
                    <button
                      type="button"
                      className="ldtp-form-btn"
                      onClick={() =>
                        onModelChange(updateSource(model, src.id, { expandColumns: [] }))
                      }
                    >
                      全列に戻す
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Section 2: Register new source */}
      <div className="ldtp-register-area">
        {!showForm ? (
          <button
            type="button"
            className="ldtp-register-btn"
            onClick={() => setShowForm(true)}
          >
            + ソースを登録
          </button>
        ) : (
          <div className="ldtp-form">
            {/* File type selector (CSV / SQLite) */}
            <div className="ldtp-form-row">
              <span className="ldtp-form-label">ファイルタイプ</span>
              <div className="ldtp-form-radio-group" role="group" aria-label="ファイルタイプ選択">
                <label className="ldtp-form-radio-label">
                  <input
                    type="radio"
                    name="ldtp-kind"
                    value="csv"
                    checked={form.kind === "csv"}
                    onChange={() =>
                      setForm({ ...EMPTY_FORM, kind: "csv" })
                    }
                  />
                  CSV
                </label>
                <label className="ldtp-form-radio-label">
                  <input
                    type="radio"
                    name="ldtp-kind"
                    value="sqlite"
                    checked={form.kind === "sqlite"}
                    onChange={() =>
                      setForm({ ...EMPTY_FORM, kind: "sqlite" })
                    }
                  />
                  SQLite
                </label>
              </div>
            </div>

            {/* File path picker */}
            <div className="ldtp-form-row">
              <label className="ldtp-form-label">
                {form.kind === "sqlite" ? "SQLite ファイル" : "CSV ファイル"}
              </label>
              <div className="ldtp-form-file-row">
                <span className="ldtp-form-file-path">
                  {form.filePath || "（未選択）"}
                </span>
                <button
                  type="button"
                  className="ldtp-form-btn"
                  onClick={handlePickFile}
                >
                  選択...
                </button>
              </div>
            </div>

            {/* SQLite: table selector */}
            {form.kind === "sqlite" && form.sqliteTables.length > 0 && (
              <div className="ldtp-form-row">
                <label htmlFor="ldtp-sqlite-table" className="ldtp-form-label">
                  テーブル
                </label>
                <select
                  id="ldtp-sqlite-table"
                  className="ldtp-form-select"
                  title="SQLite テーブル選択"
                  aria-label="SQLite テーブル選択"
                  value={form.sqliteTable}
                  onChange={(e) =>
                    handleSqliteTableChange(form.filePath, e.target.value)
                  }
                >
                  {form.sqliteTables.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Source name + key column (shown once columns are available) */}
            {form.headers.length > 0 && (
              <>
                <div className="ldtp-form-row">
                  <label htmlFor="ldtp-source-name" className="ldtp-form-label">
                    ソース名
                  </label>
                  <input
                    id="ldtp-source-name"
                    type="text"
                    className="ldtp-form-input"
                    value={form.sourceName}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, sourceName: e.target.value }))
                    }
                    placeholder="例: 株価データ"
                  />
                </div>
                <div className="ldtp-form-row">
                  <label htmlFor="ldtp-key-column" className="ldtp-form-label">
                    キー列
                  </label>
                  <select
                    id="ldtp-key-column"
                    className="ldtp-form-select"
                    title="キー列選択"
                    aria-label="キー列選択"
                    value={form.keyColumn}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, keyColumn: e.target.value }))
                    }
                  >
                    {form.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {formError && <p className="ldtp-error">{formError}</p>}

            <div className="ldtp-form-buttons">
              <button
                type="button"
                className="ldtp-form-btn"
                onClick={() => {
                  setShowForm(false);
                  setForm(EMPTY_FORM);
                  setFormError("");
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="ldtp-form-btn ldtp-form-btn--primary"
                onClick={handleRegister}
                disabled={!form.filePath || !form.sourceName.trim()}
              >
                登録
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Section 3: Lookup result card */}
      <div className="ldtp-section">
        <span>セル lookup</span>
      </div>
      <div className="ldtp-lookup-area">
        {!activeCellValue.trim() ? (
          <p className="ldtp-lookup-hint">
            セルを選択して「検索」ボタンを押すと、登録済みソースを照合します。
          </p>
        ) : (
          <>
            <div className="ldtp-lookup-key">検索キー: "{activeCellValue}"</div>
            {lookupLoading && (
              <p className="ldtp-loading">読み込み中...</p>
            )}
            {!lookupLoading && lookupSourceId && !lookupResult && (
              <p className="ldtp-miss">一致するデータが見つかりませんでした。</p>
            )}
            {lookupResult && (
              <>
                <div className="ldtp-card">
                  <div className="ldtp-card-source">{lookupResult.source.name}</div>
                  <ul className="ldtp-card-rows">
                    {lookupResult.source.columns
                      .filter((col) => col !== lookupResult.source.keyColumn)
                      .map((col) => (
                        <li key={col} className="ldtp-card-row">
                          <span className="ldtp-card-col" title={col}>
                            {col}
                          </span>
                          <span className="ldtp-card-val" title={lookupResult.row[col] ?? ""}>
                            {lookupResult.row[col] ?? ""}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
                <button
                  type="button"
                  className="ldtp-expand-btn"
                  onClick={() => onExpandToCells(lookupResult)}
                >
                  セルに展開（隣接セルへ書き込み）
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
