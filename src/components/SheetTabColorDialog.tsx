import { useEffect, useState } from "react";
import "./SheetTabColorDialog.css";

interface Props {
  /** The sheet name shown in the dialog header (display-only). */
  sheetName: string;
  /** Currently-applied tab color as "#RRGGBB", or null if none. */
  initialColor: string | null;
  /**
   * Called with the chosen "#RRGGBB" string (always upper-case, no alpha) or
   * null to clear the tab color. The dialog still calls onClose afterward.
   */
  onApply: (color: string | null) => void;
  onClose: () => void;
}

// Compact Excel-flavored palette. 14 colors keeps the picker on one row at
// 480px wide and covers the most common tab colors users reach for. Values
// are normalized to upper-case "#RRGGBB" to match the round-trip contract
// in xlsx_io.rs (parse_xlsx_tab_colors normalizes the same way).
const PALETTE: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: "#C00000", label: "ダークレッド" },
  { hex: "#FF0000", label: "赤" },
  { hex: "#FFC000", label: "オレンジ" },
  { hex: "#FFFF00", label: "黄" },
  { hex: "#92D050", label: "黄緑" },
  { hex: "#00B050", label: "緑" },
  { hex: "#00B0F0", label: "水色" },
  { hex: "#0070C0", label: "青" },
  { hex: "#002060", label: "濃い青" },
  { hex: "#7030A0", label: "紫" },
  { hex: "#A0522D", label: "茶" },
  { hex: "#808080", label: "グレー" },
  { hex: "#404040", label: "ダークグレー" },
  { hex: "#000000", label: "黒" },
];

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

function normalizeHex(input: string): string | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  return `#${m[1].toUpperCase()}`;
}

export default function SheetTabColorDialog({
  sheetName,
  initialColor,
  onApply,
  onClose,
}: Props) {
  const initialNormalized = initialColor ? normalizeHex(initialColor) : null;
  const [selected, setSelected] = useState<string | null>(initialNormalized);
  const [custom, setCustom] = useState<string>(initialNormalized ?? "");
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

  const apply = () => {
    // If the user typed a custom hex, prefer that over the palette selection.
    // Empty custom input falls back to the palette swatch.
    const trimmed = custom.trim();
    if (trimmed) {
      const normalized = normalizeHex(trimmed);
      if (!normalized) {
        setError("色は #RRGGBB 形式の 16 進数で指定してください");
        return;
      }
      setError(null);
      onApply(normalized);
      onClose();
      return;
    }
    setError(null);
    onApply(selected);
    onClose();
  };

  const removeColor = () => {
    setError(null);
    onApply(null);
    onClose();
  };

  const pickSwatch = (hex: string) => {
    setSelected(hex);
    setCustom(hex);
    setError(null);
  };

  return (
    <div className="stc-backdrop" onClick={onClose}>
      <div
        className="stc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="stc-header">
          <h2 id="stc-title" className="stc-title">タブの色: {sheetName}</h2>
          <button
            type="button"
            className="stc-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="stc-body">
          <div
            className="stc-palette"
            role="radiogroup"
            aria-label="プリセット色"
          >
            {PALETTE.map((c) => (
              <button
                key={c.hex}
                type="button"
                role="radio"
                aria-checked={selected === c.hex}
                aria-label={c.label}
                title={`${c.label} (${c.hex})`}
                className={
                  "stc-swatch" + (selected === c.hex ? " stc-swatch--active" : "")
                }
                style={{ backgroundColor: c.hex }}
                onClick={() => pickSwatch(c.hex)}
              />
            ))}
          </div>
          <label className="stc-field">
            <span className="stc-field-label">カスタム (#RRGGBB)</span>
            <input
              type="text"
              className="stc-input"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="#217346"
              maxLength={7}
            />
          </label>
          {error && <p className="stc-error">{error}</p>}
        </div>
        <footer className="stc-footer">
          <button
            type="button"
            className="stc-btn"
            onClick={removeColor}
            data-testid="stc-remove"
          >
            色を削除
          </button>
          <div className="stc-footer-actions">
            <button type="button" className="stc-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="stc-btn stc-btn--primary"
              onClick={apply}
              data-testid="stc-apply"
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
