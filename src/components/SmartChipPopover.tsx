// Smart chips MVP (#158) — hover popover that surfaces the detected chips
// for a single cell and offers an action button per chip kind. Mounted as
// a sibling of the Univer container in EditorScreen; positioned absolutely
// at the last hovered cell's client coordinates so the popover floats next
// to the cell without clipping into the canvas.
//
// Render is intentionally minimal: a small bordered card with one row per
// chip (icon + label + action). We don't try to imitate Excel's data-card
// because that scope is huge — the popover is "here are the chips, what
// do you want to do?".
//
// Lifecycle:
//   - Visible only when `chips.length > 0` AND `anchor != null`.
//   - EditorScreen feeds `chips` (lazy-detected on hover) and
//     `anchor` (clientX/clientY). When the hover moves to a different cell
//     the parent re-feeds; when it leaves the grid the parent passes null.
//   - Clicking an action button calls back into the parent which routes
//     URL/email through `invoke("open_url")` or opens the date picker.

import { useEffect } from "react";
import type { SmartChip, SmartChipKind } from "../store/smartChips";
import "./SmartChipPopover.css";

export interface SmartChipPopoverAnchor {
  /** Client-space coordinates for the popover's top-left corner. */
  x: number;
  y: number;
}

interface Props {
  chips: SmartChip[];
  anchor: SmartChipPopoverAnchor | null;
  /**
   * Called when the user picks an action on a chip. For url/email the
   * parent invokes the OS shell; for date the parent opens a picker.
   */
  onActivate: (chip: SmartChip) => void;
  /**
   * Called when the user explicitly dismisses the popover (Escape or
   * clicking outside). The parent then sets `anchor` back to null.
   */
  onDismiss: () => void;
}

function iconFor(kind: SmartChipKind): string {
  // Plain text glyphs — no icon-font dependency. Matches the rest of
  // Coco's panel-glyph style (e.g. CommentIndicatorsPanel's red triangle).
  if (kind === "url") return "🔗";
  if (kind === "email") return "✉";
  if (kind === "custom") return "🏷";
  return "📅";
}

function labelFor(chip: SmartChip): string {
  if (chip.kind === "url") return "リンクを開く";
  if (chip.kind === "email") return "メールを送信";
  // Custom chips (#185): the rule name is the most useful action label
  // ("JIRA チケットを開く" reads better than a generic "リンクを開く").
  if (chip.kind === "custom") return chip.ruleName?.trim() || "リンクを開く";
  return "カレンダーで開く";
}

export default function SmartChipPopover({
  chips,
  anchor,
  onActivate,
  onDismiss,
}: Props) {
  // Escape key dismisses. We attach a global listener so the user can
  // hit Escape with focus still on the grid.
  useEffect(() => {
    if (!anchor || chips.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor, chips.length, onDismiss]);

  if (!anchor || chips.length === 0) return null;

  // Clamp into the viewport so a hover near the right/bottom edge doesn't
  // push the popover off-screen. We use estimated card dimensions because
  // we don't have a ref yet on first render; the values are conservative.
  const VIEW_W = window.innerWidth || 1024;
  const VIEW_H = window.innerHeight || 768;
  const CARD_W = 240;
  const CARD_H = 30 + chips.length * 32;
  const left = Math.max(8, Math.min(anchor.x, VIEW_W - CARD_W - 8));
  const top = Math.max(8, Math.min(anchor.y, VIEW_H - CARD_H - 8));

  return (
    <div
      className="smart-chip-popover"
      role="dialog"
      aria-label="スマートチップ"
      style={{ left, top }}
    >
      <ul className="scp-list">
        {chips.map((chip, i) => (
          <li key={`${chip.kind}-${chip.start}-${i}`} className="scp-row">
            <span className="scp-icon" aria-hidden="true">
              {iconFor(chip.kind)}
            </span>
            <span className="scp-value" title={chip.value}>
              {chip.kind === "date" && chip.iso ? chip.iso : chip.value}
            </span>
            <button
              type="button"
              className="scp-action"
              onClick={() => onActivate(chip)}
              title={labelFor(chip)}
            >
              {labelFor(chip)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
