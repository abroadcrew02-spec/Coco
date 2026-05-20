import { useEffect, useMemo, useState } from "react";
import {
  detectDelimiter,
  detectEncoding,
  inferColumnType,
  parseCsvPreview,
  type CsvColumnType,
  type CsvEncoding,
  type CsvWizardConfig,
} from "../store/csvImportWizard";
import "./CsvImportWizardDialog.css";

interface Props {
  filePath: string;
  /** First ~5KB of the file as raw bytes. Used both for the encoding
   *  detection card on step 1 and the decoded preview on later steps. */
  previewBytes: Uint8Array;
  onImport: (config: CsvWizardConfig) => void;
  onClose: () => void;
}

type Step = 1 | 2 | 3 | 4;

const MAX_PREVIEW_ROWS = 10;
const RAW_PREVIEW_CHARS = 1024;

// Decoder labels mirror the encoding picker; "auto" defers to the backend.
const ENCODING_LABELS: Record<CsvEncoding, string> = {
  auto: "自動判定",
  utf8: "UTF-8",
  utf8bom: "UTF-8 (BOM)",
  sjis: "Shift_JIS",
  eucjp: "EUC-JP",
};

const DELIMITER_LABELS: Record<string, string> = {
  ",": "カンマ ( , )",
  ";": "セミコロン ( ; )",
  "\t": "タブ ( \\t )",
  "|": "パイプ ( | )",
};

/** Decode `bytes` under `enc`. Falls back to UTF-8-with-replacement when
 *  the requested encoding isn't recognised by the browser's TextDecoder. */
function decodeBytes(bytes: Uint8Array, enc: CsvEncoding): string {
  // "auto" → pick the detected encoding for the dialog preview only; the
  // backend re-runs detection on the full file.
  const effective: CsvEncoding = enc === "auto" ? detectEncoding(bytes) : enc;
  let label = "utf-8";
  if (effective === "sjis") label = "shift_jis";
  else if (effective === "eucjp") label = "euc-jp";
  // utf8 / utf8bom both decode via "utf-8"; the BOM (if any) is handled
  // below by stripping the leading U+FEFF.
  try {
    const decoder = new TextDecoder(label, { fatal: false });
    const decoded = decoder.decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch {
    // Unsupported encoding in this browser — degrade to UTF-8.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Compact a control character into its escape form so the raw preview
 *  card doesn't render literal CR / LF in a single-line context. */
function escapeForRawPreview(s: string): string {
  return s
    .replace(/\r\n/g, "\\r\\n\n")
    .replace(/\n/g, "\\n\n")
    .replace(/\r/g, "\\r\n")
    .replace(/\t/g, "\\t");
}

export default function CsvImportWizardDialog({
  filePath,
  previewBytes,
  onImport,
  onClose,
}: Props) {
  const [step, setStep] = useState<Step>(1);
  const detectedEnc = useMemo(() => detectEncoding(previewBytes), [previewBytes]);
  const [encoding, setEncoding] = useState<CsvEncoding>("auto");
  const [delimiter, setDelimiter] = useState<string>("auto");
  const [skipRows, setSkipRows] = useState<number>(0);
  const [hasHeader, setHasHeader] = useState<boolean>(true);
  const [columnTypes, setColumnTypes] = useState<CsvColumnType[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Escape-to-close, matching the other Coco dialogs.
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

  const decodedText = useMemo(
    () => decodeBytes(previewBytes, encoding),
    [previewBytes, encoding]
  );

  const detectedDelim = useMemo(() => detectDelimiter(decodedText), [decodedText]);
  const effectiveDelim = delimiter === "auto" ? detectedDelim : delimiter;

  // Parse preview after honouring skip-rows. We slice to MAX_PREVIEW_ROWS for
  // the table render; downstream type inference runs on the same slice so the
  // suggested types match what the user actually sees.
  const parsedRows = useMemo(
    () => parseCsvPreview(decodedText, effectiveDelim, skipRows),
    [decodedText, effectiveDelim, skipRows]
  );

  // Header row (if any) separated from the body so it can be displayed
  // distinctly. The body is what feeds inferColumnType.
  const headerRow = hasHeader ? parsedRows[0] ?? [] : null;
  const bodyRows = hasHeader ? parsedRows.slice(1) : parsedRows;
  const previewBody = bodyRows.slice(0, MAX_PREVIEW_ROWS);
  const previewCols = useMemo(() => {
    const headerLen = headerRow?.length ?? 0;
    return previewBody.reduce(
      (acc, row) => Math.max(acc, row.length),
      headerLen
    );
  }, [previewBody, headerRow]);

  // Auto-infer types whenever the parsed shape changes. Existing user
  // overrides for surviving columns are preserved; new columns get inferred
  // defaults; trimmed-off columns are dropped from state.
  useEffect(() => {
    setColumnTypes((prev) => {
      const next: CsvColumnType[] = [];
      for (let c = 0; c < previewCols; c++) {
        const colValues = previewBody.map((r) => r[c] ?? "");
        const inferred = inferColumnType(colValues);
        next.push(prev[c] ?? inferred);
      }
      return next;
    });
  }, [previewCols, previewBody]);

  const updateColumnType = (idx: number, kind: CsvColumnType) => {
    setColumnTypes((prev) => prev.map((k, i) => (i === idx ? kind : k)));
  };

  const goNext = () => {
    setError(null);
    if (step === 1) setStep(2);
    else if (step === 2) {
      if (!Number.isInteger(skipRows) || skipRows < 0) {
        setError("スキップ行数は 0 以上の整数で指定してください");
        return;
      }
      setStep(3);
    } else if (step === 3) {
      setStep(4);
    }
  };

  const goBack = () => {
    setError(null);
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
    else if (step === 4) setStep(3);
  };

  const submit = () => {
    setError(null);
    const config: CsvWizardConfig = {
      encoding,
      delimiter,
      skipRows: Math.max(0, Math.floor(skipRows)),
      hasHeader,
      columnTypes: [...columnTypes],
    };
    onImport(config);
    onClose();
  };

  const rawPreview = useMemo(
    () => escapeForRawPreview(decodedText.slice(0, RAW_PREVIEW_CHARS)),
    [decodedText]
  );

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  return (
    <div className="ciw-backdrop" onClick={onClose}>
      <div
        className="ciw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ciw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ciw-header">
          <h2 id="ciw-title" className="ciw-title">
            CSV インポート ウィザード — {fileName}
          </h2>
          <button
            type="button"
            className="ciw-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="ciw-stepper" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={`ciw-stepper-item${
                step === n ? " ciw-stepper-item--active" : ""
              }`}
            >
              {n}.{" "}
              {n === 1
                ? "ファイル / 文字コード"
                : n === 2
                ? "区切りと解析"
                : n === 3
                ? "列の型"
                : "確認"}
            </span>
          ))}
        </div>
        <div className="ciw-body">
          {step === 1 && (
            <>
              <p className="ciw-detected">
                判定された文字コード: <strong>{ENCODING_LABELS[detectedEnc]}</strong>
              </p>
              <label className="ciw-field">
                <span className="ciw-field-label">文字コードの上書き</span>
                <select
                  className="ciw-select"
                  value={encoding}
                  onChange={(e) => setEncoding(e.target.value as CsvEncoding)}
                >
                  <option value="auto">自動判定 (推奨)</option>
                  <option value="utf8">UTF-8</option>
                  <option value="utf8bom">UTF-8 (BOM)</option>
                  <option value="sjis">Shift_JIS</option>
                  <option value="eucjp">EUC-JP</option>
                </select>
              </label>
              <div className="ciw-field">
                <span className="ciw-field-label">
                  先頭バイトのプレビュー (デコード後)
                </span>
                <pre className="ciw-raw-preview">{rawPreview}</pre>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="ciw-detected">
                判定された区切り文字:{" "}
                <strong>
                  {DELIMITER_LABELS[detectedDelim] ?? `"${detectedDelim}"`}
                </strong>
              </p>
              <label className="ciw-field">
                <span className="ciw-field-label">区切り文字</span>
                <select
                  className="ciw-select"
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value)}
                >
                  <option value="auto">自動判定 (推奨)</option>
                  <option value=",">カンマ ( , )</option>
                  <option value=";">セミコロン ( ; )</option>
                  <option value={"\t"}>タブ ( \t )</option>
                  <option value="|">パイプ ( | )</option>
                </select>
              </label>
              <label className="ciw-field">
                <span className="ciw-field-label">先頭から無視する行数</span>
                <input
                  type="number"
                  min={0}
                  className="ciw-input"
                  value={skipRows}
                  onChange={(e) =>
                    setSkipRows(Math.max(0, Number.parseInt(e.target.value, 10) || 0))
                  }
                />
              </label>
              <label className="ciw-checkbox">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                />
                <span>先頭行をヘッダーとして扱う</span>
              </label>
            </>
          )}

          {step === 3 && (
            <div className="ciw-field">
              <span className="ciw-field-label">
                プレビュー (最大 {MAX_PREVIEW_ROWS} 行)。列ごとに型 / スキップを指定できます。
              </span>
              <div className="ciw-preview">
                {previewCols === 0 ? (
                  <div className="ciw-preview-empty">
                    プレビューできる行がありません
                  </div>
                ) : (
                  <table className="ciw-preview-table">
                    <thead>
                      <tr>
                        {Array.from({ length: previewCols }).map((_, ci) => (
                          <th key={`label-${ci}`}>
                            {headerRow?.[ci] ?? `列 ${ci + 1}`}
                          </th>
                        ))}
                      </tr>
                      <tr>
                        {Array.from({ length: previewCols }).map((_, ci) => (
                          <th key={`type-${ci}`} className="ciw-type-header">
                            <select
                              className="ciw-select ciw-type-select"
                              value={columnTypes[ci] ?? "text"}
                              onChange={(e) =>
                                updateColumnType(
                                  ci,
                                  e.target.value as CsvColumnType
                                )
                              }
                              aria-label={`列 ${ci + 1} の型`}
                            >
                              <option value="text">文字列</option>
                              <option value="number">数値</option>
                              <option value="date">日付</option>
                              <option value="skip">取り込まない</option>
                            </select>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewBody.map((row, ri) => (
                        <tr key={ri}>
                          {Array.from({ length: previewCols }).map((_, ci) => (
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

          {step === 4 && (
            <dl className="ciw-summary">
              <div>
                <dt>ファイル:</dt> {fileName}
              </div>
              <div>
                <dt>文字コード:</dt> {ENCODING_LABELS[encoding]}
              </div>
              <div>
                <dt>区切り文字:</dt>{" "}
                {delimiter === "auto"
                  ? `自動判定 → ${DELIMITER_LABELS[detectedDelim] ?? `"${detectedDelim}"`}`
                  : DELIMITER_LABELS[delimiter] ?? `"${delimiter}"`}
              </div>
              <div>
                <dt>スキップ行数:</dt> {skipRows}
              </div>
              <div>
                <dt>ヘッダー行:</dt> {hasHeader ? "あり" : "なし"}
              </div>
              <div>
                <dt>列の型:</dt>{" "}
                {columnTypes.length > 0
                  ? columnTypes
                      .map((k, i) => `${i + 1}:${k}`)
                      .join(", ")
                  : "(未検出)"}
              </div>
              <p className="ciw-warn">
                MVP 版: 区切り文字 / スキップ行数 / 列型の設定はバックエンドにまだ
                反映されません。インポートは現行の自動検出処理で実行されます。
                これらは backend (`workbook_import_csv`) 拡張のフォローアップ対応です。
              </p>
            </dl>
          )}

          {error && <p className="ciw-error">{error}</p>}
        </div>
        <footer className="ciw-footer">
          <p className="ciw-hint">
            キャンセルでインポートを中止します。「インポート」を押すと現在の
            ワークブックが置き換わり、未保存の変更は警告の上で破棄されます。
          </p>
          <div className="ciw-footer-actions">
            <button type="button" className="ciw-btn" onClick={onClose}>
              キャンセル
            </button>
            <div className="ciw-footer-actions-right">
              {step > 1 && (
                <button type="button" className="ciw-btn" onClick={goBack}>
                  戻る
                </button>
              )}
              {step < 4 ? (
                <button
                  type="button"
                  className="ciw-btn ciw-btn--primary"
                  onClick={goNext}
                >
                  次へ
                </button>
              ) : (
                <button
                  type="button"
                  className="ciw-btn ciw-btn--primary"
                  onClick={submit}
                >
                  インポート
                </button>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
