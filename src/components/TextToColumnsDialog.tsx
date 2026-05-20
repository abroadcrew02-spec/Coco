import { useEffect, useMemo, useState } from "react";
import {
  parseA1RangeForTextToColumns,
  splitText,
  type TextToColumnsDelimiters,
  type TextToColumnsMode,
  type TextToColumnsParams,
  type QuoteChar,
} from "../store/textToColumns";
import "./TextToColumnsDialog.css";

interface Props {
  /** Default A1 range (typically a single column of the active selection). */
  initialRange: string;
  /** First N (up to 5 displayed) source-row strings for the live preview.
   *  Caller passes plain strings — the dialog stays free of Univer access. */
  sampleRows: string[];
  onApply: (params: TextToColumnsParams) => void;
  onClose: () => void;
}

// Sheet-prefixed or bare rectangular A1 range. Single-cell refs are accepted
// here because text-to-columns on one cell is still meaningful (you might just
// be splitting one row), unlike sort.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

function validateRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return "対象範囲は必須です";
  if (!RANGE_RE.test(trimmed))
    return "範囲は A1 形式で指定してください (例: A1 や A1:A10)";
  return null;
}

// Parse a comma-/space-separated list of positive integers for fixed-width
// breaks. Returns the parsed array on success or a user-facing error string.
function parseFixedWidths(input: string): { widths: number[]; error: string | null } {
  const trimmed = input.trim();
  if (!trimmed) return { widths: [], error: null };
  const tokens = trimmed.split(/[\s,]+/).filter((s) => s.length > 0);
  const widths: number[] = [];
  for (const tok of tokens) {
    const n = Number(tok);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return { widths: [], error: `区切り位置は正の整数で指定してください: "${tok}"` };
    }
    widths.push(n);
  }
  return { widths, error: null };
}

const MAX_PREVIEW_ROWS = 5;

export default function TextToColumnsDialog({
  initialRange,
  sampleRows,
  onApply,
  onClose,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [range, setRange] = useState(initialRange);
  const [mode, setMode] = useState<TextToColumnsMode>("delimited");
  const [delimTab, setDelimTab] = useState(false);
  const [delimSemicolon, setDelimSemicolon] = useState(false);
  const [delimComma, setDelimComma] = useState(true);
  const [delimSpace, setDelimSpace] = useState(false);
  const [delimOther, setDelimOther] = useState("");
  const [collapseRuns, setCollapseRuns] = useState(false);
  const [quoteChar, setQuoteChar] = useState<QuoteChar>("double");
  const [fixedWidthsInput, setFixedWidthsInput] = useState("");
  const [trim, setTrim] = useState(false);
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

  // Build the params object used both for preview and for the final apply.
  // Wrapped in useMemo so changes to any input only re-run the split work.
  const params = useMemo<TextToColumnsParams | null>(() => {
    const rect = parseA1RangeForTextToColumns(range);
    if (!rect) return null;
    const delimiters: TextToColumnsDelimiters = {
      tab: delimTab,
      semicolon: delimSemicolon,
      comma: delimComma,
      space: delimSpace,
      other: delimOther || undefined,
    };
    const { widths } = parseFixedWidths(fixedWidthsInput);
    return {
      sourceRange: rect,
      mode,
      delimiters,
      treatConsecutiveAsOne: collapseRuns,
      quoteChar,
      fixedWidths: widths,
      trim,
    };
  }, [
    range,
    mode,
    delimTab,
    delimSemicolon,
    delimComma,
    delimSpace,
    delimOther,
    collapseRuns,
    quoteChar,
    fixedWidthsInput,
    trim,
  ]);

  // Run the split on the (up to 5) sample rows for the live preview. When
  // params aren't valid yet we skip — the preview pane will show a hint.
  const preview = useMemo(() => {
    if (!params) return [] as string[][];
    return sampleRows
      .slice(0, MAX_PREVIEW_ROWS)
      .map((row) => splitText(row, params));
  }, [params, sampleRows]);

  const previewMaxCols = preview.reduce((acc, row) => Math.max(acc, row.length), 0);

  const validateForApply = (): string | null => {
    const rangeErr = validateRange(range);
    if (rangeErr) return rangeErr;
    if (mode === "delimited") {
      const anyDelim =
        delimTab || delimSemicolon || delimComma || delimSpace || delimOther.length > 0;
      if (!anyDelim) return "区切り文字を 1 つ以上選択してください";
    } else {
      const { widths, error: fwErr } = parseFixedWidths(fixedWidthsInput);
      if (fwErr) return fwErr;
      if (widths.length === 0) return "固定幅の区切り位置を 1 つ以上指定してください";
    }
    return null;
  };

  const goNext = () => {
    const msg = validateForApply();
    if (msg) {
      setError(msg);
      return;
    }
    setError(null);
    setStep(2);
  };

  const submit = () => {
    const msg = validateForApply();
    if (msg) {
      setError(msg);
      return;
    }
    if (!params) {
      setError("対象範囲を解析できませんでした");
      return;
    }
    setError(null);
    onApply(params);
    onClose();
  };

  return (
    <div className="ttc-backdrop" onClick={onClose}>
      <div
        className="ttc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ttc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ttc-header">
          <h2 id="ttc-title" className="ttc-title">区切り位置の指定</h2>
          <button type="button" className="ttc-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ttc-stepper" aria-hidden="true">
          <span
            className={`ttc-stepper-item${step === 1 ? " ttc-stepper-item--active" : ""}`}
          >
            1. 区切り方法
          </span>
          <span
            className={`ttc-stepper-item${step === 2 ? " ttc-stepper-item--active" : ""}`}
          >
            2. プレビューと適用
          </span>
        </div>
        <div className="ttc-body">
          <label className="ttc-field">
            <span className="ttc-field-label">対象範囲（通常は単一列）</span>
            <input
              type="text"
              className="ttc-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:A10"
              autoFocus
            />
          </label>

          {step === 1 && (
            <>
              <fieldset className="ttc-fieldset">
                <legend>区切り種別</legend>
                <div className="ttc-radio-row">
                  <label className="ttc-radio">
                    <input
                      type="radio"
                      name="ttc-mode"
                      checked={mode === "delimited"}
                      onChange={() => setMode("delimited")}
                    />
                    <span>区切り文字</span>
                  </label>
                  <label className="ttc-radio">
                    <input
                      type="radio"
                      name="ttc-mode"
                      checked={mode === "fixedWidth"}
                      onChange={() => setMode("fixedWidth")}
                    />
                    <span>固定幅</span>
                  </label>
                </div>
              </fieldset>

              {mode === "delimited" && (
                <fieldset className="ttc-fieldset">
                  <legend>区切り文字</legend>
                  <div className="ttc-checkbox-row">
                    <label className="ttc-checkbox">
                      <input
                        type="checkbox"
                        checked={delimTab}
                        onChange={(e) => setDelimTab(e.target.checked)}
                      />
                      <span>タブ</span>
                    </label>
                    <label className="ttc-checkbox">
                      <input
                        type="checkbox"
                        checked={delimSemicolon}
                        onChange={(e) => setDelimSemicolon(e.target.checked)}
                      />
                      <span>セミコロン</span>
                    </label>
                    <label className="ttc-checkbox">
                      <input
                        type="checkbox"
                        checked={delimComma}
                        onChange={(e) => setDelimComma(e.target.checked)}
                      />
                      <span>カンマ</span>
                    </label>
                    <label className="ttc-checkbox">
                      <input
                        type="checkbox"
                        checked={delimSpace}
                        onChange={(e) => setDelimSpace(e.target.checked)}
                      />
                      <span>スペース</span>
                    </label>
                    <label className="ttc-checkbox">
                      <span>その他</span>
                      <input
                        type="text"
                        className="ttc-input ttc-other-input"
                        maxLength={4}
                        value={delimOther}
                        onChange={(e) => setDelimOther(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="ttc-checkbox">
                    <input
                      type="checkbox"
                      checked={collapseRuns}
                      onChange={(e) => setCollapseRuns(e.target.checked)}
                    />
                    <span>連続する区切り文字を 1 つとして扱う</span>
                  </label>
                  <label className="ttc-field">
                    <span className="ttc-field-label">引用符</span>
                    <select
                      className="ttc-select"
                      value={quoteChar}
                      onChange={(e) => setQuoteChar(e.target.value as QuoteChar)}
                    >
                      <option value="none">なし</option>
                      <option value="double">ダブルクォート (")</option>
                      <option value="single">シングルクォート (')</option>
                    </select>
                  </label>
                </fieldset>
              )}

              {mode === "fixedWidth" && (
                <fieldset className="ttc-fieldset">
                  <legend>区切り位置</legend>
                  <label className="ttc-field">
                    <span className="ttc-field-label">
                      文字数の位置をカンマ区切りで指定 (例: 5,10,15)
                    </span>
                    <input
                      type="text"
                      className="ttc-input ttc-fixed-input"
                      value={fixedWidthsInput}
                      onChange={(e) => setFixedWidthsInput(e.target.value)}
                      placeholder="5,10,15"
                    />
                  </label>
                </fieldset>
              )}

              <label className="ttc-checkbox">
                <input
                  type="checkbox"
                  checked={trim}
                  onChange={(e) => setTrim(e.target.checked)}
                />
                <span>各セルの前後の空白を取り除く</span>
              </label>
            </>
          )}

          {step === 2 && (
            <div className="ttc-field">
              <span className="ttc-field-label">プレビュー（先頭 {MAX_PREVIEW_ROWS} 行）</span>
              <div className="ttc-preview">
                {preview.length === 0 ? (
                  <div className="ttc-preview-empty">
                    プレビュー対象の行がありません
                  </div>
                ) : (
                  <table className="ttc-preview-table">
                    <thead>
                      <tr>
                        {Array.from({ length: previewMaxCols }).map((_, i) => (
                          <th key={i}>列 {i + 1}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, ri) => (
                        <tr key={ri}>
                          {Array.from({ length: previewMaxCols }).map((_, ci) => (
                            <td key={ci}>{row[ci] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {error && <p className="ttc-error">{error}</p>}
        </div>
        <footer className="ttc-footer">
          <p className="ttc-hint">
            分割結果は対象列とその右側のセルに書き込まれ、既存の値は上書きされます。
            元に戻すには [編集] → [元に戻す] を使用してください。
          </p>
          <div className="ttc-footer-actions">
            <button type="button" className="ttc-btn" onClick={onClose}>
              キャンセル
            </button>
            <div className="ttc-footer-actions-right">
              {step === 2 && (
                <button type="button" className="ttc-btn" onClick={() => setStep(1)}>
                  戻る
                </button>
              )}
              {step === 1 ? (
                <button type="button" className="ttc-btn ttc-btn--primary" onClick={goNext}>
                  次へ
                </button>
              ) : (
                <button type="button" className="ttc-btn ttc-btn--primary" onClick={submit}>
                  適用
                </button>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
