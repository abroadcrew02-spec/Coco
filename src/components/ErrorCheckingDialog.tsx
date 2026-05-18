import { useEffect, useMemo, useState } from "react";
import type { AuditIssue } from "../store/formulaAudit";
import "./ErrorCheckingDialog.css";

interface Props {
  /** Pre-collected audit issues; the caller (EditorScreen) builds this
   *  with `collectAuditIssues(snapshot)` so the dialog stays decoupled
   *  from the snapshot shape. */
  issues: AuditIssue[];
  /** Selected "Edit" — closes the dialog and jumps to the cell so the
   *  user can correct the formula directly in the grid. */
  onJumpToCell: (sheetId: string, cellRef: string) => void;
  /** Dismiss (X, Esc, Close, all issues skipped). */
  onClose: () => void;
}

/** Human-readable description for each issue kind. MVP carries
 *  "error-value" only; the other kinds are wired up so adding detectors
 *  is a one-line change here. */
function describeIssue(issue: AuditIssue): { title: string; suggestion: string } {
  switch (issue.kind) {
    case "error-value":
      return {
        title: `エラー値: ${issue.detail}`,
        suggestion:
          "数式が無効な計算を行っているか、参照先のセルに問題があります。数式を編集して修正してください。",
      };
    default: {
      // Exhaustive guard — keeps the switch honest once new kinds land.
      const _exhaustive: never = issue.kind;
      void _exhaustive;
      return { title: "問題", suggestion: "" };
    }
  }
}

/**
 * Modal stepper through the auditor's issue list. Mirrors Excel's
 * "Error Checking" dialog (Formulas → Error Checking) but slimmed to the
 * controls Coco currently supports:
 *
 *   - Previous / Next: walk the issue list.
 *   - Ignore: skip the current issue without acting on it (drops it from
 *     the in-dialog set for this session; doesn't write to the snapshot).
 *   - Edit: closes the dialog and jumps Univer's selection to the cell so
 *     the user can edit the formula in the grid.
 *   - Close (header + footer): dismiss.
 *
 * When all issues are exhausted or ignored, the dialog shows a "no more
 * issues" pane with a single Close button.
 */
export default function ErrorCheckingDialog({ issues, onJumpToCell, onClose }: Props) {
  // Local working set so "Ignore" can drop entries without mutating the
  // caller's array. We keep stable identity per (sheetId, cellRef, kind)
  // because the same cell shouldn't appear twice in practice — but if it
  // did, the index suffix makes the React key unique.
  const initialSet = useMemo<AuditIssue[]>(() => [...issues], [issues]);
  const [remaining, setRemaining] = useState<AuditIssue[]>(initialSet);
  const [index, setIndex] = useState(0);

  // Esc closes — same convention as SortDialog and the rest of Coco's modals.
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

  const total = remaining.length;
  const current = total > 0 ? remaining[Math.min(index, total - 1)] : null;
  const desc = current ? describeIssue(current) : null;

  const goPrev = () => {
    if (total === 0) return;
    setIndex((i) => (i - 1 + total) % total);
  };

  const goNext = () => {
    if (total === 0) return;
    setIndex((i) => (i + 1) % total);
  };

  const ignoreCurrent = () => {
    if (total === 0) return;
    const cur = Math.min(index, total - 1);
    const next = remaining.filter((_, i) => i !== cur);
    setRemaining(next);
    // Stay on the same slot if there's still something after the removed
    // entry, otherwise step back so we don't land out-of-bounds.
    if (cur >= next.length && next.length > 0) {
      setIndex(next.length - 1);
    } else if (next.length === 0) {
      setIndex(0);
    }
  };

  const editCurrent = () => {
    if (!current) return;
    onJumpToCell(current.sheetId, current.cellRef);
    onClose();
  };

  return (
    <div className="ecd-backdrop" onClick={onClose}>
      <div
        className="ecd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ecd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ecd-header">
          <h2 id="ecd-title" className="ecd-title">
            エラーチェック
          </h2>
          <button
            type="button"
            className="ecd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        {current && desc ? (
          <>
            <div className="ecd-body">
              <p className="ecd-counter">
                問題 {Math.min(index, total - 1) + 1} / {total}: {desc.title}
              </p>
              <p className="ecd-cell-ref">
                <span className="ecd-label">セル:</span>
                <code className="ecd-code">
                  {current.sheetName}!{current.cellRef}
                </code>
              </p>
              <p className="ecd-suggestion">{desc.suggestion}</p>
            </div>
            <footer className="ecd-footer">
              <div className="ecd-nav">
                <button
                  type="button"
                  className="ecd-btn"
                  onClick={goPrev}
                  disabled={total <= 1}
                >
                  前へ
                </button>
                <button
                  type="button"
                  className="ecd-btn"
                  onClick={goNext}
                  disabled={total <= 1}
                >
                  次へ
                </button>
              </div>
              <div className="ecd-actions">
                <button type="button" className="ecd-btn" onClick={ignoreCurrent}>
                  無視
                </button>
                <button
                  type="button"
                  className="ecd-btn ecd-btn--primary"
                  onClick={editCurrent}
                >
                  編集
                </button>
              </div>
            </footer>
          </>
        ) : (
          <>
            <div className="ecd-body ecd-body--empty">
              <p className="ecd-empty">確認すべきエラーはありません。</p>
            </div>
            <footer className="ecd-footer">
              <div className="ecd-actions">
                <button
                  type="button"
                  className="ecd-btn ecd-btn--primary"
                  onClick={onClose}
                >
                  閉じる
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
