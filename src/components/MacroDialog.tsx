import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addMacro,
  cancelRecording,
  generateMacroId,
  getEventCount,
  getState,
  playback,
  removeMacro,
  startRecording,
  stopRecording,
  subscribe,
  summariseDestructive,
  type MacroEvent,
  type MacroExecutor,
  type SavedMacro,
} from "../store/macroRecord";
import { loadAllSecure, saveAllSecure } from "../store/secureMacroStore";
import { eventsToDsl, parseDsl } from "../store/macroDsl";
import {
  assignShortcut,
  clearMacroBinding,
  loadBindings,
  MACRO_SHORTCUT_SLOTS,
  notifyShortcutsChanged,
  pruneBindings,
  saveBindings,
  slotForMacro,
  slotLabel,
  type MacroShortcutSlot,
  type ShortcutBindings,
} from "../store/macroShortcuts";
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
  // #186 — the macro store is now encrypted (AES-GCM). Reading it is async, so
  // we start with an empty list and hydrate via an effect. `loadAllSecure`
  // also transparently migrates a legacy plaintext payload on first read.
  const [macros, setMacros] = useState<SavedMacro[]>([]);
  const [bindings, setBindings] = useState<ShortcutBindings>(() => loadBindings());
  const [name, setName] = useState("");
  const [recState, setRecState] = useState<"idle" | "recording" | "playing">(
    getState,
  );
  const [eventCount, setEventCount] = useState<number>(() => getEventCount());
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  // Per-macro DSL editor: which macro id is being edited (null = none) plus
  // the in-progress text + parse errors.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dslText, setDslText] = useState("");
  const [dslErrors, setDslErrors] = useState<string[]>([]);

  // Hydrate the (encrypted) macro store once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadAllSecure();
      if (cancelled) return;
      setMacros(result.macros);
      // Drop bindings whose macro no longer exists, then persist the cleaned
      // table so it self-heals after out-of-dialog deletions.
      const ids = new Set(result.macros.map((m) => m.id));
      setBindings((prev) => {
        const pruned = pruneBindings(prev, ids);
        if (Object.keys(pruned).length !== Object.keys(prev).length) {
          saveBindings(pruned);
          notifyShortcutsChanged();
        }
        return pruned;
      });
      if (result.tampered) {
        setStatusMsg(
          "保存済みマクロを復号できませんでした（改竄またはデータ破損の可能性）。",
        );
      } else if (result.migrated) {
        setStatusMsg("保存済みマクロを暗号化形式へ移行しました。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist the macro list (encrypted) and update local state together. */
  const persistMacros = useCallback((next: SavedMacro[]) => {
    setMacros(next);
    void saveAllSecure(next);
  }, []);

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
    persistMacros(next);
    setName("");
    setStatusMsg(`「${finalName}」を保存しました (${stopped.events.length} 件)`);
  }, [macros, name, persistMacros]);

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

  const handleDelete = useCallback(
    (id: string) => {
      const target = macros.find((m) => m.id === id);
      if (!target) return;
      const ok = window.confirm(`「${target.name}」を削除しますか？`);
      if (!ok) return;
      persistMacros(removeMacro(macros, id));
      // Drop any shortcut bound to the deleted macro so we never leave a
      // dangling binding the global-shortcut hook would fire into nothing.
      setBindings((prev) => {
        const next = clearMacroBinding(prev, id);
        saveBindings(next);
        notifyShortcutsChanged();
        return next;
      });
      if (editingId === id) setEditingId(null);
      setStatusMsg("マクロを削除しました。");
    },
    [macros, persistMacros, editingId],
  );

  // ---- DSL editor -------------------------------------------------------

  const handleOpenEditor = useCallback((macro: SavedMacro) => {
    setEditingId(macro.id);
    setDslText(eventsToDsl(macro.events));
    setDslErrors([]);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditingId(null);
    setDslErrors([]);
  }, []);

  const handleSaveDsl = useCallback(() => {
    if (editingId === null) return;
    const { events, errors } = parseDsl(dslText);
    if (errors.length > 0) {
      setDslErrors(errors.map((e) => `${e.line} 行目: ${e.message}`));
      setStatusMsg("スクリプトにエラーがあります。修正してください。");
      return;
    }
    const next = macros.map((m) =>
      m.id === editingId ? { ...m, events } : m,
    );
    persistMacros(next);
    setDslErrors([]);
    setEditingId(null);
    setStatusMsg(`スクリプトを保存しました (${events.length} 行)`);
  }, [editingId, dslText, macros, persistMacros]);

  // Live validation feedback as the user types.
  const handleDslChange = useCallback((text: string) => {
    setDslText(text);
    const { errors } = parseDsl(text);
    setDslErrors(errors.map((e) => `${e.line} 行目: ${e.message}`));
  }, []);

  // ---- shortcut binding -------------------------------------------------

  const handleAssignShortcut = useCallback(
    (macroId: string, value: string) => {
      const slot = value === "" ? null : (Number(value) as MacroShortcutSlot);
      setBindings((prev) => {
        // A real slot moves the macro there; the "none" choice clears it.
        const next =
          slot === null
            ? clearMacroBinding(prev, macroId)
            : assignShortcut(prev, slot, macroId);
        saveBindings(next);
        notifyShortcutsChanged();
        return next;
      });
      setStatusMsg(
        slot === null
          ? "ショートカットの割り当てを解除しました。"
          : `${slotLabel(slot)} を割り当てました。`,
      );
    },
    [],
  );

  /** Slots already taken by OTHER macros — disabled in the select so the user
   *  can't double-assign (a slot holds at most one macro). */
  const takenSlots = useCallback(
    (currentMacroId: string): Set<MacroShortcutSlot> => {
      const taken = new Set<MacroShortcutSlot>();
      for (const slot of MACRO_SHORTCUT_SLOTS) {
        const boundId = bindings[slot];
        if (boundId && boundId !== currentMacroId) taken.add(slot);
      }
      return taken;
    },
    [bindings],
  );

  const recording = recState === "recording";
  const playing = recState === "playing";

  const dslEvents: MacroEvent[] | null = useMemo(() => {
    if (editingId === null) return null;
    const { events, errors } = parseDsl(dslText);
    return errors.length > 0 ? null : events;
  }, [editingId, dslText]);

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
                {sortedMacros.map((m) => {
                  const boundSlot = slotForMacro(bindings, m.id);
                  const taken = takenSlots(m.id);
                  const isEditing = editingId === m.id;
                  return (
                    <li
                      key={m.id}
                      className="macro-item"
                      data-testid={`macro-item-${m.id}`}
                    >
                      <div className="macro-item-row">
                        <div className="macro-item-meta">
                          <div className="macro-item-name">{m.name}</div>
                          <div className="macro-item-sub">
                            {m.events.length} 件 · {formatTimestamp(m.createdAt)}
                            {boundSlot !== null && (
                              <span className="macro-badge">
                                {slotLabel(boundSlot)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="macro-item-actions">
                          <label className="macro-shortcut-label">
                            ショートカット
                            <select
                              className="macro-select"
                              value={boundSlot ?? ""}
                              onChange={(e) =>
                                handleAssignShortcut(m.id, e.target.value)
                              }
                              disabled={recording || playing}
                              aria-label={`「${m.name}」のショートカット`}
                            >
                              <option value="">なし</option>
                              {MACRO_SHORTCUT_SLOTS.map((slot) => (
                                <option
                                  key={slot}
                                  value={slot}
                                  disabled={taken.has(slot)}
                                >
                                  {slotLabel(slot)}
                                  {taken.has(slot) ? "（使用中）" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="macro-btn"
                            onClick={() =>
                              isEditing
                                ? handleCloseEditor()
                                : handleOpenEditor(m)
                            }
                            disabled={recording || playing}
                          >
                            {isEditing ? "編集を閉じる" : "スクリプト編集"}
                          </button>
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
                      </div>
                      {isEditing && (
                        <div className="macro-dsl-editor">
                          <textarea
                            className="macro-dsl-textarea"
                            value={dslText}
                            onChange={(e) => handleDslChange(e.target.value)}
                            spellCheck={false}
                            rows={Math.max(6, dslText.split("\n").length + 1)}
                            aria-label={`「${m.name}」のスクリプト`}
                          />
                          {dslErrors.length > 0 ? (
                            <div role="alert">
                              <ul className="macro-dsl-errors">
                                {dslErrors.map((err, i) => (
                                  <li key={i}>{err}</li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="macro-dsl-ok">
                              構文 OK
                              {dslEvents
                                ? ` · ${dslEvents.length} ステートメント`
                                : ""}
                            </p>
                          )}
                          <div className="macro-dsl-actions">
                            <button
                              type="button"
                              className="macro-btn macro-btn--primary"
                              onClick={handleSaveDsl}
                              disabled={dslErrors.length > 0}
                            >
                              スクリプトを保存
                            </button>
                            <button
                              type="button"
                              className="macro-btn"
                              onClick={handleCloseEditor}
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
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
