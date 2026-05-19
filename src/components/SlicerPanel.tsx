import { useMemo } from "react";
import {
  listAllSlicers,
  listDistinctValues,
  type SlicerListing,
  type WorkbookSlicerSnapshot,
} from "../store/slicers";
import "./SlicerPanel.css";

interface Props {
  /** Stringified workbook snapshot (FWorkbook.save() / store cache). */
  workbookSnapshotJson: string;
  /** Toggle a value's inclusion in the named slicer. */
  onToggleValue: (name: string, value: string) => void;
  /** Drop a slicer from its host sheet. */
  onDelete: (sheetId: string, name: string) => void;
}

/** Render an empty-value pill as "(空白)" so users can see it's clickable. */
const BLANK_LABEL = "(空白)";

export default function SlicerPanel({
  workbookSnapshotJson,
  onToggleValue,
  onDelete,
}: Props) {
  // Parse once per snapshot change. Mirrors TableInfoPanel — the snapshot
  // JSON only updates on commit so this stays cheap.
  const { listings, parsed } = useMemo(() => {
    if (!workbookSnapshotJson) {
      return { listings: [] as SlicerListing[], parsed: null as WorkbookSlicerSnapshot | null };
    }
    let p: WorkbookSlicerSnapshot;
    try {
      p = JSON.parse(workbookSnapshotJson) as WorkbookSlicerSnapshot;
    } catch {
      return { listings: [] as SlicerListing[], parsed: null as WorkbookSlicerSnapshot | null };
    }
    return { listings: listAllSlicers(p), parsed: p };
  }, [workbookSnapshotJson]);

  return (
    <aside className="slp-root" aria-label="スライサー一覧">
      <header className="slp-header">
        <h3 className="slp-title">スライサー</h3>
        <span className="slp-count">{listings.length}</span>
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
            const values = parsed
              ? listDistinctValues(parsed, slicer.targetTable, slicer.field)
              : [];
            const selectedSet = new Set(slicer.selectedValues ?? []);
            const anySelected = selectedSet.size > 0;
            return (
              <li key={`${sheetId}:${slicer.name}`} className="slp-item">
                <div className="slp-item-head">
                  <div className="slp-name-wrap">
                    <span className="slp-name">{slicer.name}</span>
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
