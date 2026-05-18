import { useEffect, useMemo, useState } from "react";
import type { HyperlinkListing } from "../store/hyperlinkManager";
import "./HyperlinkManagerDialog.css";

interface Props {
  /**
   * Flat listing of every hyperlink across the workbook. Built by the
   * integrator via `listAllHyperlinks(snapshot)` so this component stays
   * snapshot-shape-agnostic.
   */
  links: HyperlinkListing[];
  onJumpTo: (sheetId: string, cellRef: string) => void;
  onEdit: (sheetId: string, cellRef: string) => void;
  onDelete: (sheetId: string, cellRef: string) => void;
  onBulkDelete: (kind: HyperlinkListing["kind"]) => void;
  onValidate: () => void;
  /**
   * Map keyed by `${sheetId}!${cellRef}` → true (valid) / false (invalid).
   * Absent until the user clicks "Validate". Rows missing from the map render
   * unflagged; rows mapped to `false` get the ⚠ marker and red row tint.
   */
  validationResults?: Record<string, boolean>;
  onClose: () => void;
}

const KIND_FILTER_OPTIONS: Array<{
  value: "all" | HyperlinkListing["kind"];
  label: string;
}> = [
  { value: "all", label: "すべて" },
  { value: "external", label: "外部 URL" },
  { value: "internal", label: "ブック内" },
  { value: "mailto", label: "メール" },
  { value: "file", label: "ファイル" },
  { value: "unknown", label: "不明" },
];

const KIND_LABEL: Record<HyperlinkListing["kind"], string> = {
  external: "外部",
  internal: "内部",
  mailto: "メール",
  file: "ファイル",
  unknown: "不明",
};

function rowKey(link: HyperlinkListing): string {
  return `${link.sheetId}!${link.cellRef}`;
}

/**
 * Workbook-wide hyperlinks view. Surfaces every link across every sheet so
 * the user can audit, filter, bulk-delete by kind, and run a syntactic
 * validation sweep — all without hunting cell-by-cell through the grid.
 *
 * Jump / edit / delete are delegated to the integrator (EditorScreen) via
 * callbacks. This component owns the table render, filters, and the prompt
 * UX around bulk actions only; the snapshot mutation + undo-snapshot dance
 * stays in EditorScreen where the rest of the hyperlink lifecycle already
 * lives (applyHyperlink, openHyperlinkDialog).
 *
 * Filter composition: text search ∩ kind dropdown. The validation results
 * map is opt-in — the dialog opens with no flags, the user clicks
 * "URL を検証" to populate it, and rows with `false` then render with a ⚠.
 */
export default function HyperlinkManagerDialog({
  links,
  onJumpTo,
  onEdit,
  onDelete,
  onBulkDelete,
  onValidate,
  validationResults,
  onClose,
}: Props) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | HyperlinkListing["kind"]>(
    "all",
  );

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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return links.filter((link) => {
      if (kindFilter !== "all" && link.kind !== kindFilter) return false;
      if (!needle) return true;
      const hay = [link.sheetName, link.cellRef, link.display, link.target]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [links, search, kindFilter]);

  // Pre-compute per-kind counts so the bulk-delete buttons can show a tally
  // and disable cleanly when there's nothing to remove.
  const counts = useMemo(() => {
    const acc: Record<HyperlinkListing["kind"], number> = {
      external: 0,
      internal: 0,
      mailto: 0,
      file: 0,
      unknown: 0,
    };
    for (const link of links) acc[link.kind] += 1;
    return acc;
  }, [links]);

  // Count of currently-flagged invalid rows so the Validate button can hint
  // at the outcome of the last sweep ("検証 (N 件 NG)").
  const invalidCount = useMemo(() => {
    if (!validationResults) return 0;
    let n = 0;
    for (const link of links) {
      const verdict = validationResults[rowKey(link)];
      if (verdict === false) n += 1;
    }
    return n;
  }, [links, validationResults]);

  const confirmAndBulkDelete = (kind: HyperlinkListing["kind"], label: string) => {
    const n = counts[kind];
    if (n === 0) return;
    const ok = window.confirm(
      `${label}のリンク ${n} 件を削除します。よろしいですか？`,
    );
    if (!ok) return;
    onBulkDelete(kind);
  };

  return (
    <div className="hmd-backdrop" onClick={onClose}>
      <div
        className="hmd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hmd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="hmd-header">
          <h2 id="hmd-title" className="hmd-title">
            ハイパーリンク一覧 ({filtered.length}/{links.length})
          </h2>
          <button
            type="button"
            className="hmd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="hmd-filters">
          <input
            type="search"
            className="hmd-search"
            placeholder="検索 (シート / セル / 表示テキスト / リンク先)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="ハイパーリンク検索"
          />
          <select
            className="hmd-kind-select"
            value={kindFilter}
            onChange={(e) =>
              setKindFilter(e.target.value as "all" | HyperlinkListing["kind"])
            }
            aria-label="種別フィルター"
          >
            {KIND_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="hmd-body">
          {filtered.length === 0 ? (
            <p className="hmd-empty">表示するハイパーリンクがありません</p>
          ) : (
            <table className="hmd-table">
              <thead>
                <tr>
                  <th>シート</th>
                  <th>セル</th>
                  <th>表示テキスト</th>
                  <th>リンク先</th>
                  <th>種別</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((link) => {
                  const key = rowKey(link);
                  const verdict = validationResults?.[key];
                  const invalid = verdict === false;
                  return (
                    <tr
                      key={key}
                      className={
                        invalid ? "hmd-row hmd-row--invalid" : "hmd-row"
                      }
                    >
                      <td className="hmd-cell-sheet">{link.sheetName}</td>
                      <td className="hmd-cell-ref">{link.cellRef}</td>
                      <td className="hmd-cell-display" title={link.display}>
                        {link.display}
                      </td>
                      <td
                        className={
                          invalid
                            ? "hmd-cell-target hmd-cell-target--invalid"
                            : "hmd-cell-target"
                        }
                        title={link.target}
                      >
                        {invalid && (
                          <span
                            className="hmd-warn-icon"
                            title="不正な URL"
                            aria-label="不正な URL"
                          >
                            ⚠
                          </span>
                        )}
                        {link.target}
                      </td>
                      <td>
                        <span
                          className={`hmd-kind-badge hmd-kind-badge--${link.kind}`}
                        >
                          {KIND_LABEL[link.kind]}
                        </span>
                      </td>
                      <td className="hmd-cell-actions">
                        <button
                          type="button"
                          className="hmd-mini-btn"
                          onClick={() => onJumpTo(link.sheetId, link.cellRef)}
                          title="このセルへ移動"
                        >
                          移動
                        </button>
                        <button
                          type="button"
                          className="hmd-mini-btn"
                          onClick={() => onEdit(link.sheetId, link.cellRef)}
                          title="編集"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          className="hmd-mini-btn hmd-mini-btn--danger"
                          onClick={() => {
                            if (
                              window.confirm("このハイパーリンクを削除しますか？")
                            ) {
                              onDelete(link.sheetId, link.cellRef);
                            }
                          }}
                          title="削除"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="hmd-footer">
          <div className="hmd-footer-left">
            <button
              type="button"
              className="hmd-btn hmd-btn--danger"
              onClick={() => confirmAndBulkDelete("internal", "ブック内")}
              disabled={counts.internal === 0}
              title="ブック内リンクを一括削除"
            >
              内部を一括削除 ({counts.internal})
            </button>
            <button
              type="button"
              className="hmd-btn hmd-btn--danger"
              onClick={() => confirmAndBulkDelete("external", "外部")}
              disabled={counts.external === 0}
              title="外部 URL を一括削除"
            >
              外部を一括削除 ({counts.external})
            </button>
            <button
              type="button"
              className="hmd-btn"
              onClick={onValidate}
              title="すべての URL の構文を検証"
            >
              {invalidCount > 0
                ? `URL を検証 (${invalidCount} 件 NG)`
                : "URL を検証"}
            </button>
          </div>
          <div className="hmd-footer-right">
            <button
              type="button"
              className="hmd-btn hmd-btn--primary"
              onClick={onClose}
            >
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
