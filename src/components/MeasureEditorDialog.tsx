import { useEffect, useState } from "react";
import type { StoredMeasure } from "../store/cocoDataModel";
import "./MeasureEditorDialog.css";

interface Props {
  /** Existing measure when editing; undefined when creating new. */
  initialMeasure?: StoredMeasure;
  /** Tables available for the tableId dropdown. Workbook tables. */
  tables: Array<{ id: string; name: string }>;
  /** Existing measure names — for unique-name validation. */
  existingNames: string[];
  onApply: (measure: StoredMeasure) => void;
  onClose: () => void;
}

export default function MeasureEditorDialog({
  initialMeasure,
  tables,
  existingNames,
  onApply,
  onClose,
}: Props) {
  const isEditMode = initialMeasure !== undefined;

  const [name, setName] = useState(initialMeasure?.name ?? "");
  const [tableId, setTableId] = useState(
    initialMeasure?.tableId ?? (tables.length > 0 ? tables[0].id : ""),
  );
  const [expression, setExpression] = useState(initialMeasure?.expression ?? "");
  const [format, setFormat] = useState(initialMeasure?.format ?? "");
  const [description, setDescription] = useState(initialMeasure?.description ?? "");
  const [error, setError] = useState<string | null>(null);

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

  const validate = (): string | null => {
    if (!name.trim()) return "名前は必須です";
    const lower = name.trim().toLowerCase();
    const conflict = existingNames.some(
      (n) =>
        n.toLowerCase() === lower &&
        // When editing, allow the measure's own current name
        n.toLowerCase() !== (initialMeasure?.name ?? "").toLowerCase(),
    );
    if (conflict) return "名前は既に使われています";
    if (tables.length === 0) return "テーブルが必要です（先にデータモデルを作成してください）";
    if (!expression.trim()) return "DAX 式は必須です";
    return null;
  };

  const submit = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const measure: StoredMeasure = {
      id: isEditMode ? initialMeasure!.id : crypto.randomUUID(),
      name: name.trim(),
      tableId,
      expression: expression.trim(),
    };
    if (format.trim()) measure.format = format.trim();
    if (description.trim()) measure.description = description.trim();
    onApply(measure);
    onClose();
  };

  const hasNoTables = tables.length === 0;

  return (
    <div className="med-backdrop" onClick={onClose}>
      <div
        className="med-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="med-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="med-header">
          <h2 id="med-title" className="med-title">
            {isEditMode ? "メジャーの編集" : "メジャーの新規作成"}
          </h2>
          <button type="button" className="med-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="med-body">
          <label className="med-field">
            <span className="med-field-label">名前</span>
            <input
              type="text"
              className="med-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: Total Sales"
              aria-required="true"
              autoFocus
            />
          </label>
          <label className="med-field">
            <span className="med-field-label">テーブル</span>
            {hasNoTables ? (
              <select className="med-select" disabled aria-required="true">
                <option>(none)</option>
              </select>
            ) : (
              <select
                className="med-select"
                value={tableId}
                onChange={(e) => setTableId(e.target.value)}
                aria-required="true"
              >
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="med-field">
            <span className="med-field-label">DAX 式</span>
            <textarea
              className="med-textarea"
              rows={5}
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
              placeholder="例: SUM(Sales[Amount])"
              aria-required="true"
            />
          </label>
          <label className="med-field">
            <span className="med-field-label">書式コード（省略可）</span>
            <input
              type="text"
              className="med-input"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              placeholder="例: #,##0.00"
            />
          </label>
          <label className="med-field">
            <span className="med-field-label">説明（省略可）</span>
            <input
              type="text"
              className="med-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="このメジャーの説明"
            />
          </label>
          {error && <p className="med-error">{error}</p>}
        </div>
        <footer className="med-footer">
          <div className="med-footer-actions">
            <button type="button" className="med-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="med-btn med-btn--primary" onClick={submit}>
              {isEditMode ? "更新" : "作成"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
