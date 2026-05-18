import { useEffect, useMemo, useState } from "react";
import { getLocale } from "../i18n/locale";
import {
  applyOps,
  OP_LABELS,
  type BulkCleanOp,
  type BulkCleanParams,
} from "../store/bulkClean";
import "./BulkCleanDialog.css";

// Inline title strings — the global `t()` bundle is closed (StringKey is a
// literal union) and per task constraints we can't extend locale.ts. We mirror
// the existing ja/en split locally so the integrator can later promote these
// into locale.ts if they want a single source of truth.
const TITLE_JA = "データクリーニング";
const TITLE_EN = "Data Cleaning";
function dialogTitle(): string {
  return getLocale() === "en-US" ? TITLE_EN : TITLE_JA;
}
function isJa(): boolean {
  return getLocale() !== "en-US";
}

interface Props {
  /** Default A1 range (typically derived from the active selection). */
  initialRange: string;
  /** Up to 3 sample cell values for the live before/after preview pane. */
  preview: Array<{ original: string }>;
  onApply: (params: BulkCleanParams) => void;
  onClose: () => void;
}

// Bare or sheet-qualified A1 range. Single cells are allowed — cleaning one
// cell is still meaningful (Excel lets you TRIM a single cell too).
const RANGE_RE =
  /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

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

function parseRange(input: string): ParsedRange | null {
  const trimmed = input.trim();
  if (!RANGE_RE.test(trimmed)) return null;
  const bare = trimmed.includes("!") ? trimmed.split("!")[1] : trimmed;
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(bare);
  if (!m) return null;
  const c1 = colLettersToIdx(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = m[3] ? colLettersToIdx(m[3]) : c1;
  const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

// Operations are listed here in the order they appear in the dialog. Order
// inside the user's selection is captured separately (insertion order of the
// checkbox toggles) so the user can express e.g. "trim first, then upper".
const ALL_OPS: BulkCleanOp[] = [
  "trim",
  "clean",
  "normalizeNewlines",
  "stripApostrophe",
  "upper",
  "lower",
  "proper",
  "halfToFull",
  "fullToHalf",
  "hiraToKana",
  "kanaToHira",
];

function opLabel(op: BulkCleanOp): string {
  return isJa() ? OP_LABELS[op].ja : OP_LABELS[op].en;
}

export default function BulkCleanDialog({
  initialRange,
  preview,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  // Ordered list of selected ops — order is preserved so the user can express
  // a pipeline (e.g. clean → trim → upper). Toggling a checkbox appends or
  // removes; we never reshuffle the order on the user's behalf.
  const [selectedOps, setSelectedOps] = useState<BulkCleanOp[]>([]);
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

  const toggleOp = (op: BulkCleanOp) => {
    setSelectedOps((prev) => {
      if (prev.includes(op)) return prev.filter((o) => o !== op);
      return [...prev, op];
    });
  };

  // 1-based order indicator the dialog shows next to checked items.
  const orderIndex = (op: BulkCleanOp): number | null => {
    const i = selectedOps.indexOf(op);
    return i === -1 ? null : i + 1;
  };

  // Live preview: take up to 3 cells and render before/after side-by-side.
  // Empty strings still show so the user can see e.g. "  ←→ " after trim.
  const previewRows = useMemo(() => {
    return preview.slice(0, 3).map((row) => ({
      original: row.original,
      transformed: applyOps(row.original, selectedOps),
    }));
  }, [preview, selectedOps]);

  const ja = isJa();

  const submit = () => {
    const trimmed = range.trim();
    if (!trimmed) {
      setError(ja ? "範囲は必須です" : "Range is required");
      return;
    }
    const parsed = parseRange(trimmed);
    if (!parsed) {
      setError(
        ja
          ? "範囲は A1 形式で指定してください (例: A1:C10)"
          : "Range must be A1 notation (e.g. A1:C10)",
      );
      return;
    }
    if (selectedOps.length === 0) {
      setError(
        ja
          ? "少なくとも 1 つの操作を選択してください"
          : "Pick at least one operation",
      );
      return;
    }
    setError(null);
    onApply({ range: parsed, ops: selectedOps });
    onClose();
  };

  return (
    <div className="bcd-backdrop" onClick={onClose}>
      <div
        className="bcd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bcd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bcd-header">
          <h2 id="bcd-title" className="bcd-title">
            {dialogTitle()}
          </h2>
          <button
            type="button"
            className="bcd-close"
            onClick={onClose}
            aria-label={ja ? "閉じる" : "Close"}
          >
            ×
          </button>
        </header>
        <div className="bcd-body">
          <label className="bcd-field">
            <span className="bcd-field-label">
              {ja ? "対象範囲" : "Target range"}
            </span>
            <input
              type="text"
              className="bcd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>
          <fieldset className="bcd-ops">
            <legend className="bcd-field-label">
              {ja
                ? "適用する操作 (チェックした順に実行)"
                : "Operations (applied in the order you check them)"}
            </legend>
            <div className="bcd-ops-list">
              {ALL_OPS.map((op) => {
                const idx = orderIndex(op);
                return (
                  <label
                    key={op}
                    className="bcd-op-item"
                    data-testid={`bcd-op-${op}`}
                  >
                    <input
                      type="checkbox"
                      checked={idx !== null}
                      onChange={() => toggleOp(op)}
                    />
                    {idx !== null && (
                      <span className="bcd-op-order" aria-label={`order ${idx}`}>
                        {idx}
                      </span>
                    )}
                    <span className="bcd-op-label">{opLabel(op)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <section className="bcd-preview" aria-label="preview">
            <h3 className="bcd-field-label bcd-preview-title">
              {ja ? "プレビュー (最大 3 件)" : "Preview (up to 3 cells)"}
            </h3>
            {previewRows.length === 0 ? (
              <p className="bcd-hint">
                {ja
                  ? "対象範囲にプレビュー可能なセルがありません。"
                  : "No previewable cells in the target range."}
              </p>
            ) : (
              <table className="bcd-preview-table">
                <thead>
                  <tr>
                    <th>{ja ? "変換前" : "Before"}</th>
                    <th>{ja ? "変換後" : "After"}</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i}>
                      <td className="bcd-preview-cell bcd-preview-before">
                        {row.original}
                      </td>
                      <td
                        className={
                          row.transformed === row.original
                            ? "bcd-preview-cell"
                            : "bcd-preview-cell bcd-preview-after"
                        }
                      >
                        {row.transformed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {error && <p className="bcd-error">{error}</p>}
        </div>
        <footer className="bcd-footer">
          <p className="bcd-hint">
            {ja
              ? "数式セルは変更されません。文字列セルのみが対象です。"
              : "Formula cells are skipped. Only string cells are modified."}
          </p>
          <div className="bcd-footer-actions">
            <button type="button" className="bcd-btn" onClick={onClose}>
              {ja ? "キャンセル" : "Cancel"}
            </button>
            <button
              type="button"
              className="bcd-btn bcd-btn--primary"
              onClick={submit}
            >
              {ja ? "適用" : "Apply"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
