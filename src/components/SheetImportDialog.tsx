import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./SheetImportDialog.css";

interface SheetSummary {
  name: string;
  cellCount: number;
  range: string;
}

interface Props {
  /** Called with the file path the user picked plus the names of the
   *  sheets they checked. The parent is responsible for invoking
   *  `workbook_extract_sheet_as_snapshot` per name and merging the result
   *  into the current workbook via `addImportedSheetToSnapshot`. */
  onApply: (filePath: string, sheetNames: string[]) => void;
  onClose: () => void;
}

export default function SheetImportDialog({ onApply, onClose }: Props) {
  const [filePath, setFilePath] = useState<string>("");
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
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

  const loadSheets = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setSheets([]);
    setPicked(new Set());
    try {
      const result = await invoke<SheetSummary[]>(
        "workbook_extract_sheets_from_xlsx",
        { path },
      );
      setSheets(result);
    } catch (e) {
      setError(`シート一覧の取得に失敗しました: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const browse = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Excel", extensions: ["xlsx", "xlsm"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    setFilePath(path);
    await loadSheets(path);
  }, [loadSheets]);

  const toggle = (name: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (picked.size === sheets.length) {
      setPicked(new Set());
    } else {
      setPicked(new Set(sheets.map((s) => s.name)));
    }
  };

  const apply = () => {
    if (!filePath || picked.size === 0) return;
    // Preserve sheets' source order rather than selection order so the
    // imported tabs match how they appeared in the source file.
    const ordered = sheets.filter((s) => picked.has(s.name)).map((s) => s.name);
    onApply(filePath, ordered);
    onClose();
  };

  const canApply = !!filePath && !loading && picked.size > 0 && !error;

  return (
    <div className="sid-backdrop" onClick={onClose}>
      <div
        className="sid-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sid-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sid-header">
          <h2 id="sid-title" className="sid-title">シートを別ファイルから取り込み</h2>
          <button
            type="button"
            className="sid-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="sid-body">
          <div className="sid-file-row">
            <input
              type="text"
              className="sid-file-input"
              placeholder="xlsx ファイルを選択..."
              value={filePath}
              readOnly
              data-testid="sid-file-input"
            />
            <button
              type="button"
              className="sid-btn"
              onClick={() => void browse()}
              data-testid="sid-browse"
            >
              参照...
            </button>
          </div>
          {error && <p className="sid-error">{error}</p>}
          {loading && <p className="sid-status">読み込み中...</p>}
          {!loading && sheets.length > 0 && (
            <>
              <div className="sid-list-header">
                <label className="sid-row sid-row--header">
                  <input
                    type="checkbox"
                    checked={picked.size === sheets.length}
                    onChange={toggleAll}
                    data-testid="sid-toggle-all"
                  />
                  <span className="sid-name">シート名</span>
                  <span className="sid-meta">範囲</span>
                  <span className="sid-meta sid-meta--count">セル数</span>
                </label>
              </div>
              <ul className="sid-list" role="listbox" aria-label="シート一覧">
                {sheets.map((s) => {
                  const checked = picked.has(s.name);
                  return (
                    <li key={s.name}>
                      <label
                        className={"sid-row" + (checked ? " sid-row--active" : "")}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(s.name)}
                          data-testid={`sid-pick-${s.name}`}
                        />
                        <span className="sid-name">{s.name}</span>
                        <span className="sid-meta">{s.range || "—"}</span>
                        <span className="sid-meta sid-meta--count">
                          {s.cellCount.toLocaleString()}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {!loading && !error && filePath && sheets.length === 0 && (
            <p className="sid-status">このファイルにはシートがありません。</p>
          )}
        </div>
        <footer className="sid-footer">
          <button type="button" className="sid-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="sid-btn sid-btn--primary"
            onClick={apply}
            disabled={!canApply}
            data-testid="sid-apply"
          >
            取り込み ({picked.size})
          </button>
        </footer>
      </div>
    </div>
  );
}
