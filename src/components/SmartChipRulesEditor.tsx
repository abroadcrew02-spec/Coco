// Custom smart-chip rule CRUD (#185). Embedded in SettingsDialog as a
// section. Lets the user define "regex pattern → action URL template"
// rules that the smart-chip detector applies in-grid. Fully local —
// rules persist to localStorage via customSmartChipRules.ts.
//
// The editor is intentionally form-driven: a single draft row at the
// bottom for "add", and per-row inline editing for existing rules. We
// validate on every change so the user sees ReDoS / scheme errors before
// they ever hit a hover.

import { useState } from "react";
import {
  type CustomSmartChipRule,
  type RuleValidationError,
  ALLOWED_FLAGS,
  addCustomRule,
  deleteCustomRule,
  loadCustomRules,
  toggleCustomRule,
  updateCustomRule,
  validateRule,
} from "../store/customSmartChipRules";

const ERROR_MESSAGES: Record<RuleValidationError, string> = {
  EMPTY_PATTERN: "正規表現パターンを入力してください。",
  PATTERN_TOO_LONG: "パターンが長すぎます（200 文字以内）。",
  REDOS_RISK:
    "危険なパターンです。(a+)+ のようなネストした量化子は処理が爆発するため使用できません。",
  INVALID_REGEX: "正規表現として解釈できません。構文を確認してください。",
  INVALID_FLAGS: `フラグは ${ALLOWED_FLAGS.join(", ")} のみ使用できます。`,
  EMPTY_NAME: "名前を入力してください。",
  EMPTY_TEMPLATE: "アクション URL テンプレートを入力してください。",
  TEMPLATE_NOT_HTTP: "URL テンプレートは http:// または https:// で始めてください。",
};

interface DraftFields {
  name: string;
  pattern: string;
  flags: string;
  urlTemplate: string;
}

const EMPTY_DRAFT: DraftFields = {
  name: "",
  pattern: "",
  flags: "",
  urlTemplate: "",
};

export default function SmartChipRulesEditor() {
  const [rules, setRules] = useState<CustomSmartChipRule[]>(() =>
    loadCustomRules(),
  );
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<RuleValidationError | null>(null);
  // id of the rule currently in inline-edit mode, plus its working copy.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftFields>(EMPTY_DRAFT);
  const [editError, setEditError] = useState<RuleValidationError | null>(null);

  const onAdd = () => {
    const result = addCustomRule(draft);
    if (!result.ok) {
      setDraftError(result.error);
      return;
    }
    setRules(loadCustomRules());
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
  };

  const onDelete = (id: string) => {
    setRules(deleteCustomRule(id));
    if (editingId === id) setEditingId(null);
  };

  const onToggle = (id: string) => {
    setRules(toggleCustomRule(id));
  };

  const startEdit = (rule: CustomSmartChipRule) => {
    setEditingId(rule.id);
    setEditDraft({
      name: rule.name,
      pattern: rule.pattern,
      flags: rule.flags,
      urlTemplate: rule.urlTemplate,
    });
    setEditError(null);
  };

  const saveEdit = () => {
    if (!editingId) return;
    const result = updateCustomRule(editingId, editDraft);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    setRules(result.rules);
    setEditingId(null);
    setEditError(null);
  };

  // A draft is submittable only when it passes full validation — keeps the
  // "追加" button honest so the user can't queue an invalid rule.
  const draftValid = validateRule(draft).ok;

  return (
    <div className="scr-editor">
      <p className="settings-hint">
        セル内のテキストにマッチする正規表現と、開く URL のテンプレートを定義します。
        <code>$0</code> はマッチ全体、<code>$1</code>〜<code>$9</code>{" "}
        はキャプチャグループに置換されます。例: パターン{" "}
        <code>JIRA-\d+</code> → URL{" "}
        <code>https://my.atlassian.net/browse/$0</code>。すべてローカルに保存され、外部送信はありません。
      </p>

      {rules.length > 0 && (
        <ul className="scr-list">
          {rules.map((rule) => (
            <li key={rule.id} className="scr-row">
              {editingId === rule.id ? (
                <div className="scr-form">
                  <input
                    className="scr-input"
                    placeholder="名前"
                    value={editDraft.name}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, name: e.target.value })
                    }
                  />
                  <input
                    className="scr-input scr-input--mono"
                    placeholder="正規表現パターン"
                    value={editDraft.pattern}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, pattern: e.target.value })
                    }
                  />
                  <input
                    className="scr-input scr-input--flags"
                    placeholder="フラグ (imsu)"
                    value={editDraft.flags}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, flags: e.target.value })
                    }
                  />
                  <input
                    className="scr-input scr-input--mono"
                    placeholder="https://.../$0"
                    value={editDraft.urlTemplate}
                    onChange={(e) =>
                      setEditDraft({
                        ...editDraft,
                        urlTemplate: e.target.value,
                      })
                    }
                  />
                  {editError && (
                    <p className="scr-error">{ERROR_MESSAGES[editError]}</p>
                  )}
                  <div className="scr-form-actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn--primary"
                      onClick={saveEdit}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="settings-btn"
                      onClick={() => {
                        setEditingId(null);
                        setEditError(null);
                      }}
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : (
                <div className="scr-row-view">
                  <label className="scr-toggle" title="有効 / 無効">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => onToggle(rule.id)}
                    />
                  </label>
                  <div className="scr-row-text">
                    <span
                      className={
                        "scr-name" + (rule.enabled ? "" : " scr-name--off")
                      }
                    >
                      {rule.name}
                    </span>
                    <code className="scr-meta">
                      /{rule.pattern}/{rule.flags} → {rule.urlTemplate}
                    </code>
                  </div>
                  <div className="scr-row-actions">
                    <button
                      type="button"
                      className="settings-btn"
                      onClick={() => startEdit(rule)}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className="settings-btn"
                      onClick={() => onDelete(rule.id)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="scr-form scr-form--add">
        <input
          className="scr-input"
          placeholder="名前 (例: JIRA チケット)"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          className="scr-input scr-input--mono"
          placeholder="正規表現パターン (例: JIRA-\d+)"
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
        />
        <input
          className="scr-input scr-input--flags"
          placeholder="フラグ (imsu)"
          value={draft.flags}
          onChange={(e) => setDraft({ ...draft, flags: e.target.value })}
        />
        <input
          className="scr-input scr-input--mono"
          placeholder="https://.../$0"
          value={draft.urlTemplate}
          onChange={(e) => setDraft({ ...draft, urlTemplate: e.target.value })}
        />
        {draftError && (
          <p className="scr-error">{ERROR_MESSAGES[draftError]}</p>
        )}
        <div className="scr-form-actions">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={onAdd}
            disabled={!draftValid}
          >
            ルールを追加
          </button>
        </div>
      </div>
    </div>
  );
}
