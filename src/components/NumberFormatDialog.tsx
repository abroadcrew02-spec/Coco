import { useMemo, useRef, useState } from "react";
import { t } from "../i18n/locale";
import { useFocusTrap } from "../hooks/useFocusTrap";
import "./NumberFormatDialog.css";

export interface NumberFormatValue {
  /** Format code to apply. Empty string means "General" (clear _fmt). */
  code: string;
}

interface Props {
  /** Human-readable range label (e.g. "Sheet1!B2:C5") shown in the header. */
  rangeLabel: string;
  /** Format code currently applied to the active cell, if known. */
  initialCode?: string;
  onApply: (value: NumberFormatValue) => void;
  onClose: () => void;
}

/** Built-in presets. The empty `code` means "clear" (General). */
export interface NumberFormatPreset {
  id: string;
  label: string;
  code: string;
  sample: string;
}

export const NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = [
  { id: "general", label: "標準", code: "", sample: "1234.5" },
  { id: "number", label: "数値 (0.00)", code: "0.00", sample: "1234.50" },
  { id: "currency", label: "通貨 ($#,##0.00)", code: "$#,##0.00", sample: "$1,234.50" },
  { id: "percent", label: "パーセント (0%)", code: "0%", sample: "50%" },
  { id: "date", label: "日付 (yyyy-mm-dd)", code: "yyyy-mm-dd", sample: "2026-05-14" },
  { id: "time", label: "時刻 (hh:mm:ss)", code: "hh:mm:ss", sample: "14:30:00" },
];

export default function NumberFormatDialog({
  rangeLabel,
  initialCode,
  onApply,
  onClose,
}: Props) {
  // Pick a preset that matches initialCode; otherwise fall through to "custom".
  const initialPreset = useMemo(() => {
    if (!initialCode) return "general";
    const hit = NUMBER_FORMAT_PRESETS.find((p) => p.code === initialCode);
    return hit ? hit.id : "custom";
  }, [initialCode]);

  const [presetId, setPresetId] = useState(initialPreset);
  const [customCode, setCustomCode] = useState(
    initialPreset === "custom" ? (initialCode ?? "") : "",
  );
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, onClose);

  const submit = () => {
    let code: string;
    if (presetId === "custom") {
      code = customCode.trim();
    } else {
      const preset = NUMBER_FORMAT_PRESETS.find((p) => p.id === presetId);
      code = preset ? preset.code : "";
    }
    onApply({ code });
    onClose();
  };

  return (
    <div className="nf-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="nf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nf-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="nf-header">
          <h2 id="nf-title" className="nf-title">{t("dialog.numberFormat")}</h2>
          <button
            type="button"
            className="nf-close"
            onClick={onClose}
            aria-label={t("a11y.label.closeDialog")}
          >
            ×
          </button>
        </header>
        <div className="nf-body">
          <div className="nf-range-label">
            対象: <span className="nf-range-ref">{rangeLabel}</span>
          </div>
          <ul className="nf-presets" role="radiogroup" aria-label="プリセット">
            {NUMBER_FORMAT_PRESETS.map((p) => (
              <li key={p.id} className="nf-preset-row">
                <label className="nf-preset">
                  <input
                    type="radio"
                    name="nf-preset"
                    value={p.id}
                    checked={presetId === p.id}
                    onChange={() => setPresetId(p.id)}
                  />
                  <span className="nf-preset-label">{p.label}</span>
                  <span className="nf-preset-sample">{p.sample}</span>
                </label>
              </li>
            ))}
            <li className="nf-preset-row">
              <label className="nf-preset">
                <input
                  type="radio"
                  name="nf-preset"
                  value="custom"
                  checked={presetId === "custom"}
                  onChange={() => setPresetId("custom")}
                />
                <span className="nf-preset-label">カスタム</span>
              </label>
            </li>
          </ul>
          <label className="nf-field">
            <span className="nf-field-label">カスタム書式コード</span>
            <input
              type="text"
              className="nf-input"
              value={customCode}
              onChange={(e) => {
                setCustomCode(e.target.value);
                setPresetId("custom");
              }}
              placeholder="例: #,##0.00;[Red]-#,##0.00"
              aria-label="カスタム書式コード"
            />
          </label>
        </div>
        <footer className="nf-footer">
          <p className="nf-hint">
            Excel 互換の書式コードを指定します。空文字は「標準」（書式クリア）になります。
          </p>
          <div className="nf-footer-actions">
            <button type="button" className="nf-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="nf-btn nf-btn--primary"
              onClick={submit}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
