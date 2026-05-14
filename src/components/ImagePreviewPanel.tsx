import { useState } from "react";
import type { ImagePreview } from "../store/imagePreviews";
import { colRowToA1 } from "../store/imagePreviews";
import "./ImagePreviewPanel.css";

interface Props {
  images: ImagePreview[];
  /**
   * Invoked when the user clicks a thumbnail. Lets EditorScreen jump the
   * Univer selection to the image's anchor cell so the user can navigate
   * to where it sits in the grid. Optional — when omitted the panel is
   * read-only.
   */
  onSelect?: (image: ImagePreview) => void;
}

/**
 * Floating panel in the corner of the editor that surfaces every embedded
 * image present in the workbook. Phase 2 of in-grid image support: the
 * full xlsx round-trip preserves images byte-for-byte (xlsx_io.rs +
 * `_preservedParts`), and the insert-image dialog adds new ones, but
 * Univer 0.5.x's facade exposes no decoration / pixel-position API, so
 * we can't draw a true canvas-aligned overlay without diving into the
 * unstable render-controller services.
 *
 * The MVP renders a side list of thumbnails labelled with the anchor
 * cell (e.g. "Sheet1!A1"). Clicking a thumbnail jumps the Univer
 * selection to that cell via the `onSelect` callback. The panel
 * collapses to a small badge ("images: N") so it stays out of the way
 * when the user doesn't need it; renders nothing when there are no
 * images, to avoid noise on workbooks without media.
 *
 * Same UX shape as CommentIndicatorsPanel — a deliberate consistency
 * choice so users see one "auxiliary content directory" pattern across
 * both features.
 */
export default function ImagePreviewPanel({ images, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (images.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="ipp-badge"
        onClick={() => setCollapsed(false)}
        title={`画像 ${images.length} 件（クリックで展開）`}
        aria-label={`画像 ${images.length} 件を表示`}
      >
        <span className="ipp-icon" aria-hidden="true">
          {/* Small framed-picture glyph drawn via inline SVG so it ships
              with no extra assets and stays crisp at any DPI. */}
          <svg viewBox="0 0 16 16" width="14" height="14">
            <rect
              x="1"
              y="2"
              width="14"
              height="12"
              rx="1"
              fill="none"
              stroke="#4338ca"
              strokeWidth="1.2"
            />
            <circle cx="5" cy="6" r="1.2" fill="#4338ca" />
            <path
              d="M1.5 13 L5.5 9 L9 12 L11.5 9.5 L14.5 13"
              fill="none"
              stroke="#4338ca"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="ipp-badge-count">{images.length}</span>
      </button>
    );
  }

  return (
    <aside className="ipp-panel" role="region" aria-label="画像一覧">
      <header className="ipp-header">
        <span className="ipp-title">画像 ({images.length})</span>
        <button
          type="button"
          className="ipp-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>
      <ul className="ipp-list">
        {images.map((img, i) => {
          const a1 = colRowToA1(img.fromCol, img.fromRow);
          const label = `${img.sheetName}!${a1}`;
          return (
            <li key={`${img.sheetId}-${img.mediaPath}-${i}`} className="ipp-item">
              <button
                type="button"
                className="ipp-item-btn"
                title={`${label} (${img.mediaPath})`}
                onClick={() => onSelect?.(img)}
              >
                <img
                  className="ipp-thumb"
                  src={img.src}
                  alt={label}
                  loading="lazy"
                />
                <span className="ipp-cell-ref">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
