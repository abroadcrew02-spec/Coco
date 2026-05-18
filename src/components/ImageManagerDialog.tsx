import { useEffect, useMemo, useState } from "react";
import type { ImageListing } from "../store/imageManager";
import "./ImageManagerDialog.css";

interface Props {
  /** Pre-computed listings from store/imageManager#listAllImages. */
  images: ImageListing[];
  onJumpTo: (sheetId: string, anchor: string) => void;
  onDelete: (sheetId: string, anchor: string) => void;
  onBulkDeleteOnSheet: (sheetId: string) => void;
  onExport: (image: ImageListing) => void;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} kB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * Workbook-wide image manager. Surfaces every embedded image across every
 * sheet so the user can audit, filter per-sheet, bulk-delete, and export
 * without hunting through anchors in the grid.
 *
 * Mutations are delegated to the integrator (EditorScreen) via callbacks —
 * this component owns the table render, filter, and confirm prompts only.
 * That keeps snapshot mutation + undo wiring in one place where the
 * post-mutation Univer state-refresh dance already lives. Same architectural
 * split as CommentsManagerDialog so the two managers feel uniform.
 */
export default function ImageManagerDialog({
  images,
  onJumpTo,
  onDelete,
  onBulkDeleteOnSheet,
  onExport,
  onClose,
}: Props) {
  const [sheetFilter, setSheetFilter] = useState<string>("");

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

  // Distinct sheets present in the listing, in first-seen order — matches
  // listAllImages which already yields rows in sheetOrder order.
  const sheets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const img of images) {
      if (!seen.has(img.sheetId)) seen.set(img.sheetId, img.sheetName);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [images]);

  const filtered = useMemo(() => {
    if (!sheetFilter) return images;
    return images.filter((img) => img.sheetId === sheetFilter);
  }, [images, sheetFilter]);

  // Count per-sheet for the "Delete All on Sheet X" enable check.
  const countOnSheet = useMemo(() => {
    if (!sheetFilter) return 0;
    return images.reduce((n, img) => (img.sheetId === sheetFilter ? n + 1 : n), 0);
  }, [images, sheetFilter]);

  const totalBytes = useMemo(
    () => filtered.reduce((n, img) => n + (img.sizeBytes || 0), 0),
    [filtered],
  );

  const handleBulkDeleteSheet = () => {
    if (!sheetFilter || countOnSheet === 0) return;
    const sheetName =
      sheets.find((s) => s.id === sheetFilter)?.name ?? sheetFilter;
    const ok = window.confirm(
      `シート「${sheetName}」の画像 ${countOnSheet} 枚を削除します。よろしいですか？`,
    );
    if (!ok) return;
    onBulkDeleteOnSheet(sheetFilter);
  };

  const handleBulkExport = () => {
    // Fan-out to per-row export — the integrator owns the save dialog and
    // throttles concurrent writes if needed. Same N-discrete-actions
    // pattern CommentsManagerDialog uses for "Resolve all visible".
    for (const img of filtered) onExport(img);
  };

  return (
    <div className="img-mgr-backdrop" onClick={onClose}>
      <div
        className="img-mgr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="img-mgr-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="img-mgr-header">
          <h2 id="img-mgr-title" className="img-mgr-title">
            画像一覧 ({filtered.length}/{images.length})
          </h2>
          <button
            type="button"
            className="img-mgr-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="img-mgr-filters">
          <label className="img-mgr-filter-label">
            シート:
            <select
              className="img-mgr-sheet-select"
              value={sheetFilter}
              onChange={(e) => setSheetFilter(e.target.value)}
              aria-label="シートで絞り込み"
            >
              <option value="">すべて</option>
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <span className="img-mgr-total">合計: {formatBytes(totalBytes)}</span>
        </div>

        <div className="img-mgr-body">
          {filtered.length === 0 ? (
            <p className="img-mgr-empty">表示する画像がありません</p>
          ) : (
            <table className="img-mgr-table">
              <thead>
                <tr>
                  <th></th>
                  <th>シート</th>
                  <th>セル</th>
                  <th>名前</th>
                  <th>サイズ</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((img) => {
                  const key = `${img.sheetId}!${img.anchor}!${img.mediaPath}`;
                  return (
                    <tr key={key} className="img-mgr-row">
                      <td className="img-mgr-cell-thumb">
                        <img
                          className="img-mgr-thumb"
                          src={img.src}
                          alt={img.name}
                          loading="lazy"
                        />
                      </td>
                      <td className="img-mgr-cell-sheet">{img.sheetName}</td>
                      <td className="img-mgr-cell-anchor">{img.anchor}</td>
                      <td className="img-mgr-cell-name" title={img.mediaPath}>
                        {img.name}
                      </td>
                      <td className="img-mgr-cell-size">
                        {formatBytes(img.sizeBytes)}
                      </td>
                      <td className="img-mgr-cell-actions">
                        <button
                          type="button"
                          className="img-mgr-mini-btn"
                          onClick={() => onJumpTo(img.sheetId, img.anchor)}
                          title="このセルへ移動"
                        >
                          移動
                        </button>
                        <button
                          type="button"
                          className="img-mgr-mini-btn"
                          onClick={() => onExport(img)}
                          title="ファイルに書き出し"
                        >
                          書き出し
                        </button>
                        <button
                          type="button"
                          className="img-mgr-mini-btn img-mgr-mini-btn--danger"
                          onClick={() => {
                            if (window.confirm("この画像を削除しますか？")) {
                              onDelete(img.sheetId, img.anchor);
                            }
                          }}
                          title="削除"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="img-mgr-footer">
          <div className="img-mgr-footer-left">
            <button
              type="button"
              className="img-mgr-btn img-mgr-btn--danger"
              onClick={handleBulkDeleteSheet}
              disabled={!sheetFilter || countOnSheet === 0}
              title="フィルタ中のシートの画像を一括削除"
            >
              シート全削除 ({countOnSheet})
            </button>
            <button
              type="button"
              className="img-mgr-btn"
              onClick={handleBulkExport}
              disabled={filtered.length === 0}
              title="表示中の画像をすべて書き出し"
            >
              表示中をすべて書き出し
            </button>
          </div>
          <div className="img-mgr-footer-right">
            <button
              type="button"
              className="img-mgr-btn img-mgr-btn--primary"
              onClick={onClose}
            >
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
