import { useEffect, useMemo, useState } from "react";
import type { DataFormRow } from "../store/dataForm";
import "./DataFormDialog.css";

interface Props {
  /** Sheet-qualified or bare A1 range, shown in the dialog header for
   *  context (e.g. "Sheet1!A1:D20"). Purely informational. */
  range: string;
  /** One label per column in the range, in column order. */
  columnHeaders: string[];
  /** All data rows in the range (excluding header when applicable). Keyed
   *  by absolute column index (string). */
  initialRows: DataFormRow[];
  /** Commit the buffered edits of `rowIdx` back to the workbook. Called on
   *  navigation (Prev / Next), save, and close — never on every keystroke. */
  onCommitRow: (rowIdx: number, row: DataFormRow) => void;
  /** Append a blank row to the underlying range. The caller is expected to
   *  push a new entry into the row list so the next render advances to it. */
  onAddRow: () => void;
  /** Remove `rowIdx` from the underlying range. */
  onDeleteRow: (rowIdx: number) => void;
  onClose: () => void;
}

/**
 * Excel-style row-by-row editor. Mirrors the legacy "Data → Form" command:
 * one labelled input per column, navigation buttons across the bottom, and
 * a "Record N of M" indicator at the top.
 *
 * Edits are buffered in local state — committing on navigation prevents a
 * snapshot mutation per keystroke (which would flood the undo stack and
 * make typing noticeably laggy when DV / CF rules are present).
 */
export default function DataFormDialog({
  range,
  columnHeaders,
  initialRows,
  onCommitRow,
  onAddRow,
  onDeleteRow,
  onClose,
}: Props) {
  // We re-sync `rows` whenever the parent hands us a fresh `initialRows`
  // (e.g. after onAddRow / onDeleteRow extends the list). The dialog itself
  // never edits this array — it only edits the `draft` for the active row.
  const [rows, setRows] = useState<DataFormRow[]>(() => initialRows.map((r) => ({ ...r })));
  const [currentIdx, setCurrentIdx] = useState<number>(0);
  const [draft, setDraft] = useState<DataFormRow>(() => ({ ...(initialRows[0] ?? {}) }));

  // When initialRows changes shape (length or content from a new commit
  // round-trip), reset to the new snapshot. We compare by reference because
  // the parent rebuilds the array on every meaningful change.
  useEffect(() => {
    setRows(initialRows.map((r) => ({ ...r })));
    // Clamp currentIdx to the new bounds; default to last row when shrunk
    // beyond it (post-delete) so the user lands on a valid record.
    setCurrentIdx((prev) => {
      if (initialRows.length === 0) return 0;
      if (prev >= initialRows.length) return initialRows.length - 1;
      return prev;
    });
  }, [initialRows]);

  // Refresh the draft whenever the active row changes (navigation or after
  // initialRows was reset above).
  useEffect(() => {
    setDraft({ ...(rows[currentIdx] ?? {}) });
  }, [currentIdx, rows]);

  // Capture Escape so it closes the modal even when focus isn't on a button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        commitAndThen(() => onClose());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, currentIdx, rows]);

  const total = rows.length;

  // Column key list driven off the first row so insertion order is stable
  // even when later rows have sparse cells. Falls back to columnHeaders'
  // length when the row set is empty.
  const columnKeys = useMemo<string[]>(() => {
    if (rows[0]) return Object.keys(rows[0]);
    if (initialRows[0]) return Object.keys(initialRows[0]);
    // Synthesise sequential keys when there's nothing to read from.
    return columnHeaders.map((_, i) => String(i));
  }, [rows, initialRows, columnHeaders]);

  const commitAndThen = (next: () => void) => {
    // Skip the commit when nothing's actually pending — saves a no-op
    // checkpoint on the undo stack.
    const original = rows[currentIdx] ?? {};
    let dirty = false;
    for (const k of columnKeys) {
      const a = original[k];
      const b = draft[k];
      const aStr = a === undefined || a === null ? "" : String(a);
      const bStr = b === undefined || b === null ? "" : String(b);
      if (aStr !== bStr) {
        dirty = true;
        break;
      }
    }
    if (dirty && total > 0) {
      onCommitRow(currentIdx, { ...draft });
      setRows((prev) => prev.map((r, i) => (i === currentIdx ? { ...draft } : r)));
    }
    next();
  };

  const handlePrev = () => {
    if (currentIdx <= 0) return;
    commitAndThen(() => setCurrentIdx((i) => i - 1));
  };

  const handleNext = () => {
    if (currentIdx >= total - 1) return;
    commitAndThen(() => setCurrentIdx((i) => i + 1));
  };

  const handleNew = () => {
    // Commit any pending edits on the current record first so they aren't
    // lost when the parent rebuilds initialRows with an extra entry.
    commitAndThen(() => {
      onAddRow();
      // Optimistically point at where the new row will land. The parent's
      // refreshed initialRows will redraw shortly; this just avoids a flash
      // back to the prior row before the effect runs.
      setCurrentIdx(total);
    });
  };

  const handleDelete = () => {
    if (total === 0) return;
    // Skip confirm() on the first deletion so the dialog stays snappy in
    // batch-cleanup workflows. Excel doesn't prompt either.
    onDeleteRow(currentIdx);
    // The parent will hand us a shrunk initialRows; the effect above will
    // clamp currentIdx if we went past the new end.
  };

  const handleClose = () => {
    commitAndThen(() => onClose());
  };

  return (
    <div className="df-backdrop" onClick={handleClose}>
      <div
        className="df-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="df-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="df-header">
          <h2 id="df-title" className="df-title">データフォーム — {range}</h2>
          <button
            type="button"
            className="df-close"
            onClick={handleClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="df-record-indicator" aria-live="polite">
          {total === 0
            ? "レコード: 0 / 0"
            : `レコード ${currentIdx + 1} / ${total}`}
        </div>
        <div className="df-body">
          {columnHeaders.length === 0 && (
            <p className="df-empty">列がありません。範囲を確認してください。</p>
          )}
          {columnHeaders.map((label, i) => {
            const key = columnKeys[i] ?? String(i);
            const v = draft[key];
            const display = v === undefined || v === null ? "" : String(v);
            return (
              <label key={key} className="df-field">
                <span className="df-field-label">{label}</span>
                <input
                  type="text"
                  className="df-input"
                  value={display}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  disabled={total === 0}
                  // Focus the first input on open so keyboard users can start
                  // typing immediately.
                  autoFocus={i === 0}
                />
              </label>
            );
          })}
        </div>
        <footer className="df-footer">
          <div className="df-nav">
            <button
              type="button"
              className="df-btn"
              onClick={handleNew}
              aria-label="新しいレコードを追加"
            >
              新規
            </button>
            <button
              type="button"
              className="df-btn df-btn--danger"
              onClick={handleDelete}
              disabled={total === 0}
              aria-label="現在のレコードを削除"
            >
              削除
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={handlePrev}
              disabled={currentIdx <= 0}
              aria-label="前のレコード"
            >
              ◀ 前へ
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={handleNext}
              disabled={currentIdx >= total - 1}
              aria-label="次のレコード"
            >
              次へ ▶
            </button>
          </div>
          <div className="df-footer-actions">
            <button type="button" className="df-btn df-btn--primary" onClick={handleClose}>
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
