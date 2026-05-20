import { useMemo } from "react";
import type { SparklineEntry, SparklineSnapshot } from "../store/sparklines";
import "./SparklineListPanel.css";

interface PanelRow {
  sheetId: string;
  sheetName: string;
  entry: SparklineEntry;
}

interface Props {
  /** Stringified workbook snapshot. Re-parsed on each change. */
  workbookSnapshotJson: string;
  onJumpTo: (sheetId: string, cell: string) => void;
  onDelete: (sheetId: string, cell: string) => void;
}

/** Type label for the list (Japanese, mirrors the insert dialog). */
function typeLabel(type: SparklineEntry["type"]): string {
  switch (type) {
    case "line":
      return "折れ線";
    case "column":
      return "縦棒";
    case "winloss":
      return "勝敗";
    default:
      return type;
  }
}

export default function SparklineListPanel({
  workbookSnapshotJson,
  onJumpTo,
  onDelete,
}: Props) {
  const rows = useMemo<PanelRow[]>(() => {
    if (!workbookSnapshotJson) return [];
    let snap: SparklineSnapshot;
    try {
      snap = JSON.parse(workbookSnapshotJson) as SparklineSnapshot;
    } catch {
      return [];
    }
    const sheets = snap.sheets ?? {};
    const collected: PanelRow[] = [];
    for (const sheetId of Object.keys(sheets)) {
      const sheet = sheets[sheetId];
      const arr = sheet?._sparklines;
      if (!Array.isArray(arr)) continue;
      const sheetName = sheet?.name ?? sheetId;
      for (const entry of arr) {
        if (!entry || typeof entry.cell !== "string") continue;
        collected.push({ sheetId, sheetName, entry });
      }
    }
    return collected;
  }, [workbookSnapshotJson]);

  if (rows.length === 0) {
    return (
      <div className="splp-root">
        <div className="splp-header">スパークライン</div>
        <p className="splp-empty">このブックにスパークラインはまだありません。</p>
      </div>
    );
  }

  return (
    <div className="splp-root">
      <div className="splp-header">スパークライン ({rows.length})</div>
      <ul className="splp-list">
        {rows.map((row) => (
          <li
            key={`${row.sheetId}:${row.entry.cell}`}
            className="splp-row"
          >
            <button
              type="button"
              className="splp-jump"
              onClick={() => onJumpTo(row.sheetId, row.entry.cell)}
              title={`${row.sheetName} の ${row.entry.cell} へジャンプ`}
            >
              <span className="splp-anchor">
                {row.sheetName}!{row.entry.cell}
              </span>
              <span className="splp-meta">
                <span className="splp-type">{typeLabel(row.entry.type)}</span>
                <span className="splp-source">{row.entry.sourceRange}</span>
              </span>
            </button>
            <button
              type="button"
              className="splp-delete"
              onClick={() => onDelete(row.sheetId, row.entry.cell)}
              aria-label={`${row.sheetName} の ${row.entry.cell} のスパークラインを削除`}
              title="削除"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
