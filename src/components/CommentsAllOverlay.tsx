import { useMemo } from "react";
import { computeCommentIndicators } from "../store/commentIndicators";
import type { CommentIndicator } from "../store/commentIndicators";
import "./CommentsAllOverlay.css";

interface Props {
  workbookSnapshotJson: string;
  /**
   * Jump the Univer selection to the given cell. Invoked when the user
   * clicks a card's Jump button. Receives the sheet id and the A1 cell ref
   * so EditorScreen can route to the correct subUnit before selecting.
   */
  onJumpTo: (sheetId: string, cellRef: string) => void;
  /** Hide the overlay. Wired to the View → Show All Comments toggle. */
  onClose: () => void;
}

/**
 * "Show All Comments" floating overlay. When the View menu toggle is on,
 * this panel docks to the bottom-right of the editor and renders one card
 * per comment across every sheet. Each card shows:
 *   - sheet name + A1 cell ref
 *   - author (when present)
 *   - the comment body, truncated for compactness
 *   - a Jump button that hands off to `onJumpTo` so the user can land on
 *     the referenced cell with one click.
 *
 * Univer 0.5.x's facade exposes no pixel-position API for cells, so we
 * can't truly anchor the cards over the canvas. We instead render a
 * sticky card stack — Excel-equivalent for "see every comment without
 * hovering each cell" without diving into unstable render-controller
 * internals. The companion `patchShowAllCommentsView` snapshot patch
 * supplies the in-cell glyph hint that's positionally accurate.
 *
 * Renders nothing when the snapshot has no comments — avoids visual
 * noise on workbooks without notes.
 */
export default function CommentsAllOverlay({
  workbookSnapshotJson,
  onJumpTo,
  onClose,
}: Props) {
  const indicators = useMemo<CommentIndicator[]>(
    () => computeCommentIndicators(workbookSnapshotJson),
    [workbookSnapshotJson],
  );

  if (indicators.length === 0) return null;

  return (
    <aside
      className="cao-overlay"
      role="region"
      aria-label="コメント一覧"
      tabIndex={-1}
    >
      <header className="cao-header">
        <span className="cao-title">
          <span className="cao-glyph" aria-hidden="true">
            💬
          </span>
          コメント一覧 ({indicators.length})
        </span>
        <button
          type="button"
          className="cao-close"
          onClick={onClose}
          aria-label="閉じる"
          title="閉じる"
        >
          ×
        </button>
      </header>
      <ul className="cao-cards">
        {indicators.map((ind, i) => {
          const truncated =
            ind.text.length > 120 ? `${ind.text.slice(0, 120)}…` : ind.text;
          return (
            <li
              key={`${ind.sheetId}-${ind.cell}-${i}`}
              className="cao-card"
            >
              <div className="cao-card-head">
                <span className="cao-cell-ref">
                  {ind.sheetName}!{ind.cell}
                </span>
                {ind.author ? (
                  <span className="cao-author">{ind.author}</span>
                ) : null}
              </div>
              <p className="cao-body" title={ind.text}>
                {truncated}
              </p>
              <div className="cao-actions">
                <button
                  type="button"
                  className="cao-jump"
                  onClick={() => onJumpTo(ind.sheetId, ind.cell)}
                >
                  ジャンプ
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
