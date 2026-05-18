import { type CalcMode, CALC_MODE_LABELS } from "../store/calcMode";
import "./CalculationModeIndicator.css";

interface Props {
  mode: CalcMode;
  onClick: () => void;
}

export default function CalculationModeIndicator({ mode, onClick }: Props) {
  const label = CALC_MODE_LABELS[mode].ja;
  return (
    <button
      type="button"
      className={`calc-mode-indicator calc-mode-indicator--${mode}`}
      onClick={onClick}
      title={`計算オプション: ${label}`}
      aria-label={`計算オプション: ${label}`}
    >
      <span className="calc-mode-indicator__dot" aria-hidden="true" />
      <span className="calc-mode-indicator__label">計算: {label}</span>
    </button>
  );
}
