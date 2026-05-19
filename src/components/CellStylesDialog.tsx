import { useEffect, useMemo, useState } from "react";
import {
  CELL_STYLE_PRESETS,
  type CellStylePreset,
} from "../store/cellStyles";
import "./CellStylesDialog.css";

// i18n: once `dialog.cellStyles` is registered in src/i18n/locale.ts the title
// below should swap to t("dialog.cellStyles"). The constants here mirror the
// strings the user will add (see deliverable).
const TITLE_JA = "セルスタイル";
const TITLE_EN = "Cell Styles";

interface Props {
  /** Active sheet id — opaque to the dialog; relayed back via onApply. */
  sheetId: string;
  /** Initial A1 range string, e.g. "Sheet1!A1:C10". */
  initialRange: string;
  /** Caller resolves the range + applies the preset to the snapshot. */
  onApply: (preset: CellStylePreset, range: string) => void;
  onClose: () => void;
}

// Same rectangular A1 form SortDialog accepts (bare or sheet-qualified).
// Single-cell refs are allowed here — Excel lets you apply a cell style to
// a single cell.
const RANGE_RE =
  /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

const CATEGORY_ORDER: ReadonlyArray<{
  key: CellStylePreset["category"];
  labelJa: string;
  labelEn: string;
}> = [
  { key: "good-bad-neutral", labelJa: "良 / 悪 / 注意", labelEn: "Good, Bad and Neutral" },
  { key: "data-model", labelJa: "データとモデル", labelEn: "Data and Model" },
  { key: "title-heading", labelJa: "タイトルと見出し", labelEn: "Titles and Headings" },
  { key: "accent", labelJa: "テーマのセルスタイル", labelEn: "Themed Cell Styles" },
  { key: "number", labelJa: "数値の書式", labelEn: "Number Format" },
];

/** Convert a Univer-shaped border style code to a CSS border-style. */
function borderCss(s: number | undefined): string {
  switch (s) {
    case 1:
      return "1px solid";
    case 7:
      return "3px double";
    case 8:
      return "2px solid";
    case 13:
      return "3px solid";
    default:
      return "1px solid";
  }
}

/** Translate a preset's Univer style payload into inline CSS for the swatch. */
function swatchStyle(preset: CellStylePreset): React.CSSProperties {
  const css: React.CSSProperties = {};
  const s = preset.style as Record<string, unknown>;
  const bg = s.bg as { rgb?: string } | undefined;
  if (bg?.rgb) css.backgroundColor = bg.rgb;
  const cl = s.cl as { rgb?: string } | undefined;
  if (cl?.rgb) css.color = cl.rgb;
  if (s.bl === 1) css.fontWeight = 700;
  if (s.it === 1) css.fontStyle = "italic";
  if (typeof s.fs === "number") {
    // Cap preview font-size so headings/title don't break the grid layout.
    css.fontSize = Math.min(16, Math.max(10, s.fs));
  }
  const bd = s.bd as
    | { t?: { s?: number; cl?: { rgb?: string } }; b?: { s?: number; cl?: { rgb?: string } }; l?: { s?: number; cl?: { rgb?: string } }; r?: { s?: number; cl?: { rgb?: string } } }
    | undefined;
  if (bd) {
    if (bd.t) css.borderTop = `${borderCss(bd.t.s)} ${bd.t.cl?.rgb ?? "#000"}`;
    if (bd.b) css.borderBottom = `${borderCss(bd.b.s)} ${bd.b.cl?.rgb ?? "#000"}`;
    if (bd.l) css.borderLeft = `${borderCss(bd.l.s)} ${bd.l.cl?.rgb ?? "#000"}`;
    if (bd.r) css.borderRight = `${borderCss(bd.r.s)} ${bd.r.cl?.rgb ?? "#000"}`;
  }
  return css;
}

function categoryLabel(
  cat: CellStylePreset["category"],
  locale: "ja" | "en",
): string {
  const hit = CATEGORY_ORDER.find((c) => c.key === cat);
  if (!hit) return cat;
  return locale === "ja" ? hit.labelJa : hit.labelEn;
}

function validateRange(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return "範囲は必須です";
  if (!RANGE_RE.test(trimmed))
    return "範囲は A1 形式で指定してください (例: A1 / A1:C10)";
  return null;
}

export default function CellStylesDialog({
  initialRange,
  onApply,
  onClose,
}: Props) {
  const [range, setRange] = useState(initialRange);
  const [selected, setSelected] = useState<string>("good");
  const [error, setError] = useState<string | null>(null);

  // The locale is read once per render at the t() call site, so for the
  // category labels we just inspect the current document language; default
  // to en if anything's amiss.
  const locale: "ja" | "en" = useMemo(() => {
    try {
      const stored =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("coco.locale")
          : null;
      if (stored === "ja-JP") return "ja";
      if (stored === "en-US") return "en";
    } catch {
      /* fall through */
    }
    return typeof navigator !== "undefined" &&
      navigator.language?.toLowerCase().startsWith("ja")
      ? "ja"
      : "en";
  }, []);

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

  const grouped = useMemo(() => {
    const out = new Map<CellStylePreset["category"], CellStylePreset[]>();
    for (const p of CELL_STYLE_PRESETS) {
      const arr = out.get(p.category);
      if (arr) arr.push(p);
      else out.set(p.category, [p]);
    }
    return out;
  }, []);

  const submit = () => {
    const rangeErr = validateRange(range);
    if (rangeErr) {
      setError(rangeErr);
      return;
    }
    const preset = CELL_STYLE_PRESETS.find((p) => p.id === selected);
    if (!preset) {
      setError("プリセットを選択してください");
      return;
    }
    setError(null);
    onApply(preset, range.trim());
    onClose();
  };

  return (
    <div className="cs-backdrop" onClick={onClose}>
      <div
        className="cs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cs-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cs-header">
          <h2 id="cs-title" className="cs-title">
            {locale === "ja" ? TITLE_JA : TITLE_EN}
          </h2>
          <button
            type="button"
            className="cs-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="cs-body">
          <label className="cs-field">
            <span className="cs-field-label">対象範囲</span>
            <input
              type="text"
              className="cs-input"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="A1 または A1:C10"
            />
          </label>
          <div className="cs-gallery" role="radiogroup" aria-label="セルスタイル">
            {CATEGORY_ORDER.map(({ key }) => {
              const items = grouped.get(key);
              if (!items || items.length === 0) return null;
              return (
                <section key={key} className="cs-section">
                  <h3 className="cs-section-title">
                    {categoryLabel(key, locale)}
                  </h3>
                  <div className="cs-grid">
                    {items.map((p) => {
                      const isSel = selected === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          role="radio"
                          aria-checked={isSel}
                          className={
                            "cs-swatch" + (isSel ? " cs-swatch--sel" : "")
                          }
                          onClick={() => setSelected(p.id)}
                          onDoubleClick={() => {
                            setSelected(p.id);
                            submit();
                          }}
                          title={p.label}
                        >
                          <span className="cs-swatch-sample" style={swatchStyle(p)}>
                            ABC 123
                          </span>
                          <span className="cs-swatch-label">{p.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          {error && <p className="cs-error">{error}</p>}
        </div>
        <footer className="cs-footer">
          <p className="cs-hint">
            選択したプリセットを範囲内のすべてのセルに適用します。
            既存の書式と互換性のあるキーは上書きされます。
          </p>
          <div className="cs-footer-actions">
            <button type="button" className="cs-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="cs-btn cs-btn--primary"
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
