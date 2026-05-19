import { useEffect, useMemo, useState } from "react";
import type { SpellIssue } from "../store/spellCheck";
import "./SpellCheckDialog.css";

interface Props {
  /** Pre-collected spell issues; the caller (EditorScreen) builds this with
   *  `collectSpellIssues(snapshot, userDict)` so the dialog stays decoupled
   *  from the snapshot shape. */
  issues: SpellIssue[];
  /** Apply a replacement to the offending cell. The caller writes
   *  `<replacement>` into the snapshot at the issue's (sheetId, cellRef)
   *  by splicing it into `cellValue` at `[offset, offset + word.length)`. */
  onChange: (issue: SpellIssue, replacement: string) => void;
  /** Skip just this one occurrence — no snapshot change. */
  onIgnore: () => void;
  /** Skip every remaining occurrence of `word` (any casing) for the rest of
   *  this session. The dialog drops them from its working set. */
  onIgnoreAll: (word: string) => void;
  /** Persist `word` into the user's custom dictionary (localStorage) and drop
   *  every remaining occurrence from the working set. */
  onAddToDictionary: (word: string) => void;
  /** Close the dialog and select the cell so the user can edit it manually. */
  onJumpToCell: (sheetId: string, cellRef: string) => void;
  /** Dismiss (X, Esc, Close, or "no more issues"). */
  onClose: () => void;
}

/**
 * Stepper modal for the spell-check tool. Mirrors Word's "Spelling & Grammar"
 * pane but slimmed to the MVP controls:
 *
 *   - Change: rewrite the cell value with the chosen suggestion (or the
 *     selected suggestion if the user clicked a chip first).
 *   - Ignore: skip just this occurrence.
 *   - Ignore All: skip every remaining occurrence of the same word.
 *   - Add to Dictionary: persist the word to localStorage and treat it as
 *     correct for this session and all future sessions.
 *   - Edit Cell: close the dialog and jump to the cell.
 *
 * When the working set empties, the dialog shows a "no more issues" pane.
 */
export default function SpellCheckDialog({
  issues,
  onChange,
  onIgnore,
  onIgnoreAll,
  onAddToDictionary,
  onJumpToCell,
  onClose,
}: Props) {
  const initialSet = useMemo<SpellIssue[]>(() => [...issues], [issues]);
  const [remaining, setRemaining] = useState<SpellIssue[]>(initialSet);
  const [index, setIndex] = useState(0);
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null);

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

  const total = remaining.length;
  const cur = total > 0 ? Math.min(index, total - 1) : 0;
  const current = total > 0 ? remaining[cur] : null;
  const totalOriginal = initialSet.length;

  // Reset suggestion selection whenever the focused issue changes — otherwise
  // a previously-chosen suggestion would carry across to a different word.
  useEffect(() => {
    if (!current) {
      setSelectedSuggestion(null);
      return;
    }
    setSelectedSuggestion(current.suggestions[0] ?? null);
  }, [current?.sheetId, current?.cellRef, current?.offset, current?.word]);
  // ^ depend on the issue identity, not the object ref (which is stable here).

  // Drop the head of the working set after an action and step the cursor so
  // the user keeps moving forward. Used by Change / Ignore / Ignore All /
  // Add to Dictionary.
  const advance = (filter: (issue: SpellIssue) => boolean) => {
    setRemaining((prev) => {
      const next = prev.filter(filter);
      // Keep `index` pointing at the slot we were on; if we ran off the end,
      // clamp to the last entry (or 0 when empty).
      setIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
      return next;
    });
  };

  const handleChange = () => {
    if (!current) return;
    const replacement = selectedSuggestion ?? current.suggestions[0];
    if (!replacement) return;
    onChange(current, replacement);
    // Drop this specific occurrence (one cell/offset can only be wrong once
    // per scan — but `cellRef + offset` is the safe identity).
    advance(
      (i) =>
        !(i.sheetId === current.sheetId &&
          i.cellRef === current.cellRef &&
          i.offset === current.offset),
    );
  };

  const handleIgnore = () => {
    if (!current) return;
    onIgnore();
    advance(
      (i) =>
        !(i.sheetId === current.sheetId &&
          i.cellRef === current.cellRef &&
          i.offset === current.offset),
    );
  };

  const handleIgnoreAll = () => {
    if (!current) return;
    const lower = current.word.toLowerCase();
    onIgnoreAll(current.word);
    advance((i) => i.word.toLowerCase() !== lower);
  };

  const handleAddToDictionary = () => {
    if (!current) return;
    const lower = current.word.toLowerCase();
    onAddToDictionary(current.word);
    advance((i) => i.word.toLowerCase() !== lower);
  };

  const handleEditCell = () => {
    if (!current) return;
    onJumpToCell(current.sheetId, current.cellRef);
    onClose();
  };

  // Build the highlighted context: text before / misspelled word / text after.
  // We render the surrounding cell value verbatim with the offending run
  // wrapped in <mark> so the user sees exactly where the issue is.
  const renderContext = (issue: SpellIssue) => {
    const before = issue.cellValue.slice(0, issue.offset);
    const word = issue.cellValue.slice(issue.offset, issue.offset + issue.word.length);
    const after = issue.cellValue.slice(issue.offset + issue.word.length);
    return (
      <>
        <span>{before}</span>
        <mark className="scd-mark">{word}</mark>
        <span>{after}</span>
      </>
    );
  };

  return (
    <div className="scd-backdrop" onClick={onClose}>
      <div
        className="scd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="scd-header">
          <h2 id="scd-title" className="scd-title">
            スペルチェック (英語)
          </h2>
          <button
            type="button"
            className="scd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        {current ? (
          <>
            <div className="scd-body">
              <p className="scd-counter">
                問題 {cur + 1} / {total}
                {totalOriginal !== total && (
                  <span className="scd-counter-orig"> (元 {totalOriginal})</span>
                )}
                : <code className="scd-code">{current.cellRef}</code> on{" "}
                <span className="scd-sheet">{current.sheetName}</span>
              </p>
              <div className="scd-context-label">該当箇所:</div>
              <div className="scd-context">{renderContext(current)}</div>
              <div className="scd-word-row">
                <span className="scd-label">辞書にない語:</span>
                <code className="scd-word">{current.word}</code>
              </div>
              <div className="scd-suggest-label">候補:</div>
              {current.suggestions.length > 0 ? (
                <div className="scd-suggestions">
                  {current.suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={
                        "scd-suggestion" +
                        (s === selectedSuggestion ? " scd-suggestion--active" : "")
                      }
                      onClick={() => setSelectedSuggestion(s)}
                      onDoubleClick={() => {
                        setSelectedSuggestion(s);
                        // Apply on double-click for power users.
                        onChange(current, s);
                        advance(
                          (i) =>
                            !(i.sheetId === current.sheetId &&
                              i.cellRef === current.cellRef &&
                              i.offset === current.offset),
                        );
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="scd-no-suggestions">候補は見つかりませんでした。</p>
              )}
            </div>
            <footer className="scd-footer">
              <div className="scd-actions">
                <button
                  type="button"
                  className="scd-btn"
                  onClick={handleIgnore}
                >
                  無視
                </button>
                <button
                  type="button"
                  className="scd-btn"
                  onClick={handleIgnoreAll}
                >
                  すべて無視
                </button>
                <button
                  type="button"
                  className="scd-btn"
                  onClick={handleAddToDictionary}
                >
                  辞書に追加
                </button>
                <button
                  type="button"
                  className="scd-btn"
                  onClick={handleEditCell}
                >
                  セルを編集
                </button>
                <button
                  type="button"
                  className="scd-btn scd-btn--primary"
                  onClick={handleChange}
                  disabled={!selectedSuggestion}
                >
                  変更
                </button>
              </div>
            </footer>
          </>
        ) : (
          <>
            <div className="scd-body scd-body--empty">
              <p className="scd-empty">
                {totalOriginal === 0
                  ? "スペルミスは見つかりませんでした。"
                  : "すべての問題を処理しました。"}
              </p>
            </div>
            <footer className="scd-footer">
              <div className="scd-actions">
                <button
                  type="button"
                  className="scd-btn scd-btn--primary"
                  onClick={onClose}
                >
                  閉じる
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
