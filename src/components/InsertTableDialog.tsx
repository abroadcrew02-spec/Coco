import { useEffect, useMemo, useState } from "react";
import {
  createTable,
  parseA1ToRange,
  type TableEntry,
  type TableStylePreset,
} from "../store/tables";
import "./InsertTableDialog.css";

interface Props {
  /** Default A1 range for the new table (typically the active selection). */
  initialRange: string;
  /** Workbook-wide list of table names — used to auto-pick "TableN". */
  existingTableNames: string[];
  onApply: (table: TableEntry) => void;
  onClose: () => void;
}

// Bare or sheet-qualified rectangular A1 range. We accept a single-cell ref
// too, but the dialog enforces the ≥1x1 / ≥2x2 minimum at submit time so
// the user gets a meaningful error rather than a silent reject.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

const STYLE_OPTIONS: ReadonlyArray<{ value: TableStylePreset; label: string }> = [
  { value: "TableStyleMedium2", label: "中間 2 (Medium 2)" },
  { value: "TableStyleLight1", label: "薄色 1 (Light 1)" },
  { value: "TableStyleDark1", label: "濃色 1 (Dark 1)" },
];

export default function InsertTableDialog({
  initialRange,
  existingTableNames,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [headerRow, setHeaderRow] = useState(true);
  const [bandedRows, setBandedRows] = useState(true);
  const [totalsRow, setTotalsRow] = useState(false);
  const [style, setStyle] = useState<TableStylePreset>("TableStyleMedium2");
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

  // Re-derive the parsed rectangle on every range change so the preview
  // ("4 行 x 3 列" etc.) stays in sync without us validating on every keystroke.
  const parsed = useMemo(() => {
    const trimmed = range.trim();
    if (!trimmed || !RANGE_RE.test(trimmed)) return null;
    return parseA1ToRange(trimmed);
  }, [range]);

  const dims = useMemo(() => {
    if (!parsed) return null;
    const rows = parsed.range.r2 - parsed.range.r1 + 1;
    const cols = parsed.range.c2 - parsed.range.c1 + 1;
    return { rows, cols };
  }, [parsed]);

  const submit = () => {
    const trimmed = range.trim();
    if (!trimmed) {
      setError("テーブル範囲は必須です");
      return;
    }
    if (!RANGE_RE.test(trimmed)) {
      setError("範囲は A1 形式で指定してください (例: A1:C10)");
      return;
    }
    const result = parseA1ToRange(trimmed);
    if (!result) {
      setError("範囲を解析できませんでした");
      return;
    }
    const rect = result.range;
    const rows = rect.r2 - rect.r1 + 1;
    const cols = rect.c2 - rect.c1 + 1;
    // With a header row we need at least one data row + at least one column.
    // Without a header row, any non-empty rectangle is acceptable.
    if (headerRow && (rows < 2 || cols < 1)) {
      setError("ヘッダー行を含むテーブルは 2 行以上 1 列以上が必要です");
      return;
    }
    if (!headerRow && (rows < 1 || cols < 1)) {
      setError("テーブル範囲は 1 セル以上必要です");
      return;
    }
    setError(null);
    // The dialog's sheet context is owned by the caller — we build the
    // TableEntry with a minimal "phantom" sheet so the column inference
    // can still pull headers if the caller passed them via a side-channel.
    // In practice the caller (EditorScreen) re-runs createTable against the
    // real sheet to get true column names; this entry is the dialog's intent.
    const entry = createTable(
      // We don't have direct access to the snapshot here; the caller is
      // expected to overwrite `columns` after the fact when wiring this
      // into the live workbook. We still emit a placeholder so the API
      // contract returns a fully-formed TableEntry.
      { cellData: undefined },
      rect,
      {
        headerRow,
        totalsRow,
        style,
        showBandedRows: bandedRows,
        existingTableNames,
      },
    );
    onApply(entry);
    onClose();
  };

  return (
    <div className="it-backdrop" onClick={onClose}>
      <div
        className="it-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="it-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="it-header">
          <h2 id="it-title" className="it-title">テーブルの作成</h2>
          <button type="button" className="it-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="it-body">
          <label className="it-field">
            <span className="it-field-label">テーブルの範囲</span>
            <input
              type="text"
              className="it-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
            {dims && (
              <span className="it-hint-line">
                {dims.rows} 行 × {dims.cols} 列
              </span>
            )}
          </label>
          <label className="it-checkbox">
            <input
              type="checkbox"
              checked={headerRow}
              onChange={(e) => setHeaderRow(e.target.checked)}
            />
            <span>テーブルにヘッダー行を含む</span>
          </label>
          <label className="it-checkbox">
            <input
              type="checkbox"
              checked={bandedRows}
              onChange={(e) => setBandedRows(e.target.checked)}
            />
            <span>縞模様の行</span>
          </label>
          <label className="it-checkbox">
            <input
              type="checkbox"
              checked={totalsRow}
              onChange={(e) => setTotalsRow(e.target.checked)}
            />
            <span>集計行</span>
          </label>
          <label className="it-field">
            <span className="it-field-label">テーブルスタイル</span>
            <select
              className="it-select"
              value={style}
              onChange={(e) => setStyle(e.target.value as TableStylePreset)}
            >
              {STYLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="it-error">{error}</p>}
        </div>
        <footer className="it-footer">
          <p className="it-hint">
            選択した範囲をテーブル (ListObject) に変換します。テーブル名は自動的に
            付与され、後からサイドパネルで変更できます。構造化参照
            (例: <code>Table1[Sales]</code>) は xlsx 保存時に書き出されます。
          </p>
          <div className="it-footer-actions">
            <button type="button" className="it-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="it-btn it-btn--primary"
              onClick={submit}
            >
              作成
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
