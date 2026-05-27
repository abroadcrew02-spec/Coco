// #244 — LinkedDataTypesPanel
//
// Ribbon panel for local CSV-based linked data types. Three sections:
//   1. Registered source list (name, key column, column count, delete)
//   2. Register new source (file picker → header read → key column + name)
//   3. Cell lookup card — shows data for the currently selected cell value
//
// No external API calls: fully local / serverless per Coco's policy.

import { useState, useCallback } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  type CocoLinkedDataTypes,
  type LinkedDataTypeSource,
  addSource,
  removeSource,
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
  /** Close the panel. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Registration form state
// ---------------------------------------------------------------------------

interface RegForm {
  filePath: string;
  headers: string[];
  keyColumn: string;
  sourceName: string;
}

const EMPTY_FORM: RegForm = {
  filePath: "",
  headers: [],
  keyColumn: "",
  sourceName: "",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LinkedDataTypesPanel({
  model,
  onModelChange,
  activeCellValue,
  onExpandToCells,
  onClose,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RegForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [lookupData, setLookupData] = useState<Array<Record<string, string>> | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupSourceId, setLookupSourceId] = useState<string | null>(null);

  const sources = listSources(model);

  // ---- file picker ---------------------------------------------------------

  const handlePickFile = useCallback(async () => {
    try {
      const result = await openFileDialog({
        filters: [{ name: "CSV ファイル", extensions: ["csv", "tsv"] }],
        multiple: false,
      });
      if (!result || Array.isArray(result)) return;
      const filePath = result as string;

      // Read the first row as CSV header via Tauri command.
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

      // Auto-fill source name from file basename.
      const basename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
      const nameSuggestion = basename.replace(/\.(csv|tsv)$/i, "");

      setForm({
        filePath,
        headers,
        keyColumn: headers[0],
        sourceName: nameSuggestion,
      });
      setFormError("");
    } catch {
      // User cancelled the dialog — no action needed.
    }
  }, []);

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

    const newSource: LinkedDataTypeSource = {
      id: crypto.randomUUID(),
      name: form.sourceName.trim(),
      sourcePath: form.filePath,
      keyColumn: form.keyColumn,
      columns: form.headers,
      updatedAt: new Date().toISOString(),
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
      if (lookupSourceId === id) {
        setLookupData(null);
        setLookupSourceId(null);
      }
    },
    [model, onModelChange, lookupSourceId],
  );

  // ---- lookup active cell against all sources ------------------------------

  const handleLookup = useCallback(
    async (source: LinkedDataTypeSource) => {
      const key = activeCellValue.trim();
      if (!key) return;

      setLookupLoading(true);
      setLookupSourceId(source.id);
      try {
        // Read the full CSV via Tauri.
        const rows = await invoke<Array<Record<string, string>>>("read_csv_rows", {
          path: source.sourcePath,
          maxRows: 1000,
        });
        setLookupData(rows);
      } catch {
        setLookupData(null);
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
                </div>
              </div>
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
              <button
                type="button"
                className="ldtp-remove-btn"
                onClick={() => handleRemove(src.id)}
                aria-label={`${src.name} を削除`}
                title="削除"
              >
                ×
              </button>
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
            + CSV ソースを登録
          </button>
        ) : (
          <div className="ldtp-form">
            <div className="ldtp-form-row">
              <label className="ldtp-form-label">CSV ファイル</label>
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

            {form.headers.length > 0 && (
              <>
                <div className="ldtp-form-row">
                  <label className="ldtp-form-label">ソース名</label>
                  <input
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
                  <label className="ldtp-form-label">キー列</label>
                  <select
                    className="ldtp-form-select"
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
