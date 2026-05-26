import { useMemo } from "react";
import {
  listAllSlicers,
  listDistinctValues,
  type SlicerListing,
  type WorkbookSlicerPivotSnapshot,
} from "../store/slicers";
import "./SlicerPanel.css";

interface Props {
  /** Stringified workbook snapshot (FWorkbook.save() / store cache). */
  workbookSnapshotJson: string;
  /** Toggle a value's inclusion in the named slicer. */
  onToggleValue: (name: string, value: string) => void;
  /** Drop a slicer from its host sheet. */
  onDelete: (sheetId: string, name: string) => void;
  /** Clear all selected values for the named slicer ("show all"). Optional. */
  onClearSelection?: (name: string) => void;
  /** Select all distinct values for the named slicer (still "show all"). Optional. */
  onSelectAll?: (name: string, values: string[]) => void;
  /** Invert the named slicer's selection. Optional. */
  onInvertSelection?: (name: string) => void;
  /** Reset every slicer in the workbook to "show all" in one batch. Optional. */
  onClearAllSlicers?: () => void;
}

/** Render an empty-value pill as "(空白)" so users can see it's clickable. */
const BLANK_LABEL = "(空白)";

export default function SlicerPanel({
  workbookSnapshotJson,
  onToggleValue,
  onDelete,
  onClearSelection,
  onSelectAll,
  onInvertSelection,
  onClearAllSlicers,
}: Props) {
  // Parse once per snapshot change. Mirrors TableInfoPanel — the snapshot
  // JSON only updates on commit so this stays cheap.
  const { listings, parsed } = useMemo(() => {
    if (!workbookSnapshotJson) {
      return { listings: [] as SlicerListing[], parsed: null as WorkbookSlicerPivotSnapshot | null };
    }
    let p: WorkbookSlicerPivotSnapshot;
    try {
      p = JSON.parse(workbookSnapshotJson) as WorkbookSlicerPivotSnapshot;
    } catch {
      return { listings: [] as SlicerListing[], parsed: null as WorkbookSlicerPivotSnapshot | null };
    }
    return { listings: listAllSlicers(p), parsed: p };
  }, [workbookSnapshotJson]);

  // Any slicer with a non-empty selection — enables the "reset all" button.
  const anyActive = listings.some((l) => (l.slicer.selectedValues ?? []).length > 0);

  return (
    <aside className="slp-root" aria-label="スライサー一覧">
      <header className="slp-header">
        <h3 className="slp-title">スライサー</h3>
        <span className="slp-count">{listings.length}</span>
        {onClearAllSlicers && listings.length > 1 && (
          <button
            type="button"
            className="slp-header-btn"
            onClick={onClearAllSlicers}
            disabled={!anyActive}
            title="すべてのスライサーの選択をクリア"
          >
            すべてリセット
          </button>
        )}
      </header>
      {listings.length === 0 ? (
        <p className="slp-empty">
          このブックにはスライサーがありません。[挿入] → [スライサー...]
          から作成できます。
        </p>
      ) : (
        <ul className="slp-list">
          {listings.map(({ sheetId, sheetName, slicer }) => {
            // Distinct values are recomputed on every render from the
            // current snapshot — keeps the pills in sync when the user
            // edits underlying cells outside the slicer flow.
            const kind = slicer.targetKind ?? "table";
            const values = parsed
              ? listDistinctValues(parsed, slicer.targetTable, slicer.field, kind)
              : [];
            const selectedSet = new Set(slicer.selectedValues ?? []);
            const anySelected = selectedSet.size > 0;
            const isPivot = kind === "pivot";
            return (
              <li key={`${sheetId}:${slicer.name}`} className="slp-item">
                <div className="slp-item-head">
                  <div className="slp-name-wrap">
                    <span className="slp-name">{slicer.name}</span>
                    {isPivot && (
                      <span className="slp-kind-badge" title="ピボット連動スライサー">ピボット</span>
                    )}
                    <span className="slp-meta">
                      {slicer.targetTable}
                      <span className="slp-sep"> / </span>
                      {slicer.field}
                      <span className="slp-sep"> / </span>
                      <span className="slp-sheet">{sheetName}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="slp-btn slp-btn--danger"
                    onClick={() => onDelete(sheetId, slicer.name)}
                    aria-label={`${slicer.name} を削除`}
                  >
                    削除
                  </button>
                </div>
                {values.length > 0 && (onClearSelection || onSelectAll || onInvertSelection) && (
                  <div className="slp-bulk-row">
                    {onClearSelection && (
                      <button
                        type="button"
                        className="slp-bulk-btn"
                        onClick={() => onClearSelection(slicer.name)}
                        disabled={!anySelected}
                        title="選択をクリア (すべて表示)"
                      >
                        クリア
                      </button>
                    )}
                    {onSelectAll && (
                      <button
                        type="button"
                        className="slp-bulk-btn"
                        onClick={() => onSelectAll(slicer.name, values)}
                        title="すべての値を選択"
                      >
                        すべて
                      </button>
                    )}
                    {onInvertSelection && (
                      <button
                        type="button"
                        className="slp-bulk-btn"
                        onClick={() => onInvertSelection(slicer.name)}
                        disabled={!anySelected}
                        title="選択を反転"
                      >
                        反転
                      </button>
                    )}
                  </div>
                )}
                {values.length === 0 ? (
                  <p className="slp-empty-vals">
                    対象テーブルが見つからないか、フィールドが空です。
                  </p>
                ) : (
                  <ul
                    className={
                      "slp-pills" + (anySelected ? "" : " slp-pills--all")
                    }
                  >
                    {values.map((v) => {
                      const active = selectedSet.has(v);
                      const label = v === "" ? BLANK_LABEL : v;
                      return (
                        <li key={v}>
                          <button
                            type="button"
                            className={
                              "slp-pill" +
                              (active ? " slp-pill--active" : "") +
                              (!anySelected ? " slp-pill--neutral" : "")
                            }
                            onClick={() => onToggleValue(slicer.name, v)}
                            aria-pressed={active}
                            title={
                              anySelected
                                ? active
                                  ? `${label} を選択解除`
                                  : `${label} を追加`
                                : `${label} のみを表示`
                            }
                          >
                            {label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="slp-state">
                  {anySelected
                    ? `${selectedSet.size} / ${values.length} 件を表示`
                    : `すべて表示 (${values.length} 件)`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
