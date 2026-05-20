import { useEffect, useMemo, useState } from "react";
import type {
  ConvertToDateParams,
  SmartDateLocale,
} from "../store/smartDate";
import "./SmartDateDialog.css";

interface PreviewRow {
  original: string;
  converted: string | "(変換不可)";
}

interface Props {
  /** A1 range string, e.g. "A1:A50". Prefilled from the active selection. */
  initialRange: string;
  /** Up to 5 rows of "before → after" recomputed by the caller whenever the
   *  user changes locale / format. Stale rows are tolerated — the caller can
   *  recompute and pass a new array on every render. */
  samplePreview: PreviewRow[];
  /** Called when the user changes the locale, format, or range. The parent
   *  uses this to recompute samplePreview. Optional — preview will simply
   *  stay frozen if omitted. */
  onConfigChange?: (config: {
    locale: SmartDateLocale;
    outputFormat: string;
    range: string;
  }) => void;
  onApply: (params: ConvertToDateParams) => void;
  onClose: () => void;
}

const RANGE_RE = /^(?:[^!\s]+!)?\$?([A-Za-z]+)\$?([1-9]\d*)(?::\$?([A-Za-z]+)\$?([1-9]\d*))?$/;

function colLettersToIdx(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseRange(
  range: string,
): { r1: number; c1: number; r2: number; c2: number } | null {
  const trimmed = range.trim();
  const m = RANGE_RE.exec(trimmed.includes("!") ? trimmed.split("!")[1] : trimmed);
  if (!m) return null;
  const c1 = colLettersToIdx(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  if (c1 < 0 || r1 < 0) return null;
  if (m[3] === undefined) return { r1, c1, r2: r1, c2: c1 };
  const c2 = colLettersToIdx(m[3]);
  const r2 = parseInt(m[4], 10) - 1;
  if (c2 < 0 || r2 < 0) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

const FORMAT_PRESETS: Array<{ value: string; label: string }> = [
  { value: "yyyy/m/d", label: "yyyy/m/d (例: 2026/5/18)" },
  { value: "yyyy-mm-dd", label: "yyyy-mm-dd (例: 2026-05-18)" },
  { value: "yyyy年m月d日", label: "yyyy年m月d日 (例: 2026年5月18日)" },
  { value: "__custom__", label: "カスタム..." },
];

export default function SmartDateDialog({
  initialRange,
  samplePreview,
  onConfigChange,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [locale, setLocale] = useState<SmartDateLocale>("ja");
  const [formatChoice, setFormatChoice] = useState<string>("yyyy/m/d");
  const [customFormat, setCustomFormat] = useState<string>("yyyy/m/d");
  const [error, setError] = useState<string | null>(null);

  const effectiveFormat = formatChoice === "__custom__" ? customFormat : formatChoice;

  // Forward changes upstream so the parent can refresh samplePreview. We
  // debounce via the useEffect natural batching — React coalesces multiple
  // state updates into one render before this fires.
  useEffect(() => {
    onConfigChange?.({ locale, outputFormat: effectiveFormat, range });
  }, [locale, effectiveFormat, range, onConfigChange]);

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

  const matchedCount = useMemo(
    () => samplePreview.filter((row) => row.converted !== "(変換不可)").length,
    [samplePreview],
  );

  const submit = () => {
    const parsed = parseRange(range);
    if (!parsed) {
      setError("範囲は A1 形式で指定してください (例: A1:A50)");
      return;
    }
    if (formatChoice === "__custom__" && !customFormat.trim()) {
      setError("カスタム書式を入力してください");
      return;
    }
    setError(null);
    onApply({
      range: parsed,
      locale,
      outputFormat: effectiveFormat,
    });
    onClose();
  };

  return (
    <div className="sdd-backdrop" onClick={onClose}>
      <div
        className="sdd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sdd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sdd-header">
          <h2 id="sdd-title" className="sdd-title">日付に変換</h2>
          <button type="button" className="sdd-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="sdd-body">
          <label className="sdd-field">
            <span className="sdd-field-label">変換範囲</span>
            <input
              type="text"
              className="sdd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:A50"
              autoFocus
            />
          </label>
          <label className="sdd-field">
            <span className="sdd-field-label">日付形式の解釈</span>
            <select
              className="sdd-select"
              value={locale}
              onChange={(e) => setLocale(e.target.value as SmartDateLocale)}
            >
              <option value="us">米国式 (MM/DD/YYYY)</option>
              <option value="eu">欧州式 (DD/MM/YYYY)</option>
              <option value="ja">日本式 (YYYY年M月D日 / YYYY-MM-DD)</option>
            </select>
          </label>
          <label className="sdd-field">
            <span className="sdd-field-label">出力書式</span>
            <select
              className="sdd-select"
              value={formatChoice}
              onChange={(e) => setFormatChoice(e.target.value)}
            >
              {FORMAT_PRESETS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {formatChoice === "__custom__" && (
            <label className="sdd-field">
              <span className="sdd-field-label">カスタム書式コード</span>
              <input
                type="text"
                className="sdd-input"
                value={customFormat}
                onChange={(e) => setCustomFormat(e.target.value)}
                placeholder="yyyy/m/d"
              />
            </label>
          )}
          <fieldset className="sdd-preview">
            <legend className="sdd-field-label">
              プレビュー (先頭 {samplePreview.length} 件 / 変換可能 {matchedCount} 件)
            </legend>
            {samplePreview.length === 0 ? (
              <p className="sdd-preview-empty">
                対象セルが見つかりません。範囲またはロケールを見直してください。
              </p>
            ) : (
              <ul className="sdd-preview-list">
                {samplePreview.map((row, idx) => (
                  <li
                    key={idx}
                    className={
                      row.converted === "(変換不可)"
                        ? "sdd-preview-row sdd-preview-row--miss"
                        : "sdd-preview-row"
                    }
                  >
                    <span className="sdd-preview-original">{row.original || "(空)"}</span>
                    <span className="sdd-preview-arrow">→</span>
                    <span className="sdd-preview-converted">{row.converted}</span>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {error && <p className="sdd-error">{error}</p>}
        </div>
        <footer className="sdd-footer">
          <p className="sdd-hint">
            指定した範囲の文字列セルを順に解析し、日付として読み取れたセルだけを Excel
            日付シリアル値 + 表示形式に書き換えます。読み取れなかったセルはそのまま残ります。
          </p>
          <div className="sdd-footer-actions">
            <button type="button" className="sdd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="button" className="sdd-btn sdd-btn--primary" onClick={submit}>
              変換
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
