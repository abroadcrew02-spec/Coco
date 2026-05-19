import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/locale";
import {
  HEADER_FOOTER_TOKENS,
  PAPER_SIZES,
  validatePageSetup,
  type Orientation,
  type PageOrder,
  type PageSetupHeaderFooter,
  type PageSetupMargins,
  type PageSetupPage,
  type PageSetupSheetOpts,
  type PageSetupValue,
  type PaperSize,
} from "../store/pageSetup";
import "./PageSetupDialog.css";

type TabId = "page" | "margins" | "header-footer" | "sheet";

interface Props {
  sheetName: string;
  initial: PageSetupValue;
  onApply: (value: PageSetupValue) => void;
  onClose: () => void;
}

type HeaderFooterField = keyof PageSetupHeaderFooter;

const HEADER_FOOTER_FIELDS: ReadonlyArray<{ id: HeaderFooterField; label: string }> = [
  { id: "headerLeft", label: "ヘッダー (左)" },
  { id: "headerCenter", label: "ヘッダー (中央)" },
  { id: "headerRight", label: "ヘッダー (右)" },
  { id: "footerLeft", label: "フッター (左)" },
  { id: "footerCenter", label: "フッター (中央)" },
  { id: "footerRight", label: "フッター (右)" },
];

// Tiny helpers — coerce a user-edited text field into a finite Number, falling
// back to `fallback` (typically the current value) so we don't blow away the
// previous setting just because the input is briefly empty / mid-typed.
function parseNum(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export default function PageSetupDialog({
  sheetName,
  initial,
  onApply,
  onClose,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("page");

  // Local section state — initialised from `initial` so the parent owns the
  // canonical value while the dialog is open. On submit we merge the four
  // sections back into a single PageSetupValue.
  const [page, setPage] = useState<PageSetupPage>({ ...(initial.page ?? {}) });
  const [margins, setMargins] = useState<PageSetupMargins>({
    ...(initial.margins ?? {}),
  });
  const [headerFooter, setHeaderFooter] = useState<PageSetupHeaderFooter>({
    ...(initial.headerFooter ?? {}),
  });
  const [sheetOpts, setSheetOpts] = useState<PageSetupSheetOpts>({
    ...(initial.sheetOpts ?? {}),
  });

  // The most recently focused header/footer text field. Used by the
  // quick-insert token row to know where to splice the inserted token.
  const lastFocusedHFRef = useRef<HeaderFooterField | null>(null);
  const fieldRefs = useRef<Partial<Record<HeaderFooterField, HTMLInputElement | null>>>(
    {},
  );

  const composed: PageSetupValue = useMemo(
    () => ({ page, margins, headerFooter, sheetOpts }),
    [page, margins, headerFooter, sheetOpts],
  );

  const validation = useMemo(() => validatePageSetup(composed), [composed]);
  const canSubmit = validation.ok;

  // Esc + Ctrl/Cmd+Enter shortcuts. Bound on window so they work regardless of
  // which field has focus (textarea / select / button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (canSubmit) {
          onApply(composed);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onApply, composed, canSubmit]);

  const submit = () => {
    if (!validation.ok) return;
    onApply(composed);
    onClose();
  };

  // Insert a token (e.g. "&[Page]") into the most recently focused header/
  // footer field at the caret. Falls back to appending when we never tracked
  // focus (first click on the toolbar before clicking a field).
  const insertToken = (token: string) => {
    const field = lastFocusedHFRef.current;
    if (!field) {
      // Nothing focused yet — bias to the header-center field as the most
      // common Excel use case (page-of-pages footer goes to footerCenter).
      const fallback: HeaderFooterField = "headerCenter";
      setHeaderFooter((prev) => ({
        ...prev,
        [fallback]: (prev[fallback] ?? "") + token,
      }));
      // Re-focus so the user can keep typing right after the inserted token.
      fieldRefs.current[fallback]?.focus();
      return;
    }
    const input = fieldRefs.current[field];
    if (!input) {
      setHeaderFooter((prev) => ({
        ...prev,
        [field]: (prev[field] ?? "") + token,
      }));
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const current = input.value;
    const next = current.slice(0, start) + token + current.slice(end);
    setHeaderFooter((prev) => ({ ...prev, [field]: next }));
    // Restore focus + place the caret just after the inserted token on the
    // next tick (after React applies the value update).
    requestAnimationFrame(() => {
      const el = fieldRefs.current[field];
      if (!el) return;
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="ps-backdrop" onClick={onClose}>
      <div
        className="ps-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ps-header">
          <h2 id="ps-title" className="ps-title">{t("dialog.pageSetup")}</h2>
          <button
            type="button"
            className="ps-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="ps-sheet-label">
          対象シート: <span className="ps-sheet-ref">{sheetName}</span>
        </div>
        <div className="ps-tabs" role="tablist">
          {(
            [
              { id: "page", label: "ページ" },
              { id: "margins", label: "余白" },
              { id: "header-footer", label: "ヘッダー/フッター" },
              { id: "sheet", label: "シート" },
            ] as Array<{ id: TabId; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`ps-tab${activeTab === tab.id ? " ps-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="ps-body">
          {activeTab === "page" && (
            <section className="ps-section" aria-label="ページ設定">
              <div className="ps-grid">
                <label className="ps-field">
                  <span className="ps-field-label">印刷の向き</span>
                  <select
                    className="ps-select"
                    value={page.orientation ?? "portrait"}
                    onChange={(e) =>
                      setPage({ ...page, orientation: e.target.value as Orientation })
                    }
                  >
                    <option value="portrait">縦</option>
                    <option value="landscape">横</option>
                  </select>
                </label>
                <label className="ps-field">
                  <span className="ps-field-label">用紙サイズ</span>
                  <select
                    className="ps-select"
                    value={page.paperSize ?? "A4"}
                    onChange={(e) =>
                      setPage({ ...page, paperSize: e.target.value as PaperSize })
                    }
                  >
                    {PAPER_SIZES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="ps-fieldset">
                <legend className="ps-legend">拡大縮小</legend>
                <label className="ps-field ps-field--inline">
                  <span className="ps-field-label">倍率 (%)</span>
                  <input
                    type="number"
                    className="ps-input ps-input--num"
                    min={10}
                    max={400}
                    step={1}
                    value={page.scalePercent ?? 100}
                    onChange={(e) =>
                      setPage({
                        ...page,
                        scalePercent: parseNum(e.target.value, page.scalePercent ?? 100),
                      })
                    }
                  />
                </label>
                <div className="ps-fit-row">
                  <span className="ps-field-label">ページに合わせる</span>
                  <label className="ps-field-inline-pair">
                    <span>横</span>
                    <input
                      type="number"
                      className="ps-input ps-input--num"
                      min={1}
                      max={1000}
                      placeholder="-"
                      value={page.fitToPagesWide ?? ""}
                      onChange={(e) =>
                        setPage({
                          ...page,
                          fitToPagesWide: parseIntOrNull(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="ps-field-inline-pair">
                    <span>縦</span>
                    <input
                      type="number"
                      className="ps-input ps-input--num"
                      min={1}
                      max={1000}
                      placeholder="-"
                      value={page.fitToPagesTall ?? ""}
                      onChange={(e) =>
                        setPage({
                          ...page,
                          fitToPagesTall: parseIntOrNull(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <p className="ps-hint">
                  「ページに合わせる」を指定すると倍率より優先されます (Excel と同じ挙動)。
                </p>
              </fieldset>
            </section>
          )}

          {activeTab === "margins" && (
            <section className="ps-section" aria-label="余白">
              <div className="ps-grid ps-grid--margins">
                {(
                  [
                    { id: "top", label: "上 (mm)" },
                    { id: "bottom", label: "下 (mm)" },
                    { id: "left", label: "左 (mm)" },
                    { id: "right", label: "右 (mm)" },
                    { id: "header", label: "ヘッダー (mm)" },
                    { id: "footer", label: "フッター (mm)" },
                  ] as Array<{ id: keyof PageSetupMargins; label: string }>
                ).map((f) => (
                  <label key={f.id} className="ps-field">
                    <span className="ps-field-label">{f.label}</span>
                    <input
                      type="number"
                      className="ps-input ps-input--num"
                      min={0}
                      max={200}
                      step={1}
                      value={(margins[f.id] as number | undefined) ?? 0}
                      onChange={(e) =>
                        setMargins({
                          ...margins,
                          [f.id]: parseNum(
                            e.target.value,
                            (margins[f.id] as number | undefined) ?? 0,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="ps-checks">
                <label className="ps-checkbox">
                  <input
                    type="checkbox"
                    checked={!!margins.centerH}
                    onChange={(e) =>
                      setMargins({ ...margins, centerH: e.target.checked })
                    }
                  />
                  <span>水平方向に中央揃え</span>
                </label>
                <label className="ps-checkbox">
                  <input
                    type="checkbox"
                    checked={!!margins.centerV}
                    onChange={(e) =>
                      setMargins({ ...margins, centerV: e.target.checked })
                    }
                  />
                  <span>垂直方向に中央揃え</span>
                </label>
              </div>
            </section>
          )}

          {activeTab === "header-footer" && (
            <section className="ps-section" aria-label="ヘッダーとフッター">
              <div className="ps-token-row" role="toolbar" aria-label="挿入トークン">
                <span className="ps-token-label">挿入:</span>
                {HEADER_FOOTER_TOKENS.map((tok) => (
                  <button
                    key={tok.token}
                    type="button"
                    className="ps-token-btn"
                    title={`${tok.label} (${tok.token})`}
                    onMouseDown={(e) => {
                      // Prevent blurring the input before we read the caret.
                      e.preventDefault();
                    }}
                    onClick={() => insertToken(tok.token)}
                  >
                    {tok.label}
                  </button>
                ))}
              </div>
              <div className="ps-hf-grid">
                {HEADER_FOOTER_FIELDS.map((f) => (
                  <label key={f.id} className="ps-field">
                    <span className="ps-field-label">{f.label}</span>
                    <input
                      ref={(el) => {
                        fieldRefs.current[f.id] = el;
                      }}
                      type="text"
                      className="ps-input"
                      value={headerFooter[f.id] ?? ""}
                      onChange={(e) =>
                        setHeaderFooter({ ...headerFooter, [f.id]: e.target.value })
                      }
                      onFocus={() => {
                        lastFocusedHFRef.current = f.id;
                      }}
                      placeholder={`例: &[Tab] - &[Date]`}
                    />
                  </label>
                ))}
              </div>
              <p className="ps-hint">
                &[Page] / &[Pages] / &[Date] / &[Time] / &[File] / &[Tab] を
                埋め込めます。
              </p>
            </section>
          )}

          {activeTab === "sheet" && (
            <section className="ps-section" aria-label="シート">
              <label className="ps-field">
                <span className="ps-field-label">印刷範囲</span>
                <input
                  type="text"
                  className="ps-input"
                  value={sheetOpts.printArea ?? ""}
                  placeholder="A1:D50"
                  onChange={(e) =>
                    setSheetOpts({ ...sheetOpts, printArea: e.target.value })
                  }
                />
              </label>
              <fieldset className="ps-fieldset">
                <legend className="ps-legend">タイトル (繰り返し)</legend>
                <label className="ps-field">
                  <span className="ps-field-label">先頭行 (行範囲)</span>
                  <input
                    type="text"
                    className="ps-input"
                    value={sheetOpts.printTitleRows ?? ""}
                    placeholder="$1:$3"
                    onChange={(e) =>
                      setSheetOpts({ ...sheetOpts, printTitleRows: e.target.value })
                    }
                  />
                </label>
                <label className="ps-field">
                  <span className="ps-field-label">左端列 (列範囲)</span>
                  <input
                    type="text"
                    className="ps-input"
                    value={sheetOpts.printTitleCols ?? ""}
                    placeholder="$A:$B"
                    onChange={(e) =>
                      setSheetOpts({ ...sheetOpts, printTitleCols: e.target.value })
                    }
                  />
                </label>
              </fieldset>
              <div className="ps-checks">
                <label className="ps-checkbox">
                  <input
                    type="checkbox"
                    checked={!!sheetOpts.gridlines}
                    onChange={(e) =>
                      setSheetOpts({ ...sheetOpts, gridlines: e.target.checked })
                    }
                  />
                  <span>枠線を印刷する</span>
                </label>
                <label className="ps-checkbox">
                  <input
                    type="checkbox"
                    checked={!!sheetOpts.headings}
                    onChange={(e) =>
                      setSheetOpts({ ...sheetOpts, headings: e.target.checked })
                    }
                  />
                  <span>行列番号を印刷する</span>
                </label>
                <label className="ps-checkbox">
                  <input
                    type="checkbox"
                    checked={!!sheetOpts.blackAndWhite}
                    onChange={(e) =>
                      setSheetOpts({ ...sheetOpts, blackAndWhite: e.target.checked })
                    }
                  />
                  <span>白黒印刷</span>
                </label>
                <label className="ps-checkbox">
                  <input
                    type="checkbox"
                    checked={!!sheetOpts.draftQuality}
                    onChange={(e) =>
                      setSheetOpts({ ...sheetOpts, draftQuality: e.target.checked })
                    }
                  />
                  <span>簡易印刷 (ドラフト品質)</span>
                </label>
              </div>
              <label className="ps-field">
                <span className="ps-field-label">ページの順序</span>
                <select
                  className="ps-select"
                  value={sheetOpts.pageOrder ?? "downThenOver"}
                  onChange={(e) =>
                    setSheetOpts({
                      ...sheetOpts,
                      pageOrder: e.target.value as PageOrder,
                    })
                  }
                >
                  <option value="downThenOver">下方向 → 右方向</option>
                  <option value="overThenDown">右方向 → 下方向</option>
                </select>
              </label>
            </section>
          )}

          {!validation.ok && validation.errors && (
            <ul className="ps-errors" aria-live="polite">
              {validation.errors.map((msg) => (
                <li key={msg} className="ps-error">
                  {msg}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="ps-footer">
          <p className="ps-hint">
            ここで設定した内容はスナップショットに保存されます。実際の印刷 / PDF 出力は別機能です。
          </p>
          <div className="ps-footer-actions">
            <button type="button" className="ps-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ps-btn ps-btn--primary"
              onClick={submit}
              disabled={!canSubmit}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
