import { useEffect, useMemo, useState } from "react";
import {
  OutlineGroup,
  addGroup,
  removeGroup,
  setCollapsed,
} from "../store/outlineGroups";
import "./OutlineGroupDialog.css";

interface Selection {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

interface Props {
  sheetName: string;
  sheetId: string;
  initialRows: OutlineGroup[];
  initialCols: OutlineGroup[];
  /** Current grid selection — used as the default range for "Group selected".
   *  null when nothing is selected (button is disabled). */
  selection: Selection | null;
  onApply: (rows: OutlineGroup[], cols: OutlineGroup[]) => void;
  onClose: () => void;
}

// Convert a 0-based column index to A1 letters (0 → "A", 26 → "AA").
function colToA1(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Human-readable range label, e.g. "Row 5–10" / "Col B–D".
function rangeLabel(axis: "row" | "col", start: number, end: number): string {
  if (axis === "row") {
    return start === end ? `行 ${start + 1}` : `行 ${start + 1}–${end + 1}`;
  }
  return start === end
    ? `列 ${colToA1(start)}`
    : `列 ${colToA1(start)}–${colToA1(end)}`;
}

export default function OutlineGroupDialog({
  sheetName,
  sheetId: _sheetId,
  initialRows,
  initialCols,
  selection,
  onApply,
  onClose,
}: Props) {
  // Local working copies so the dialog can preview multiple operations and
  // commit only on Apply. The parent owns persistence (snapshot write).
  const [rows, setRows] = useState<OutlineGroup[]>(initialRows);
  const [cols, setCols] = useState<OutlineGroup[]>(initialCols);

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

  // Sheet stub for the pure helpers — they only read the two outline arrays.
  const rowSheet = useMemo(() => ({ _outlineRows: rows }), [rows]);
  const colSheet = useMemo(() => ({ _outlineCols: cols }), [cols]);

  const canGroupRows =
    selection !== null && selection.endRow >= selection.startRow;
  const canGroupCols =
    selection !== null && selection.endCol >= selection.startCol;

  const handleGroupRows = () => {
    if (!selection) return;
    setRows(addGroup(rowSheet, "row", selection.startRow, selection.endRow));
  };

  const handleGroupCols = () => {
    if (!selection) return;
    setCols(addGroup(colSheet, "col", selection.startCol, selection.endCol));
  };

  const handleToggleRow = (g: OutlineGroup) => {
    setRows(setCollapsed(rowSheet, "row", g.start, g.end, !g.collapsed));
  };

  const handleToggleCol = (g: OutlineGroup) => {
    setCols(setCollapsed(colSheet, "col", g.start, g.end, !g.collapsed));
  };

  const handleRemoveRow = (g: OutlineGroup) => {
    setRows(removeGroup(rowSheet, "row", g.start, g.end));
  };

  const handleRemoveCol = (g: OutlineGroup) => {
    setCols(removeGroup(colSheet, "col", g.start, g.end));
  };

  const submit = () => {
    onApply(rows, cols);
    onClose();
  };

  // Render a single axis section. Kept inline (rather than a sub-component)
  // because the JSX is small and the action wiring differs per axis.
  const renderGroupList = (
    axis: "row" | "col",
    list: OutlineGroup[],
    onToggle: (g: OutlineGroup) => void,
    onRemove: (g: OutlineGroup) => void,
  ) => {
    if (list.length === 0) {
      return <p className="og-empty">グループはありません。</p>;
    }
    return (
      <ul className="og-list">
        {list.map((g) => (
          <li key={`${axis}-${g.start}-${g.end}-${g.level}`} className="og-row">
            <span className="og-range">{rangeLabel(axis, g.start, g.end)}</span>
            <span className="og-level">レベル {g.level}</span>
            <button
              type="button"
              className="og-btn og-btn--small"
              onClick={() => onToggle(g)}
              aria-label={g.collapsed ? "展開" : "折りたたみ"}
            >
              {g.collapsed ? "展開" : "折りたたみ"}
            </button>
            <button
              type="button"
              className="og-btn og-btn--small og-btn--danger"
              onClick={() => onRemove(g)}
              aria-label="グループを解除"
            >
              解除
            </button>
          </li>
        ))}
      </ul>
    );
  };

  const selectionLabel = (() => {
    if (!selection) return "選択範囲なし";
    const rowsTxt = rangeLabel("row", selection.startRow, selection.endRow);
    const colsTxt = rangeLabel("col", selection.startCol, selection.endCol);
    return `${rowsTxt} / ${colsTxt}`;
  })();

  return (
    <div className="og-backdrop" onClick={onClose}>
      <div
        className="og-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="og-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="og-header">
          <h2 id="og-title" className="og-title">
            グループ化 — {sheetName}
          </h2>
          <button
            type="button"
            className="og-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="og-body">
          <div className="og-selection">
            <span className="og-selection-label">現在の選択</span>
            <span className="og-selection-value">{selectionLabel}</span>
          </div>

          <section className="og-section">
            <header className="og-section-header">
              <h3 className="og-section-title">行グループ</h3>
              <button
                type="button"
                className="og-btn og-btn--add"
                onClick={handleGroupRows}
                disabled={!canGroupRows}
              >
                + 選択した行をグループ化
              </button>
            </header>
            {renderGroupList("row", rows, handleToggleRow, handleRemoveRow)}
          </section>

          <section className="og-section">
            <header className="og-section-header">
              <h3 className="og-section-title">列グループ</h3>
              <button
                type="button"
                className="og-btn og-btn--add"
                onClick={handleGroupCols}
                disabled={!canGroupCols}
              >
                + 選択した列をグループ化
              </button>
            </header>
            {renderGroupList("col", cols, handleToggleCol, handleRemoveCol)}
          </section>
        </div>
        <footer className="og-footer">
          <p className="og-hint">
            重なる範囲は自動的にネストされ、内側ほどレベルが大きくなります。
            折りたたみは行/列を一時的に非表示にするだけで、データは保持されます。
          </p>
          <div className="og-footer-actions">
            <button type="button" className="og-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="og-btn og-btn--primary"
              onClick={submit}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
