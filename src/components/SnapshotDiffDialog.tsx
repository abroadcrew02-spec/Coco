import { useEffect, useMemo, useState } from "react";
import {
  diffSnapshots,
  summarizeDiff,
  type DiffEntry,
} from "../store/snapshotDiff";
import { getLocale } from "../i18n/locale";
import "./SnapshotDiffDialog.css";

// Local label bundle so the dialog stays self-contained until the matching
// keys are merged into src/i18n/locale.ts. Pulls the active locale via
// getLocale() so it still flips ja-JP / en-US in lockstep with the rest
// of the app. Keys mirror the deliverable's i18n list one-for-one.
const DIFF_LABELS = {
  "ja-JP": {
    title: "スナップショット比較",
    before: "比較元（旧）",
    after: "比較先（新）",
    empty: "（スナップショットがありません）",
    sameSelection: "同じスナップショットを比較しています。",
    sheets: "シート",
    loading: "読み込み中...",
    noChanges: "差分はありません。",
    jump: "このセルへ",
  },
  "en-US": {
    title: "Compare Snapshots",
    before: "Before",
    after: "After",
    empty: "(no snapshots)",
    sameSelection: "Both pickers point at the same snapshot.",
    sheets: "Sheets",
    loading: "Loading...",
    noChanges: "No differences.",
    jump: "Jump",
  },
} as const;

type DiffLabelKey = keyof (typeof DIFF_LABELS)["ja-JP"];

function dt(key: DiffLabelKey): string {
  return DIFF_LABELS[getLocale()][key];
}

export interface SnapshotOption {
  id: string;
  label: string;
}

interface Props {
  availableSnapshots: SnapshotOption[];
  loadSnapshotJson: (id: string) => Promise<string | null>;
  onJumpTo: (sheetId: string, cellRef: string) => void;
  onClose: () => void;
}

// Stringify diff cell values for the side-by-side columns. Keep it short
// enough to fit a list row — objects (rich text) collapse to "{…}", arrays
// to "[…]" so the row stays scannable.
function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[…]";
  if (typeof v === "object") return "{…}";
  return String(v);
}

export default function SnapshotDiffDialog({
  availableSnapshots,
  loadSnapshotJson,
  onJumpTo,
  onClose,
}: Props) {
  // Default the "before" picker to the second-most-recent snapshot and the
  // "after" picker to the most recent. The caller passes snapshots in
  // newest-first order (matches SnapshotHistoryDialog).
  const [aId, setAId] = useState<string>(() =>
    availableSnapshots.length >= 2
      ? availableSnapshots[1].id
      : availableSnapshots[0]?.id ?? ""
  );
  const [bId, setBId] = useState<string>(() => availableSnapshots[0]?.id ?? "");
  const [aJson, setAJson] = useState<string | null>(null);
  const [bJson, setBJson] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  // Load both snapshot bodies whenever either picker changes. Latch the
  // request id so an in-flight load doesn't clobber a newer selection.
  useEffect(() => {
    if (!aId || !bId) {
      setAJson(null);
      setBJson(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadSnapshotJson(aId), loadSnapshotJson(bId)])
      .then(([a, b]) => {
        if (cancelled) return;
        if (a === null || b === null) {
          setError("スナップショットの読み込みに失敗しました。");
          setAJson(null);
          setBJson(null);
        } else {
          setAJson(a);
          setBJson(b);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError("スナップショットの読み込みに失敗しました。");
        setAJson(null);
        setBJson(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId, loadSnapshotJson]);

  const diffs: DiffEntry[] = useMemo(() => {
    if (!aJson || !bJson) return [];
    if (aId === bId) return [];
    return diffSnapshots(aJson, bJson);
  }, [aJson, bJson, aId, bId]);

  const summary = useMemo(() => summarizeDiff(diffs), [diffs]);

  const grouped = useMemo(() => {
    const map = new Map<string, { sheetName: string; entries: DiffEntry[] }>();
    for (const d of diffs) {
      const existing = map.get(d.sheetId);
      if (existing) existing.entries.push(d);
      else map.set(d.sheetId, { sheetName: d.sheetName, entries: [d] });
    }
    return Array.from(map.entries());
  }, [diffs]);

  const sameSelection = aId === bId && aId !== "";
  const ready = !!aJson && !!bJson && !sameSelection;

  return (
    <div className="snapshot-diff-backdrop" onClick={onClose}>
      <div
        className="snapshot-diff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-diff-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="snapshot-diff-header">
          <h2 id="snapshot-diff-title" className="snapshot-diff-title">
            {dt("title")}
          </h2>
          <button
            type="button"
            className="snapshot-diff-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="snapshot-diff-pickers">
          <label className="snapshot-diff-picker">
            <span className="snapshot-diff-picker__label">
              {dt("before")}
            </span>
            <select
              value={aId}
              onChange={(e) => setAId(e.target.value)}
              disabled={availableSnapshots.length === 0}
            >
              {availableSnapshots.length === 0 && (
                <option value="">{dt("empty")}</option>
              )}
              {availableSnapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <span className="snapshot-diff-pickers__arrow" aria-hidden="true">→</span>
          <label className="snapshot-diff-picker">
            <span className="snapshot-diff-picker__label">
              {dt("after")}
            </span>
            <select
              value={bId}
              onChange={(e) => setBId(e.target.value)}
              disabled={availableSnapshots.length === 0}
            >
              {availableSnapshots.length === 0 && (
                <option value="">{dt("empty")}</option>
              )}
              {availableSnapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {sameSelection && (
          <p className="snapshot-diff-hint">
            {dt("sameSelection")}
          </p>
        )}
        {error && <p className="snapshot-diff-error">{error}</p>}

        {ready && (
          <div className="snapshot-diff-summary">
            <span className="snapshot-diff-summary__chip snapshot-diff-summary__chip--added">
              + {summary.added}
            </span>
            <span className="snapshot-diff-summary__chip snapshot-diff-summary__chip--removed">
              − {summary.removed}
            </span>
            <span className="snapshot-diff-summary__chip snapshot-diff-summary__chip--changed">
              Δ {summary.changed}
            </span>
            <span className="snapshot-diff-summary__sheets">
              {dt("sheets")}: {summary.sheets}
            </span>
          </div>
        )}

        <div className="snapshot-diff-body">
          {loading && (
            <p className="snapshot-diff-empty">{dt("loading")}</p>
          )}
          {!loading && ready && diffs.length === 0 && (
            <p className="snapshot-diff-empty">{dt("noChanges")}</p>
          )}
          {!loading && ready && grouped.length > 0 && (
            <div className="snapshot-diff-groups">
              {grouped.map(([sheetId, group]) => (
                <section key={sheetId} className="snapshot-diff-group">
                  <h3 className="snapshot-diff-group__title">{group.sheetName}</h3>
                  <ul className="snapshot-diff-list">
                    {group.entries.map((d) => (
                      <li
                        key={`${d.sheetId}:${d.row}:${d.col}:${d.kind}`}
                        className={`snapshot-diff-row snapshot-diff-row--${d.kind}`}
                      >
                        <span className="snapshot-diff-row__kind" aria-hidden="true">
                          {d.kind === "added" ? "+" : d.kind === "removed" ? "−" : "Δ"}
                        </span>
                        <span className="snapshot-diff-row__cell">{d.cellRef}</span>
                        <span className="snapshot-diff-row__values">
                          <span
                            className="snapshot-diff-row__old"
                            title={formatValue(d.oldValue)}
                          >
                            {formatValue(d.oldValue)}
                          </span>
                          <span className="snapshot-diff-row__arrow" aria-hidden="true">
                            →
                          </span>
                          <span
                            className="snapshot-diff-row__new"
                            title={formatValue(d.newValue)}
                          >
                            {formatValue(d.newValue)}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="snapshot-diff-row__jump"
                          onClick={() => onJumpTo(d.sheetId, d.cellRef)}
                          title={dt("jump")}
                        >
                          {dt("jump")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
