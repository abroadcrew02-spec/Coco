import { useMemo, useState } from "react";
import {
  extractChartData,
  listAllCharts,
  renderChart,
  type ChartListing,
} from "../store/chartRender";
import "./ChartCanvasPanel.css";

interface Props {
  /** Full Univer workbook snapshot, serialized — same source as
   *  ChartPreviewPanel. The panel reparses internally; callers don't need
   *  to pre-extract chart entries. */
  workbookSnapshotJson: string;
}

const CANVAS_W = 480;
const CANVAS_H = 300;

/**
 * Sidebar panel that renders the workbook's currently-selected chart
 * (`_charts` entry) as a live inline SVG. Distinct from ChartPreviewPanel,
 * which lists all charts at small size; this panel focuses on ONE chart at
 * full readable size so the user can verify their data before exporting.
 *
 * Selection state: kept local — the dropdown picks among every authored
 * chart workbook-wide. When the underlying snapshot changes, the list
 * regenerates and we clamp the selection to a valid index so the panel
 * stays mounted across edits.
 *
 * Render path: extractChartData (pure) → renderChart (pure SVG string) →
 * dangerouslySetInnerHTML. Re-renders are cheap because React doesn't
 * have to reconcile every <rect>. Fixed 480x300 viewport; CSS scales the
 * SVG element responsively if the panel is narrower than 480.
 *
 * The panel renders nothing when the workbook has no charts so EditorScreen
 * doesn't show an empty box on a fresh sheet.
 */
export default function ChartCanvasPanel({ workbookSnapshotJson }: Props) {
  const listings: ChartListing[] = useMemo(
    () => listAllCharts(workbookSnapshotJson),
    [workbookSnapshotJson],
  );

  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState(0);

  // If a chart was deleted out from under us, clamp the index so we don't
  // try to render undefined.
  const safeIdx =
    listings.length === 0 ? 0 : Math.min(selected, listings.length - 1);
  const current: ChartListing | undefined = listings[safeIdx];

  const svg = useMemo(() => {
    if (!current) return "";
    const data = extractChartData(workbookSnapshotJson, {
      entry: current.entry,
      sheetId: current.sheetId,
    });
    return renderChart(data, current.entry, CANVAS_W, CANVAS_H);
  }, [current, workbookSnapshotJson]);

  if (listings.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="ccp-badge"
        onClick={() => setCollapsed(false)}
        title={`グラフ ${listings.length} 件（クリックで展開）`}
        aria-label={`グラフ ${listings.length} 件を表示`}
      >
        <span className="ccp-icon" aria-hidden="true">📈</span>
        <span className="ccp-badge-count">{listings.length}</span>
      </button>
    );
  }

  return (
    <aside className="ccp-panel" role="region" aria-label="グラフ表示">
      <header className="ccp-header">
        <span className="ccp-title">
          <span className="ccp-icon" aria-hidden="true">📈</span>
          グラフ表示
        </span>
        <button
          type="button"
          className="ccp-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>
      <div className="ccp-body">
        <label className="ccp-picker">
          <span className="ccp-picker-label">グラフ</span>
          <select
            className="ccp-select"
            value={safeIdx}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {listings.map((l, i) => {
              const label =
                (l.entry.title ? `${l.entry.title} — ` : "") +
                `${l.sheetName}!${l.entry.range} [${l.entry.type}]`;
              return (
                <option key={`${l.sheetId}-${l.index}`} value={i}>
                  {label}
                </option>
              );
            })}
          </select>
        </label>
        <div
          className="ccp-canvas"
          aria-label={
            current
              ? `${current.entry.type} chart for ${current.sheetName}!${current.entry.range}`
              : "chart"
          }
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </aside>
  );
}
