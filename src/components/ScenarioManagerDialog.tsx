import { useEffect, useMemo, useState } from "react";
import type { ScenarioEntry } from "../store/scenarios";
import "./ScenarioManagerDialog.css";

// A1 cell ref, optionally sheet-qualified ("Sheet1!B2") and with absolute
// markers ($A$1). Single-cell only — scenarios are cell-level.
const CELL_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*$/;

interface Props {
  scenarios: ScenarioEntry[];
  onApply: (scenario: ScenarioEntry) => void;
  onAdd: (entry: Omit<ScenarioEntry, "createdAt">) => void;
  onDelete: (name: string) => void;
  onSummary: (resultCells: string[]) => void;
  onClose: () => void;
}

/** Parse multi-line / comma / whitespace separated cell list into A1 refs. */
function parseCellList(raw: string): { cells: string[]; error: string | null } {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { cells: [], error: "セル参照を 1 件以上入力してください" };
  for (const tok of tokens) {
    if (!CELL_RE.test(tok)) {
      return { cells: [], error: `不正なセル参照: ${tok}` };
    }
  }
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }
  return { cells: deduped, error: null };
}

export default function ScenarioManagerDialog({
  scenarios,
  onApply,
  onAdd,
  onDelete,
  onSummary,
  onClose,
}: Props) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [cellsText, setCellsText] = useState("");
  const [resultCellsText, setResultCellsText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

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

  const sortedScenarios = useMemo(
    () =>
      [...scenarios].sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      ),
    [scenarios],
  );

  const handleAdd = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("シナリオ名は必須です");
      return;
    }
    if (
      scenarios.some(
        (s) => s.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      )
    ) {
      setFormError("同じ名前のシナリオが既に存在します");
      return;
    }
    const { cells, error } = parseCellList(cellsText);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    onAdd({
      name: trimmedName,
      comment: comment.trim() || undefined,
      changingCells: cells,
      // The caller (EditorScreen) is responsible for snapshotting current
      // cell values via the ScenarioAdapter and merging them in — we leave
      // `values` empty here so this dialog stays free of FUniver access.
      values: {},
    });
    setName("");
    setComment("");
    setCellsText("");
  };

  const handleSummary = () => {
    const raw = resultCellsText.trim();
    if (!raw) {
      onSummary([]);
      return;
    }
    const { cells, error } = parseCellList(raw);
    if (error) {
      setFormError(error);
      return;
    }
    onSummary(cells);
  };

  return (
    <div className="smd-backdrop" onClick={onClose}>
      <div
        className="smd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="smd-header">
          <h2 id="smd-title" className="smd-title">シナリオの管理</h2>
          <button
            type="button"
            className="smd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="smd-body">
          <section className="smd-section">
            <h3 className="smd-section-title">登録されたシナリオ</h3>
            {sortedScenarios.length === 0 ? (
              <p className="smd-empty">まだシナリオがありません。下のフォームから追加してください。</p>
            ) : (
              <ul className="smd-list">
                {sortedScenarios.map((s) => (
                  <li key={s.name} className="smd-item">
                    <div className="smd-item-main">
                      <div className="smd-item-name">{s.name}</div>
                      {s.comment && <div className="smd-item-comment">{s.comment}</div>}
                      <div className="smd-item-cells">
                        変化させるセル: {s.changingCells.join(", ") || "—"}
                      </div>
                    </div>
                    <div className="smd-item-actions">
                      <button
                        type="button"
                        className="smd-btn"
                        onClick={() => onApply(s)}
                      >
                        表示
                      </button>
                      <button
                        type="button"
                        className="smd-btn smd-btn--danger"
                        onClick={() => onDelete(s.name)}
                      >
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="smd-section">
            <h3 className="smd-section-title">新規シナリオ</h3>
            <label className="smd-field">
              <span className="smd-field-label">シナリオ名</span>
              <input
                type="text"
                className="smd-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="最良ケース"
              />
            </label>
            <label className="smd-field">
              <span className="smd-field-label">コメント (任意)</span>
              <input
                type="text"
                className="smd-input"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="売上が 20% 増加した場合"
              />
            </label>
            <label className="smd-field">
              <span className="smd-field-label">変化させるセル (改行 / カンマ区切り)</span>
              <textarea
                className="smd-textarea"
                value={cellsText}
                onChange={(e) => setCellsText(e.target.value)}
                placeholder={"Sheet1!B2\nSheet1!B3"}
                rows={4}
              />
            </label>
            {formError && <p className="smd-error">{formError}</p>}
            <div className="smd-add-row">
              <button
                type="button"
                className="smd-btn smd-btn--primary"
                onClick={handleAdd}
              >
                追加
              </button>
            </div>
          </section>

          <section className="smd-section">
            <h3 className="smd-section-title">サマリー</h3>
            <label className="smd-field">
              <span className="smd-field-label">結果セル (任意、改行 / カンマ区切り)</span>
              <textarea
                className="smd-textarea"
                value={resultCellsText}
                onChange={(e) => setResultCellsText(e.target.value)}
                placeholder={"Sheet1!E10"}
                rows={2}
              />
            </label>
            <div className="smd-add-row">
              <button
                type="button"
                className="smd-btn"
                onClick={handleSummary}
                disabled={sortedScenarios.length === 0}
              >
                サマリー作成
              </button>
            </div>
          </section>
        </div>
        <footer className="smd-footer">
          <p className="smd-hint">
            シナリオは workbook 単位で保存されます。「表示」を押すと該当セルが上書きされます (元に戻すには Ctrl+Z)。
          </p>
          <div className="smd-footer-actions">
            <button type="button" className="smd-btn" onClick={onClose}>
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
