import { useEffect, useState } from "react";
import {
  type CalcMode,
  CALC_MODE_LABELS,
} from "../store/calcMode";
import "./CalculationOptionsDialog.css";

interface Props {
  currentMode: CalcMode;
  onApply: (mode: CalcMode) => void;
  onRecalcAll: () => void;
  onRecalcSheet: () => void;
  onClose: () => void;
}

const MODE_ORDER: CalcMode[] = ["auto", "autoNoTables", "manual"];

export default function CalculationOptionsDialog({
  currentMode,
  onApply,
  onRecalcAll,
  onRecalcSheet,
  onClose,
}: Props) {
  const [pending, setPending] = useState<CalcMode>(currentMode);

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

  const apply = () => {
    onApply(pending);
    onClose();
  };

  const isDirty = pending !== currentMode;

  return (
    <div className="calc-opts-backdrop" onClick={onClose}>
      <div
        className="calc-opts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calc-opts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="calc-opts-header">
          <h2 id="calc-opts-title" className="calc-opts-title">
            計算オプション
          </h2>
          <button
            type="button"
            className="calc-opts-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="calc-opts-body">
          <p className="calc-opts-hint">
            計算: 数式を再計算するタイミングを設定します。
          </p>
          <div className="calc-opts-radio-group">
            {MODE_ORDER.map((mode) => (
              <label key={mode} className="calc-opts-radio">
                <input
                  type="radio"
                  name="coco-calc-mode"
                  checked={pending === mode}
                  onChange={() => setPending(mode)}
                />
                <span>{CALC_MODE_LABELS[mode].ja}</span>
              </label>
            ))}
          </div>
          <div className="calc-opts-recalc-row">
            <button
              type="button"
              className="calc-opts-btn"
              onClick={onRecalcAll}
              title="F9"
            >
              今すぐ再計算 (F9)
            </button>
            <button
              type="button"
              className="calc-opts-btn"
              onClick={onRecalcSheet}
              title="Shift+F9"
            >
              シート再計算 (Shift+F9)
            </button>
          </div>
          <p className="calc-opts-shortcut-hint">
            F9 ですべてのブックを再計算し、Shift+F9 で現在のシートのみを再計算します。
          </p>
        </div>
        <footer className="calc-opts-footer">
          <button type="button" className="calc-opts-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="calc-opts-btn calc-opts-btn--primary"
            onClick={apply}
            disabled={!isDirty}
          >
            適用
          </button>
        </footer>
      </div>
    </div>
  );
}
