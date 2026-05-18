import { useEffect, useState } from "react";
import "./ForecastSheetDialog.css";

// A1 range (single cell or rectangle), with optional sheet qualifier.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;
// A1 single-cell ref for the output anchor.
const CELL_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateRange(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label}は必須です`;
  if (!RANGE_RE.test(trimmed)) {
    return `${label}は A1 形式の範囲で指定してください (例: A2:A10)`;
  }
  return null;
}

function validateCell(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label}は必須です`;
  if (!CELL_RE.test(trimmed)) {
    return `${label}は単一セル参照で指定してください (例: D1)`;
  }
  return null;
}

export interface ForecastApplyParams {
  xRange: string;
  yRange: string;
  periods: number;
  confidence: number;
  destination: string;
  showConfidence: boolean;
}

interface Props {
  initialXRange: string;
  initialYRange: string;
  onApply: (params: ForecastApplyParams) => void;
  onClose: () => void;
}

export default function ForecastSheetDialog({
  initialXRange,
  initialYRange,
  onApply,
  onClose,
}: Props) {
  const [xRange, setXRange] = useState(initialXRange);
  const [yRange, setYRange] = useState(initialYRange);
  const [periodsText, setPeriodsText] = useState("5");
  const [confidenceText, setConfidenceText] = useState("95");
  const [destination, setDestination] = useState("");
  const [showConfidence, setShowConfidence] = useState(true);
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

  const handleApply = () => {
    const xErr = validateRange("X 範囲", xRange);
    if (xErr) {
      setError(xErr);
      return;
    }
    const yErr = validateRange("Y 範囲", yRange);
    if (yErr) {
      setError(yErr);
      return;
    }
    const periods = Number(periodsText.trim());
    if (!Number.isFinite(periods) || periods <= 0 || !Number.isInteger(periods)) {
      setError("予測期間は 1 以上の整数で指定してください");
      return;
    }
    const confPct = Number(confidenceText.trim());
    if (!Number.isFinite(confPct) || confPct <= 0 || confPct >= 100) {
      setError("信頼水準は 0 より大きく 100 未満の数値 (%) で指定してください");
      return;
    }
    const destErr = validateCell("出力先セル", destination);
    if (destErr) {
      setError(destErr);
      return;
    }
    setError(null);

    onApply({
      xRange: xRange.trim(),
      yRange: yRange.trim(),
      periods,
      confidence: confPct / 100,
      destination: destination.trim(),
      showConfidence,
    });
  };

  return (
    <div className="fsd-backdrop" onClick={onClose}>
      <div
        className="fsd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fsd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fsd-header">
          <h2 id="fsd-title" className="fsd-title">予測シート</h2>
          <button
            type="button"
            className="fsd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="fsd-body">
          <label className="fsd-field">
            <span className="fsd-field-label">X 範囲 (日付 / 連続値)</span>
            <input
              type="text"
              className="fsd-input"
              value={xRange}
              onChange={(e) => setXRange(e.target.value)}
              placeholder="A2:A10"
              autoFocus
            />
          </label>
          <label className="fsd-field">
            <span className="fsd-field-label">Y 範囲 (観測値)</span>
            <input
              type="text"
              className="fsd-input"
              value={yRange}
              onChange={(e) => setYRange(e.target.value)}
              placeholder="B2:B10"
            />
          </label>
          <div className="fsd-row">
            <label className="fsd-field">
              <span className="fsd-field-label">予測期間</span>
              <input
                type="text"
                inputMode="numeric"
                className="fsd-input"
                value={periodsText}
                onChange={(e) => setPeriodsText(e.target.value)}
                placeholder="5"
              />
            </label>
            <label className="fsd-field">
              <span className="fsd-field-label">信頼水準 (%)</span>
              <input
                type="text"
                inputMode="decimal"
                className="fsd-input"
                value={confidenceText}
                onChange={(e) => setConfidenceText(e.target.value)}
                placeholder="95"
              />
            </label>
          </div>
          <label className="fsd-field">
            <span className="fsd-field-label">出力先セル (表の左上)</span>
            <input
              type="text"
              className="fsd-input"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="D1"
            />
          </label>
          <label className="fsd-field fsd-field--row">
            <input
              type="checkbox"
              checked={showConfidence}
              onChange={(e) => setShowConfidence(e.target.checked)}
            />
            <span className="fsd-field-label">信頼区間を表示する</span>
          </label>
          {error && <p className="fsd-error">{error}</p>}
          <p className="fsd-hint">
            線形回帰 (最小二乗法) で予測値を計算します。出力先セルを左上として、X / Y (実測) / 予測 / 下限 / 上限 の表を書き込みます。
          </p>
        </div>
        <footer className="fsd-footer">
          <button type="button" className="fsd-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="fsd-btn fsd-btn--primary"
            onClick={handleApply}
          >
            作成
          </button>
        </footer>
      </div>
    </div>
  );
}
