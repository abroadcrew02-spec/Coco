import { useEffect, useMemo, useState } from "react";
import {
  BUILTIN_LISTS,
  type CustomList,
  generateListId,
  loadCustomLists,
  saveCustomLists,
} from "../store/customLists";
import "./CustomListsDialog.css";

interface Props {
  /** A1 reference of the cell/range the user had selected when invoking the
   *  dialog. Used as the default target for the "適用" button. */
  initialActiveRange: string;
  /** Called when the user clicks 適用. The parent is expected to write
   *  `items` into the snapshot starting at the top-left of `range`. */
  onApplyToRange: (range: string, items: string[]) => void;
  onClose: () => void;
}

type EditorEntry = CustomList & { builtin: boolean };

// Combine built-ins + user lists into a single uniform model the dialog can
// render. Built-ins are flagged so the UI can disable mutation/deletion.
function combineLists(user: CustomList[]): EditorEntry[] {
  const builtinEntries: EditorEntry[] = BUILTIN_LISTS.map((l) => ({
    ...l,
    builtin: true,
  }));
  const userEntries: EditorEntry[] = user.map((l) => ({ ...l, builtin: false }));
  return [...builtinEntries, ...userEntries];
}

export default function CustomListsDialog({
  initialActiveRange,
  onApplyToRange,
  onClose,
}: Props) {
  const [entries, setEntries] = useState<EditorEntry[]>(() =>
    combineLists(loadCustomLists()),
  );
  const [selectedId, setSelectedId] = useState<string>(
    () => entries[0]?.id ?? "",
  );
  const [itemsText, setItemsText] = useState<string>(() => {
    const first = entries[0];
    return first ? first.items.join("\n") : "";
  });
  const [nameText, setNameText] = useState<string>(() => entries[0]?.name ?? "");
  const [applyRange, setApplyRange] = useState<string>(initialActiveRange || "A1");

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  // Sync the right-pane editors whenever the selection moves between lists.
  // Built-ins read-only; user lists become editable on selection.
  useEffect(() => {
    if (selectedEntry) {
      setItemsText(selectedEntry.items.join("\n"));
      setNameText(selectedEntry.name);
    } else {
      setItemsText("");
      setNameText("");
    }
  }, [selectedId, selectedEntry]);

  // Escape to dismiss — matches SettingsDialog's behaviour.
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

  const isBuiltin = selectedEntry?.builtin ?? false;

  // Commit the right-pane edits back into `entries` (in-memory only).
  // Triggered on every keystroke so the persisted state mirrors the editor
  // without an explicit "OK" per-list — Excel's dialog behaves the same way.
  const commitDraft = (nextName: string, nextItemsText: string) => {
    if (!selectedEntry || selectedEntry.builtin) return;
    const items = nextItemsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setEntries((prev) =>
      prev.map((e) =>
        e.id === selectedEntry.id
          ? { ...e, name: nextName.trim() || e.name, items }
          : e,
      ),
    );
  };

  const handleNameChange = (v: string) => {
    setNameText(v);
    commitDraft(v, itemsText);
  };

  const handleItemsChange = (v: string) => {
    setItemsText(v);
    commitDraft(nameText, v);
  };

  const handleAddList = () => {
    const id = generateListId();
    const fresh: EditorEntry = {
      id,
      name: "新規リスト",
      items: [],
      builtin: false,
    };
    setEntries((prev) => [...prev, fresh]);
    setSelectedId(id);
  };

  const handleDeleteList = () => {
    if (!selectedEntry || selectedEntry.builtin) return;
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== selectedEntry.id);
      // Move selection to the first remaining entry so the right pane
      // doesn't go blank in an awkward way.
      setSelectedId(next[0]?.id ?? "");
      return next;
    });
  };

  const handleSave = () => {
    const userOnly = entries
      .filter((e) => !e.builtin)
      .map<CustomList>(({ id, name, items }) => ({ id, name, items }));
    saveCustomLists(userOnly);
    onClose();
  };

  const handleApply = () => {
    if (!selectedEntry) return;
    if (selectedEntry.items.length === 0) return;
    const range = applyRange.trim();
    if (!range) return;
    onApplyToRange(range, selectedEntry.items);
    // Don't close on apply — Excel keeps the dialog open so the user can
    // tweak the list and re-apply. The user can still hit 閉じる/Escape.
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal custom-lists-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-lists-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="custom-lists-title" className="settings-title">
            ユーザー設定リスト / Custom Lists
          </h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="custom-lists-body">
          <aside className="custom-lists-sidebar" aria-label="リスト一覧">
            <ul className="custom-lists-list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={
                      "custom-lists-list-item" +
                      (entry.id === selectedId
                        ? " custom-lists-list-item--active"
                        : "")
                    }
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span className="custom-lists-list-name">{entry.name}</span>
                    {entry.builtin && (
                      <span className="custom-lists-badge">組み込み</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="custom-lists-sidebar-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={handleAddList}
              >
                + 新規リスト
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={handleDeleteList}
                disabled={isBuiltin || !selectedEntry}
                title={isBuiltin ? "組み込みリストは削除できません" : undefined}
              >
                削除
              </button>
            </div>
          </aside>
          <section className="custom-lists-editor" aria-label="リスト編集">
            <label className="custom-lists-field">
              <span className="custom-lists-label">リスト名</span>
              <input
                type="text"
                className="custom-lists-input"
                value={nameText}
                disabled={isBuiltin || !selectedEntry}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="例: 四半期 / Quarters"
              />
            </label>
            <label className="custom-lists-field custom-lists-field--grow">
              <span className="custom-lists-label">
                リスト項目 (1 行 1 項目)
              </span>
              <textarea
                className="custom-lists-textarea"
                value={itemsText}
                disabled={isBuiltin || !selectedEntry}
                onChange={(e) => handleItemsChange(e.target.value)}
                placeholder={
                  "Q1\nQ2\nQ3\nQ4"
                }
                rows={12}
                spellCheck={false}
              />
            </label>
            <fieldset className="custom-lists-apply">
              <legend>選択範囲に適用</legend>
              <p className="settings-hint">
                指定範囲の左上セルから順にリスト項目を書き込みます。範囲がリスト項目数より長い場合は折り返します。
              </p>
              <label className="custom-lists-field custom-lists-field--inline">
                <span className="custom-lists-label">適用先 (A1 形式)</span>
                <input
                  type="text"
                  className="custom-lists-input custom-lists-input--range"
                  value={applyRange}
                  onChange={(e) => setApplyRange(e.target.value)}
                  placeholder="A1:A10"
                />
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  onClick={handleApply}
                  disabled={
                    !selectedEntry ||
                    selectedEntry.items.length === 0 ||
                    !applyRange.trim()
                  }
                >
                  適用
                </button>
              </label>
            </fieldset>
          </section>
        </div>
        <footer className="settings-footer">
          <button type="button" className="settings-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={handleSave}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
