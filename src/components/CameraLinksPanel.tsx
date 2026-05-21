import { useMemo } from "react";
import {
  listCameraLinks,
  type CameraLink,
} from "../store/cameraLinks";
import { rectToA1 } from "../store/cameraRender";
import "./CameraLinksPanel.css";

interface Props {
  /** Stringified workbook snapshot (FWorkbook.save() / store cache). */
  workbookSnapshotJson: string;
  /** Map sheet id -> display name, for labelling source/dst. */
  sheetNamesById: Record<string, string>;
  /** Jump the Univer selection to the camera link's SOURCE range. */
  onJumpToSource: (link: CameraLink) => void;
  /** Jump the Univer selection to the camera link's DST anchor. */
  onJumpToDest: (link: CameraLink) => void;
  /** Drop a camera link. */
  onDelete: (id: string) => void;
}

/**
 * Sidebar panel listing every "camera" snapshot image in the workbook (#184).
 *
 * Univer 0.5.x exposes no in-grid overlay / pixel API, so — per the issue —
 * camera images are surfaced here as a thumbnail directory rather than
 * floating on the grid. Each entry shows the baked PNG, the source range,
 * and the destination anchor; clicking jumps the selection to either end.
 *
 * Broken links (source sheet deleted) render a #REF! placeholder instead of
 * a thumbnail. Same UX shape as ImagePreviewPanel / SlicerPanel for
 * consistency.
 */
export default function CameraLinksPanel({
  workbookSnapshotJson,
  sheetNamesById,
  onJumpToSource,
  onJumpToDest,
  onDelete,
}: Props) {
  const links = useMemo(() => {
    if (!workbookSnapshotJson) return [] as CameraLink[];
    try {
      return listCameraLinks(JSON.parse(workbookSnapshotJson));
    } catch {
      return [] as CameraLink[];
    }
  }, [workbookSnapshotJson]);

  const sheetName = (id: string): string => sheetNamesById[id] ?? id;

  return (
    <aside className="cam-root" aria-label="カメラ画像一覧">
      <header className="cam-header">
        <h3 className="cam-title">カメラ画像</h3>
        <span className="cam-count">{links.length}</span>
      </header>
      {links.length === 0 ? (
        <p className="cam-empty">
          カメラ画像はありません。セル範囲を選択して右クリック →
          [カメラ撮影] で作成できます。
        </p>
      ) : (
        <ul className="cam-list">
          {links.map((link) => {
            const srcLabel = `${sheetName(link.sourceSheetId)}!${rectToA1(
              link.sourceRange,
            )}`;
            const dstLabel = `${sheetName(link.dstSheetId)}!${rectToA1({
              r1: link.dstAnchor.row,
              c1: link.dstAnchor.col,
              r2: link.dstAnchor.row,
              c2: link.dstAnchor.col,
            })}`;
            return (
              <li key={link.id} className="cam-item">
                <div className="cam-item-head">
                  <span className="cam-src" title={srcLabel}>
                    {srcLabel}
                  </span>
                  <button
                    type="button"
                    className="cam-btn cam-btn--danger"
                    onClick={() => onDelete(link.id)}
                    aria-label={`${srcLabel} のカメラ画像を削除`}
                  >
                    削除
                  </button>
                </div>
                <button
                  type="button"
                  className="cam-thumb-btn"
                  onClick={() => onJumpToSource(link)}
                  title={`ソース範囲 ${srcLabel} へ移動`}
                >
                  {link.broken ? (
                    <span className="cam-ref-error">#REF!</span>
                  ) : link.dataUrl ? (
                    <img
                      className="cam-thumb"
                      src={link.dataUrl}
                      alt={srcLabel}
                      loading="lazy"
                    />
                  ) : (
                    <span className="cam-ref-error cam-ref-error--stale">
                      (再描画待ち)
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="cam-dst-btn"
                  onClick={() => onJumpToDest(link)}
                  title={`貼り付け先 ${dstLabel} へ移動`}
                >
                  → {dstLabel}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
