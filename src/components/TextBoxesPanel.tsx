import { useMemo, useState } from "react";
import type { ShapeKind, TextBox } from "../store/textBoxes";
import { colRowToA1, makeTextBoxId } from "../store/textBoxes";
import "./TextBoxesPanel.css";

interface Props {
  /** Shapes filtered to the active sheet — caller does the filtering. */
  textBoxes: TextBox[];
  /** Active sheet name for badge title / aria. */
  sheetName?: string;
  /**
   * Invoked when the user clicks a row. Lets the editor jump the Univer
   * selection to the shape's anchor cell. Optional — when omitted the
   * panel is read-only.
   */
  onSelect?: (tb: TextBox) => void;
  /** Delete callback — when omitted the delete button is hidden. */
  onDelete?: (tb: TextBox) => void;
  /**
   * Patch a shape's geometry / style. Powers the inline numeric editor
   * (#188) — Univer 0.5.x has no stable pixel-overlay API so move / resize
   * are done as cell-unit number edits here rather than by dragging.
   */
  onPatch?: (id: string, patch: Partial<Omit<TextBox, "id">>) => void;
  /**
   * Group / ungroup the supplied shape ids (#188). A non-empty `groupId`
   * groups them; `undefined` clears the grouping.
   */
  onGroup?: (ids: string[], groupId: string | undefined) => void;
}

/** Human label for a shape kind. */
function kindLabel(kind: ShapeKind | undefined): string {
  switch (kind) {
    case "rect":
      return "矩形";
    case "ellipse":
      return "円";
    case "line":
      return "線";
    case "textbox":
    default:
      return "テキスト";
  }
}

/**
 * Floating panel that lists every shape (text box / rectangle / ellipse /
 * line) on the active sheet. Same UX shape as ImagePreviewPanel — collapsible
 * to a small badge so it stays out of the way. We render nothing when there
 * are no shapes so workbooks without shapes don't see the panel at all.
 *
 * Note: Univer 0.5.x's facade exposes no pixel-aligned overlay API, so we
 * can't draw a true canvas-positioned shape on the grid or support drag /
 * resize. The panel is the MVP visual + editing surface — anchor cell and
 * size are edited as cell-unit numbers — and the xlsx export round-trip
 * ensures Excel renders the actual shape at the recorded anchor.
 */
export default function TextBoxesPanel({
  textBoxes,
  sheetName,
  onSelect,
  onDelete,
  onPatch,
  onGroup,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // Row id whose inline geometry editor is expanded. Only one at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Set of selected row ids for the group / ungroup action.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop selections that no longer exist (shape deleted / sheet switched).
  const liveSelected = useMemo(() => {
    const ids = new Set(textBoxes.map((t) => t.id));
    const next = new Set<string>();
    for (const id of selected) if (ids.has(id)) next.add(id);
    return next;
  }, [selected, textBoxes]);

  if (textBoxes.length === 0) return null;

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedList = textBoxes.filter((t) => liveSelected.has(t.id));
  // Group is offered when ≥2 shapes are selected; ungroup when every selected
  // shape already shares one group id.
  const canGroup = selectedList.length >= 2;
  const sharedGroupId =
    selectedList.length > 0 && selectedList.every((t) => t.groupId)
      ? selectedList[0].groupId
      : undefined;
  const canUngroup =
    selectedList.length >= 1 &&
    sharedGroupId !== undefined &&
    selectedList.every((t) => t.groupId === sharedGroupId);

  if (collapsed) {
    return (
      <button
        type="button"
        className="tbp-badge"
        onClick={() => setCollapsed(false)}
        title={`図形 ${textBoxes.length} 件（クリックで展開）`}
        aria-label={`図形 ${textBoxes.length} 件を表示`}
      >
        <span className="tbp-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="1"
              fill="none"
              stroke="#4338ca"
              strokeWidth="1.2"
            />
            <text
              x="8"
              y="11.5"
              textAnchor="middle"
              fontSize="9"
              fontWeight="700"
              fill="#4338ca"
              fontFamily="serif"
            >
              T
            </text>
          </svg>
        </span>
        <span className="tbp-badge-count">{textBoxes.length}</span>
      </button>
    );
  }

  return (
    <aside className="tbp-panel" role="region" aria-label="図形一覧">
      <header className="tbp-header">
        <span className="tbp-title">
          図形{sheetName ? ` — ${sheetName}` : ""} ({textBoxes.length})
        </span>
        <button
          type="button"
          className="tbp-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>
      {onGroup && (canGroup || canUngroup) && (
        <div className="tbp-group-bar">
          {canGroup && (
            <button
              type="button"
              className="tbp-group-btn"
              onClick={() => {
                onGroup(
                  selectedList.map((t) => t.id),
                  makeTextBoxId().replace(/^tb_/, "grp_"),
                );
                setSelected(new Set());
              }}
            >
              グループ化 ({selectedList.length})
            </button>
          )}
          {canUngroup && (
            <button
              type="button"
              className="tbp-group-btn"
              onClick={() => {
                onGroup(
                  selectedList.map((t) => t.id),
                  undefined,
                );
                setSelected(new Set());
              }}
            >
              グループ解除
            </button>
          )}
        </div>
      )}
      <ul className="tbp-list">
        {textBoxes.map((tb) => {
          const a1 = colRowToA1(tb.x, tb.y);
          const preview =
            tb.text.length > 32
              ? tb.text.slice(0, 30).replace(/\n/g, " ") + "…"
              : tb.text.replace(/\n/g, " ");
          const isEditing = editingId === tb.id;
          return (
            <li key={tb.id} className="tbp-item">
              <div className="tbp-item-main">
                {onGroup && (
                  <input
                    type="checkbox"
                    className="tbp-select"
                    checked={liveSelected.has(tb.id)}
                    onChange={() => toggleSelected(tb.id)}
                    aria-label={`${a1} の図形を選択`}
                  />
                )}
                <button
                  type="button"
                  className="tbp-item-btn"
                  onClick={() => onSelect?.(tb)}
                  title={`${a1} — ${tb.text || kindLabel(tb.type)}`}
                >
                  <span
                    className="tbp-preview"
                    style={{
                      color: tb.color,
                      backgroundColor:
                        tb.type === "line" ||
                        tb.backgroundColor === "transparent"
                          ? "transparent"
                          : tb.backgroundColor,
                      borderColor:
                        tb.borderColor === "transparent"
                          ? "transparent"
                          : tb.borderColor,
                      borderRadius: tb.type === "ellipse" ? "50%" : undefined,
                      fontFamily: tb.fontFamily || "inherit",
                      fontSize: `${Math.min(tb.fontSize, 14)}px`,
                    }}
                  >
                    {preview || `(${kindLabel(tb.type)})`}
                  </span>
                  <span className="tbp-cell-ref">
                    {kindLabel(tb.type)} · {a1} · {tb.w}×{tb.h}
                    {tb.groupId ? " · G" : ""}
                  </span>
                </button>
                {onPatch && (
                  <button
                    type="button"
                    className="tbp-edit"
                    onClick={() =>
                      setEditingId(isEditing ? null : tb.id)
                    }
                    aria-label={`${a1} の図形を編集`}
                    aria-expanded={isEditing ? "true" : "false"}
                    title="位置 / サイズを編集"
                  >
                    ✎
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    className="tbp-delete"
                    onClick={() => onDelete(tb)}
                    aria-label={`${a1} の図形を削除`}
                    title="削除"
                  >
                    ×
                  </button>
                )}
              </div>
              {isEditing && onPatch && (
                <div className="tbp-editor">
                  <label className="tbp-editor-field">
                    <span>列 (X)</span>
                    <input
                      type="number"
                      min={0}
                      value={tb.x}
                      onChange={(e) =>
                        onPatch(tb.id, {
                          x: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                        })
                      }
                    />
                  </label>
                  <label className="tbp-editor-field">
                    <span>行 (Y)</span>
                    <input
                      type="number"
                      min={0}
                      value={tb.y}
                      onChange={(e) =>
                        onPatch(tb.id, {
                          y: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                        })
                      }
                    />
                  </label>
                  <label className="tbp-editor-field">
                    <span>幅</span>
                    <input
                      type="number"
                      min={1}
                      value={tb.w}
                      onChange={(e) =>
                        onPatch(tb.id, {
                          w: Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                        })
                      }
                    />
                  </label>
                  <label className="tbp-editor-field">
                    <span>高さ</span>
                    <input
                      type="number"
                      min={1}
                      value={tb.h}
                      onChange={(e) =>
                        onPatch(tb.id, {
                          h: Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
