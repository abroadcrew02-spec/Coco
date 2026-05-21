// #136 / #189 — Script editor dialog.
//
// 左ペインにスクリプト一覧 (snapshot._scripts)、右ペインにエディタ
// (textarea) + 実行ボタン + console output エリア。
//
// #189 で追加:
//   - トリガー登録の可視化 (onOpen / onEdit / timer / menu)
//   - 登録済みカスタムメニューの一覧 + 手動発火ボタン
//   - 実行ログ (localStorage 永続) の閲覧タブ
//   - API リファレンス (.d.ts) パネル
//   - エラー発生行のインライン表示
//   - sandboxed iframe での実行 (scriptRuntime 側で自動選択)
//
// EditorScreen 側で FUniver を保持しているため `fUniver` を props で受け取る。
// 永続化は `onChange(updatedScripts)` で親に伝える。

import { useEffect, useMemo, useState } from "react";
import type { FUniver } from "@univerjs/facade";
import {
  type ScriptEntry,
  type ScriptRunResult,
  type RegisteredTrigger,
  type ExecutionLogRecord,
  createDefaultScript,
  generateScriptId,
  runScript,
  collectTriggers,
  fireTrigger,
  recordRun,
  readExecutionLog,
  clearExecutionLog,
} from "../store/scriptRuntime";
import { SCRIPT_API_DTS } from "../store/scriptApiDts";
import "./ScriptEditorDialog.css";

interface Props {
  scripts: ScriptEntry[];
  fUniver: FUniver | null;
  /** 保護シート判定用の現在の snapshot JSON。 */
  snapshotJson: string | null;
  onChange: (next: ScriptEntry[]) => void;
  onClose: () => void;
}

type RightTab = "console" | "log" | "reference";

export default function ScriptEditorDialog({
  scripts,
  fUniver,
  snapshotJson,
  onChange,
  onClose,
}: Props) {
  const initial = useMemo(() => {
    if (scripts.length > 0) return scripts;
    return [createDefaultScript()];
  }, [scripts]);

  const [entries, setEntries] = useState<ScriptEntry[]>(initial);
  const [selectedId, setSelectedId] = useState<string>(initial[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<ScriptRunResult | null>(null);
  const [tab, setTab] = useState<RightTab>("console");
  const [triggers, setTriggers] = useState<RegisteredTrigger[]>([]);
  const [execLog, setExecLog] = useState<ExecutionLogRecord[]>(() =>
    readExecutionLog(),
  );

  useEffect(() => {
    setEntries(initial);
    setSelectedId(initial[0]?.id ?? "");
  }, [initial]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  // 選択スクリプトのトリガー登録をドライランで収集して可視化する。
  useEffect(() => {
    if (!selected) {
      setTriggers([]);
      return;
    }
    let cancelled = false;
    void collectTriggers(selected, { fUniver, snapshotJson }).then((r) => {
      if (!cancelled) setTriggers(r.triggers);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, fUniver, snapshotJson]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const commitEntries = (next: ScriptEntry[]) => {
    setEntries(next);
    onChange(next);
  };

  const handleAdd = () => {
    const fresh: ScriptEntry = {
      ...createDefaultScript(),
      id: generateScriptId(),
      name: `スクリプト ${entries.length + 1}`,
    };
    commitEntries([...entries, fresh]);
    setSelectedId(fresh.id);
  };

  const handleDelete = (id: string) => {
    const next = entries.filter((e) => e.id !== id);
    commitEntries(next);
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? "");
    }
  };

  const handleRenameSelected = (name: string) => {
    if (!selected) return;
    const next = entries.map((e) =>
      e.id === selected.id ? { ...e, name, lastModified: Date.now() } : e,
    );
    commitEntries(next);
  };

  const handleSourceChange = (source: string) => {
    if (!selected) return;
    const next = entries.map((e) =>
      e.id === selected.id ? { ...e, source, lastModified: Date.now() } : e,
    );
    commitEntries(next);
  };

  const handleRun = async () => {
    if (!selected || running) return;
    setRunning(true);
    setLastResult(null);
    setTab("console");
    try {
      const result = await runScript(selected.source, { fUniver, snapshotJson });
      setLastResult(result);
      recordRun(selected, "manual", result);
      setExecLog(readExecutionLog());
    } finally {
      setRunning(false);
    }
  };

  // カスタムメニュー項目を手動発火する (#189)。
  const handleFireMenu = async (label: string) => {
    if (!selected || running) return;
    setRunning(true);
    setLastResult(null);
    setTab("console");
    try {
      const result = await fireTrigger(selected, "menu", {
        fUniver,
        snapshotJson,
        label,
      });
      setLastResult(result);
      recordRun(selected, "menu", result);
      setExecLog(readExecutionLog());
    } finally {
      setRunning(false);
    }
  };

  const handleClearConsole = () => setLastResult(null);

  const handleClearLog = () => {
    clearExecutionLog();
    setExecLog([]);
  };

  return (
    <div className="script-editor-overlay" role="dialog" aria-modal="true">
      <div className="script-editor-dialog">
        <div className="script-editor-header">
          <h2>スクリプトエディタ</h2>
          <button
            type="button"
            className="script-editor-close"
            aria-label="閉じる"
            onClick={onClose}
            disabled={running}
          >
            ×
          </button>
        </div>

        <div className="script-editor-body">
          <aside className="script-editor-list">
            <div className="script-editor-list-header">
              <span>スクリプト</span>
              <button
                type="button"
                className="script-editor-list-add"
                onClick={handleAdd}
              >
                ＋ 新規
              </button>
            </div>
            <ul className="script-editor-list-items">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className={
                    "script-editor-list-item" +
                    (e.id === selectedId ? " selected" : "")
                  }
                  onClick={() => setSelectedId(e.id)}
                >
                  <span>{e.name}</span>
                  <button
                    type="button"
                    className="script-editor-list-delete"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      // eslint-disable-next-line no-alert
                      if (confirm(`「${e.name}」を削除しますか?`)) {
                        handleDelete(e.id);
                      }
                    }}
                    aria-label={`${e.name} を削除`}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="script-editor-main">
            {selected ? (
              <>
                <div className="script-editor-name-row">
                  <label htmlFor="script-editor-name">名前</label>
                  <input
                    id="script-editor-name"
                    type="text"
                    value={selected.name}
                    onChange={(e) => handleRenameSelected(e.target.value)}
                  />
                </div>

                <SourceEditor
                  source={selected.source}
                  errorLine={lastResult && !lastResult.ok ? lastResult.errorLine : null}
                  onChange={handleSourceChange}
                />

                {triggers.length > 0 && (
                  <div className="script-editor-triggers">
                    <span className="script-editor-triggers-label">
                      登録トリガー:
                    </span>
                    {triggers.map((t, i) => (
                      <TriggerChip
                        key={`${t.kind}-${t.label}-${i}`}
                        trigger={t}
                        disabled={running}
                        onFire={
                          t.kind === "menu"
                            ? () => void handleFireMenu(t.label)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}

                <div className="script-editor-toolbar">
                  <button
                    type="button"
                    className="script-editor-run"
                    onClick={() => void handleRun()}
                    disabled={running}
                  >
                    {running ? "実行中..." : "▶ 実行"}
                  </button>
                  <div className="script-editor-tabs">
                    <button
                      type="button"
                      className={tab === "console" ? "active" : ""}
                      onClick={() => setTab("console")}
                    >
                      コンソール
                    </button>
                    <button
                      type="button"
                      className={tab === "log" ? "active" : ""}
                      onClick={() => {
                        setExecLog(readExecutionLog());
                        setTab("log");
                      }}
                    >
                      実行ログ
                    </button>
                    <button
                      type="button"
                      className={tab === "reference" ? "active" : ""}
                      onClick={() => setTab("reference")}
                    >
                      APIリファレンス
                    </button>
                  </div>
                  {lastResult && tab === "console" && (
                    <span className="script-editor-status">
                      {lastResult.ok
                        ? `OK (${lastResult.elapsedMs}ms)`
                        : `エラー (${lastResult.elapsedMs}ms${lastResult.timedOut ? " — タイムアウト" : ""})`}
                    </span>
                  )}
                </div>

                {tab === "console" && (
                  <pre className="script-editor-console">
                    {lastResult
                      ? renderConsoleOutput(lastResult)
                      : "// 実行結果はここに表示されます"}
                  </pre>
                )}
                {tab === "log" && (
                  <div className="script-editor-log">
                    <div className="script-editor-log-toolbar">
                      <span>実行ログ (最新 100 件・端末ローカル保存)</span>
                      <button type="button" onClick={handleClearLog}>
                        ログを消去
                      </button>
                    </div>
                    {execLog.length === 0 ? (
                      <div className="script-editor-log-empty">
                        実行履歴はありません
                      </div>
                    ) : (
                      <ul className="script-editor-log-items">
                        {execLog.map((r, i) => (
                          <li
                            key={`${r.at}-${i}`}
                            className={r.ok ? "ok" : "err"}
                          >
                            <span className="log-time">
                              {new Date(r.at).toLocaleTimeString()}
                            </span>
                            <span className="log-name">{r.scriptName}</span>
                            <span className="log-trigger">{r.trigger}</span>
                            <span className="log-status">
                              {r.ok
                                ? `OK ${r.elapsedMs}ms`
                                : `NG${r.timedOut ? " (timeout)" : ""}: ${r.error ?? ""}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {tab === "reference" && (
                  <pre className="script-editor-reference">{SCRIPT_API_DTS}</pre>
                )}
              </>
            ) : (
              <div style={{ padding: 20, color: "#666" }}>
                左のリストから選ぶか「＋ 新規」を押してスクリプトを作成してください。
              </div>
            )}
          </section>
        </div>

        <div className="script-editor-footer">
          <button type="button" onClick={handleClearConsole} disabled={running}>
            コンソールをクリア
          </button>
          <button type="button" onClick={onClose} disabled={running}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 軽量ソースエディタ — textarea の背後に行番号 + エラー行ハイライトを
 * 重ねる。Monaco フル統合は将来対応 (バンドルサイズ過大)。
 */
function SourceEditor({
  source,
  errorLine,
  onChange,
}: {
  source: string;
  errorLine: number | null;
  onChange: (s: string) => void;
}) {
  const lines = source.split("\n");
  return (
    <div className="script-editor-source-wrap">
      <div className="script-editor-gutter" aria-hidden="true">
        {lines.map((_, i) => (
          <div
            key={i}
            className={
              "script-editor-gutter-line" +
              (errorLine === i + 1 ? " error" : "")
            }
          >
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        className="script-editor-source"
        value={source}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="// ここに JavaScript を記述..."
      />
    </div>
  );
}

/** トリガー種別のバッジ。menu 種別は手動発火ボタンを兼ねる。 */
function TriggerChip({
  trigger,
  disabled,
  onFire,
}: {
  trigger: RegisteredTrigger;
  disabled: boolean;
  onFire?: () => void;
}) {
  const labelMap: Record<RegisteredTrigger["kind"], string> = {
    onOpen: "onOpen",
    onEdit: "onEdit",
    timer: `timer ${trigger.label}`,
    menu: `menu「${trigger.label}」`,
  };
  if (trigger.kind === "menu" && onFire) {
    return (
      <button
        type="button"
        className="script-editor-trigger-chip menu"
        disabled={disabled}
        onClick={onFire}
        title="このメニュー項目を手動実行"
      >
        ▷ {labelMap.menu}
      </button>
    );
  }
  return (
    <span className={`script-editor-trigger-chip ${trigger.kind}`}>
      {labelMap[trigger.kind]}
    </span>
  );
}

function renderConsoleOutput(r: ScriptRunResult): string {
  const lines: string[] = [];
  for (const l of r.logs) lines.push(l);
  if (!r.ok && r.error) {
    lines.push("");
    lines.push(
      `[error]${r.errorLine ? ` (行 ${r.errorLine})` : ""} ${r.error}`,
    );
    if (r.stack) {
      lines.push(r.stack);
    }
  }
  return lines.join("\n");
}
