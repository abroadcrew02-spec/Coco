import { useEffect, useRef, useState } from "react";
import type { CocoDataModel, StoredCalculatedColumn } from "../store/cocoDataModel";
import { evaluateTransientCalculatedColumn } from "../store/cocoDataModel";
import { CALC_COLUMN_ERROR, DAX_FUNCTION_REFERENCE, parseDaxSafe } from "../store/daxEngine";
import { useDaxAutocomplete } from "./useDaxAutocomplete";
import DaxColumnRefChips from "./DaxColumnRefChips";
import DaxFunctionChips from "./DaxFunctionChips";
import "./CalculatedColumnEditorDialog.css";

interface ExistingPair {
  tableId: string;
  columnName: string;
}

interface Props {
  /** Existing column when editing; undefined when creating new. */
  initialColumn?: StoredCalculatedColumn;
  /** Tables available for the tableId dropdown. Workbook tables. */
  tables: Array<{ id: string; name: string }>;
  /** Existing (tableId, columnName) pairs for uniqueness validation. */
  existingPairs: ExistingPair[];
  /** Full data model — used for the live-preview evaluation. */
  cocoModel?: CocoDataModel;
  onApply: (col: StoredCalculatedColumn) => void;
  onClose: () => void;
}

export default function CalculatedColumnEditorDialog({
  initialColumn,
  tables,
  existingPairs,
  cocoModel,
  onApply,
  onClose,
}: Props) {
  const isEditMode = initialColumn !== undefined;

  const [name, setName] = useState(initialColumn?.name ?? "");
  const [columnName, setColumnName] = useState(initialColumn?.columnName ?? "");
  const [tableId, setTableId] = useState(
    initialColumn?.tableId ?? (tables.length > 0 ? tables[0].id : ""),
  );
  const [expression, setExpression] = useState(initialColumn?.expression ?? "");
  const [format, setFormat] = useState(initialColumn?.format ?? "");
  const [description, setDescription] = useState(initialColumn?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ values: unknown[]; hasError: boolean } | null>(null);
  const [parseError, setParseError] = useState<{ message: string; offset?: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Parse-error tracking — runs on every expression change.
  useEffect(() => {
    if (!expression.trim()) {
      setParseError(null);
      return;
    }
    const result = parseDaxSafe(expression.trim());
    setParseError(result.error ?? null);
  }, [expression]);

  const handleChipInsert = (insertText: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? expression.length;
    const textWithoutCaret = insertText.replace("|", "");
    const caretOffset = insertText.indexOf("|");
    const newExpression =
      expression.slice(0, start) + textWithoutCaret + expression.slice(start);
    setExpression(newExpression);
    requestAnimationFrame(() => {
      textarea.focus();
      const newPos = start + (caretOffset >= 0 ? caretOffset : textWithoutCaret.length);
      textarea.setSelectionRange(newPos, newPos);
    });
  };

  // Resolve the currently selected table name for column suggestions.
  const selectedTableName = tables.find((t) => t.id === tableId)?.name;

  const autocompleteTables = (cocoModel?.tables ?? []).map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({ name: c.name })),
  }));

  const autocomplete = useDaxAutocomplete({
    textareaRef,
    value: expression,
    onInsert: (newExpression, newCaret) => {
      setExpression(newExpression);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(newCaret, newCaret);
      });
    },
    functions: DAX_FUNCTION_REFERENCE,
    tables: autocompleteTables,
    contextTableName: selectedTableName,
  });

  // Live preview — debounced 300 ms.
  useEffect(() => {
    if (!expression.trim() || !cocoModel || !tableId) {
      setPreview(null);
      return;
    }
    const colPreviewName = columnName.trim() || "_preview_";
    const tid = setTimeout(() => {
      try {
        const values = evaluateTransientCalculatedColumn(cocoModel, {
          tableId,
          columnName: colPreviewName,
          expression: expression.trim(),
        });
        if (values === null) {
          setPreview(null);
          return;
        }
        const hasError = values.some((v) => v === CALC_COLUMN_ERROR);
        setPreview({ values, hasError });
      } catch {
        setPreview({ values: [CALC_COLUMN_ERROR], hasError: true });
      }
    }, 300);
    return () => clearTimeout(tid);
  }, [expression, tableId, columnName, cocoModel]);

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
    if (!columnName.trim()) return "列名は必須です";
    if (tables.length === 0) return "テーブルが必要です（先にデータモデルを作成してください）";
    if (!expression.trim()) return "DAX 式は必須です";

    // Check (tableId, columnName) uniqueness — exclude self when editing
    const colNameLower = columnName.trim().toLowerCase();
    const conflict = existingPairs.some((p) => {
      if (p.tableId !== tableId) return false;
      if (p.columnName.toLowerCase() !== colNameLower) return false;
      // When editing, allow the column's own current (tableId, columnName)
      if (
        isEditMode &&
        initialColumn!.tableId === tableId &&
        initialColumn!.columnName.toLowerCase() === colNameLower
      ) {
        return false;
      }
      return true;
    });
    if (conflict) return "この列名はすでに使われています";

    return null;
  };

  const submit = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const col: StoredCalculatedColumn = {
      id: isEditMode ? initialColumn!.id : crypto.randomUUID(),
      name: name.trim(),
      tableId,
      expression: expression.trim(),
      columnName: columnName.trim(),
    };
    if (format.trim()) col.format = format.trim();
    if (description.trim()) col.description = description.trim();
    onApply(col);
    onClose();
  };

  const hasNoTables = tables.length === 0;

  return (
    <div className="cced-backdrop" onClick={onClose}>
      <div
        className="cced-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cced-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cced-header">
          <h2 id="cced-title" className="cced-title">
            {isEditMode ? "計算列の編集" : "計算列の新規作成"}
          </h2>
          <button type="button" className="cced-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="cced-body">
          <label className="cced-field">
            <span className="cced-field-label">名前</span>
            <input
              type="text"
              className="cced-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: Full Name"
              aria-required="true"
              autoFocus
            />
          </label>
          <label className="cced-field">
            <span className="cced-field-label">列名</span>
            <input
              type="text"
              className="cced-input"
              value={columnName}
              onChange={(e) => setColumnName(e.target.value)}
              placeholder="例: FullName"
              aria-required="true"
            />
          </label>
          <label className="cced-field">
            <span className="cced-field-label">テーブル</span>
            {hasNoTables ? (
              <select className="cced-select" disabled aria-required="true">
                <option>(none)</option>
              </select>
            ) : (
              <select
                className="cced-select"
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
          <label className="cced-field">
            <span className="cced-field-label">DAX 式</span>
            <div className="dac-wrapper">
              <textarea
                ref={textareaRef}
                className="cced-textarea"
                rows={5}
                value={expression}
                onChange={(e) => {
                  setExpression(e.target.value);
                  autocomplete.handleChange(e);
                }}
                onKeyDown={autocomplete.handleKeyDown}
                placeholder={'例: [FirstName] & " " & [LastName]'}
                aria-required="true"
              />
              {autocomplete.dropdown}
            </div>
            <DaxFunctionChips onInsert={handleChipInsert} />
            <DaxColumnRefChips
              tables={cocoModel?.tables ?? []}
              onInsert={handleChipInsert}
            />
            {parseError !== null && (
              <div className="cced-parse-error" role="alert">
                {`構文エラー${parseError.offset !== undefined ? ` (${parseError.offset + 1} 文字目付近)` : ""}: ${parseError.message}`}
              </div>
            )}
            {preview !== null && (
              preview.hasError ? (
                parseError === null ? (
                  <div className="cced-preview cced-preview--error">{CALC_COLUMN_ERROR}</div>
                ) : null
              ) : (
                <div className="cced-preview">
                  プレビュー: <strong>[{preview.values.map((v) => String(v)).join(", ")}]</strong>
                </div>
              )
            )}
          </label>
          <label className="cced-field">
            <span className="cced-field-label">書式コード（省略可）</span>
            <input
              type="text"
              className="cced-input"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              placeholder="例: #,##0.00"
            />
          </label>
          <label className="cced-field">
            <span className="cced-field-label">説明（省略可）</span>
            <input
              type="text"
              className="cced-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="この計算列の説明"
            />
          </label>
          {error && <p className="cced-error">{error}</p>}
        </div>
        <footer className="cced-footer">
          <div className="cced-footer-actions">
            <button type="button" className="cced-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="cced-btn cced-btn--primary" onClick={submit}>
              {isEditMode ? "更新" : "作成"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
