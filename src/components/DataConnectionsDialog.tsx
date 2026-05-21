import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  type CastType,
  type DataConnection,
  type DataConnectionType,
  type EtlStep,
  type FilterOp,
  defaultConnectionName,
  describeStep,
  inferConnectionType,
  listConnections,
  sheetHasExtraRows,
  validateSqliteQuery,
} from "../store/dataConnections";
import "./DataConnectionsDialog.css";

/** Input shape for adding a connection. The discriminated `type` decides
 *  which optional config block is required. */
export interface AddConnectionInput {
  name: string;
  type: DataConnectionType;
  sourcePath: string;
  targetSheetName: string;
  /** Web source — required when `type === "web"`. */
  webUrl?: string;
  webFormat?: "auto" | "json" | "csv";
  webHeaders?: Record<string, string>;
  /** SQLite source — required when `type === "sqlite"`. */
  sqliteQuery?: string;
}

interface Props {
  /** Current workbook snapshot JSON. */
  snapshotJson: string | null;
  /** Refresh a single connection. */
  onRefresh: (connectionId: string) => Promise<void>;
  /** Add a new connection. */
  onAdd: (input: AddConnectionInput) => Promise<void>;
  /** Edit an existing connection's name, target sheet, ETL steps, schedule. */
  onEdit: (
    id: string,
    patch: {
      name: string;
      targetSheetName: string;
      steps: EtlStep[];
      scheduleOnOpen: boolean;
      scheduleIntervalMinutes: number;
    },
  ) => Promise<void>;
  /** Remove the connection record. */
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

type RowState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

type AddKind = "file" | "web" | "sqlite";

interface AddState {
  kind: AddKind;
  sourcePath: string;
  type: DataConnectionType;
  name: string;
  targetSheetName: string;
  webUrl: string;
  webFormat: "auto" | "json" | "csv";
  webHeadersText: string;
  sqliteQuery: string;
}

interface EditState {
  id: string;
  name: string;
  targetSheetName: string;
  steps: EtlStep[];
  scheduleOnOpen: boolean;
  scheduleIntervalMinutes: number;
}

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "等しい" },
  { value: "neq", label: "等しくない" },
  { value: "contains", label: "含む" },
  { value: "not_contains", label: "含まない" },
  { value: "gt", label: "より大きい" },
  { value: "gte", label: "以上" },
  { value: "lt", label: "より小さい" },
  { value: "lte", label: "以下" },
  { value: "empty", label: "空白" },
  { value: "not_empty", label: "空白でない" },
];

const CAST_TYPES: { value: CastType; label: string }[] = [
  { value: "text", label: "文字列" },
  { value: "number", label: "数値" },
  { value: "boolean", label: "真偽値" },
  { value: "date", label: "日付" },
];

/** Parse a textarea of `Header: value` lines into a headers map. Blank lines
 *  and lines without a colon are skipped. */
function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export default function DataConnectionsDialog({
  snapshotJson,
  onRefresh,
  onAdd,
  onEdit,
  onRemove,
  onClose,
}: Props) {
  const connections = useMemo(() => {
    if (!snapshotJson) return [] as DataConnection[];
    try {
      const parsed = JSON.parse(snapshotJson) as Parameters<typeof listConnections>[0];
      return listConnections(parsed);
    } catch {
      return [];
    }
  }, [snapshotJson]);

  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [adding, setAdding] = useState<AddState | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editing) setEditing(null);
        else if (adding) setAdding(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing, adding]);

  const setRow = (id: string, state: RowState) =>
    setRowStates((cur) => ({ ...cur, [id]: state }));

  const handleRefresh = useCallback(
    async (id: string) => {
      try {
        if (snapshotJson) {
          const parsed = JSON.parse(snapshotJson) as Parameters<typeof listConnections>[0];
          const conn = listConnections(parsed).find((c) => c.id === id);
          if (conn && sheetHasExtraRows(parsed, conn)) {
            const ok = window.confirm(
              `対象シート "${conn.targetSheetName}" には取り込み範囲外のデータがあるようです。リフレッシュで上書きされる可能性があります。続行しますか？`,
            );
            if (!ok) return;
          }
        }
      } catch {
        // Best-effort warning — fall through to the load on parse errors.
      }
      setRow(id, { kind: "loading" });
      setGlobalError(null);
      try {
        await onRefresh(id);
        setRow(id, { kind: "idle" });
      } catch (e) {
        setRow(id, { kind: "error", message: (e as Error).message });
      }
    },
    [onRefresh, snapshotJson],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const current = rowStates[id];
      if (current?.kind === "error" && current.message === "__confirm_remove") {
        try {
          await onRemove(id);
        } catch (e) {
          setGlobalError((e as Error).message);
        }
        return;
      }
      setRow(id, { kind: "error", message: "__confirm_remove" });
    },
    [onRemove, rowStates],
  );

  const blankAddState = (kind: AddKind): AddState => ({
    kind,
    sourcePath: "",
    type: kind === "web" ? "web" : kind === "sqlite" ? "sqlite" : "csv",
    name: "",
    targetSheetName: "",
    webUrl: "",
    webFormat: "auto",
    webHeadersText: "",
    sqliteQuery: "SELECT * FROM ",
  });

  const handleBrowseFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [
        { name: "Data files", extensions: ["csv", "tsv", "json"] },
        { name: "CSV", extensions: ["csv", "tsv"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const type = inferConnectionType(path);
    if (!type || (type !== "csv" && type !== "json")) {
      setGlobalError("対応していないファイル形式です (.csv / .tsv / .json のみ)");
      return;
    }
    const name = defaultConnectionName(path);
    setAdding({ ...blankAddState("file"), sourcePath: path, type, name, targetSheetName: name });
  }, []);

  const handleBrowseDb = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const name = defaultConnectionName(path);
    setAdding((cur) => ({
      ...(cur ?? blankAddState("sqlite")),
      kind: "sqlite",
      type: "sqlite",
      sourcePath: path,
      name: cur?.name || name,
      targetSheetName: cur?.targetSheetName || name,
    }));
  }, []);

  const handleAddSubmit = useCallback(async () => {
    if (!adding) return;
    setGlobalError(null);
    try {
      if (adding.kind === "web") {
        const url = adding.webUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
          setGlobalError("有効な http(s) URL を入力してください");
          return;
        }
        const fallbackName = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "Web";
          }
        })();
        await onAdd({
          name: adding.name.trim() || fallbackName,
          type: "web",
          sourcePath: "",
          targetSheetName: adding.targetSheetName.trim() || adding.name.trim() || fallbackName,
          webUrl: url,
          webFormat: adding.webFormat,
          webHeaders: parseHeaderLines(adding.webHeadersText),
        });
      } else if (adding.kind === "sqlite") {
        if (!adding.sourcePath) {
          setGlobalError("データベースファイルを選択してください");
          return;
        }
        const qErr = validateSqliteQuery(adding.sqliteQuery);
        if (qErr) {
          setGlobalError(qErr);
          return;
        }
        await onAdd({
          name: adding.name.trim() || defaultConnectionName(adding.sourcePath),
          type: "sqlite",
          sourcePath: adding.sourcePath,
          targetSheetName:
            adding.targetSheetName.trim() || defaultConnectionName(adding.sourcePath),
          sqliteQuery: adding.sqliteQuery.trim(),
        });
      } else {
        await onAdd({
          name: adding.name.trim() || defaultConnectionName(adding.sourcePath),
          type: adding.type,
          sourcePath: adding.sourcePath,
          targetSheetName:
            adding.targetSheetName.trim() || defaultConnectionName(adding.sourcePath),
        });
      }
      setAdding(null);
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  }, [adding, onAdd]);

  const handleEditSubmit = useCallback(async () => {
    if (!editing) return;
    setGlobalError(null);
    try {
      await onEdit(editing.id, {
        name: editing.name.trim(),
        targetSheetName: editing.targetSheetName.trim(),
        steps: editing.steps,
        scheduleOnOpen: editing.scheduleOnOpen,
        scheduleIntervalMinutes: Math.max(0, Math.floor(editing.scheduleIntervalMinutes)),
      });
      setEditing(null);
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  }, [editing, onEdit]);

  // --- ETL step editing helpers (operate on the `editing` draft) ---
  const updateSteps = (mut: (steps: EtlStep[]) => EtlStep[]) => {
    setEditing((cur) => (cur ? { ...cur, steps: mut([...cur.steps]) } : cur));
  };
  const addStep = (kind: EtlStep["kind"]) => {
    const fresh: EtlStep =
      kind === "filter"
        ? { kind: "filter", column: "", op: "eq", value: "" }
        : kind === "rename"
          ? { kind: "rename", column: "", to: "" }
          : kind === "cast"
            ? { kind: "cast", column: "", to: "text" }
            : kind === "select"
              ? { kind: "select", columns: [] }
              : kind === "sort"
                ? { kind: "sort", column: "", direction: "asc" }
                : { kind: "dedup", columns: [] };
    updateSteps((s) => [...s, fresh]);
  };
  const removeStep = (idx: number) => updateSteps((s) => s.filter((_, i) => i !== idx));
  const moveStep = (idx: number, dir: -1 | 1) =>
    updateSteps((s) => {
      const j = idx + dir;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  const patchStep = (idx: number, patch: Partial<EtlStep>) =>
    updateSteps((s) =>
      s.map((st, i) => (i === idx ? ({ ...st, ...patch } as EtlStep) : st)),
    );

  return (
    <div className="dcd-backdrop" onClick={onClose}>
      <div
        className="dcd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dcd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dcd-header">
          <h2 id="dcd-title" className="dcd-title">外部データ接続</h2>
          <button
            type="button"
            className="dcd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="dcd-body">
          {globalError && (
            <p className="dcd-error" data-testid="dcd-global-error">
              {globalError}
            </p>
          )}
          <div className="dcd-toolbar">
            <button
              type="button"
              className="dcd-btn dcd-btn--primary"
              onClick={() => void handleBrowseFile()}
              data-testid="dcd-add"
            >
              + ファイル
            </button>
            <button
              type="button"
              className="dcd-btn"
              onClick={() => setAdding(blankAddState("web"))}
              data-testid="dcd-add-web"
            >
              + Web/API
            </button>
            <button
              type="button"
              className="dcd-btn"
              onClick={() => setAdding(blankAddState("sqlite"))}
              data-testid="dcd-add-sqlite"
            >
              + SQLite
            </button>
            <span className="dcd-hint">
              CSV / JSON / Web API / ローカル SQLite を接続として登録できます。
            </span>
          </div>
          {connections.length === 0 ? (
            <p className="dcd-empty">
              接続はまだありません。上のボタンから登録してください。
            </p>
          ) : (
            <ul className="dcd-list" data-testid="dcd-list">
              {connections.map((c) => {
                const state = rowStates[c.id];
                const isLoading = state?.kind === "loading";
                const confirmingRemove =
                  state?.kind === "error" && state.message === "__confirm_remove";
                const rowError =
                  state?.kind === "error" && state.message !== "__confirm_remove"
                    ? state.message
                    : null;
                const stepCount = c.steps?.length ?? 0;
                const sourceLabel =
                  c.type === "web"
                    ? c.web?.url ?? ""
                    : c.type === "sqlite"
                      ? `${c.sourcePath}  [${c.sqlite?.query ?? ""}]`
                      : c.sourcePath;
                return (
                  <li key={c.id} className="dcd-row">
                    <div className="dcd-row-main">
                      <div className="dcd-row-name">
                        <span className={`dcd-badge dcd-badge--${c.type}`}>{c.type.toUpperCase()}</span>
                        <span className="dcd-name" title={c.name}>{c.name}</span>
                        {stepCount > 0 && (
                          <span className="dcd-badge dcd-badge--steps">{stepCount} ステップ</span>
                        )}
                        {c.schedule && (c.schedule.onOpen || c.schedule.intervalMinutes > 0) && (
                          <span className="dcd-badge dcd-badge--sched">
                            {c.schedule.onOpen ? "起動時" : ""}
                            {c.schedule.intervalMinutes > 0
                              ? `${c.schedule.onOpen ? " / " : ""}${c.schedule.intervalMinutes}分毎`
                              : ""}
                          </span>
                        )}
                      </div>
                      <div className="dcd-row-meta" title={sourceLabel}>
                        {sourceLabel}
                      </div>
                      <div className="dcd-row-meta">
                        対象シート: {c.targetSheetName}
                        {" / "}
                        最終取得: {c.lastRefreshedAt
                          ? new Date(c.lastRefreshedAt).toLocaleString()
                          : "未取得"}
                      </div>
                      {rowError && (
                        <div className="dcd-row-error" data-testid={`dcd-row-error-${c.id}`}>
                          {rowError}
                        </div>
                      )}
                    </div>
                    <div className="dcd-row-actions">
                      <button
                        type="button"
                        className="dcd-btn"
                        disabled={isLoading}
                        onClick={() => void handleRefresh(c.id)}
                        data-testid={`dcd-refresh-${c.id}`}
                      >
                        {isLoading ? "取得中..." : "リフレッシュ"}
                      </button>
                      <button
                        type="button"
                        className="dcd-btn"
                        disabled={isLoading}
                        onClick={() =>
                          setEditing({
                            id: c.id,
                            name: c.name,
                            targetSheetName: c.targetSheetName,
                            steps: c.steps ? c.steps.map((s) => ({ ...s })) : [],
                            scheduleOnOpen: c.schedule?.onOpen ?? false,
                            scheduleIntervalMinutes: c.schedule?.intervalMinutes ?? 0,
                          })
                        }
                        data-testid={`dcd-edit-${c.id}`}
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        className={confirmingRemove ? "dcd-btn dcd-btn--danger" : "dcd-btn"}
                        disabled={isLoading}
                        onClick={() => void handleRemove(c.id)}
                        data-testid={`dcd-remove-${c.id}`}
                      >
                        {confirmingRemove ? "削除を確定" : "削除"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="dcd-footer">
          <button type="button" className="dcd-btn" onClick={onClose}>
            閉じる
          </button>
        </footer>
      </div>

      {adding && (
        <div className="dcd-backdrop dcd-backdrop--nested" onClick={() => setAdding(null)}>
          <div
            className="dcd-modal dcd-modal--small"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="dcd-header">
              <h2 className="dcd-title">
                {adding.kind === "web"
                  ? "Web/API 接続を追加"
                  : adding.kind === "sqlite"
                    ? "SQLite 接続を追加"
                    : "接続を追加"}
              </h2>
              <button
                type="button"
                className="dcd-close"
                onClick={() => setAdding(null)}
                aria-label="閉じる"
              >
                ×
              </button>
            </header>
            <div className="dcd-body">
              {adding.kind === "file" && (
                <>
                  <label className="dcd-field">
                    <span className="dcd-field-label">ファイル</span>
                    <input
                      type="text"
                      className="dcd-input"
                      value={adding.sourcePath}
                      readOnly
                      data-testid="dcd-add-path"
                    />
                  </label>
                  <label className="dcd-field">
                    <span className="dcd-field-label">形式</span>
                    <input
                      type="text"
                      className="dcd-input"
                      value={adding.type.toUpperCase()}
                      readOnly
                    />
                  </label>
                </>
              )}
              {adding.kind === "web" && (
                <>
                  <label className="dcd-field">
                    <span className="dcd-field-label">URL</span>
                    <input
                      type="text"
                      className="dcd-input"
                      placeholder="https://api.example.com/data"
                      value={adding.webUrl}
                      onChange={(e) => setAdding({ ...adding, webUrl: e.target.value })}
                      data-testid="dcd-add-weburl"
                    />
                  </label>
                  <label className="dcd-field">
                    <span className="dcd-field-label">レスポンス形式</span>
                    <select
                      className="dcd-input"
                      value={adding.webFormat}
                      onChange={(e) =>
                        setAdding({
                          ...adding,
                          webFormat: e.target.value as AddState["webFormat"],
                        })
                      }
                    >
                      <option value="auto">自動判定</option>
                      <option value="json">JSON</option>
                      <option value="csv">CSV</option>
                    </select>
                  </label>
                  <label className="dcd-field">
                    <span className="dcd-field-label">追加ヘッダ (任意)</span>
                    <textarea
                      className="dcd-input dcd-textarea"
                      placeholder={"Accept: application/json"}
                      value={adding.webHeadersText}
                      onChange={(e) => setAdding({ ...adding, webHeadersText: e.target.value })}
                      data-testid="dcd-add-webheaders"
                    />
                  </label>
                  <p className="dcd-hint dcd-hint--block">
                    URL のドメインは設定の許可リスト (#138) に登録されている必要があります。
                    認証情報が登録済みのドメインは自動的に付与されます。
                  </p>
                </>
              )}
              {adding.kind === "sqlite" && (
                <>
                  <label className="dcd-field">
                    <span className="dcd-field-label">データベース</span>
                    <div className="dcd-field-row">
                      <input
                        type="text"
                        className="dcd-input"
                        value={adding.sourcePath}
                        readOnly
                        data-testid="dcd-add-dbpath"
                      />
                      <button
                        type="button"
                        className="dcd-btn"
                        onClick={() => void handleBrowseDb()}
                      >
                        参照...
                      </button>
                    </div>
                  </label>
                  <label className="dcd-field">
                    <span className="dcd-field-label">SQL クエリ (SELECT のみ)</span>
                    <textarea
                      className="dcd-input dcd-textarea"
                      value={adding.sqliteQuery}
                      onChange={(e) => setAdding({ ...adding, sqliteQuery: e.target.value })}
                      data-testid="dcd-add-sql"
                    />
                  </label>
                  <p className="dcd-hint dcd-hint--block">
                    データベースは読み取り専用で開きます。SELECT / WITH クエリのみ実行できます。
                  </p>
                </>
              )}
              <label className="dcd-field">
                <span className="dcd-field-label">接続名</span>
                <input
                  type="text"
                  className="dcd-input"
                  value={adding.name}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                  data-testid="dcd-add-name"
                />
              </label>
              <label className="dcd-field">
                <span className="dcd-field-label">取り込み先シート名</span>
                <input
                  type="text"
                  className="dcd-input"
                  value={adding.targetSheetName}
                  onChange={(e) => setAdding({ ...adding, targetSheetName: e.target.value })}
                  data-testid="dcd-add-target"
                />
              </label>
            </div>
            <footer className="dcd-footer">
              <button
                type="button"
                className="dcd-btn"
                onClick={() => setAdding(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="dcd-btn dcd-btn--primary"
                onClick={() => void handleAddSubmit()}
                data-testid="dcd-add-submit"
              >
                追加して読み込み
              </button>
            </footer>
          </div>
        </div>
      )}

      {editing && (
        <div className="dcd-backdrop dcd-backdrop--nested" onClick={() => setEditing(null)}>
          <div
            className="dcd-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="dcd-header">
              <h2 className="dcd-title">接続を編集</h2>
              <button
                type="button"
                className="dcd-close"
                onClick={() => setEditing(null)}
                aria-label="閉じる"
              >
                ×
              </button>
            </header>
            <div className="dcd-body">
              <label className="dcd-field">
                <span className="dcd-field-label">接続名</span>
                <input
                  type="text"
                  className="dcd-input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  data-testid="dcd-edit-name"
                />
              </label>
              <label className="dcd-field">
                <span className="dcd-field-label">取り込み先シート名</span>
                <input
                  type="text"
                  className="dcd-input"
                  value={editing.targetSheetName}
                  onChange={(e) =>
                    setEditing({ ...editing, targetSheetName: e.target.value })
                  }
                  data-testid="dcd-edit-target"
                />
              </label>

              {/* Phase 2: ETL steps */}
              <div className="dcd-section">
                <div className="dcd-section-head">
                  <span className="dcd-section-title">変換ステップ (ETL)</span>
                  <div className="dcd-step-add">
                    <select
                      className="dcd-input dcd-input--inline"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) addStep(e.target.value as EtlStep["kind"]);
                        e.target.value = "";
                      }}
                      data-testid="dcd-step-add"
                    >
                      <option value="">+ ステップを追加</option>
                      <option value="filter">フィルター</option>
                      <option value="rename">列名変更</option>
                      <option value="cast">型変換</option>
                      <option value="select">列の選択</option>
                      <option value="sort">並べ替え</option>
                      <option value="dedup">重複削除</option>
                    </select>
                  </div>
                </div>
                {editing.steps.length === 0 ? (
                  <p className="dcd-hint dcd-hint--block">
                    ステップなし — 元データがそのまま取り込まれます。
                  </p>
                ) : (
                  <ol className="dcd-steps" data-testid="dcd-steps">
                    {editing.steps.map((step, idx) => (
                      <li key={idx} className="dcd-step">
                        <div className="dcd-step-head">
                          <span className="dcd-step-summary">{describeStep(step)}</span>
                          <div className="dcd-step-actions">
                            <button
                              type="button"
                              className="dcd-btn dcd-btn--icon"
                              onClick={() => moveStep(idx, -1)}
                              disabled={idx === 0}
                              aria-label="上へ"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="dcd-btn dcd-btn--icon"
                              onClick={() => moveStep(idx, 1)}
                              disabled={idx === editing.steps.length - 1}
                              aria-label="下へ"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="dcd-btn dcd-btn--icon dcd-btn--danger"
                              onClick={() => removeStep(idx)}
                              aria-label="削除"
                              data-testid={`dcd-step-remove-${idx}`}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                        <div className="dcd-step-body">
                          {step.kind === "filter" && (
                            <>
                              <input
                                type="text"
                                className="dcd-input dcd-input--inline"
                                placeholder="列名"
                                value={step.column}
                                onChange={(e) => patchStep(idx, { column: e.target.value })}
                              />
                              <select
                                className="dcd-input dcd-input--inline"
                                value={step.op}
                                onChange={(e) =>
                                  patchStep(idx, { op: e.target.value as FilterOp })
                                }
                              >
                                {FILTER_OPS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              {step.op !== "empty" && step.op !== "not_empty" && (
                                <input
                                  type="text"
                                  className="dcd-input dcd-input--inline"
                                  placeholder="値"
                                  value={step.value}
                                  onChange={(e) => patchStep(idx, { value: e.target.value })}
                                />
                              )}
                            </>
                          )}
                          {step.kind === "rename" && (
                            <>
                              <input
                                type="text"
                                className="dcd-input dcd-input--inline"
                                placeholder="現在の列名"
                                value={step.column}
                                onChange={(e) => patchStep(idx, { column: e.target.value })}
                              />
                              <span className="dcd-step-arrow">→</span>
                              <input
                                type="text"
                                className="dcd-input dcd-input--inline"
                                placeholder="新しい列名"
                                value={step.to}
                                onChange={(e) => patchStep(idx, { to: e.target.value })}
                              />
                            </>
                          )}
                          {step.kind === "cast" && (
                            <>
                              <input
                                type="text"
                                className="dcd-input dcd-input--inline"
                                placeholder="列名"
                                value={step.column}
                                onChange={(e) => patchStep(idx, { column: e.target.value })}
                              />
                              <select
                                className="dcd-input dcd-input--inline"
                                value={step.to}
                                onChange={(e) =>
                                  patchStep(idx, { to: e.target.value as CastType })
                                }
                              >
                                {CAST_TYPES.map((t) => (
                                  <option key={t.value} value={t.value}>
                                    {t.label}
                                  </option>
                                ))}
                              </select>
                            </>
                          )}
                          {step.kind === "select" && (
                            <input
                              type="text"
                              className="dcd-input"
                              placeholder="列名をカンマ区切りで (例: name, age)"
                              value={step.columns.join(", ")}
                              onChange={(e) =>
                                patchStep(idx, {
                                  columns: e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          )}
                          {step.kind === "sort" && (
                            <>
                              <input
                                type="text"
                                className="dcd-input dcd-input--inline"
                                placeholder="列名"
                                value={step.column}
                                onChange={(e) => patchStep(idx, { column: e.target.value })}
                              />
                              <select
                                className="dcd-input dcd-input--inline"
                                value={step.direction}
                                onChange={(e) =>
                                  patchStep(idx, {
                                    direction: e.target.value as "asc" | "desc",
                                  })
                                }
                              >
                                <option value="asc">昇順</option>
                                <option value="desc">降順</option>
                              </select>
                            </>
                          )}
                          {step.kind === "dedup" && (
                            <input
                              type="text"
                              className="dcd-input"
                              placeholder="判定列をカンマ区切りで (空欄=全列)"
                              value={step.columns.join(", ")}
                              onChange={(e) =>
                                patchStep(idx, {
                                  columns: e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {/* Phase 5: schedule */}
              <div className="dcd-section">
                <span className="dcd-section-title">自動リフレッシュ</span>
                <label className="dcd-check">
                  <input
                    type="checkbox"
                    checked={editing.scheduleOnOpen}
                    onChange={(e) =>
                      setEditing({ ...editing, scheduleOnOpen: e.target.checked })
                    }
                    data-testid="dcd-sched-onopen"
                  />
                  ワークブックを開いたときにリフレッシュ
                </label>
                <label className="dcd-field dcd-field--inline">
                  <span className="dcd-field-label">間隔 (分, 0=なし)</span>
                  <input
                    type="number"
                    min={0}
                    className="dcd-input dcd-input--inline"
                    value={editing.scheduleIntervalMinutes}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        scheduleIntervalMinutes: Number(e.target.value) || 0,
                      })
                    }
                    data-testid="dcd-sched-interval"
                  />
                </label>
              </div>
            </div>
            <footer className="dcd-footer">
              <button type="button" className="dcd-btn" onClick={() => setEditing(null)}>
                キャンセル
              </button>
              <button
                type="button"
                className="dcd-btn dcd-btn--primary"
                onClick={() => void handleEditSubmit()}
                data-testid="dcd-edit-submit"
              >
                保存
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

export type { DataConnection };
