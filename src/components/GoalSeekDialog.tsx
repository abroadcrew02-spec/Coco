import { useEffect, useMemo, useRef, useState } from "react";
import {
  type GoalSeekAdapter,
  type GoalSeekResult,
  runGoalSeek,
} from "../store/goalSeek";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { t } from "../i18n/locale";
import "./GoalSeekDialog.css";

// A1 cell ref (NOT a range — Goal Seek operates on single cells only).
// Accepts optional sheet qualifier ("Sheet1!B5") and absolute markers ($A$1).
const CELL_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateCell(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label}は必須です`;
  if (!CELL_RE.test(trimmed)) return `${label}は単一セル参照で指定してください (例: A1)`;
  return null;
}

interface Props {
  initialTargetCell: string;
  initialChangingCell: string;
  runAdapter: GoalSeekAdapter;
  onClose: () => void;
  /** Called when the user accepts the result — caller persists / records undo. */
  onCommit: (changingCellValue: number) => void;
}

type RunStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: GoalSeekResult };

export default function GoalSeekDialog({
  initialTargetCell,
  initialChangingCell,
  runAdapter,
  onClose,
  onCommit,
}: Props) {
  const [targetCell, setTargetCell] = useState(initialTargetCell);
  const [targetValueText, setTargetValueText] = useState("0");
  const [changingCell, setChangingCell] = useState(initialChangingCell);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, onClose);

  // Capture the original value of the changing cell when the dialog opens so
  // the user can revert via "元に戻す" if they don't like the result. We only
  // capture once and we capture for whatever cell ref they currently have —
  // re-typing the changing cell mid-flight means the restore target shifts.
  const originalRef = useRef<{ cell: string; value: number | null }>({
    cell: initialChangingCell,
    value: null,
  });
  useEffect(() => {
    const v = runAdapter.readNumeric(initialChangingCell);
    originalRef.current = { cell: initialChangingCell, value: v };
  }, [initialChangingCell, runAdapter]);

  const running = status.kind === "running";

  const handleRun = () => {
    const tErr = validateCell("数式入力セル", targetCell);
    if (tErr) {
      setError(tErr);
      return;
    }
    const cErr = validateCell("変化させるセル", changingCell);
    if (cErr) {
      setError(cErr);
      return;
    }
    const targetValue = Number(targetValueText.trim());
    if (!Number.isFinite(targetValue)) {
      setError("目標値は有効な数値で指定してください");
      return;
    }
    if (targetCell.trim() === changingCell.trim()) {
      setError("数式入力セルと変化させるセルは別のセルを指定してください");
      return;
    }
    setError(null);

    // If the user retyped changingCell, capture a new baseline for restore.
    if (originalRef.current.cell !== changingCell.trim()) {
      originalRef.current = {
        cell: changingCell.trim(),
        value: runAdapter.readNumeric(changingCell.trim()),
      };
    }

    setStatus({ kind: "running" });
    // Defer to a microtask so the spinner paint isn't blocked by the
    // synchronous solver loop. The solver itself runs synchronously inside
    // Univer 0.5.x's recompute pipeline.
    queueMicrotask(() => {
      try {
        const result = runGoalSeek(runAdapter, {
          targetCell: targetCell.trim(),
          targetValue,
          changingCell: changingCell.trim(),
        });
        setStatus({ kind: "done", result });
      } catch (e) {
        setStatus({
          kind: "done",
          result: {
            ok: false,
            iterations: 0,
            finalValue: Number.NaN,
            finalError: Number.NaN,
            reason: "invalid",
            finalChanging: Number.NaN,
          },
        });
        setError(e instanceof Error ? e.message : "ゴールシーク実行に失敗しました");
      }
    });
  };

  const handleRestore = () => {
    const { cell, value } = originalRef.current;
    if (value === null) return;
    runAdapter.writeNumeric(cell, value);
    setStatus({ kind: "idle" });
  };

  const handleCommit = () => {
    if (status.kind !== "done") return;
    onCommit(status.result.finalChanging);
    onClose();
  };

  const summary = useMemo(() => {
    if (status.kind !== "done") return null;
    const r = status.result;
    const reasonText = (() => {
      switch (r.reason) {
        case "converged":
          return "解が見つかりました";
        case "max-iter":
          return `最大反復回数 (${r.iterations}) に達しましたが、解は収束しませんでした`;
        case "diverged":
          return "解が収束しません (関数が単調でないか、解が存在しない可能性があります)";
        case "invalid":
          return "セル参照または値が不正です";
      }
    })();
    return { reasonText, r };
  }, [status]);

  return (
    <div className="gsd-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="gsd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gsd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gsd-header">
          <h2 id="gsd-title" className="gsd-title">ゴールシーク</h2>
          <button
            type="button"
            className="gsd-close"
            onClick={onClose}
            aria-label={t("a11y.label.closeDialog")}
          >
            ×
          </button>
        </header>
        <div className="gsd-body">
          <label className="gsd-field">
            <span className="gsd-field-label">数式入力セル</span>
            <input
              type="text"
              className="gsd-input"
              value={targetCell}
              onChange={(e) => setTargetCell(e.target.value)}
              disabled={running}
              placeholder="B5"
              autoFocus
            />
          </label>
          <label className="gsd-field">
            <span className="gsd-field-label">目標値</span>
            <input
              type="text"
              inputMode="decimal"
              className="gsd-input"
              value={targetValueText}
              onChange={(e) => setTargetValueText(e.target.value)}
              disabled={running}
              placeholder="100"
            />
          </label>
          <label className="gsd-field">
            <span className="gsd-field-label">変化させるセル</span>
            <input
              type="text"
              className="gsd-input"
              value={changingCell}
              onChange={(e) => setChangingCell(e.target.value)}
              disabled={running}
              placeholder="A1"
            />
          </label>
          {error && <p className="gsd-error">{error}</p>}
          {running && (
            <div className="gsd-status">
              <span className="gsd-spinner" aria-hidden="true" />
              <span>解を探索中…</span>
            </div>
          )}
          {summary && (
            <div
              className={`gsd-result ${summary.r.ok ? "gsd-result--ok" : "gsd-result--bad"}`}
              role="status"
            >
              <p className="gsd-result-headline">{summary.reasonText}</p>
              <dl className="gsd-result-grid">
                <dt>反復回数</dt>
                <dd>{summary.r.iterations}</dd>
                <dt>現在の値</dt>
                <dd>{Number.isFinite(summary.r.finalValue) ? summary.r.finalValue : "—"}</dd>
                <dt>目標値との差</dt>
                <dd>{Number.isFinite(summary.r.finalError) ? summary.r.finalError.toExponential(2) : "—"}</dd>
                <dt>変化させるセルの値</dt>
                <dd>{Number.isFinite(summary.r.finalChanging) ? summary.r.finalChanging : "—"}</dd>
              </dl>
            </div>
          )}
        </div>
        <footer className="gsd-footer">
          <p className="gsd-hint">
            セカント法で反復探索します。関数が単調でない、または解が存在しない場合は失敗することがあります。
          </p>
          <div className="gsd-footer-actions">
            <button
              type="button"
              className="gsd-btn"
              onClick={handleRestore}
              disabled={
                running ||
                originalRef.current.value === null ||
                status.kind === "idle"
              }
            >
              元に戻す
            </button>
            <button
              type="button"
              className="gsd-btn"
              onClick={onClose}
              disabled={running}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="gsd-btn gsd-btn--primary"
              onClick={status.kind === "done" ? handleCommit : handleRun}
              disabled={running}
            >
              {status.kind === "done" ? "OK" : "実行"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
