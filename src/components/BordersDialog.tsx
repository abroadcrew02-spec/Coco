import { useEffect, useMemo, useState } from "react";
import {
  BORDER_PRESETS,
  type BorderParams,
  type BorderPreset,
  type BorderStyle,
} from "../store/borders";
import "./BordersDialog.css";

// i18n: once `dialog.borders` is registered in src/i18n/locale.ts the title
// below should swap to t("dialog.borders"). The constant here mirrors the
// string the user will add (see deliverable).
const TITLE_JA = "罫線";

interface Props {
  /** Initial A1 range string, e.g. "Sheet1!A1:C10" or "A1". */
  initialRange: string;
  /** Active sheet id — opaque to the dialog; relayed back via onApply. */
  sheetId: string;
  /** Caller resolves the range + applies the borders to the snapshot. */
  onApply: (params: BorderParams) => void;
  onClose: () => void;
}

// Bare or sheet-qualified A1 rectangle. Single-cell refs are allowed —
// you can put a border on one cell in Excel.
const RANGE_RE =
  /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

const STYLE_OPTIONS: ReadonlyArray<{ value: BorderStyle; labelJa: string }> = [
  { value: "thin", labelJa: "細線" },
  { value: "medium", labelJa: "中線" },
  { value: "thick", labelJa: "太線" },
  { value: "dashed", labelJa: "破線" },
  { value: "dotted", labelJa: "点線" },
  { value: "double", labelJa: "二重線" },
];

function colLetterToIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseRange(
  range: string,
): { r1: number; c1: number; r2: number; c2: number } | null {
  const cleaned = range.includes("!")
    ? range.split("!").slice(1).join("!")
    : range;
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(
    cleaned.trim(),
  );
  if (!m) return null;
  const c1 = colLetterToIndex(m[1]);
  const r1 = parseInt(m[2], 10) - 1;
  const c2 = m[3] ? colLetterToIndex(m[3]) : c1;
  const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
  if (r1 < 0 || c1 < 0 || r2 < 0 || c2 < 0) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

/** Draw the preset's pattern on a 3x3 grid as inline SVG. The grid sits
 *  inside a 36x36 viewbox with a 4px gutter so the strokes don't clip. */
function PresetIcon({ preset, color }: { preset: BorderPreset; color: string }) {
  // Grid coordinates: rows at y = {6, 16, 26, 36}, cols at x = {6, 16, 26, 36}.
  const x0 = 6;
  const x1 = 16;
  const x2 = 26;
  const x3 = 36;
  const y0 = 6;
  const y1 = 16;
  const y2 = 26;
  const y3 = 36;

  const lines: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    weight?: "thin" | "thick" | "double";
  }> = [];

  const w: "thin" | "thick" | "double" = preset.sides.doubleBottom
    ? "double"
    : preset.sides.thickBottom
      ? "thick"
      : "thin";

  if (preset.sides.t)
    lines.push({ x1: x0, y1: y0, x2: x3, y2: y0, weight: "thin" });
  if (preset.sides.b)
    lines.push({ x1: x0, y1: y3, x2: x3, y2: y3, weight: w });
  if (preset.sides.l)
    lines.push({ x1: x0, y1: y0, x2: x0, y2: y3, weight: "thin" });
  if (preset.sides.r)
    lines.push({ x1: x3, y1: y0, x2: x3, y2: y3, weight: "thin" });
  if (preset.sides.insideH) {
    lines.push({ x1: x0, y1: y1, x2: x3, y2: y1, weight: "thin" });
    lines.push({ x1: x0, y1: y2, x2: x3, y2: y2, weight: "thin" });
  }
  if (preset.sides.insideV) {
    lines.push({ x1: x1, y1: y0, x2: x1, y2: y3, weight: "thin" });
    lines.push({ x1: x2, y1: y0, x2: x2, y2: y3, weight: "thin" });
  }

  return (
    <svg
      viewBox="0 0 42 42"
      width="42"
      height="42"
      className="bd-preset-icon"
      aria-hidden="true"
    >
      {/* Faint guide grid (always rendered) so users see the 3x3 reference. */}
      {[y0, y1, y2, y3].map((y) => (
        <line
          key={`g-h-${y}`}
          x1={x0}
          y1={y}
          x2={x3}
          y2={y}
          stroke="#e2e2e2"
          strokeWidth={0.5}
        />
      ))}
      {[x0, x1, x2, x3].map((x) => (
        <line
          key={`g-v-${x}`}
          x1={x}
          y1={y0}
          x2={x}
          y2={y3}
          stroke="#e2e2e2"
          strokeWidth={0.5}
        />
      ))}
      {/* Painted edges. Double = two stacked parallel lines. */}
      {lines.map((l, i) => {
        if (l.weight === "double") {
          // Offset perpendicular to the line direction by 1.5px each way.
          const horiz = l.y1 === l.y2;
          const dx = horiz ? 0 : 1.5;
          const dy = horiz ? 1.5 : 0;
          return (
            <g key={i}>
              <line
                x1={l.x1 - dx}
                y1={l.y1 - dy}
                x2={l.x2 - dx}
                y2={l.y2 - dy}
                stroke={color}
                strokeWidth={1}
              />
              <line
                x1={l.x1 + dx}
                y1={l.y1 + dy}
                x2={l.x2 + dx}
                y2={l.y2 + dy}
                stroke={color}
                strokeWidth={1}
              />
            </g>
          );
        }
        return (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={color}
            strokeWidth={l.weight === "thick" ? 2.5 : 1.25}
          />
        );
      })}
    </svg>
  );
}

export default function BordersDialog({
  initialRange,
  sheetId,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [preset, setPreset] = useState<string>("outside");
  const [color, setColor] = useState<string>("#000000");
  const [style, setStyle] = useState<BorderStyle>("thin");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const parsed = useMemo(() => parseRange(range), [range]);

  const submit = () => {
    const trimmed = range.trim();
    if (!trimmed) {
      setError("適用範囲は必須です");
      return;
    }
    if (!RANGE_RE.test(trimmed)) {
      setError("範囲は A1 形式で指定してください (例: A1 や A1:C10)");
      return;
    }
    const rect = parseRange(trimmed);
    if (!rect) {
      setError("範囲を解釈できませんでした");
      return;
    }
    setError(null);
    onApply({
      range: rect,
      preset,
      color,
      style,
    });
    onClose();
  };

  // sheetId is currently opaque to the dialog but threaded through props so
  // the caller can map presets to the right sheet without re-deriving it.
  void sheetId;

  return (
    <div className="bd-backdrop" onClick={onClose}>
      <div
        className="bd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bd-header">
          <h2 id="bd-title" className="bd-title">
            {TITLE_JA}
          </h2>
          <button
            type="button"
            className="bd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="bd-body">
          <label className="bd-field">
            <span className="bd-field-label">適用範囲</span>
            <input
              type="text"
              className="bd-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1:C10"
              autoFocus
            />
          </label>

          <fieldset className="bd-presets">
            <legend className="bd-field-label">プリセット</legend>
            <div className="bd-preset-grid">
              {BORDER_PRESETS.map((p) => {
                const selected = p.id === preset;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`bd-preset${selected ? " bd-preset--selected" : ""}`}
                    onClick={() => setPreset(p.id)}
                    aria-pressed={selected}
                    title={`${p.nameJa} / ${p.nameEn}`}
                    data-testid={`borders-preset-${p.id}`}
                  >
                    <PresetIcon preset={p} color={color} />
                    <span className="bd-preset-label">{p.nameJa}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="bd-row">
            <label className="bd-field bd-field--inline">
              <span className="bd-field-label">線の色</span>
              <input
                type="color"
                className="bd-color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="線の色"
              />
            </label>
            <label className="bd-field bd-field--inline bd-field--grow">
              <span className="bd-field-label">線種</span>
              <select
                className="bd-select"
                value={style}
                onChange={(e) => setStyle(e.target.value as BorderStyle)}
                aria-label="線の種類"
              >
                {STYLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.labelJa}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {parsed && (
            <p className="bd-hint">
              {`対象セル数: ${(parsed.r2 - parsed.r1 + 1) * (parsed.c2 - parsed.c1 + 1)} 個`}
            </p>
          )}
          {error && <p className="bd-error">{error}</p>}
        </div>
        <footer className="bd-footer">
          <p className="bd-hint">
            プリセットを選んで「適用」を押すと、選択中のセル範囲の罫線が一括で設定されます。
            「枠線なし」を選ぶと既存の罫線が削除されます。
          </p>
          <div className="bd-footer-actions">
            <button type="button" className="bd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="bd-btn bd-btn--primary"
              onClick={submit}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
