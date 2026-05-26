import { useMemo } from "react";
import { resolveInGridChartsForSheet } from "../store/inGridChartLayout";
import { extractChartData, renderChart } from "../store/chartRender";
import type { CellPixelOptions } from "../store/cellPixelBounds";
import "./InGridChartLayer.css";

interface Props {
  workbookSnapshotJson: string | null;
  activeSheetId: string | null;
  pixelOpts?: CellPixelOptions;
}

export default function InGridChartLayer({
  workbookSnapshotJson,
  activeSheetId,
  pixelOpts,
}: Props) {
  const items = useMemo(() => {
    if (!workbookSnapshotJson || !activeSheetId) return [];
    const placements = resolveInGridChartsForSheet(
      workbookSnapshotJson,
      activeSheetId,
      pixelOpts,
    );
    return placements.map((p) => {
      const data = extractChartData(workbookSnapshotJson, {
        entry: p.entry,
        sheetId: activeSheetId,
      });
      const svg = renderChart(data, p.entry, p.box.width, p.box.height);
      return { placement: p, svg };
    });
  }, [workbookSnapshotJson, activeSheetId, pixelOpts]);

  if (items.length === 0) return null;

  return (
    <div className="ingrid-chart-layer" role="presentation" aria-hidden="true">
      {items.map(({ placement, svg }) => (
        <div
          key={placement.key}
          className="ingrid-chart-frame"
          style={{
            left: placement.box.left,
            top: placement.box.top,
            width: placement.box.width,
            height: placement.box.height,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ))}
    </div>
  );
}
