import { useMemo, useState } from "react";
import {
  cellRefToA1,
  findDependents,
  findPrecedents,
  getSheetName,
} from "../store/formulaTrace";
import "./FormulaTracePanel.css";

interface Props {
  /** Serialized snapshot JSON — same source the other audit panels read.
   *  Parsed lazily inside useMemo so a noop re-render doesn't re-walk
   *  every cell in the workbook. */
  workbookSnapshotJson: string;
  /** Univer's currently-active sheet id. Null when no workbook is open
   *  (e.g. during the home-screen → editor transition). */
  activeSheetId: string | null;
  /** 0-based row of the active selection. Null mirrors activeSheetId. */
  activeRow: number | null;
  /** 0-based column of the active selection. */
  activeCol: number | null;
  /** Click handler: jumps Univer's selection to (sheetId, cellRef). */
  onJumpTo: (sheetId: string, cellRef: string) => void;
}

/**
 * Sidebar panel mirroring ErrorIndicatorsPanel — surfaces the precedent
 * and dependent cells of the active selection. Univer 0.5.x has no public
 * API for drawing Excel-style trace arrows in the grid, so the panel is
 * the only surfacing path; entries are click-jump targets.
 *
 * Precedents = cells referenced by the active cell's formula.
 * Dependents = cells whose formula references the active cell.
 *
 * Sections render their counts in the header so the user can tell at a
 * glance whether a cell is a leaf, root, or hub.
 */
export default function FormulaTracePanel({
  workbookSnapshotJson,
  activeSheetId,
  activeRow,
  activeCol,
  onJumpTo,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // Parse the snapshot once per JSON update; reuse the parsed value for
  // both precedent and dependent passes.
  const parsedSnapshot = useMemo<unknown>(() => {
    if (!workbookSnapshotJson) return null;
    try {
      return JSON.parse(workbookSnapshotJson) as unknown;
    } catch {
      return null;
    }
  }, [workbookSnapshotJson]);

  const hasActive =
    parsedSnapshot !== null &&
    activeSheetId !== null &&
    activeRow !== null &&
    activeCol !== null;

  const activeA1 = useMemo(() => {
    if (activeRow === null || activeCol === null) return "";
    return cellRefToA1(activeRow, activeCol);
  }, [activeRow, activeCol]);

  const activeSheetName = useMemo(() => {
    if (!hasActive || !activeSheetId) return "";
    return getSheetName(parsedSnapshot, activeSheetId);
  }, [parsedSnapshot, activeSheetId, hasActive]);

  const precedents = useMemo(() => {
    if (!hasActive || !activeSheetId || activeRow === null || activeCol === null) return [];
    return findPrecedents(parsedSnapshot, activeSheetId, activeRow, activeCol);
  }, [parsedSnapshot, activeSheetId, activeRow, activeCol, hasActive]);

  const dependents = useMemo(() => {
    if (!hasActive || !activeSheetId || activeRow === null || activeCol === null) return [];
    return findDependents(parsedSnapshot, activeSheetId, activeRow, activeCol);
  }, [parsedSnapshot, activeSheetId, activeRow, activeCol, hasActive]);

  if (collapsed) {
    const total = precedents.length + dependents.length;
    return (
      <button
        type="button"
        className="ftp-badge"
        onClick={() => setCollapsed(false)}
        title={`依存関係（クリックで展開, ${total} 件）`}
        aria-label="依存関係パネルを表示"
      >
        <span className="ftp-glyph" aria-hidden="true">↳</span>
        <span className="ftp-badge-count">{total}</span>
      </button>
    );
  }

  return (
    <aside className="ftp-panel" role="region" aria-label="依存関係">
      <header className="ftp-header">
        <span className="ftp-title">
          <span className="ftp-glyph" aria-hidden="true">↳</span>
          依存関係
        </span>
        <button
          type="button"
          className="ftp-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>

      <div className="ftp-active">
        {hasActive ? (
          <>
            <span className="ftp-active-label">選択中</span>
            <span className="ftp-active-ref" title={`${activeSheetName}!${activeA1}`}>
              {activeSheetName}!{activeA1}
            </span>
          </>
        ) : (
          <span className="ftp-active-empty">セルを選択してください</span>
        )}
      </div>

      <div className="ftp-list">
        <section className="ftp-section">
          <h3 className="ftp-section-title">
            参照元 (Precedents)
            <span className="ftp-section-count">{precedents.length}</span>
          </h3>
          {precedents.length === 0 ? (
            <p className="ftp-empty">なし</p>
          ) : (
            <ul className="ftp-items">
              {precedents.map((p, i) => {
                const sheetName = getSheetName(parsedSnapshot, p.sheetId);
                return (
                  <li key={`p-${p.sheetId}-${p.cellRef}-${i}`} className="ftp-item">
                    <button
                      type="button"
                      className="ftp-item-btn"
                      title={`${sheetName}!${p.cellRef} へ移動`}
                      onClick={() => onJumpTo(p.sheetId, p.cellRef)}
                    >
                      <span className="ftp-cell-ref">{p.cellRef}</span>
                      <span className="ftp-sheet">{sheetName}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="ftp-section">
          <h3 className="ftp-section-title">
            参照先 (Dependents)
            <span className="ftp-section-count">{dependents.length}</span>
          </h3>
          {dependents.length === 0 ? (
            <p className="ftp-empty">なし</p>
          ) : (
            <ul className="ftp-items">
              {dependents.map((d, i) => {
                const sheetName = getSheetName(parsedSnapshot, d.sheetId);
                // Truncate long formulas so the panel doesn't overflow;
                // the full text lives in the button's title attribute.
                const snippet = d.formula.length > 36
                  ? d.formula.slice(0, 36) + "…"
                  : d.formula;
                return (
                  <li key={`d-${d.sheetId}-${d.cellRef}-${i}`} className="ftp-item">
                    <button
                      type="button"
                      className="ftp-item-btn"
                      title={`${sheetName}!${d.cellRef} = ${d.formula}`}
                      onClick={() => onJumpTo(d.sheetId, d.cellRef)}
                    >
                      <span className="ftp-cell-ref">{d.cellRef}</span>
                      <span className="ftp-sheet">{sheetName}</span>
                      <span className="ftp-formula">{snippet}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
