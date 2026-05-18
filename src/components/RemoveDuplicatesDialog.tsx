import { useEffect, useMemo, useState } from "react";
import { getLocale } from "../i18n/locale";
import type { RemoveDuplicatesParams } from "../store/removeDuplicates";
import "./RemoveDuplicatesDialog.css";

// Inline title strings — the global `t()` bundle is closed (StringKey is a
// literal union) and per task constraints we can't extend locale.ts. We mirror
// the existing ja/en split locally so the integrator can later promote these
// into locale.ts if they want a single source of truth.
const TITLE_JA = "重複の削除";
const TITLE_EN = "Remove Duplicates";
function dialogTitle(): string {
  return getLocale() === "en-US" ? TITLE_EN : TITLE_JA;
}

interface Props {
  /** Default A1 range (typically derived from the active selection). */
  initialRange: string;
  /** Active sheet id — kept for parity with applyToSheet callers. */
  sheetId: string;
  /** Raw Univer snapshot for the sheet so the dialog can render header cells. */
  sheetSnapshot: { cellData?: Record<string, Record<string, unknown>> };
  onApply: (params: RemoveDuplicatesParams) => void;
  onClose: () => void;
}

// Bare or sheet-qualified rectangular A1 range. Single-cell refs are rejected
// — deduplicating a single cell is meaningless.
const RANGE_RE =
  /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*$/;

interface ParsedRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function colLettersToIdx(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function colIdxToLetters(idx: number): string {
  let n = idx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseRange(input: string): ParsedRange | null {
  const trimmed = input.trim();
  if (!RANGE_RE.test(trimmed)) return null;
  const bare = trimmed.includes("!") ? trimmed.split("!")[1] : trimmed;
  const m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(bare);
  if (!m) return null;
  const c1 = colLettersToIdx(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = colLettersToIdx(m[3]);
  const r2 = parseInt(m[4], 10) - 1;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

function readHeaderLabel(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell !== "object") {
    const s = String(cell).trim();
    return s.length > 0 ? s : null;
  }
  const c = cell as { v?: unknown };
  if (c.v === undefined || c.v === null) return null;
  const s = String(c.v).trim();
  return s.length > 0 ? s : null;
}

export default function RemoveDuplicatesDialog({
  initialRange,
  sheetSnapshot,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [hasHeader, setHasHeader] = useState(true);
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null until the user has touched the column list; we then preserve their
  // pick across range edits unless the column count changes underneath them.
  const [selectedCols, setSelectedCols] = useState<Set<number> | null>(null);

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

  const parsed = useMemo(() => parseRange(range), [range]);

  // Column descriptors derived from the parsed range. Labels prefer the
  // header-row value when `hasHeader` is on, otherwise fall back to "Column N"
  // (1-based, so the first column inside the range is "Column 1").
  const columns = useMemo(() => {
    if (!parsed) return [] as Array<{ offset: number; letter: string; label: string }>;
    const headerRow =
      hasHeader && sheetSnapshot.cellData?.[String(parsed.r1)]
        ? sheetSnapshot.cellData[String(parsed.r1)]
        : null;
    const out: Array<{ offset: number; letter: string; label: string }> = [];
    for (let offset = 0; offset <= parsed.c2 - parsed.c1; offset++) {
      const absCol = parsed.c1 + offset;
      const letter = colIdxToLetters(absCol);
      const headerLabel = headerRow
        ? readHeaderLabel(headerRow[String(absCol)])
        : null;
      out.push({
        offset,
        letter,
        label: headerLabel ?? `Column ${offset + 1}`,
      });
    }
    return out;
  }, [parsed, hasHeader, sheetSnapshot]);

  // Default-select all columns whenever the column count changes (range edits,
  // header toggles that re-derive labels but not count, etc).
  useEffect(() => {
    if (selectedCols === null) return;
    const expected = columns.length;
    if (expected !== selectedCols.size) {
      // Range changed shape under us — reset to "all selected".
      setSelectedCols(null);
    }
  }, [columns.length, selectedCols]);

  const effectiveSelected = useMemo(() => {
    if (selectedCols) return selectedCols;
    return new Set(columns.map((c) => c.offset));
  }, [selectedCols, columns]);

  const toggleCol = (offset: number) => {
    const next = new Set(effectiveSelected);
    if (next.has(offset)) next.delete(offset);
    else next.add(offset);
    setSelectedCols(next);
  };

  const selectAll = () => {
    setSelectedCols(new Set(columns.map((c) => c.offset)));
  };

  const clearAll = () => {
    setSelectedCols(new Set());
  };

  const submit = () => {
    if (!range.trim()) {
      setError("範囲は必須です");
      return;
    }
    if (!parsed) {
      setError("範囲は複数セルの A1 形式で指定してください (例: A1:C10)");
      return;
    }
    const keyCols = Array.from(effectiveSelected).sort((a, b) => a - b);
    if (keyCols.length === 0) {
      setError("少なくとも 1 列を選択してください");
      return;
    }
    setError(null);
    onApply({
      range: { r1: parsed.r1, c1: parsed.c1, r2: parsed.r2, c2: parsed.c2 },
      hasHeader,
      keyCols,
      caseInsensitive,
    });
    onClose();
  };

  return (
    <div className="rdd-backdrop" onClick={onClose}>
      <div
        className="rdd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rdd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rdd-header">
          <h2 id="rdd-title" className="rdd-title">
            {dialogTitle()}
          </h2>
          <button
            type="button"
            className="rdd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="rdd-body">
          <label className="rdd-field">
            <span className="rdd-field-label">対象範囲</span>
            <input
              type="text"
              className="rdd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <label className="rdd-checkbox">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
            />
            <span>先頭行をヘッダーとして除外する</span>
          </label>
          <label className="rdd-checkbox">
            <input
              type="checkbox"
              checked={caseInsensitive}
              onChange={(e) => setCaseInsensitive(e.target.checked)}
            />
            <span>大文字と小文字を区別しない</span>
          </label>
          <fieldset className="rdd-cols">
            <legend className="rdd-field-label">キー列 (重複判定に使用)</legend>
            <div className="rdd-cols-toolbar">
              <button
                type="button"
                className="rdd-btn rdd-btn--ghost"
                onClick={selectAll}
                disabled={columns.length === 0}
              >
                すべて選択
              </button>
              <button
                type="button"
                className="rdd-btn rdd-btn--ghost"
                onClick={clearAll}
                disabled={columns.length === 0}
              >
                すべて解除
              </button>
            </div>
            <div className="rdd-cols-list">
              {columns.length === 0 && (
                <p className="rdd-hint">範囲を入力すると列が表示されます。</p>
              )}
              {columns.map((c) => (
                <label
                  key={c.offset}
                  className="rdd-col-item"
                  data-testid={`rdd-col-${c.offset}`}
                >
                  <input
                    type="checkbox"
                    checked={effectiveSelected.has(c.offset)}
                    onChange={() => toggleCol(c.offset)}
                  />
                  <span className="rdd-col-letter">{c.letter}</span>
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && <p className="rdd-error">{error}</p>}
        </div>
        <footer className="rdd-footer">
          <p className="rdd-hint">
            選択されたキー列の値を結合してハッシュキーを作り、最初に出現した行のみを残します。
            残された行は元の順序を保ち、削除された分だけ下の行が上に詰められます。
          </p>
          <div className="rdd-footer-actions">
            <button type="button" className="rdd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="rdd-btn rdd-btn--primary"
              onClick={submit}
            >
              重複を削除
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
