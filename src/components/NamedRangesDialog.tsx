import { useMemo, useRef, useState } from "react";
import { t } from "../i18n/locale";
import { useFocusTrap } from "../hooks/useFocusTrap";
import "./NamedRangesDialog.css";

export interface NamedRangeEntry {
  name: string;
  formula: string;
  scope?: string;
}

interface Props {
  initialRanges: NamedRangeEntry[];
  onSave: (next: NamedRangeEntry[]) => void;
  onClose: () => void;
}

// Excel-style valid name: starts with letter/underscore, alphanumerics + underscore.
// We intentionally keep this narrow (ASCII only) — full Excel rules allow CJK
// and dots, but the round-trip on the Rust side only re-emits names that
// rust_xlsxwriter accepts, so we don't widen prematurely.
const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A few sentinels Excel reserves outright; this is not exhaustive but covers
// the most common collisions users hit by accident.
const RESERVED_NAMES = new Set([
  "R",
  "C",
  "TRUE",
  "FALSE",
  "Print_Area",
  "Print_Titles",
  "_xlnm.Print_Area",
  "_xlnm.Print_Titles",
]);

function validate(
  name: string,
  formula: string,
  others: NamedRangeEntry[],
  editingOriginalName: string | null,
): string | null {
  const trimmedName = name.trim();
  const trimmedFormula = formula.trim();
  if (!trimmedName) return "名前は必須です";
  if (!VALID_NAME_RE.test(trimmedName))
    return "名前は英字またはアンダースコアで始まり、英数字のみ使用できます";
  if (RESERVED_NAMES.has(trimmedName) || RESERVED_NAMES.has(trimmedName.toUpperCase()))
    return "この名前は Excel で予約されています";
  if (!trimmedFormula) return "数式は必須です";
  if (!trimmedFormula.startsWith("="))
    return "数式は = で始める必要があります（例: =Sheet1!$A$1）";
  // Uniqueness: case-insensitive (Excel matches names that way) and only when the
  // user-entered name differs from the one they were originally editing.
  const lower = trimmedName.toLowerCase();
  for (const other of others) {
    if (editingOriginalName !== null && other.name === editingOriginalName) continue;
    if (other.name.toLowerCase() === lower) return "同じ名前が既に存在します";
  }
  return null;
}

export default function NamedRangesDialog({ initialRanges, onSave, onClose }: Props) {
  // Working copy of the list — only flushed to onSave when the user clicks 適用.
  const [ranges, setRanges] = useState<NamedRangeEntry[]>(() =>
    initialRanges.map((r) => ({ ...r })),
  );
  // Form state: when editingIndex === -1 we're adding; null means the form is closed.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formName, setFormName] = useState("");
  const [formFormula, setFormFormula] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, onClose);

  const isDirty = useMemo(() => {
    if (ranges.length !== initialRanges.length) return true;
    for (let i = 0; i < ranges.length; i++) {
      const a = ranges[i];
      const b = initialRanges[i];
      if (a.name !== b.name || a.formula !== b.formula || (a.scope ?? "") !== (b.scope ?? ""))
        return true;
    }
    return false;
  }, [ranges, initialRanges]);

  const openAddForm = () => {
    setEditingIndex(-1);
    setFormName("");
    setFormFormula("=");
    setFormError(null);
  };

  const openEditForm = (idx: number) => {
    const r = ranges[idx];
    setEditingIndex(idx);
    setFormName(r.name);
    setFormFormula(r.formula);
    setFormError(null);
  };

  const cancelForm = () => {
    setEditingIndex(null);
    setFormError(null);
  };

  const submitForm = () => {
    if (editingIndex === null) return;
    const isAdding = editingIndex === -1;
    const originalName = isAdding ? null : ranges[editingIndex].name;
    const err = validate(formName, formFormula, ranges, originalName);
    if (err) {
      setFormError(err);
      return;
    }
    const entry: NamedRangeEntry = {
      name: formName.trim(),
      formula: formFormula.trim(),
    };
    if (isAdding) {
      setRanges([...ranges, entry]);
    } else {
      const next = ranges.slice();
      // Preserve the existing scope (we don't expose a scope editor in this minimal cut).
      const scope = ranges[editingIndex].scope;
      next[editingIndex] = scope ? { ...entry, scope } : entry;
      setRanges(next);
    }
    setEditingIndex(null);
    setFormError(null);
  };

  const deleteRange = (idx: number) => {
    setRanges(ranges.filter((_, i) => i !== idx));
    // If we were editing the same row, dismiss the form.
    if (editingIndex === idx) {
      setEditingIndex(null);
    }
  };

  const apply = () => {
    onSave(ranges);
    onClose();
  };

  return (
    <div className="nr-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="nr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nr-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="nr-header">
          <h2 id="nr-title" className="nr-title">{t("dialog.namedRanges")}</h2>
          <button
            type="button"
            className="nr-close"
            onClick={onClose}
            aria-label={t("a11y.label.closeDialog")}
          >
            ×
          </button>
        </header>
        <div className="nr-body">
          {ranges.length === 0 ? (
            <p className="nr-empty">名前付き範囲はまだ登録されていません。</p>
          ) : (
            <ul className="nr-list" aria-label="登録済みの名前付き範囲">
              {ranges.map((r, idx) => (
                <li key={`${r.name}-${idx}`} className="nr-item">
                  <div className="nr-item-text">
                    <span className="nr-item-name">{r.name}</span>
                    <span className="nr-item-formula">{r.formula}</span>
                    {r.scope && <span className="nr-item-scope">範囲: {r.scope}</span>}
                  </div>
                  <div className="nr-item-actions">
                    <button
                      type="button"
                      className="nr-btn"
                      onClick={() => openEditForm(idx)}
                      aria-label={`${r.name} を編集`}
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      className="nr-btn nr-btn--danger"
                      onClick={() => deleteRange(idx)}
                      aria-label={`${r.name} を削除`}
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {editingIndex === null ? (
            <button type="button" className="nr-btn nr-btn--add" onClick={openAddForm}>
              + 追加
            </button>
          ) : (
            <div className="nr-form" role="group" aria-label="名前付き範囲の編集フォーム">
              <h3 className="nr-form-title">
                {editingIndex === -1 ? "新しい名前付き範囲" : "名前付き範囲を編集"}
              </h3>
              <label className="nr-field">
                <span className="nr-field-label">名前</span>
                <input
                  type="text"
                  className="nr-input"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="MyRange"
                  autoFocus
                />
              </label>
              <label className="nr-field">
                <span className="nr-field-label">数式 / 参照</span>
                <input
                  type="text"
                  className="nr-input"
                  value={formFormula}
                  onChange={(e) => setFormFormula(e.target.value)}
                  placeholder="=Sheet1!$A$1"
                />
              </label>
              {formError && <p className="nr-error">{formError}</p>}
              <div className="nr-form-actions">
                <button type="button" className="nr-btn" onClick={cancelForm}>
                  キャンセル
                </button>
                <button
                  type="button"
                  className="nr-btn nr-btn--primary"
                  onClick={submitForm}
                >
                  {editingIndex === -1 ? "追加" : "更新"}
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="nr-footer">
          <p className="nr-hint">
            Excel の名前付き範囲を編集します。Ctrl+F3 で開けます。範囲（ワークブック/シート）の選択は今回のリリースでは未対応です。
          </p>
          <div className="nr-footer-actions">
            <button type="button" className="nr-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="nr-btn nr-btn--primary"
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
