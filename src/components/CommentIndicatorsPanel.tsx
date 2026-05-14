import { useState } from "react";
import type { CommentIndicator } from "../store/commentIndicators";
import "./CommentIndicatorsPanel.css";

interface Props {
  indicators: CommentIndicator[];
  /**
   * Invoked when the user clicks an entry. Lets EditorScreen jump the
   * Univer selection to the target cell so the next Shift+F2 opens the
   * correct comment. Optional — when omitted the panel is read-only.
   */
  onSelect?: (indicator: CommentIndicator) => void;
}

/**
 * Floating panel in the corner of the editor that surfaces every cell
 * carrying a comment. Compensates for the fact that Univer 0.5.x's
 * facade doesn't expose a cell-decoration / pixel-position API, so we
 * can't draw an in-cell triangle aligned to the canvas without diving
 * into the unstable internal render-controller services.
 *
 * Each row shows a small red triangle (matching Excel's note glyph),
 * the cell ref, and the comment text. Hovering the row shows the full
 * comment text via a native `title=""` tooltip; clicking jumps the
 * Univer selection to the target cell via the `onSelect` callback.
 *
 * The panel collapses to a small badge ("notes: N") when minimized so
 * it doesn't permanently occupy grid real estate. Renders nothing when
 * there are no comments to avoid visual noise on workbooks without notes.
 */
export default function CommentIndicatorsPanel({ indicators, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (indicators.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="cip-badge"
        onClick={() => setCollapsed(false)}
        title={`コメント ${indicators.length} 件（クリックで展開）`}
        aria-label={`コメント ${indicators.length} 件を表示`}
      >
        <span className="cip-triangle" aria-hidden="true" />
        <span className="cip-badge-count">{indicators.length}</span>
      </button>
    );
  }

  return (
    <aside
      className="cip-panel"
      role="region"
      aria-label="コメント一覧"
    >
      <header className="cip-header">
        <span className="cip-title">
          <span className="cip-triangle" aria-hidden="true" />
          コメント ({indicators.length})
        </span>
        <button
          type="button"
          className="cip-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>
      <ul className="cip-list">
        {indicators.map((ind, i) => {
          // Combine author + text for the hover tooltip so the user can
          // see who wrote what without committing to a click.
          const tooltip = ind.author
            ? `${ind.author}: ${ind.text}`
            : ind.text;
          return (
            <li key={`${ind.sheetId}-${ind.cell}-${i}`} className="cip-item">
              <button
                type="button"
                className="cip-item-btn"
                title={tooltip}
                onClick={() => onSelect?.(ind)}
              >
                <span className="cip-triangle" aria-hidden="true" />
                <span className="cip-cell-ref">
                  {ind.sheetName}!{ind.cell}
                </span>
                <span className="cip-text">{ind.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
