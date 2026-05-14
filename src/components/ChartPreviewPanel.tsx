import { useState } from "react";
import type { ChartPreview } from "./chartPreviewData";
import "./ChartPreviewPanel.css";

interface Props {
  previews: ChartPreview[];
  /**
   * Invoked when the user clicks a chart entry. Lets EditorScreen jump the
   * Univer selection to the chart's source range so the user can edit the
   * underlying data. Optional — when omitted the panel is read-only.
   */
  onSelect?: (preview: ChartPreview) => void;
}

// Fixed canvas size used for every inline SVG render. Small enough to fit
// several charts in the sidebar without scrolling per chart, large enough
// that a dozen-or-so bars / pie slices are still distinguishable.
const SVG_W = 220;
const SVG_H = 120;
const PAD_X = 24;
const PAD_Y = 16;

// Palette borrowed from a colorblind-friendly Tableau-style set. Each
// rendered chart cycles through this list deterministically so the user
// gets a stable visual signature per dataset.
const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

/**
 * Floating sidebar listing authored charts (`_charts`) on every sheet,
 * each rendered as a small inline SVG.
 *
 * Why a sidebar rather than a canvas-aligned overlay: Univer 0.5.x's
 * facade does not expose pixel coordinates for an A1 range, so anchoring
 * an overlay to the chart's source `range` cell would require diving into
 * unstable render-controller internals — same constraint that drove the
 * CommentIndicatorsPanel design. The sidebar trades pixel fidelity for
 * stability while still satisfying the "user sees SOMETHING for their
 * chart" goal (vs. the prior invisible state).
 *
 * Each entry shows: sheet!range header, the chart type icon, an optional
 * title, and a 220x120 SVG. Hovering shows a native tooltip with the
 * full data table. Clicking jumps the Univer selection to the range so
 * the user can edit the data.
 *
 * Renders nothing when there are no charts to avoid visual noise on
 * workbooks without authored charts.
 */
export default function ChartPreviewPanel({ previews, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (previews.length === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="cpp-badge"
        onClick={() => setCollapsed(false)}
        title={`グラフ ${previews.length} 件（クリックで展開）`}
        aria-label={`グラフ ${previews.length} 件を表示`}
      >
        <span className="cpp-icon" aria-hidden="true">📊</span>
        <span className="cpp-badge-count">{previews.length}</span>
      </button>
    );
  }

  return (
    <aside className="cpp-panel" role="region" aria-label="グラフ一覧">
      <header className="cpp-header">
        <span className="cpp-title">
          <span className="cpp-icon" aria-hidden="true">📊</span>
          グラフ ({previews.length})
        </span>
        <button
          type="button"
          className="cpp-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="最小化"
          title="最小化"
        >
          −
        </button>
      </header>
      <ul className="cpp-list">
        {previews.map((p, i) => {
          const tooltip = renderTooltip(p);
          return (
            <li key={`${p.sheetId}-${p.range}-${i}`} className="cpp-item">
              <button
                type="button"
                className="cpp-item-btn"
                title={tooltip}
                onClick={() => onSelect?.(p)}
              >
                <div className="cpp-item-meta">
                  <span className="cpp-cell-ref">
                    {p.sheetName}!{p.range}
                  </span>
                  <span className="cpp-type">[{p.type}]</span>
                </div>
                {p.title && <div className="cpp-chart-title">{p.title}</div>}
                <ChartSvg preview={p} />
                {p.data.length === 0 && (
                  <p className="cpp-empty">数値データが見つかりません</p>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function renderTooltip(p: ChartPreview): string {
  if (p.data.length === 0) return `${p.sheetName}!${p.range} (no numeric data)`;
  const rows = p.labels.map((l, i) => `${l}: ${p.data[i]}`).join("\n");
  return `${p.sheetName}!${p.range}\n${rows}`;
}

function ChartSvg({ preview }: { preview: ChartPreview }) {
  if (preview.data.length === 0) {
    return (
      <svg
        className="cpp-svg cpp-svg--empty"
        width={SVG_W}
        height={SVG_H}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        aria-hidden="true"
      >
        <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#f9fafb" />
        <line x1={PAD_X} y1={SVG_H - PAD_Y} x2={SVG_W - PAD_X / 2} y2={SVG_H - PAD_Y} stroke="#d1d5db" />
        <line x1={PAD_X} y1={SVG_H - PAD_Y} x2={PAD_X} y2={PAD_Y} stroke="#d1d5db" />
      </svg>
    );
  }
  switch (preview.type) {
    case "bar":
      return <BarChart preview={preview} />;
    case "line":
      return <LineChart preview={preview} />;
    case "pie":
      return <PieChart preview={preview} />;
  }
}

// ---------- Bar ----------

function BarChart({ preview }: { preview: ChartPreview }) {
  const { data, labels } = preview;
  const plotW = SVG_W - PAD_X * 1.25;
  const plotH = SVG_H - PAD_Y * 2;
  const xLeft = PAD_X;
  const yTop = PAD_Y;
  const yBase = yTop + plotH;
  // Include zero so negative-only / positive-only data still anchors at 0.
  const allWithZero = [0, ...data];
  const min = Math.min(...allWithZero);
  const max = Math.max(...allWithZero);
  const span = max - min || 1;
  const zeroY = yBase - ((0 - min) / span) * plotH;
  const slot = plotW / data.length;
  const barW = Math.max(2, slot * 0.7);
  const barOffset = (slot - barW) / 2;

  return (
    <svg
      className="cpp-svg"
      width={SVG_W}
      height={SVG_H}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      aria-label={`bar chart, ${data.length} values`}
    >
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#ffffff" />
      {/* Axes */}
      <line x1={xLeft} y1={yBase} x2={xLeft + plotW} y2={yBase} stroke="#9ca3af" />
      <line x1={xLeft} y1={yTop} x2={xLeft} y2={yBase} stroke="#9ca3af" />
      {/* Zero line when data crosses zero */}
      {min < 0 && max > 0 && (
        <line
          x1={xLeft}
          y1={zeroY}
          x2={xLeft + plotW}
          y2={zeroY}
          stroke="#d1d5db"
          strokeDasharray="2 2"
        />
      )}
      {/* Bars */}
      {data.map((v, i) => {
        const top = yBase - ((Math.max(v, 0) - min) / span) * plotH;
        const bot = yBase - ((Math.min(v, 0) - min) / span) * plotH;
        const h = Math.max(1, bot - top);
        const x = xLeft + i * slot + barOffset;
        return (
          <rect
            key={i}
            x={x}
            y={top}
            width={barW}
            height={h}
            fill={PALETTE[i % PALETTE.length]}
          />
        );
      })}
      {/* First + last label only (avoids overlap on small width) */}
      {labels.length > 0 && (
        <text x={xLeft} y={SVG_H - 2} fontSize={9} fill="#6b7280">
          {truncate(labels[0], 6)}
        </text>
      )}
      {labels.length > 1 && (
        <text
          x={xLeft + plotW}
          y={SVG_H - 2}
          fontSize={9}
          fill="#6b7280"
          textAnchor="end"
        >
          {truncate(labels[labels.length - 1], 6)}
        </text>
      )}
      {/* Min / max value labels */}
      <text x={xLeft - 2} y={yTop + 4} fontSize={9} fill="#6b7280" textAnchor="end">
        {fmt(max)}
      </text>
      <text x={xLeft - 2} y={yBase} fontSize={9} fill="#6b7280" textAnchor="end">
        {fmt(min)}
      </text>
    </svg>
  );
}

// ---------- Line ----------

function LineChart({ preview }: { preview: ChartPreview }) {
  const { data, labels } = preview;
  const plotW = SVG_W - PAD_X * 1.25;
  const plotH = SVG_H - PAD_Y * 2;
  const xLeft = PAD_X;
  const yTop = PAD_Y;
  const yBase = yTop + plotH;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  // For a single point, place it in the middle horizontally.
  const step = data.length > 1 ? plotW / (data.length - 1) : 0;

  const points = data.map((v, i) => {
    const x = data.length > 1 ? xLeft + i * step : xLeft + plotW / 2;
    const y = yBase - ((v - min) / span) * plotH;
    return { x, y };
  });
  const path =
    points.length > 0
      ? points
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
          .join(" ")
      : "";

  return (
    <svg
      className="cpp-svg"
      width={SVG_W}
      height={SVG_H}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      aria-label={`line chart, ${data.length} values`}
    >
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#ffffff" />
      <line x1={xLeft} y1={yBase} x2={xLeft + plotW} y2={yBase} stroke="#9ca3af" />
      <line x1={xLeft} y1={yTop} x2={xLeft} y2={yBase} stroke="#9ca3af" />
      <path d={path} fill="none" stroke={PALETTE[0]} strokeWidth={1.5} />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={PALETTE[0]} />
      ))}
      {labels.length > 0 && (
        <text x={xLeft} y={SVG_H - 2} fontSize={9} fill="#6b7280">
          {truncate(labels[0], 6)}
        </text>
      )}
      {labels.length > 1 && (
        <text
          x={xLeft + plotW}
          y={SVG_H - 2}
          fontSize={9}
          fill="#6b7280"
          textAnchor="end"
        >
          {truncate(labels[labels.length - 1], 6)}
        </text>
      )}
      <text x={xLeft - 2} y={yTop + 4} fontSize={9} fill="#6b7280" textAnchor="end">
        {fmt(max)}
      </text>
      <text x={xLeft - 2} y={yBase} fontSize={9} fill="#6b7280" textAnchor="end">
        {fmt(min)}
      </text>
    </svg>
  );
}

// ---------- Pie ----------

function PieChart({ preview }: { preview: ChartPreview }) {
  const { data, labels } = preview;
  // Pie charts can't represent negative slices. Treat them as absolute.
  const positives = data.map((v) => Math.abs(v));
  const total = positives.reduce((a, b) => a + b, 0);

  const cx = SVG_W / 2 - 20;
  const cy = SVG_H / 2;
  const r = Math.min(SVG_W / 2 - 28, SVG_H / 2 - 8);

  if (total === 0) {
    return (
      <svg
        className="cpp-svg"
        width={SVG_W}
        height={SVG_H}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        aria-label="pie chart, all zero"
      >
        <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#ffffff" />
        <circle cx={cx} cy={cy} r={r} fill="#e5e7eb" />
      </svg>
    );
  }

  let acc = 0;
  const slices = positives.map((v, i) => {
    const start = (acc / total) * Math.PI * 2;
    acc += v;
    const end = (acc / total) * Math.PI * 2;
    return { start, end, color: PALETTE[i % PALETTE.length], label: labels[i] ?? "", value: v };
  });

  return (
    <svg
      className="cpp-svg"
      width={SVG_W}
      height={SVG_H}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      aria-label={`pie chart, ${data.length} slices`}
    >
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#ffffff" />
      {slices.map((s, i) => {
        // Special-case a single 100% slice — an SVG arc path can't draw a
        // full circle in one segment.
        if (slices.length === 1) {
          return <circle key={i} cx={cx} cy={cy} r={r} fill={s.color} />;
        }
        const x1 = cx + r * Math.cos(s.start - Math.PI / 2);
        const y1 = cy + r * Math.sin(s.start - Math.PI / 2);
        const x2 = cx + r * Math.cos(s.end - Math.PI / 2);
        const y2 = cy + r * Math.sin(s.end - Math.PI / 2);
        const large = s.end - s.start > Math.PI ? 1 : 0;
        const d = `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
        return <path key={i} d={d} fill={s.color} stroke="#ffffff" strokeWidth={0.5} />;
      })}
      {/* Legend (up to first 4 entries) */}
      {slices.slice(0, 4).map((s, i) => (
        <g key={`lg-${i}`} transform={`translate(${SVG_W - 60}, ${10 + i * 14})`}>
          <rect width={10} height={10} fill={s.color} />
          <text x={14} y={9} fontSize={9} fill="#374151">
            {truncate(s.label || String(i + 1), 8)}
          </text>
        </g>
      ))}
      {slices.length > 4 && (
        <text x={SVG_W - 46} y={10 + 4 * 14 + 9} fontSize={9} fill="#6b7280">
          +{slices.length - 4}…
        </text>
      )}
    </svg>
  );
}

// ---------- Utils ----------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "";
  // Compact representation so 1000000 doesn't blow past the axis label space.
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  if (abs >= 1 || n === 0) return String(Math.round(n * 100) / 100);
  return n.toFixed(2);
}
