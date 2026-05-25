import { useEffect, useMemo, useRef, useState } from "react";
import {
  runSolver,
  type SolverGoal,
  type SolverResult,
} from "../store/solver";
import type { GoalSeekAdapter } from "../store/goalSeek";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { t } from "../i18n/locale";
import "./SolverDialog.css";

const CELL_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateCell(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label}は必須です`;
  if (!CELL_RE.test(trimmed)) return `${label}は単一セル参照で指定してください (例: A1)`;
  return null;
}

interface Props {
  initialObjectiveCell: string;
  initialChangingCell: string;
  runAdapter: GoalSeekAdapter;
  onClose: () => void;
  onCommit: (changingCellValue: number) => void;
}

type RunStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: SolverResult };

export default function SolverDialog({
  initialObjectiveCell,
  initialChangingCell,
  runAdapter,
  onClose,
  onCommit,
}: Props) {
  const [objectiveCell, setObjectiveCell] = useState(initialObjectiveCell);
  const [goal, setGoal] = useState<SolverGoal>("maximize");
  const [targetValueText, setTargetValueText] = useState("0");
  const [changingCell, setChangingCell] = useState(initialChangingCell);
  const [lowerBoundText, setLowerBoundText] = useState("");
  const [upperBoundText, setUpperBoundText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, onClose);

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
    const oErr = validateCell("目的セル", objectiveCell);
    if (oErr) {
      setError(oErr);
      return;
    }
    const cErr = validateCell("変数セル", changingCell);
    if (cErr) {
      setError(cErr);
      return;
    }
    if (objectiveCell.trim() === changingCell.trim()) {
      setError("目的セルと変数セルは別のセルを指定してください");
      return;
    }
    let target: number | undefined;
    if (goal === "value") {
      target = Number(targetValueText.trim());
      if (!Number.isFinite(target)) {
        setError("目標値は有効な数値で指定してください");
        return;
      }
    }
    let lo: number | undefined;
    let hi: number | undefined;
    if (lowerBoundText.trim()) {
      const n = Number(lowerBoundText.trim());
      if (!Number.isFinite(n)) {
        setError("下限は有効な数値で指定してください");
        return;
      }
      lo = n;
    }
    if (upperBoundText.trim()) {
      const n = Number(upperBoundText.trim());
      if (!Number.isFinite(n)) {
        setError("上限は有効な数値で指定してください");
        return;
      }
      hi = n;
    }
    if (lo !== undefined && hi !== undefined && lo >= hi) {
      setError("下限は上限より小さい値を指定してください");
      return;
    }
    setError(null);

    if (originalRef.current.cell !== changingCell.trim()) {
      originalRef.current = {
        cell: changingCell.trim(),
        value: runAdapter.readNumeric(changingCell.trim()),
      };
    }

    setStatus({ kind: "running" });
    queueMicrotask(() => {
      try {
        const result = runSolver(runAdapter, {
          objectiveCell: objectiveCell.trim(),
          changingCell: changingCell.trim(),
          goal,
          targetValue: target,
          lowerBound: lo,
          upperBound: hi,
        });
        setStatus({ kind: "done", result });
      } catch (e) {
        setStatus({
          kind: "done",
          result: {
            ok: false,
            iterations: 0,
            finalObjective: Number.NaN,
            finalChanging: Number.NaN,
            reason: "invalid",
          },
        });
        setError(e instanceof Error ? e.message : "ソルバー実行に失敗しました");
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
          return `最大反復回数 (${r.iterations}) に達しました`;
        case "bracket-flat":
          return "目的関数が一定 (探索範囲内で変化なし)";
        case "delegated":
          return "ゴールシーク経路で解は収束しませんでした";
        case "invalid":
          return "セル参照または値が不正です";
      }
    })();
    return { reasonText, r };
  }, [status]);

  return (
    <div className="slv-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="slv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slv-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="slv-header">
          <h2 id="slv-title" className="slv-title">ソルバー (MVP: 単変数)</h2>
          <button
            type="button"
            className="slv-close"
            onClick={onClose}
            aria-label={t("a11y.label.closeDialog")}
          >
            ×
          </button>
        </header>
        <div className="slv-body">
          <label className="slv-field">
            <span className="slv-field-label">目的セル</span>
            <input
              type="text"
              className="slv-input"
              value={objectiveCell}
              onChange={(e) => setObjectiveCell(e.target.value)}
              disabled={running}
              placeholder="B5"
              autoFocus
            />
          </label>
          <div className="slv-field">
            <span className="slv-field-label">目標</span>
            <div className="slv-radio-row">
              <label className="slv-radio">
                <input
                  type="radio"
                  value="maximize"
                  checked={goal === "maximize"}
                  onChange={() => setGoal("maximize")}
                  disabled={running}
                />
                <span>最大化</span>
              </label>
              <label className="slv-radio">
                <input
                  type="radio"
                  value="minimize"
                  checked={goal === "minimize"}
                  onChange={() => setGoal("minimize")}
                  disabled={running}
                />
                <span>最小化</span>
              </label>
              <label className="slv-radio">
                <input
                  type="radio"
                  value="value"
                  checked={goal === "value"}
                  onChange={() => setGoal("value")}
                  disabled={running}
                />
                <span>指定値</span>
              </label>
            </div>
          </div>
          {goal === "value" && (
            <label className="slv-field">
              <span className="slv-field-label">目標値</span>
              <input
                type="text"
                inputMode="decimal"
                className="slv-input"
                value={targetValueText}
                onChange={(e) => setTargetValueText(e.target.value)}
                disabled={running}
                placeholder="100"
              />
            </label>
          )}
          <label className="slv-field">
            <span className="slv-field-label">変数セル</span>
            <input
              type="text"
              className="slv-input"
              value={changingCell}
              onChange={(e) => setChangingCell(e.target.value)}
              disabled={running}
              placeholder="A1"
            />
          </label>
          <div className="slv-bounds-row">
            <label className="slv-field">
              <span className="slv-field-label">下限 (任意)</span>
              <input
                type="text"
                inputMode="decimal"
                className="slv-input"
                value={lowerBoundText}
                onChange={(e) => setLowerBoundText(e.target.value)}
                disabled={running}
                placeholder="-1000000"
              />
            </label>
            <label className="slv-field">
              <span className="slv-field-label">上限 (任意)</span>
              <input
                type="text"
                inputMode="decimal"
                className="slv-input"
                value={upperBoundText}
                onChange={(e) => setUpperBoundText(e.target.value)}
                disabled={running}
                placeholder="1000000"
              />
            </label>
          </div>
          {error && <p className="slv-error">{error}</p>}
          {running && (
            <div className="slv-status">
              <span className="slv-spinner" aria-hidden="true" />
              <span>解を探索中…</span>
            </div>
          )}
          {summary && (
            <div
              className={`slv-result ${summary.r.ok ? "slv-result--ok" : "slv-result--bad"}`}
              role="status"
            >
              <p className="slv-result-headline">{summary.reasonText}</p>
              <dl className="slv-result-grid">
                <dt>反復回数</dt>
                <dd>{summary.r.iterations}</dd>
                <dt>目的関数値</dt>
                <dd>{Number.isFinite(summary.r.finalObjective) ? summary.r.finalObjective : "—"}</dd>
                <dt>変数セルの値</dt>
                <dd>{Number.isFinite(summary.r.finalChanging) ? summary.r.finalChanging : "—"}</dd>
              </dl>
            </div>
          )}
        </div>
        <footer className="slv-footer">
          <p className="slv-hint">
            黄金分割法で単変数最適化を行います。多変数 / 線形計画は今後のアップデートで対応予定です。
          </p>
          <div className="slv-footer-actions">
            <button
              type="button"
              className="slv-btn"
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
              className="slv-btn"
              onClick={onClose}
              disabled={running}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="slv-btn slv-btn--primary"
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
