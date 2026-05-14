import { useEffect, useMemo, useState } from "react";
import "./DataValidationDialog.css";

// Mirrors the per-sheet `_dataValidations[]` entry shape the Rust side writes
// into the snapshot (xlsx_io.rs ~3950). Only the fields the dialog can edit
// are typed strictly; extras (showErrorMessage, errorStyle, prompt*) are kept
// as a passthrough bag so we don't drop them on round-trip.
export interface DataValidationEntry {
  sqref: string;
  type?: string;
  operator?: string;
  formula1?: string;
  formula2?: string;
  allowBlank?: boolean;
  errorTitle?: string;
  errorMessage?: string;
  // Passthrough fields preserved verbatim across the dialog edit.
  [k: string]: unknown;
}

interface Props {
  initialRules: DataValidationEntry[];
  sheetName: string;
  onSave: (next: DataValidationEntry[]) => void;
  onClose: () => void;
}

// Validation types supported by the export side. `whole` / `decimal` /
// `textLength` / `date` use formula1+formula2 with an operator; `list` uses
// formula1 as the source (either a comma list "Yes,No" or "=Sheet1!$A$1:$A$3").
const TYPES = [
  { value: "list", label: "リスト (list)" },
  { value: "whole", label: "整数 (whole)" },
  { value: "decimal", label: "小数 (decimal)" },
  { value: "date", label: "日付 (date)" },
  { value: "textLength", label: "文字数 (textLength)" },
] as const;

const OPERATORS = [
  { value: "between", label: "の間" },
  { value: "notBetween", label: "の外" },
  { value: "equal", label: "等しい" },
  { value: "notEqual", label: "等しくない" },
  { value: "greaterThan", label: "より大きい" },
  { value: "lessThan", label: "より小さい" },
  { value: "greaterThanOrEqual", label: "以上" },
  { value: "lessThanOrEqual", label: "以下" },
] as const;

// Excel sqref accepts space-separated A1 ranges, e.g. "A1:A10 C1:C5" or a
// single cell like "B2". We accept a lax form because the export side is
// already tolerant — anything malformed is dropped silently downstream.
const SQREF_RE = /^[A-Za-z]+\d+(?::[A-Za-z]+\d+)?(?:\s+[A-Za-z]+\d+(?::[A-Za-z]+\d+)?)*$/;

const OPERATORS_WITH_TWO_FORMULAS = new Set(["between", "notBetween"]);

interface FormState {
  sqref: string;
  type: string;
  operator: string;
  formula1: string;
  formula2: string;
  allowBlank: boolean;
  errorTitle: string;
  errorMessage: string;
}

const EMPTY_FORM: FormState = {
  sqref: "",
  type: "list",
  operator: "between",
  formula1: "",
  formula2: "",
  allowBlank: false,
  errorTitle: "",
  errorMessage: "",
};

function entryToForm(e: DataValidationEntry): FormState {
  return {
    sqref: e.sqref ?? "",
    type: e.type ?? "list",
    operator: e.operator ?? "between",
    formula1: e.formula1 ?? "",
    formula2: e.formula2 ?? "",
    allowBlank: e.allowBlank === true,
    errorTitle: e.errorTitle ?? "",
    errorMessage: e.errorMessage ?? "",
  };
}

function formToEntry(form: FormState, original?: DataValidationEntry): DataValidationEntry {
  // Start from the original so passthrough fields (showErrorMessage,
  // promptTitle, etc.) survive an edit cycle untouched.
  const out: DataValidationEntry = { ...(original ?? {}), sqref: form.sqref.trim() };
  if (form.type) out.type = form.type;
  else delete out.type;
  // `list` doesn't carry an operator (between/etc only apply to numeric/date).
  if (form.type !== "list" && form.operator) out.operator = form.operator;
  else delete out.operator;
  if (form.formula1) out.formula1 = form.formula1;
  else delete out.formula1;
  // formula2 only matters for the two-bound operators on numeric/date/textLength.
  if (form.type !== "list" && OPERATORS_WITH_TWO_FORMULAS.has(form.operator) && form.formula2) {
    out.formula2 = form.formula2;
  } else {
    delete out.formula2;
  }
  if (form.allowBlank) out.allowBlank = true;
  else delete out.allowBlank;
  if (form.errorTitle) out.errorTitle = form.errorTitle;
  else delete out.errorTitle;
  if (form.errorMessage) out.errorMessage = form.errorMessage;
  else delete out.errorMessage;
  return out;
}

function validate(form: FormState): string | null {
  if (!form.sqref.trim()) return "適用範囲 (sqref) は必須です";
  if (!SQREF_RE.test(form.sqref.trim()))
    return "適用範囲は A1 形式で指定してください（例: A1:A10、または B2 C5）";
  if (!form.type) return "種類を選択してください";
  if (form.type === "list") {
    if (!form.formula1.trim()) return "リストの値または参照を入力してください";
  } else {
    if (!form.formula1.trim()) return "式または値 (formula1) は必須です";
    if (OPERATORS_WITH_TWO_FORMULAS.has(form.operator) && !form.formula2.trim())
      return "between / notBetween では formula2 も必須です";
  }
  return null;
}

function summarize(e: DataValidationEntry): string {
  if (e.type === "list") {
    return `リスト: ${e.formula1 ?? "(空)"}`;
  }
  const op = e.operator ?? "between";
  if (OPERATORS_WITH_TWO_FORMULAS.has(op)) {
    return `${e.type ?? "?"} ${op} ${e.formula1 ?? ""} / ${e.formula2 ?? ""}`;
  }
  return `${e.type ?? "?"} ${op} ${e.formula1 ?? ""}`;
}

export default function DataValidationDialog({
  initialRules,
  sheetName,
  onSave,
  onClose,
}: Props) {
  // Working copy — only flushed via onSave when the user clicks 適用.
  const [rules, setRules] = useState<DataValidationEntry[]>(() =>
    initialRules.map((r) => ({ ...r })),
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

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

  const isDirty = useMemo(() => {
    if (rules.length !== initialRules.length) return true;
    return JSON.stringify(rules) !== JSON.stringify(initialRules);
  }, [rules, initialRules]);

  const openAddForm = () => {
    setEditingIndex(-1);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const openEditForm = (idx: number) => {
    setEditingIndex(idx);
    setForm(entryToForm(rules[idx]));
    setFormError(null);
  };

  const cancelForm = () => {
    setEditingIndex(null);
    setFormError(null);
  };

  const submitForm = () => {
    if (editingIndex === null) return;
    const err = validate(form);
    if (err) {
      setFormError(err);
      return;
    }
    const isAdding = editingIndex === -1;
    if (isAdding) {
      setRules([...rules, formToEntry(form)]);
    } else {
      const next = rules.slice();
      next[editingIndex] = formToEntry(form, rules[editingIndex]);
      setRules(next);
    }
    setEditingIndex(null);
    setFormError(null);
  };

  const deleteRule = (idx: number) => {
    setRules(rules.filter((_, i) => i !== idx));
    if (editingIndex === idx) setEditingIndex(null);
  };

  const apply = () => {
    onSave(rules);
    onClose();
  };

  const showOperator = form.type !== "list";
  const showFormula2 = showOperator && OPERATORS_WITH_TWO_FORMULAS.has(form.operator);

  return (
    <div className="dv-backdrop" onClick={onClose}>
      <div
        className="dv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dv-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dv-header">
          <h2 id="dv-title" className="dv-title">
            データの入力規則 — {sheetName}
          </h2>
          <button type="button" className="dv-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="dv-body">
          {rules.length === 0 ? (
            <p className="dv-empty">このシートには入力規則がまだ登録されていません。</p>
          ) : (
            <ul className="dv-list" aria-label="登録済みの入力規則">
              {rules.map((r, idx) => (
                <li key={idx} className="dv-item">
                  <div className="dv-item-text">
                    <span className="dv-item-sqref">{r.sqref}</span>
                    <span className="dv-item-summary">{summarize(r)}</span>
                  </div>
                  <div className="dv-item-actions">
                    <button
                      type="button"
                      className="dv-btn"
                      onClick={() => openEditForm(idx)}
                      aria-label={`${r.sqref} の規則を編集`}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className="dv-btn dv-btn--danger"
                      onClick={() => deleteRule(idx)}
                      aria-label={`${r.sqref} の規則を削除`}
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {editingIndex === null ? (
            <button type="button" className="dv-btn dv-btn--add" onClick={openAddForm}>
              + 追加
            </button>
          ) : (
            <div className="dv-form" role="group" aria-label="入力規則の編集フォーム">
              <h3 className="dv-form-title">
                {editingIndex === -1 ? "新しい入力規則" : "入力規則を編集"}
              </h3>
              <label className="dv-field">
                <span className="dv-field-label">適用範囲 (sqref)</span>
                <input
                  type="text"
                  className="dv-input"
                  value={form.sqref}
                  onChange={(e) => setForm({ ...form, sqref: e.target.value })}
                  placeholder="A1:A10"
                  autoFocus
                />
              </label>
              <label className="dv-field">
                <span className="dv-field-label">種類</span>
                <select
                  className="dv-input"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              {showOperator && (
                <label className="dv-field">
                  <span className="dv-field-label">演算子</span>
                  <select
                    className="dv-input"
                    value={form.operator}
                    onChange={(e) => setForm({ ...form, operator: e.target.value })}
                  >
                    {OPERATORS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label} ({o.value})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="dv-field">
                <span className="dv-field-label">
                  {form.type === "list" ? "リストの値 / 参照" : "値または式 (formula1)"}
                </span>
                <input
                  type="text"
                  className="dv-input"
                  value={form.formula1}
                  onChange={(e) => setForm({ ...form, formula1: e.target.value })}
                  placeholder={
                    form.type === "list" ? '"Yes,No,Maybe" または =Sheet1!$A$1:$A$3' : "10"
                  }
                />
              </label>
              {showFormula2 && (
                <label className="dv-field">
                  <span className="dv-field-label">上限値または式 (formula2)</span>
                  <input
                    type="text"
                    className="dv-input"
                    value={form.formula2}
                    onChange={(e) => setForm({ ...form, formula2: e.target.value })}
                    placeholder="100"
                  />
                </label>
              )}
              <label className="dv-field dv-field--inline">
                <input
                  type="checkbox"
                  checked={form.allowBlank}
                  onChange={(e) => setForm({ ...form, allowBlank: e.target.checked })}
                />
                <span className="dv-field-label">空白を許可する</span>
              </label>
              <label className="dv-field">
                <span className="dv-field-label">エラータイトル</span>
                <input
                  type="text"
                  className="dv-input"
                  value={form.errorTitle}
                  onChange={(e) => setForm({ ...form, errorTitle: e.target.value })}
                  placeholder="入力エラー"
                />
              </label>
              <label className="dv-field">
                <span className="dv-field-label">エラーメッセージ</span>
                <textarea
                  className="dv-input dv-textarea"
                  value={form.errorMessage}
                  onChange={(e) => setForm({ ...form, errorMessage: e.target.value })}
                  placeholder="許可された値を入力してください。"
                  rows={2}
                />
              </label>
              {formError && <p className="dv-error">{formError}</p>}
              <div className="dv-form-actions">
                <button type="button" className="dv-btn" onClick={cancelForm}>
                  キャンセル
                </button>
                <button type="button" className="dv-btn dv-btn--primary" onClick={submitForm}>
                  {editingIndex === -1 ? "追加" : "更新"}
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="dv-footer">
          <p className="dv-hint">
            入力規則はスナップショットに直接書き込まれ、xlsx エクスポート時に再エクスポートされます。シート切替後の反映は次の保存時です。
          </p>
          <div className="dv-footer-actions">
            <button type="button" className="dv-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="dv-btn dv-btn--primary"
              onClick={apply}
              disabled={!isDirty}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
