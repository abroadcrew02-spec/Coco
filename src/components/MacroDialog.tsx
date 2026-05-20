import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addMacro,
  cancelRecording,
  generateMacroId,
  getEventCount,
  getState,
  loadAll,
  playback,
  removeMacro,
  saveAll,
  startRecording,
  stopRecording,
  subscribe,
  summariseDestructive,
  type MacroExecutor,
  type SavedMacro,
} from "../store/macroRecord";
import "./MacroDialog.css";

interface Props {
  /** Wired to FUniver.executeCommand from EditorScreen. Optional so the
   *  dialog can render before the engine is ready — playback is gated
   *  on this being non-null. */
  executor: MacroExecutor | null;
  onClose: () => void;
}

function formatTimestamp(ms: number): string {
  try {
    const d = new Date(ms);
    return d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function MacroDialog({ executor, onClose }: Props) {
  const [macros, setMacros] = useState<SavedMacro[]>(() => loadAll());
  const [name, setName] = useState("");
  const [recState, setRecState] = useState<"idle" | "recording" | "playing">(
    getState,
  );
  const [eventCount, setEventCount] = useState<number>(() => getEventCount());
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Subscribe to recorder transitions so the button states stay in sync even
  // if recording is started/stopped programmatically (future scripted entry
  // points). MVP only has the in-dialog buttons but the wiring is cheap.
  useEffect(() => {
    const unsub = subscribe(() => {
      setRecState(getState());
      setEventCount(getEventCount());
    });
    return () => {
      unsub();
    };
  }, []);

  // Escape to dismiss — matches the rest of Coco's modals.
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

  const sortedMacros = useMemo(
    () => [...macros].sort((a, b) => b.createdAt - a.createdAt),
    [macros],
  );

  const handleStart = useCallback(() => {
    if (!startRecording()) return;
    setStatusMsg("記録を開始しました。操作を実行してください。");
  }, []);

  const handleStop = useCallback(() => {
    const stopped = stopRecording();
    if (!stopped) return;
    if (stopped.events.length === 0) {
      setStatusMsg("記録された操作がありません。");
      return;
    }
    const destructive = summariseDestructive(stopped.events);
    if (destructive.length > 0) {
      const human = destructive
        .map((id) => id.replace(/^sheet\.command\./, ""))
        .join(", ");
      const ok = window.confirm(
        `このマクロには破壊的な操作 (${human}) が含まれます。再生時に元に戻せない場合があります。保存しますか？`,
      );
      if (!ok) {
        setStatusMsg("保存をキャンセルしました。");
        return;
      }
    }
    const finalName = name.trim() || `マクロ ${macros.length + 1}`;
    const next = addMacro(macros, finalName, stopped.events, Date.now(), generateMacroId());
    setMacros(next);
    saveAll(next);
    setName("");
    setStatusMsg(`「${finalName}」を保存しました (${stopped.events.length} 件)`);
  }, [macros, name]);

  const handleCancel = useCallback(() => {
    cancelRecording();
    setStatusMsg("記録を破棄しました。");
  }, []);

  const handlePlay = useCallback(
    async (macro: SavedMacro) => {
      if (!executor) {
        setStatusMsg("エディタが準備できていません。少し待ってからお試しください。");
        return;
      }
      if (recState === "recording") {
        setStatusMsg("記録中は再生できません。先に停止してください。");
        return;
      }
      const destructive = summariseDestructive(macro.events);
      if (destructive.length > 0) {
        const ok = window.confirm(
          `「${macro.name}」には破壊的な操作が含まれます。実行しますか？`,
        );
        if (!ok) return;
      }
      setStatusMsg(`「${macro.name}」を再生中...`);
      const result = await playback(macro.events, executor);
      const errPart =
        result.errors.length > 0 ? ` (失敗: ${result.errors.length})` : "";
      setStatusMsg(
        `再生完了: ${result.ran} 件実行${errPart}`,
      );
    },
    [executor, recState],
  );

  const handleDelete = useCallback((id: string) => {
    const target = macros.find((m) => m.id === id);
    if (!target) return;
    const ok = window.confirm(`「${target.name}」を削除しますか？`);
    if (!ok) return;
    const next = removeMacro(macros, id);
    setMacros(next);
    saveAll(next);
    setStatusMsg("マクロを削除しました。");
  }, [macros]);

  const recording = recState === "recording";
  const playing = recState === "playing";

  return (
    <div
      className="macro-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="macro-modal"
        role="dialog"
        aria-modal="true"
        aria-label="マクロの記録 / 再生"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="macro-header">
          <h2 className="macro-title">マクロの記録 / 再生</h2>
          <button
            type="button"
            className="macro-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="macro-body">
          <section className="macro-section">
            <h3 className="macro-section-title">記録</h3>
            <div className="macro-record-row">
              <input
                type="text"
                className="macro-input"
                placeholder="マクロ名 (省略可)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={recording || playing}
                aria-label="マクロ名"
              />
              {!recording ? (
                <button
                  type="button"
                  className="macro-btn macro-btn--primary"
                  onClick={handleStart}
                  disabled={playing}
                >
                  記録開始
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="macro-btn macro-btn--primary"
                    onClick={handleStop}
                  >
                    停止して保存 ({eventCount})
                  </button>
                  <button
                    type="button"
                    className="macro-btn"
                    onClick={handleCancel}
                  >
                    破棄
                  </button>
                </>
              )}
            </div>
            {recording && (
              <p className="macro-hint" role="status" aria-live="polite">
                <span className="macro-rec-dot" aria-hidden="true" />
                記録中 · 操作を実行してください
              </p>
            )}
          </section>

          <section className="macro-section">
            <h3 className="macro-section-title">
              保存済みマクロ ({sortedMacros.length})
            </h3>
            {sortedMacros.length === 0 ? (
              <p className="macro-empty">
                まだマクロがありません。上で「記録開始」を押して操作を記録してください。
              </p>
            ) : (
              <ul className="macro-list" aria-label="保存済みマクロ一覧">
                {sortedMacros.map((m) => (
                  <li
                    key={m.id}
                    className="macro-item"
                    data-testid={`macro-item-${m.id}`}
                  >
                    <div className="macro-item-meta">
                      <div className="macro-item-name">{m.name}</div>
                      <div className="macro-item-sub">
                        {m.events.length} 件 · {formatTimestamp(m.createdAt)}
                      </div>
                    </div>
                    <div className="macro-item-actions">
                      <button
                        type="button"
                        className="macro-btn macro-btn--primary"
                        onClick={() => void handlePlay(m)}
                        disabled={!executor || recording || playing}
                      >
                        再生
                      </button>
                      <button
                        type="button"
                        className="macro-btn"
                        onClick={() => handleDelete(m.id)}
                        disabled={recording || playing}
                      >
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="macro-footer">
          <span className="macro-status" role="status" aria-live="polite">
            {statusMsg ?? "操作を選択してください"}
          </span>
          <button type="button" className="macro-btn" onClick={onClose}>
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}
