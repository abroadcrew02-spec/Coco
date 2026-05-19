import { useEffect, useMemo, useState } from "react";
import type { SubtotalFunction, SubtotalParams } from "../store/subtotals";
import "./SubtotalDialog.css";

// Bare or sheet-qualified rectangular A1 range. Single-cell refs are rejected
// — subtotaling a single cell is meaningless.
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*$/;

interface ParsedRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function colIndexToLetters(idx: number): string {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

function parseRange(raw: string): ParsedRange | null {
  const trimmed = raw.trim();
  if (!RANGE_RE.test(trimmed)) return null;
  const bare = trimmed.includes("!") ? trimmed.split("!")[1] : trimmed;
  const m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(bare);
  if (!m) return null;
  const c1 = colLetterToIndex(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = colLetterToIndex(m[3]);
  const r2 = parseInt(m[4], 10) - 1;
  if (c1 < 0 || c2 < 0 || r1 < 0 || r2 < 0) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

const FUNCTIONS: SubtotalFunction[] = [
  "SUM",
  "AVERAGE",
  "COUNT",
  "MAX",
  "MIN",
  "PRODUCT",
];

interface Props {
  initialRange: string;
  sheetId: string;
  sheetSnapshot: {
    cellData?: Record<string, Record<string, unknown>>;
    rowData?: Record<string, unknown>;
  };
  onApply: (params: SubtotalParams) => void;
  /**
   * Optional — called when the user clicks "Remove all existing subtotals".
   * The integrator strips matching rows from cellData and writes the result
   * back through applyMutatedSnapshot. When omitted, the button is hidden.
   */
  onRemoveAll?: (groupCol: number) => void;
  onClose: () => void;
}

export default function SubtotalDialog({
  initialRange,
  sheetId: _sheetId,
  sheetSnapshot,
  onApply,
  onRemoveAll,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [hasHeader, setHasHeader] = useState(true);
  const [groupByCol, setGroupByCol] = useState(1);
  const [aggregate, setAggregate] = useState<SubtotalFunction>("SUM");
  const [targetCols, setTargetCols] = useState<number[]>([]);
  const [addOutline, setAddOutline] = useState(true);
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

  // Parse the range once; memoize so we don't reparse on every keystroke for
  // downstream dropdown population.
  const parsed = useMemo(() => parseRange(range), [range]);
  const width = parsed ? parsed.c2 - parsed.c1 + 1 : 0;

  // Build the column dropdown list. When hasHeader is on, the labels come
  // from the first row of the range; otherwise we fall back to "Column N".
  const columnLabels = useMemo(() => {
    const labels: { idx: number; label: string }[] = [];
    if (!parsed) return labels;
    for (let i = 1; i <= width; i++) {
      const absCol = parsed.c1 + (i - 1);
      const headerCell = hasHeader
        ? sheetSnapshot.cellData?.[String(parsed.r1)]?.[String(absCol)]
        : undefined;
      const headerValue =
        headerCell && typeof headerCell === "object"
          ? (headerCell as { v?: unknown }).v
          : undefined;
      const headerStr =
        headerValue === undefined || headerValue === null
          ? ""
          : String(headerValue).trim();
      const fallback = `${colIndexToLetters(absCol)} (${i})`;
      labels.push({ idx: i, label: headerStr || fallback });
    }
    return labels;
  }, [parsed, width, hasHeader, sheetSnapshot.cellData]);

  // When the range shrinks, clip out-of-bounds selections to keep the dialog
  // state internally consistent (user can re-pick after fixing the range).
  useEffect(() => {
    if (!parsed) return;
    if (groupByCol > width || groupByCol < 1) setGroupByCol(1);
    setTargetCols((prev) => prev.filter((c) => c >= 1 && c <= width));
  }, [width, groupByCol, parsed]);

  const toggleTarget = (idx: number) => {
    setTargetCols((prev) =>
      prev.includes(idx) ? prev.filter((c) => c !== idx) : [...prev, idx].sort((a, b) => a - b),
    );
  };

  const submit = () => {
    if (!parsed) {
      setError("範囲は複数セルの A1 形式で指定してください (例: A1:C10)");
      return;
    }
    if (groupByCol < 1 || groupByCol > width) {
      setError("グループ化する列を選択してください");
      return;
    }
    if (targetCols.length === 0) {
      setError("集計する列を 1 つ以上選択してください");
      return;
    }
    if (targetCols.includes(groupByCol)) {
      setError("集計する列はグループ化する列と異なる必要があります");
      return;
    }
    setError(null);
    onApply({
      range: parsed,
      groupByCol,
      aggregate,
      targetCols: [...targetCols],
      hasHeader,
      addOutline,
    });
    onClose();
  };

  const removeAll = () => {
    if (!parsed || !onRemoveAll) return;
    const absGroupCol = parsed.c1 + (groupByCol - 1);
    onRemoveAll(absGroupCol);
    onClose();
  };

  return (
    <div className="std-backdrop" onClick={onClose}>
      <div
        className="std-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="std-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="std-header">
          <h2 id="std-title" className="std-title">小計</h2>
          <button type="button" className="std-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="std-body">
          <label className="std-field">
            <span className="std-field-label">対象範囲</span>
            <input
              type="text"
              className="std-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <label className="std-checkbox">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
            />
            <span>先頭行をヘッダーとして扱う</span>
          </label>
          <label className="std-field">
            <span className="std-field-label">グループ化する列</span>
            <select
              className="std-select"
              value={groupByCol}
              onChange={(e) => setGroupByCol(parseInt(e.target.value, 10) || 1)}
              disabled={!parsed}
            >
              {columnLabels.map((c) => (
                <option key={c.idx} value={c.idx}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="std-field">
            <span className="std-field-label">集計の方法</span>
            <select
              className="std-select"
              value={aggregate}
              onChange={(e) => setAggregate(e.target.value as SubtotalFunction)}
            >
              {FUNCTIONS.map((fn) => (
                <option key={fn} value={fn}>
                  {fn}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="std-targets">
            <legend>集計する列（複数選択可）</legend>
            {columnLabels.length === 0 && (
              <p className="std-hint">範囲を正しく入力すると列の一覧が表示されます。</p>
            )}
            {columnLabels.map((c) => (
              <label key={c.idx} className="std-target-item">
                <input
                  type="checkbox"
                  checked={targetCols.includes(c.idx)}
                  onChange={() => toggleTarget(c.idx)}
                  disabled={c.idx === groupByCol}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="std-checkbox">
            <input
              type="checkbox"
              checked={addOutline}
              onChange={(e) => setAddOutline(e.target.checked)}
            />
            <span>アウトライン（折りたたみ）を追加する</span>
          </label>
          <p className="std-info">
            ヒント: 小計は事前にグループ列で並べ替えた範囲に対して適用します。
            並べ替えされていない場合、同じキーが連続する区間ごとに集計されます。
          </p>
          {error && <p className="std-error">{error}</p>}
        </div>
        <footer className="std-footer">
          <p className="std-hint">
            集計行と総計行をシートに直接挿入します。元に戻すには Ctrl+Alt+Z でスナップショットを復元してください。
          </p>
          <div className="std-footer-actions">
            <div>
              {onRemoveAll && (
                <button
                  type="button"
                  className="std-btn std-btn--danger"
                  onClick={removeAll}
                  disabled={!parsed}
                >
                  既存の小計をすべて削除
                </button>
              )}
            </div>
            <div className="std-footer-actions-right">
              <button type="button" className="std-btn" onClick={onClose}>
                キャンセル
              </button>
              <button type="button" className="std-btn std-btn--primary" onClick={submit}>
                適用
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
