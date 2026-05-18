import { useEffect, useMemo, useState } from "react";
import {
  compareRanges,
  listSheets,
  parseQualifiedA1Range,
  resolveSheetIdByName,
  summarizeRangeCompare,
  type RangeCompareDiff,
  type RangeRef,
} from "../store/rangeCompare";
import { getLocale } from "../i18n/locale";
import "./RangeCompareDialog.css";

// Local label bundle, mirroring SnapshotDiffDialog's pattern so the dialog
// is self-contained until matching keys are merged into src/i18n/locale.ts.
const RC_LABELS = {
  "ja-JP": {
    title: "範囲の比較",
    rangeA: "範囲 A",
    rangeB: "範囲 B",
    placeholder: "例: Sheet1!A1:C10",
    compare: "比較",
    valueDiffer: "値が違う",
    formulaOnly: "数式のみ違う",
    onlyA: "A のみ",
    onlyB: "B のみ",
    total: "合計",
    noDiff: "差分はありません。",
    invalid: "範囲の指定が正しくありません。Sheet1!A1:C10 形式で入力してください。",
    unknownSheet: "シートが見つかりません。",
    jump: "ジャンプ",
    formulaLabel: "数式",
    valueLabel: "値",
  },
  "en-US": {
    title: "Compare Ranges",
    rangeA: "Range A",
    rangeB: "Range B",
    placeholder: "e.g. Sheet1!A1:C10",
    compare: "Compare",
    valueDiffer: "Value differs",
    formulaOnly: "Formula only",
    onlyA: "Only in A",
    onlyB: "Only in B",
    total: "Total",
    noDiff: "No differences.",
    invalid: "Invalid range. Use the form Sheet1!A1:C10.",
    unknownSheet: "Sheet not found.",
    jump: "Jump",
    formulaLabel: "formula",
    valueLabel: "value",
  },
} as const;

type RcLabelKey = keyof (typeof RC_LABELS)["ja-JP"];

function rt(key: RcLabelKey): string {
  return RC_LABELS[getLocale()][key];
}

interface Props {
  initialRangeA: string;
  initialRangeB: string;
  workbookSnapshotJson: string;
  onJumpTo: (sheetId: string, cellRef: string) => void;
  onClose: () => void;
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[…]";
  if (typeof v === "object") return "{…}";
  return String(v);
}

function resolveRangeInput(
  expr: string,
  snapshotJson: string,
  fallbackSheetId: string | null,
): { ref: RangeRef | null; error: "invalid" | "unknown-sheet" | null } {
  const parsed = parseQualifiedA1Range(expr);
  if (!parsed) return { ref: null, error: "invalid" };
  let sheetId: string | null = null;
  if (parsed.sheetName) {
    sheetId = resolveSheetIdByName(snapshotJson, parsed.sheetName);
    if (!sheetId) return { ref: null, error: "unknown-sheet" };
  } else {
    sheetId = fallbackSheetId;
    if (!sheetId) return { ref: null, error: "unknown-sheet" };
  }
  return {
    ref: {
      sheetId,
      range: { r1: parsed.r1, c1: parsed.c1, r2: parsed.r2, c2: parsed.c2 },
    },
    error: null,
  };
}

export default function RangeCompareDialog({
  initialRangeA,
  initialRangeB,
  workbookSnapshotJson,
  onJumpTo,
  onClose,
}: Props) {
  const [rangeAText, setRangeAText] = useState(initialRangeA);
  const [rangeBText, setRangeBText] = useState(initialRangeB);
  const [results, setResults] = useState<RangeCompareDiff[] | null>(null);
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

  // Fallback sheet for bare ranges (no sheet prefix). First sheet in the
  // workbook's sheetOrder so the behaviour is deterministic across calls.
  const fallbackSheetId = useMemo(() => {
    const sheets = listSheets(workbookSnapshotJson);
    return sheets[0]?.sheetId ?? null;
  }, [workbookSnapshotJson]);

  const runCompare = () => {
    const a = resolveRangeInput(rangeAText, workbookSnapshotJson, fallbackSheetId);
    if (a.error) {
      setError(a.error === "invalid" ? rt("invalid") : rt("unknownSheet"));
      setResults(null);
      return;
    }
    const b = resolveRangeInput(rangeBText, workbookSnapshotJson, fallbackSheetId);
    if (b.error) {
      setError(b.error === "invalid" ? rt("invalid") : rt("unknownSheet"));
      setResults(null);
      return;
    }
    setError(null);
    setResults(compareRanges(workbookSnapshotJson, a.ref!, b.ref!));
  };

  const summary = useMemo(
    () => (results ? summarizeRangeCompare(results) : null),
    [results],
  );

  // Bucket by kind so the table is grouped by issue category.
  const grouped = useMemo(() => {
    if (!results) return [];
    const order: RangeCompareDiff["kind"][] = [
      "value-differ",
      "formula-differ-value-same",
      "only-in-a",
      "only-in-b",
    ];
    return order
      .map((kind) => ({
        kind,
        entries: results.filter((d) => d.kind === kind),
      }))
      .filter((g) => g.entries.length > 0);
  }, [results]);

  const labelForKind = (kind: RangeCompareDiff["kind"]): string => {
    switch (kind) {
      case "value-differ":
        return rt("valueDiffer");
      case "formula-differ-value-same":
        return rt("formulaOnly");
      case "only-in-a":
        return rt("onlyA");
      case "only-in-b":
        return rt("onlyB");
    }
  };

  return (
    <div className="rc-backdrop" onClick={onClose}>
      <div
        className="rc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rc-header">
          <h2 id="rc-title" className="rc-title">{rt("title")}</h2>
          <button type="button" className="rc-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>

        <div className="rc-inputs">
          <label className="rc-field">
            <span className="rc-field-label">{rt("rangeA")}</span>
            <input
              type="text"
              className="rc-input"
              value={rangeAText}
              onChange={(e) => setRangeAText(e.target.value)}
              placeholder={rt("placeholder")}
              autoFocus
            />
          </label>
          <label className="rc-field">
            <span className="rc-field-label">{rt("rangeB")}</span>
            <input
              type="text"
              className="rc-input"
              value={rangeBText}
              onChange={(e) => setRangeBText(e.target.value)}
              placeholder={rt("placeholder")}
            />
          </label>
          <button
            type="button"
            className="rc-btn rc-btn--primary"
            onClick={runCompare}
          >
            {rt("compare")}
          </button>
        </div>

        {error && <p className="rc-error">{error}</p>}

        {summary && (
          <div className="rc-summary">
            <span className="rc-summary__chip rc-summary__chip--value">
              Δ {summary.valueDiffer} {rt("valueDiffer")}
            </span>
            <span className="rc-summary__chip rc-summary__chip--formula">
              ƒ {summary.formulaOnly} {rt("formulaOnly")}
            </span>
            <span className="rc-summary__chip rc-summary__chip--only-a">
              A {summary.onlyA}
            </span>
            <span className="rc-summary__chip rc-summary__chip--only-b">
              B {summary.onlyB}
            </span>
            <span className="rc-summary__total">
              {rt("total")}: {summary.total}
            </span>
          </div>
        )}

        <div className="rc-body">
          {results && results.length === 0 && (
            <p className="rc-empty">{rt("noDiff")}</p>
          )}
          {grouped.map((group) => (
            <section key={group.kind} className="rc-group">
              <h3 className={`rc-group__title rc-group__title--${group.kind}`}>
                {labelForKind(group.kind)} ({group.entries.length})
              </h3>
              <ul className="rc-list">
                {group.entries.map((d, idx) => (
                  <li key={`${group.kind}:${idx}:${d.positionLabel}`} className="rc-row">
                    <span className="rc-row__pos">{d.positionLabel}</span>
                    <div className="rc-row__cells">
                      {d.aCell && (
                        <button
                          type="button"
                          className="rc-row__cell rc-row__cell--a"
                          onClick={() => onJumpTo(d.aCell!.sheetId, d.aCell!.cellRef)}
                          title={rt("jump")}
                        >
                          <span className="rc-row__ref">A · {d.aCell.cellRef}</span>
                          <span className="rc-row__val">{formatValue(d.aCell.value)}</span>
                          {d.aCell.formula !== undefined && (
                            <span className="rc-row__formula">={d.aCell.formula}</span>
                          )}
                        </button>
                      )}
                      {d.bCell && (
                        <button
                          type="button"
                          className="rc-row__cell rc-row__cell--b"
                          onClick={() => onJumpTo(d.bCell!.sheetId, d.bCell!.cellRef)}
                          title={rt("jump")}
                        >
                          <span className="rc-row__ref">B · {d.bCell.cellRef}</span>
                          <span className="rc-row__val">{formatValue(d.bCell.value)}</span>
                          {d.bCell.formula !== undefined && (
                            <span className="rc-row__formula">={d.bCell.formula}</span>
                          )}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
