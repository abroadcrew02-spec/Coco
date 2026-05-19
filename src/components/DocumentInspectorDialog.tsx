import { useEffect, useMemo, useState } from "react";
import type {
  InspectionCategory,
  InspectionResult,
} from "../store/documentInspector";
import "./DocumentInspectorDialog.css";

interface Props {
  /** One entry per InspectionCategory, in dialog display order. */
  inspections: InspectionResult[];
  onStrip: (category: InspectionCategory) => void;
  onJumpTo: (sheetId: string, cellRef: string) => void;
  onReinspect: () => void;
  onClose: () => void;
}

// Display title for each inspection category. Kept inline (rather than via
// i18n key) because the rest of this file is JA-only — matches the
// CommentsManagerDialog convention.
const CATEGORY_TITLES: Record<InspectionCategory, string> = {
  hiddenSheets: "非表示シート",
  comments: "コメント / 注釈",
  personalInfo: "個人情報 (作成者名など)",
  hiddenRowsCols: "非表示の行 / 列",
  externalLinks: "外部リンク",
  snapshots: "スナップショット履歴",
  preservedParts: "保持パーツ / カスタム XML",
  metadata: "ブック メタデータ",
};

/**
 * Excel-style "ドキュメント検査" modal. Lists every inspection category
 * with its hit count + description, lets the user jump to the first
 * matching item, and exposes a per-category "すべて削除" button (with a
 * confirm prompt) that delegates the actual snapshot mutation to the
 * integrator via `onStrip`. After any strip, the integrator can call
 * `onReinspect` (we surface a top-bar "再検査" button too) to refresh
 * the count list.
 *
 * The dialog never mutates the snapshot itself — same separation-of-
 * concerns as CommentsManagerDialog. EditorScreen's `applyMutatedSnapshot`
 * is the single source of truth for the Coco undo checkpoint.
 */
export default function DocumentInspectorDialog({
  inspections,
  onStrip,
  onJumpTo,
  onReinspect,
  onClose,
}: Props) {
  // Track which category panel is expanded (item list visible). At most one
  // open at a time keeps the dialog scan-friendly.
  const [expanded, setExpanded] = useState<InspectionCategory | null>(null);

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

  // Total hits so the dialog header conveys "clean vs. dirty" at a glance.
  const totalHits = useMemo(
    () => inspections.reduce((sum, r) => sum + (r.canStrip ? r.count : 0), 0),
    [inspections],
  );

  const handleStrip = (cat: InspectionCategory, count: number) => {
    if (count === 0) return;
    const title = CATEGORY_TITLES[cat];
    const ok = window.confirm(
      `「${title}」(${count} 件) をすべて削除します。よろしいですか？\n(この操作は Coco の元に戻す履歴に記録されます。)`,
    );
    if (!ok) return;
    onStrip(cat);
  };

  return (
    <div className="doc-inspector-backdrop" onClick={onClose}>
      <div
        className="doc-inspector-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-inspector-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="doc-inspector-header">
          <h2 id="doc-inspector-title" className="doc-inspector-title">
            ドキュメント検査
            {totalHits === 0 ? (
              <span className="doc-inspector-status doc-inspector-status--clean">
                クリーン
              </span>
            ) : (
              <span className="doc-inspector-status doc-inspector-status--hits">
                {totalHits} 件の項目
              </span>
            )}
          </h2>
          <div className="doc-inspector-header-actions">
            <button
              type="button"
              className="doc-inspector-btn"
              onClick={onReinspect}
              title="現在のブック状態で再検査"
            >
              再検査
            </button>
            <button
              type="button"
              className="doc-inspector-close"
              onClick={onClose}
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </header>

        <p className="doc-inspector-intro">
          共有前にチェックしておきたい潜在的な情報を一覧表示します。各項目の
          「移動」で内容を確認するか、「すべて削除」で一括で取り除けます。
        </p>

        <div className="doc-inspector-body">
          {inspections.length === 0 ? (
            <p className="doc-inspector-empty">
              検査対象のブックが読み込まれていません。
            </p>
          ) : (
            <ul className="doc-inspector-list">
              {inspections.map((r) => {
                const isOpen = expanded === r.category;
                const title = CATEGORY_TITLES[r.category];
                return (
                  <li
                    key={r.category}
                    className={
                      r.count > 0
                        ? "doc-inspector-row doc-inspector-row--hit"
                        : "doc-inspector-row"
                    }
                  >
                    <div className="doc-inspector-row-summary">
                      <div className="doc-inspector-row-text">
                        <span className="doc-inspector-row-title">
                          {title}
                        </span>
                        <span
                          className={
                            r.count > 0
                              ? "doc-inspector-row-count doc-inspector-row-count--hit"
                              : "doc-inspector-row-count"
                          }
                        >
                          {r.count}
                        </span>
                        <span className="doc-inspector-row-desc">
                          {r.description}
                        </span>
                      </div>
                      <div className="doc-inspector-row-actions">
                        {r.count > 0 && r.items.length === 1 && r.items[0].sheetId ? (
                          <button
                            type="button"
                            className="doc-inspector-mini-btn"
                            onClick={() =>
                              onJumpTo(
                                r.items[0].sheetId!,
                                r.items[0].cellRef ?? "A1",
                              )
                            }
                            title="該当箇所へ移動"
                          >
                            移動
                          </button>
                        ) : r.count > 0 ? (
                          <button
                            type="button"
                            className="doc-inspector-mini-btn"
                            onClick={() =>
                              setExpanded(isOpen ? null : r.category)
                            }
                            aria-expanded={isOpen}
                          >
                            {isOpen ? "閉じる" : `一覧 (${r.count})`}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="doc-inspector-mini-btn doc-inspector-mini-btn--danger"
                          onClick={() => handleStrip(r.category, r.count)}
                          disabled={!r.canStrip || r.count === 0}
                          title={
                            r.canStrip
                              ? "この種類の項目をすべて削除"
                              : "削除は別ダイアログで管理"
                          }
                        >
                          すべて削除
                        </button>
                      </div>
                    </div>

                    {isOpen && r.items.length > 0 && (
                      <ul className="doc-inspector-items">
                        {r.items.map((it, idx) => (
                          <li
                            key={`${r.category}-${idx}`}
                            className="doc-inspector-item"
                          >
                            <span className="doc-inspector-item-label">
                              {it.label}
                            </span>
                            {it.sheetId ? (
                              <button
                                type="button"
                                className="doc-inspector-mini-btn"
                                onClick={() =>
                                  onJumpTo(it.sheetId!, it.cellRef ?? "A1")
                                }
                                title="このセルへ移動"
                              >
                                移動
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="doc-inspector-footer">
          <button
            type="button"
            className="doc-inspector-btn doc-inspector-btn--primary"
            onClick={onClose}
          >
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}
