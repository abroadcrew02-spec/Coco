import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAll,
  replaceAll,
  replaceOne,
  type FindMatch,
  type FindReplaceParams,
  type FindReplaceScope,
} from "../store/findReplaceAll";
import "./FindReplaceAllDialog.css";

interface Props {
  activeSheetId: string | null;
  workbookSnapshotJson: string;
  onReplaceCommit: (newSnapshotJson: string) => void;
  onJumpToCell: (sheetId: string, cellRef: string) => void;
  onClose: () => void;
}

// Cap rendered rows so a "Find All" against a wildcard pattern in a huge
// sheet doesn't freeze the dialog. Internal match arrays remain complete —
// only the table is windowed.
const RESULT_DISPLAY_CAP = 1000;
// How much of the matched cell value to surface in the preview column. Long
// strings get an ellipsis; we centre the slice around the match position so
// the user can see what they actually matched.
const PREVIEW_RADIUS = 40;

function buildPreview(match: FindMatch): string {
  const value = match.value ?? "";
  if (match.matchStart < 0) {
    // Whole-cell hit — just truncate from the start.
    return value.length > PREVIEW_RADIUS * 2
      ? value.slice(0, PREVIEW_RADIUS * 2) + "…"
      : value;
  }
  const start = Math.max(0, match.matchStart - PREVIEW_RADIUS);
  const end = Math.min(value.length, match.matchStart + match.matchLength + PREVIEW_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return prefix + value.slice(start, end) + suffix;
}

export default function FindReplaceAllDialog({
  activeSheetId,
  workbookSnapshotJson,
  onReplaceCommit,
  onJumpToCell,
  onClose,
}: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [matchEntireCell, setMatchEntireCell] = useState(false);
  const [scope, setScope] = useState<FindReplaceScope>("workbook");
  const [searchBy, setSearchBy] = useState<"rows" | "columns">("rows");
  const [results, setResults] = useState<FindMatch[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [status, setStatus] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  // Snapshot we operate against — held locally so successive Replace clicks
  // see the result of the previous one without waiting for the parent to
  // round-trip. Sync to workbookSnapshotJson when the prop changes.
  const [snapshotJson, setSnapshotJson] = useState(workbookSnapshotJson);

  useEffect(() => {
    setSnapshotJson(workbookSnapshotJson);
  }, [workbookSnapshotJson]);

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

  // Build the params payload once per render so the action handlers stay
  // small. Keep this synchronous — none of the helpers are async.
  const params = useMemo<FindReplaceParams>(
    () => ({
      find,
      replace,
      isRegex,
      matchCase,
      matchEntireCell,
      scope,
      activeSheetId,
      searchBy,
    }),
    [find, replace, isRegex, matchCase, matchEntireCell, scope, activeSheetId, searchBy],
  );

  // Parse the snapshot lazily — JSON.parse is the expensive bit and we don't
  // want to re-parse on every keystroke. Failure falls back to an empty
  // object so findAll/replaceAll just return zero results.
  const parsedSnapshot = useMemo<unknown>(() => {
    try {
      return JSON.parse(snapshotJson);
    } catch {
      return null;
    }
  }, [snapshotJson]);

  const handleFindAll = useCallback(() => {
    if (!find) {
      setResults([]);
      setSelectedIndex(-1);
      setStatus({ kind: "info", text: "検索文字列を入力してください" });
      return;
    }
    const matches = findAll(parsedSnapshot, params);
    setResults(matches);
    setSelectedIndex(matches.length > 0 ? 0 : -1);
    setStatus({
      kind: "info",
      text: `${matches.length} 件見つかりました`,
    });
  }, [find, parsedSnapshot, params]);

  const handleReplaceAll = useCallback(() => {
    if (!find) {
      setStatus({ kind: "info", text: "検索文字列を入力してください" });
      return;
    }
    const { snapshotMutated, replacedCount } = replaceAll(parsedSnapshot, params);
    if (replacedCount === 0) {
      setStatus({ kind: "info", text: "置換対象は見つかりませんでした" });
      return;
    }
    const nextJson = JSON.stringify(snapshotMutated);
    setSnapshotJson(nextJson);
    onReplaceCommit(nextJson);
    // Re-find against the new state so the table reflects what's left
    // (typically 0, unless the replacement itself matches).
    const rescanned = findAll(snapshotMutated, params);
    setResults(rescanned);
    setSelectedIndex(rescanned.length > 0 ? 0 : -1);
    setStatus({ kind: "info", text: `${replacedCount} 件置換しました` });
  }, [find, parsedSnapshot, params, onReplaceCommit]);

  const handleReplaceOne = useCallback(() => {
    if (results.length === 0 || selectedIndex < 0 || selectedIndex >= results.length) {
      setStatus({ kind: "info", text: "結果を選択してから置換してください" });
      return;
    }
    const match = results[selectedIndex];
    const replacement = replace ?? "";
    const mutated = replaceOne(parsedSnapshot, match, replacement);
    const nextJson = JSON.stringify(mutated);
    setSnapshotJson(nextJson);
    onReplaceCommit(nextJson);
    // Re-scan so subsequent offsets are valid after a length-changing edit.
    const rescanned = findAll(mutated, params);
    setResults(rescanned);
    if (rescanned.length === 0) {
      setSelectedIndex(-1);
      setStatus({ kind: "info", text: "1 件置換しました — 残りはありません" });
      return;
    }
    // Move selection to the next hit after the one we just consumed.
    setSelectedIndex(Math.min(selectedIndex, rescanned.length - 1));
    setStatus({ kind: "info", text: "1 件置換しました" });
  }, [results, selectedIndex, replace, parsedSnapshot, params, onReplaceCommit]);

  const handleRowClick = useCallback(
    (idx: number) => {
      setSelectedIndex(idx);
      const match = results[idx];
      if (!match) return;
      onJumpToCell(match.sheetId, match.cellRef);
    },
    [results, onJumpToCell],
  );

  const handleRowDoubleClick = useCallback(
    (idx: number) => {
      const match = results[idx];
      if (!match) return;
      onJumpToCell(match.sheetId, match.cellRef);
      onClose();
    },
    [results, onJumpToCell, onClose],
  );

  const displayResults = results.slice(0, RESULT_DISPLAY_CAP);
  const overflow = results.length - displayResults.length;

  return (
    <div className="fra-backdrop" onClick={onClose}>
      <div
        className="fra-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fra-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fra-header">
          <h2 id="fra-title" className="fra-title">検索と置換 (全シート)</h2>
          <button type="button" className="fra-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="fra-body">
          <label className="fra-field">
            <span className="fra-field-label">検索する文字列</span>
            <input
              type="text"
              className="fra-input"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleFindAll();
                }
              }}
            />
          </label>
          <label className="fra-field">
            <span className="fra-field-label">置換後の文字列</span>
            <input
              type="text"
              className="fra-input"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
            />
          </label>
          <div className="fra-options">
            <label className="fra-checkbox">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />
              <span>大文字と小文字を区別する</span>
            </label>
            <label className="fra-checkbox">
              <input
                type="checkbox"
                checked={matchEntireCell}
                onChange={(e) => setMatchEntireCell(e.target.checked)}
              />
              <span>セル全体を一致対象にする</span>
            </label>
            <label className="fra-checkbox">
              <input
                type="checkbox"
                checked={isRegex}
                onChange={(e) => setIsRegex(e.target.checked)}
              />
              <span>正規表現を使う</span>
            </label>
          </div>
          <div className="fra-options">
            <label className="fra-select-field">
              <span>検索対象</span>
              <select
                className="fra-select"
                value={scope}
                onChange={(e) => setScope(e.target.value as FindReplaceScope)}
              >
                <option value="sheet">アクティブシートのみ</option>
                <option value="workbook">ブック全体</option>
              </select>
            </label>
            <label className="fra-select-field">
              <span>検索方向</span>
              <select
                className="fra-select"
                value={searchBy}
                onChange={(e) => setSearchBy(e.target.value as "rows" | "columns")}
              >
                <option value="rows">行 (左→右, 上→下)</option>
                <option value="columns">列 (上→下, 左→右)</option>
              </select>
            </label>
          </div>
          <div className="fra-results">
            <div className="fra-results-header">
              <span>シート</span>
              <span>セル</span>
              <span>値</span>
              <span>プレビュー</span>
            </div>
            <div className="fra-results-body" role="listbox" aria-label="検索結果">
              {displayResults.length === 0 && (
                <div className="fra-empty">「すべて検索」をクリックすると結果が表示されます</div>
              )}
              {displayResults.map((m, idx) => (
                <div
                  key={`${m.sheetId}:${m.row}:${m.col}:${m.matchStart}:${idx}`}
                  className={`fra-result-row${idx === selectedIndex ? " is-selected" : ""}`}
                  role="option"
                  aria-selected={idx === selectedIndex}
                  onClick={() => handleRowClick(idx)}
                  onDoubleClick={() => handleRowDoubleClick(idx)}
                >
                  <span className="fra-cell" title={m.sheetName}>{m.sheetName}</span>
                  <span className="fra-cell">{m.cellRef}</span>
                  <span className="fra-cell" title={m.value}>{m.value}</span>
                  <span className="fra-cell fra-cell--preview">{buildPreview(m)}</span>
                </div>
              ))}
              {overflow > 0 && (
                <div className="fra-overflow">
                  …他に {overflow} 件あります (上限 {RESULT_DISPLAY_CAP} 件まで表示)
                </div>
              )}
            </div>
          </div>
          {status && (
            <p className={`fra-status fra-status--${status.kind}`}>{status.text}</p>
          )}
        </div>
        <footer className="fra-footer">
          <button type="button" className="fra-btn" onClick={onClose}>
            閉じる
          </button>
          <div className="fra-footer-actions">
            <button type="button" className="fra-btn" onClick={handleFindAll}>
              すべて検索
            </button>
            <button
              type="button"
              className="fra-btn"
              onClick={handleReplaceOne}
              disabled={selectedIndex < 0}
            >
              置換
            </button>
            <button type="button" className="fra-btn fra-btn--primary" onClick={handleReplaceAll}>
              すべて置換
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
