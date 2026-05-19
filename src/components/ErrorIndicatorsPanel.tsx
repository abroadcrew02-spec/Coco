import { useMemo, useState } from "react";
import { collectAuditIssues, type AuditIssue } from "../store/formulaAudit";
import "./ErrorIndicatorsPanel.css";

interface Props {
  /** Serialized snapshot JSON — same source EditorScreen passes around for
   *  every other audit/preview panel. The panel parses it lazily inside
   *  useMemo so a noop re-render doesn't re-walk every cell. */
  workbookSnapshotJson: string;
  /** Click handler: jumps Univer's selection to (sheetId, cellRef). Optional
   *  callers can omit the jump in test contexts. */
  onJumpTo: (sheetId: string, cellRef: string) => void;
}

/**
 * Floating panel mirroring CommentIndicatorsPanel — surfaces every cell
 * the auditor flagged with an error value. Univer 0.5.x has no public API
 * for in-cell decorations, so the panel doubles as a navigable list and
 * doesn't try to render an in-grid triangle.
 *
 * Issues are grouped by sheet so the user can scan a workbook with many
 * sheets without scrolling past unrelated cells. The panel collapses to a
 * pill badge when minimized; renders nothing when there are no issues to
 * avoid noise on clean workbooks.
 */
export default function ErrorIndicatorsPanel({ workbookSnapshotJson, onJumpTo }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // Parse + walk the snapshot only when the source string changes. The
  // workbook snapshot is already JSON-stringified upstream so this is the
  // single source of truth for what's "in" the workbook right now.
  const issues = useMemo<AuditIssue[]>(() => {
    if (!workbookSnapshotJson) return [];
    try {
      const parsed = JSON.parse(workbookSnapshotJson) as unknown;
      return collectAuditIssues(parsed);
    } catch {
      return [];
    }
  }, [workbookSnapshotJson]);

  // Group by sheetId, preserving the (collectAuditIssues-guaranteed)
  // workbook order. A Map keeps insertion order so we don't need a side
  // structure to remember which sheet appeared first.
  const grouped = useMemo(() => {
    const map = new Map<string, { sheetName: string; items: AuditIssue[] }>();
    for (const issue of issues) {
      const existing = map.get(issue.sheetId);
      if (existing) {
        existing.items.push(issue);
      } else {
        map.set(issue.sheetId, { sheetName: issue.sheetName, items: [issue] });
      }
    }
    return Array.from(map.entries());
  }, [issues]);

  if (issues.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="eip-badge"
        onClick={() => setCollapsed(false)}
        title={`エラー ${issues.length} 件（クリックで展開）`}
        aria-label={`エラー ${issues.length} 件を表示`}
      >
        <span className="eip-glyph" aria-hidden="true">⚠</span>
        <span className="eip-badge-count">{issues.length}</span>
      </button>
    );
  }

  return (
    <aside className="eip-panel" role="region" aria-label="エラー一覧">
      <header className="eip-header">
        <span className="eip-title">
          <span className="eip-glyph" aria-hidden="true">⚠</span>
          エラー ({issues.length})
        </span>
        <button
          type="button"
          className="eip-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>
      <div className="eip-list">
        {grouped.map(([sheetId, { sheetName, items }]) => (
          <section key={sheetId} className="eip-group">
            <h3 className="eip-group-title">{sheetName}</h3>
            <ul className="eip-items">
              {items.map((issue, i) => (
                <li key={`${sheetId}-${issue.cellRef}-${i}`} className="eip-item">
                  <button
                    type="button"
                    className="eip-item-btn"
                    title={`${issue.sheetName}!${issue.cellRef} — ${issue.detail}`}
                    onClick={() => onJumpTo(sheetId, issue.cellRef)}
                  >
                    <span className="eip-cell-ref">{issue.cellRef}</span>
                    <span className="eip-detail">{issue.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
