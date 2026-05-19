import { useMemo, useState } from "react";
import {
  addWatch,
  loadWatchList,
  readCellSnapshot,
  removeWatch,
  saveWatchList,
  type WatchEntry,
} from "../store/watchList";
import "./WatchWindowPanel.css";

interface Props {
  /** Serialized snapshot JSON — same source EditorScreen passes to the
   *  other audit/preview panels. Parsed lazily inside useMemo so a noop
   *  re-render doesn't re-walk the snapshot for every watch row. */
  workbookSnapshotJson: string;
  /** Click handler: jumps Univer's selection to (sheetId, cellRef). */
  onJumpTo: (sheetId: string, cellRef: string) => void;
}

interface SheetMeta {
  id: string;
  name: string;
}

// Pull (id, name) pairs out of the snapshot so the "+ add" form can offer
// a sheet picker. Returns [] when the snapshot is malformed — the form
// then falls back to a free-text sheet-id input (which is rarely useful
// but better than blocking the user entirely).
function extractSheetMeta(snapshot: unknown): SheetMeta[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as {
    sheets?: Record<string, { name?: string } | undefined>;
    sheetOrder?: string[];
  };
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];
  const ids =
    Array.isArray(snap.sheetOrder) && snap.sheetOrder.length > 0
      ? snap.sheetOrder.filter((id) => typeof id === "string" && id in sheets)
      : Object.keys(sheets);
  return ids.map((id) => {
    const s = sheets[id];
    const name = s && typeof s.name === "string" && s.name.length > 0 ? s.name : id;
    return { id, name };
  });
}

/** Cheap A1 sanity check: one-or-more letters followed by one-or-more
 *  digits. Accepts optional `$` anchors so users can paste copied refs. */
function isValidA1(ref: string): boolean {
  return /^\$?[A-Za-z]+\$?\d+$/.test(ref.trim());
}

/** Render an unknown cell value as a display string. Mirrors how the
 *  grid itself stringifies non-string `v` values (numbers as-is, booleans
 *  as "TRUE"/"FALSE", everything else via JSON.stringify) so the panel
 *  matches what the user sees in the sheet. */
function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Floating panel listing every cell the user has pinned to the Watch
 * Window. Mirrors ErrorIndicatorsPanel's layout/positioning so all the
 * audit panels share a visual language. Re-renders on every snapshot
 * change so values + formulas stay live as the user edits.
 *
 * State lives in localStorage (`coco.watchList`) and is loaded once at
 * mount; subsequent mutations update both state and storage so the list
 * survives reloads.
 */
export default function WatchWindowPanel({ workbookSnapshotJson, onJumpTo }: Props) {
  // Initial value only — we never re-read localStorage on re-render.
  const [watches, setWatches] = useState<WatchEntry[]>(() => loadWatchList());
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formSheetId, setFormSheetId] = useState<string>("");
  const [formCellRef, setFormCellRef] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);

  // Parse the snapshot once per change so every watch row can look itself
  // up without each row re-parsing the full JSON blob.
  const parsedSnapshot = useMemo<unknown>(() => {
    if (!workbookSnapshotJson) return null;
    try {
      return JSON.parse(workbookSnapshotJson);
    } catch {
      return null;
    }
  }, [workbookSnapshotJson]);

  const sheetMeta = useMemo(() => extractSheetMeta(parsedSnapshot), [parsedSnapshot]);

  // Live read of each watch's current value + formula. Pulls the freshest
  // sheet name from the snapshot too so a renamed sheet shows the new
  // label without forcing the user to re-add the watch.
  const rows = useMemo(() => {
    return watches.map((w) => {
      const { value, formula } = readCellSnapshot(parsedSnapshot, w.sheetId, w.cellRef);
      const liveSheet = sheetMeta.find((s) => s.id === w.sheetId);
      return {
        entry: w,
        sheetName: liveSheet?.name ?? w.sheetName,
        value,
        formula,
      };
    });
  }, [watches, parsedSnapshot, sheetMeta]);

  const handleRemove = (id: string) => {
    setWatches((prev) => {
      const next = removeWatch(prev, id);
      if (next !== prev) saveWatchList(next);
      return next;
    });
  };

  const handleAdd = () => {
    const sheetId = formSheetId.trim();
    const cellRef = formCellRef.trim();
    if (!sheetId) {
      setFormError("シートを選択してください。");
      return;
    }
    if (!isValidA1(cellRef)) {
      setFormError("セル参照は A1 形式で入力してください。");
      return;
    }
    const sheetName = sheetMeta.find((s) => s.id === sheetId)?.name ?? sheetId;
    setWatches((prev) => {
      const next = addWatch(prev, { sheetId, sheetName, cellRef });
      if (next !== prev) saveWatchList(next);
      return next;
    });
    setFormCellRef("");
    setFormError(null);
    setAdding(false);
  };

  const handleOpenAddForm = () => {
    // Default the sheet picker to the first available sheet so the user
    // doesn't have to touch the dropdown for a single-sheet workbook.
    if (!formSheetId && sheetMeta.length > 0) {
      setFormSheetId(sheetMeta[0].id);
    }
    setFormError(null);
    setAdding(true);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="wwp-badge"
        onClick={() => setCollapsed(false)}
        title={`ウォッチ ${watches.length} 件（クリックで展開）`}
        aria-label={`ウォッチ ${watches.length} 件を表示`}
      >
        <span className="wwp-glyph" aria-hidden="true">👁</span>
        <span className="wwp-badge-count">{watches.length}</span>
      </button>
    );
  }

  return (
    <aside className="wwp-panel" role="region" aria-label="ウォッチウィンドウ">
      <header className="wwp-header">
        <span className="wwp-title">
          <span className="wwp-glyph" aria-hidden="true">👁</span>
          ウォッチウィンドウ ({watches.length})
        </span>
        <span className="wwp-header-actions">
          <button
            type="button"
            className="wwp-add"
            onClick={handleOpenAddForm}
            aria-label="ウォッチを追加"
            title="ウォッチを追加"
          >
            +
          </button>
          <button
            type="button"
            className="wwp-collapse"
            onClick={() => setCollapsed(true)}
            aria-label="最小化"
            title="最小化"
          >
            −
          </button>
        </span>
      </header>
      {adding && (
        <div className="wwp-add-form">
          <label className="wwp-add-row">
            <span className="wwp-add-label">シート</span>
            <select
              className="wwp-add-select"
              value={formSheetId}
              onChange={(e) => setFormSheetId(e.target.value)}
            >
              {sheetMeta.length === 0 && <option value="">(なし)</option>}
              {sheetMeta.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wwp-add-row">
            <span className="wwp-add-label">セル</span>
            <input
              className="wwp-add-input"
              type="text"
              placeholder="A1"
              value={formCellRef}
              onChange={(e) => setFormCellRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAdding(false);
                  setFormError(null);
                }
              }}
            />
          </label>
          {formError && <div className="wwp-add-error">{formError}</div>}
          <div className="wwp-add-buttons">
            <button type="button" className="wwp-add-submit" onClick={handleAdd}>
              追加
            </button>
            <button
              type="button"
              className="wwp-add-cancel"
              onClick={() => {
                setAdding(false);
                setFormError(null);
              }}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
      {watches.length === 0 ? (
        <div className="wwp-empty">
          監視中のセルはありません。「+」で追加してください。
        </div>
      ) : (
        <div className="wwp-table-wrap">
          <table className="wwp-table">
            <thead>
              <tr>
                <th>シート</th>
                <th>セル</th>
                <th>値</th>
                <th>数式</th>
                <th aria-label="操作"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, sheetName, value, formula }) => {
                const display = formatValue(value);
                return (
                  <tr key={entry.id} className="wwp-row">
                    <td className="wwp-cell-sheet">
                      <button
                        type="button"
                        className="wwp-jump"
                        title={`${sheetName}!${entry.cellRef} に移動`}
                        onClick={() => onJumpTo(entry.sheetId, entry.cellRef)}
                      >
                        {sheetName}
                      </button>
                    </td>
                    <td className="wwp-cell-ref">{entry.cellRef}</td>
                    <td className="wwp-cell-value" title={display}>
                      {display || <span className="wwp-empty-cell">(空)</span>}
                    </td>
                    <td className="wwp-cell-formula" title={formula ?? ""}>
                      {formula ?? <span className="wwp-empty-cell">—</span>}
                    </td>
                    <td className="wwp-cell-remove">
                      <button
                        type="button"
                        className="wwp-remove"
                        onClick={() => handleRemove(entry.id)}
                        aria-label={`${sheetName}!${entry.cellRef} を削除`}
                        title="削除"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
