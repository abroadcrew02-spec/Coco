import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { requestSettings, requestHelp } from "../hooks/useGlobalShortcuts";
import { useEditorPreload } from "../hooks/useEditorPreload";
import { routeOpenPath } from "../store/pathRouter";
import { recoveryReasonLabel } from "../store/recoveryLabels";
import { friendlyError } from "../store/errorMessages";
import { t } from "../i18n/locale";
import { timeAgoJa } from "./timeAgo";
import { TEMPLATE_CATALOG, buildTemplateSnapshot } from "../store/templates";
import TemplatesGalleryDialog from "./TemplatesGalleryDialog";
import type { RecentFile, RecoveryCandidate } from "../types/workbook";
import "./HomeScreen.css";

// Pool of small, low-stakes hints rotated for returning users. Each one is
// reachable through a built-in shortcut that already works today — the
// command-palette tip is deliberately omitted until that lands (T1).
const RETURNING_USER_TIPS: ReadonlyArray<string> = [
  "Ctrl+F3 で名前付き範囲",
  "Ctrl+1 で表示形式",
  "Shift+F2 でコメント追加",
  "Ctrl+K でハイパーリンク",
  "Ctrl+F でセル内検索",
];

// Left-rail navigation views. "home" is the Excel-style landing surface;
// "new" focuses the template gallery; "open" drives the file dialog.
type NavView = "home" | "new" | "open";

export default function HomeScreen() {
  const {
    recentFiles,
    recoveryCandidates,
    lastError,
    importWarnings,
    newWorkbook,
    openCoco,
    importXlsx,
    importCsv,
    restoreCandidate,
    dismissCandidate,
    removeRecent,
    clearRecents,
    clearError,
    dismissWarnings,
    pinnedPaths,
    togglePinned,
    pinnedOrder,
    reorderPinned,
    updateSnapshot,
  } = useWorkbookStore();

  // Active left-rail view. Defaults to the home landing surface.
  const [navView, setNavView] = useState<NavView>("home");
  // Recents pane sub-tab: all recents vs. the pinned-only ("favorites") view.
  const [recentsTab, setRecentsTab] = useState<"recent" | "pinned">("recent");
  // "Other templates" still routes through the existing modal gallery.
  const [galleryOpen, setGalleryOpen] = useState(false);

  // Inline filter — shown only when there are enough recents to make
  // scanning awkward. Below the threshold, an input would just be noise.
  const FILTER_THRESHOLD = 6;
  const [filterQuery, setFilterQuery] = useState("");
  const [focusedRecentIdx, setFocusedRecentIdx] = useState(-1);
  // Path the user is currently dragging over (for visual drop indicator).
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // Sort pinned entries to the top, ordered by pinnedOrder when present
  // (paths not yet in pinnedOrder go at the end of the pinned group);
  // unpinned entries preserve the backend's last_opened DESC order.
  const orderIndex = (path: string): number => {
    const i = pinnedOrder.indexOf(path);
    // Unknown pinned paths sort after known ones (stable among themselves).
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sortedRecents = [...recentFiles].sort((a, b) => {
    const ap = pinnedPaths.includes(a.path) ? 1 : 0;
    const bp = pinnedPaths.includes(b.path) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (ap === 1) {
      // Both pinned — order by pinnedOrder; unknown paths fall back to stable
      // backend ordering via MAX_SAFE_INTEGER on both sides.
      return orderIndex(a.path) - orderIndex(b.path);
    }
    return 0;
  });
  // When the "pinned" sub-tab is active, restrict the source list to pinned
  // entries. The filter + keyboard nav then operate on that narrowed set.
  const tabScopedRecents =
    recentsTab === "pinned"
      ? sortedRecents.filter((f) => pinnedPaths.includes(f.path))
      : sortedRecents;
  const filteredRecents = filterQuery.trim()
    ? tabScopedRecents.filter((f) =>
        f.name.toLowerCase().includes(filterQuery.trim().toLowerCase()) ||
        f.path.toLowerCase().includes(filterQuery.trim().toLowerCase())
      )
    : tabScopedRecents;

  // Clamp focused index when the list shrinks (e.g. user types a filter that
  // excludes the focused row). -1 if no rows match.
  useEffect(() => {
    setFocusedRecentIdx((i) => {
      if (filteredRecents.length === 0) return -1;
      return Math.min(i, filteredRecents.length - 1);
    });
  }, [filteredRecents.length]);

  // Index where the unpinned-recents section begins. -1 if all pinned or
  // all unpinned (no separator needed in those cases).
  const firstUnpinnedIdx = filteredRecents.findIndex(
    (f) => !pinnedPaths.includes(f.path)
  );
  const showSeparator = firstUnpinnedIdx > 0;

  // Ctrl/Cmd+F focuses the recents filter (when present). Escape inside the
  // input clears the query without losing focus. The home screen is the only
  // place this shortcut routes — the editor delegates Ctrl+F to Univer.
  // Arrow keys move the recent-list focus, Enter opens the focused row. We
  // ignore Arrow events that come from inside an input/textarea so the filter
  // input retains its native caret behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        if (filterInputRef.current) {
          e.preventDefault();
          filterInputRef.current.focus();
          filterInputRef.current.select();
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      const isInInput =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (isInInput) return;
      if (filteredRecents.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRecentIdx((i) => Math.min(i + 1, filteredRecents.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRecentIdx((i) => Math.max(i < 0 ? 0 : i - 1, 0));
      } else if (e.key === "Enter" && focusedRecentIdx >= 0) {
        e.preventDefault();
        const target = filteredRecents[focusedRecentIdx];
        if (target) void handleRecentFile(target);
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        focusedRecentIdx >= 0
      ) {
        e.preventDefault();
        const target = filteredRecents[focusedRecentIdx];
        if (target) void removeRecent(target.path);
      } else if (
        e.key.toLowerCase() === "p" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        focusedRecentIdx >= 0
      ) {
        e.preventDefault();
        const target = filteredRecents[focusedRecentIdx];
        if (target) void togglePinned(target.path);
      } else if (e.key === "Escape" && focusedRecentIdx >= 0) {
        e.preventDefault();
        setFocusedRecentIdx(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // filteredRecents is recomputed every render (new array ref), so this
    // effect re-binds on every render. Acceptable: keydown re-registration
    // is cheap relative to the cost of stale closures.
  });

  useEditorPreload();

  // First-run detection: no recents AND no recovery candidates. We show the
  // welcome hero only in that state — once anything lands in either bucket
  // the user is past the onboarding moment.
  const isFirstRun =
    recentFiles.length === 0 && recoveryCandidates.length === 0;

  // Pick a random tip per mount so it varies between sessions without
  // re-shuffling on every render (which would feel jittery).
  const tip = useMemo(
    () =>
      RETURNING_USER_TIPS[
        Math.floor(Math.random() * RETURNING_USER_TIPS.length)
      ],
    [],
  );

  const handleOpenFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "Excel / CSV / TSV / JSON", extensions: ["xlsx", "xlsm", "csv", "tsv", "json", "jsonl", "ndjson"] },
        { name: "Excel Files", extensions: ["xlsx", "xlsm"] },
        { name: "CSV / TSV Files", extensions: ["csv", "tsv"] },
        { name: "JSON / JSONL", extensions: ["json", "jsonl", "ndjson"] },
      ],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const lower = path.toLowerCase();
    if (lower.endsWith(".json") || lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
      await handleImportJson(path);
      return;
    }
    const route = routeOpenPath(path);
    if (route.kind === "coco") await openCoco(route.path);
    else if (route.kind === "csv") await importCsv(route.path);
    else if (route.kind === "xlsx") await importXlsx(route.path);
  };

  // #248 — JSON / JSONL import. Reads the file via the new Tauri
  // `read_text_file_utf8` command, parses it with the renderer-side
  // `parseAuto` (which auto-detects `[...]` JSON-array vs JSONL by first
  // non-whitespace char), and seeds a new workbook with the resulting table.
  // Caveats: nested objects/arrays JSON-stringify into the cell; non-array
  // JSON or per-line malformed JSONL surfaces warnings but doesn't abort.
  const handleImportJson = async (path: string) => {
    try {
      const text = await invoke<string>("read_text_file_utf8", { path });
      const { parseAuto, buildSnapshotFromJson } = await import("../store/jsonImport");
      const result = parseAuto(text);
      if (result.rows.length === 0) {
        useWorkbookStore.setState({
          lastError: result.warnings[0] ?? "JSON は0行でした",
        });
        return;
      }
      await newWorkbook();
      const snap = buildSnapshotFromJson(result);
      updateSnapshot(JSON.stringify(snap));
      if (result.warnings.length > 0) {
        useWorkbookStore.setState({
          importWarnings: result.warnings.map((message) => ({
            severity: "info" as const,
            code: "JSON_IMPORT_WARNING",
            message,
          })),
        });
      }
    } catch (e) {
      useWorkbookStore.setState({
        lastError: friendlyError(String(e)),
      });
    }
  };

  const handleRecentFile = async (file: RecentFile) => {
    if (!file.exists) return;
    const route = routeOpenPath(file.path);
    // Recent files are filtered server-side to known kinds, but treat
    // anything unrecognized (legacy entries, dotted names) as .coco —
    // that matches the prior fallback behavior.
    if (route.kind === "csv") await importCsv(file.path);
    else if (route.kind === "xlsx") await importXlsx(file.path);
    else await openCoco(file.path);
  };

  // Create a new workbook from a template tile. The blank tile falls through
  // to the plain newWorkbook() path; every other id seeds the editor with a
  // pre-built snapshot. newWorkbook() flips screen→editor + stamps a fresh
  // workbookId; the follow-up updateSnapshot lands before the editor mounts,
  // so Univer initializes straight from the template snapshot.
  const handleUseTemplate = async (id: string) => {
    setGalleryOpen(false);
    await newWorkbook();
    const snapshotJson = buildTemplateSnapshot(id);
    if (snapshotJson) updateSnapshot(snapshotJson);
  };

  // ── Recents table (shared between the home view and the "open" pane) ──────
  const renderRecentsTable = () => (
    <table className="recent-table">
      <thead>
        <tr>
          <th className="recent-col-name" scope="col">名前</th>
          <th className="recent-col-path" scope="col">場所</th>
          <th className="recent-col-when" scope="col">変更日</th>
          <th className="recent-col-actions" scope="col">
            <span className="recent-col-actions-label">操作</span>
          </th>
        </tr>
      </thead>
      <tbody className="recent-list">
        {filteredRecents.map((f: RecentFile, idx: number) => {
          const opened = Date.parse(f.lastOpened);
          const ageLabel = Number.isFinite(opened) ? timeAgoJa(opened) : null;
          const fullDate = Number.isFinite(opened)
            ? new Date(opened).toLocaleString("ja-JP")
            : f.lastOpened;
          const isPinned = pinnedPaths.includes(f.path);
          const isFocused = idx === focusedRecentIdx;
          const separatorBefore = showSeparator && idx === firstUnpinnedIdx;
          // Type badge — derived from extension via routeOpenPath so it
          // stays consistent with how the file would be opened.
          const route = routeOpenPath(f.path);
          const kindLabel =
            route.kind === "xlsx"
              ? f.path.toLowerCase().endsWith(".xlsm")
                ? "xlsm"
                : "xlsx"
              : route.kind === "csv"
              ? f.path.toLowerCase().endsWith(".tsv")
                ? "tsv"
                : "csv"
              : route.kind === "coco"
              ? "coco"
              : "?";
          return [
            separatorBefore && (
              <tr
                key={`sep-${f.path}`}
                className="recent-separator-row"
                aria-hidden="true"
              >
                <td colSpan={4} className="recent-separator">
                  最近開いたファイル
                </td>
              </tr>
            ),
            <tr
              key={f.path}
              ref={(el) => {
                // Scroll the focused row into view when keyboard nav moves
                // past the visible area. Browsers no-op when the row is
                // already visible, so this doesn't cause jitter on click.
                if (el && isFocused) {
                  el.scrollIntoView({ block: "nearest", behavior: "auto" });
                }
              }}
              className={`recent-item ${!f.exists ? "recent-item--missing" : ""} ${isPinned ? "recent-item--pinned" : ""} ${isFocused ? "recent-item--focused" : ""} ${dragOverPath === f.path ? "recent-item--drag-over" : ""}`}
              onClick={() => handleRecentFile(f)}
              onMouseEnter={() => setFocusedRecentIdx(idx)}
              draggable={isPinned}
              onDragStart={(e) => {
                if (!isPinned) return;
                e.dataTransfer.setData("text/plain", f.path);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                // Only allow drop onto another pinned row. Without this,
                // dragging a pinned item over an unpinned one would show
                // a drop cursor that resolves to a no-op.
                if (!isPinned) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverPath !== f.path) setDragOverPath(f.path);
              }}
              onDragLeave={() => {
                if (dragOverPath === f.path) setDragOverPath(null);
              }}
              onDrop={(e) => {
                if (!isPinned) return;
                e.preventDefault();
                const dragged = e.dataTransfer.getData("text/plain");
                setDragOverPath(null);
                if (dragged && dragged !== f.path && pinnedPaths.includes(dragged)) {
                  void reorderPinned(dragged, f.path);
                }
              }}
              onDragEnd={() => setDragOverPath(null)}
            >
              <td className="recent-name">
                {isPinned && <span className="recent-pin-indicator" aria-hidden="true">📌</span>}
                <span className={`recent-kind recent-kind--${kindLabel}`}>{kindLabel}</span>
                {f.name}
                {!f.exists && <span className="recent-badge">見つかりません</span>}
              </td>
              <td className="recent-path">{f.path}</td>
              <td className="recent-when" title={ageLabel ? `最終アクセス: ${fullDate}` : undefined}>
                {ageLabel ?? ""}
              </td>
              <td className="recent-actions">
                <button
                  type="button"
                  className="recent-pin"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePinned(f.path);
                  }}
                  aria-label={isPinned ? "ピン留めを外す" : "ピン留めする"}
                  aria-pressed={isPinned ? "true" : "false"}
                  title={isPinned ? "ピン留めを外す" : "ピン留めする"}
                >
                  {isPinned ? "📌" : "📍"}
                </button>
                <button
                  type="button"
                  className="recent-reveal"
                  onClick={(e) => {
                    e.stopPropagation();
                    invoke("reveal_in_file_manager", { path: f.path }).catch((err) => {
                      useWorkbookStore.setState({ lastError: friendlyError(String(err)) });
                    });
                  }}
                  aria-label="ファイルの場所を開く"
                  title="ファイルの場所を開く"
                  disabled={!f.exists}
                >
                  📁
                </button>
                <button
                  type="button"
                  className="recent-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecent(f.path);
                  }}
                  aria-label="この項目を削除"
                  title="この項目を削除"
                >
                  ×
                </button>
              </td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );

  // ── "New" section: template tiles surfaced inline (Excel Start screen) ────
  const renderTemplateTiles = () => (
    <ul className="home-template-grid" aria-label="テンプレート">
      {TEMPLATE_CATALOG.map((tpl) => (
        <li key={tpl.id}>
          <button
            type="button"
            className={
              "home-template-tile" +
              (tpl.id === "blank" ? " home-template-tile--blank" : "")
            }
            onClick={() => void handleUseTemplate(tpl.id)}
            data-testid={`home-template-${tpl.id}`}
            title={tpl.descriptionJa}
          >
            <span className="home-template-thumb" aria-hidden="true">
              {tpl.thumbnailEmoji}
            </span>
            <span className="home-template-name">{tpl.nameJa}</span>
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          className="home-template-more"
          onClick={() => setGalleryOpen(true)}
          data-testid="home-template-more"
        >
          その他のテンプレート…
        </button>
      </li>
    </ul>
  );

  // ── Recovery candidates (Coco-specific) ───────────────────────────────────
  const renderRecovery = () =>
    recoveryCandidates.length > 0 && (
      <div className="home-section">
        <h2>復元候補</h2>
        <ul className="recovery-list">
          {recoveryCandidates.map((c: RecoveryCandidate) => {
            const saved = Date.parse(c.savedAt);
            const ageLabel = Number.isFinite(saved) ? timeAgoJa(saved) : null;
            const fullDate = Number.isFinite(saved)
              ? new Date(saved).toLocaleString("ja-JP")
              : c.savedAt;
            return (
              <li key={c.candidateId} className="recovery-item">
                <div className="recovery-item__main">
                  <span className="recovery-item__title">{c.originalPath ?? "無題のワークブック"}</span>
                  <span className="recovery-date" title={fullDate}>
                    {ageLabel ?? fullDate} · {recoveryReasonLabel(c.reason)}
                  </span>
                </div>
                <div className="recovery-item__actions">
                  <button
                    type="button"
                    className="btn-tertiary"
                    onClick={() => restoreCandidate(c.candidateId)}
                  >
                    復元
                  </button>
                  <button
                    type="button"
                    className="btn-tertiary btn-tertiary--danger"
                    onClick={() => dismissCandidate(c.candidateId)}
                  >
                    破棄
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );

  // ── Recents pane (table + tabs + filter), shared by home & open views ─────
  const renderRecentsPane = () => (
    <div className="home-section home-recents">
      <div className="home-section-header">
        <div className="home-recents-tabs" role="tablist" aria-label="ファイル一覧">
          <button
            type="button"
            role="tab"
            aria-selected={recentsTab === "recent"}
            className={
              "home-recents-tab" +
              (recentsTab === "recent" ? " home-recents-tab--active" : "")
            }
            onClick={() => setRecentsTab("recent")}
          >
            最近使ったアイテム
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={recentsTab === "pinned"}
            className={
              "home-recents-tab" +
              (recentsTab === "pinned" ? " home-recents-tab--active" : "")
            }
            onClick={() => setRecentsTab("pinned")}
          >
            お気に入り
          </button>
        </div>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            if (window.confirm(t("confirm.recents.clear"))) {
              clearRecents();
            }
          }}
        >
          すべて削除
        </button>
      </div>
      {recentFiles.length >= FILTER_THRESHOLD && (
        <input
          ref={filterInputRef}
          type="search"
          className="recent-filter"
          placeholder="ファイル名 / パスで絞り込み... (Ctrl+F)"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filterQuery) {
              e.preventDefault();
              setFilterQuery("");
            }
          }}
          aria-label="最近使ったファイルを絞り込む"
        />
      )}
      {filterQuery.trim() && filteredRecents.length === 0 && (
        <p className="recent-empty-filter">該当するファイルがありません</p>
      )}
      {filterQuery.trim() && filteredRecents.length > 0 && (
        <p className="recent-filter-count" aria-live="polite">
          {filteredRecents.length} / {tabScopedRecents.length} 件一致
        </p>
      )}
      {recentsTab === "pinned" && tabScopedRecents.length === 0 ? (
        <p className="recent-empty-filter">お気に入りに登録したファイルはありません</p>
      ) : (
        renderRecentsTable()
      )}
    </div>
  );

  return (
    <div className="home-screen">
      {/* Left navigation rail — Excel Start screen layout. */}
      <nav className="home-nav" aria-label="ホームナビゲーション">
        <div className="home-nav-brand">
          <span className="home-nav-logo">Coco</span>
        </div>
        <ul className="home-nav-list">
          <li>
            <button
              type="button"
              className={
                "home-nav-item" + (navView === "home" ? " home-nav-item--active" : "")
              }
              aria-current={navView === "home" ? "page" : undefined}
              onClick={() => setNavView("home")}
            >
              <span className="home-nav-icon" aria-hidden="true">🏠</span>
              <span className="home-nav-label">ホーム</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={
                "home-nav-item" + (navView === "new" ? " home-nav-item--active" : "")
              }
              aria-current={navView === "new" ? "page" : undefined}
              onClick={() => setNavView("new")}
            >
              <span className="home-nav-icon" aria-hidden="true">➕</span>
              <span className="home-nav-label">新規</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={
                "home-nav-item" + (navView === "open" ? " home-nav-item--active" : "")
              }
              aria-current={navView === "open" ? "page" : undefined}
              onClick={() => setNavView("open")}
            >
              <span className="home-nav-icon" aria-hidden="true">📂</span>
              <span className="home-nav-label">開く</span>
            </button>
          </li>
        </ul>
        <div className="home-nav-footer">
          <button
            type="button"
            className="home-nav-item home-nav-item--minor"
            onClick={requestSettings}
            title="設定"
          >
            <span className="home-nav-icon" aria-hidden="true">⚙</span>
            <span className="home-nav-label">設定</span>
          </button>
          <button
            type="button"
            className="home-nav-item home-nav-item--minor"
            onClick={requestHelp}
            title="ヘルプ (F1)"
          >
            <span className="home-nav-icon" aria-hidden="true">?</span>
            <span className="home-nav-label">ヘルプ</span>
          </button>
        </div>
      </nav>

      {/* Main content area — content depends on the active rail view. */}
      <main className="home-main">
        {(lastError || importWarnings.length > 0) && (
          <div className="home-error">
            <div className="home-error__content">
              {lastError && <span className="home-error__title">{lastError}</span>}
              {importWarnings.map((w, i) => (
                <span key={i} className={`home-error__item home-error__item--${w.severity}`}>
                  {w.message}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="home-error__dismiss"
              onClick={() => {
                clearError();
                dismissWarnings();
              }}
            >
              ×
            </button>
          </div>
        )}

        {navView === "home" && (
          <>
            <h1 className="home-view-title">ホーム</h1>
            {recentFiles.length > 0 && recentFiles[0].exists && (
              <button
                type="button"
                className="home-continue"
                onClick={() => handleRecentFile(recentFiles[0])}
                title="前回作業していたファイルを開く"
              >
                <span className="home-continue__label">前回のファイルを続ける</span>
                <span className="home-continue__name">{recentFiles[0].name}</span>
              </button>
            )}
            <section className="home-section" aria-labelledby="home-new-title">
              <h2 id="home-new-title">新規</h2>
              {renderTemplateTiles()}
            </section>
            {renderRecovery()}
            {recentFiles.length > 0 && renderRecentsPane()}
            {isFirstRun && (
              <section className="home-welcome" aria-labelledby="home-welcome-title">
                <h2 id="home-welcome-title" className="home-welcome__title">
                  Coco へようこそ
                </h2>
                <p className="home-welcome__tagline">
                  ローカルファーストの xlsx スプレッドシート。
                  <br />
                  オフラインで安全に編集できます。
                </p>
                <ol className="home-welcome__steps">
                  <li>ファイルを開く / ドロップ</li>
                  <li>編集 / 保存 (Ctrl+S)</li>
                  <li>シートタブで複数シート</li>
                </ol>
              </section>
            )}
            {recentFiles.length > 0 && (
              <p className="home-tip" role="note">
                <span className="home-tip__icon" aria-hidden="true">💡</span>
                <span className="home-tip__label">ヒント:</span>
                <span className="home-tip__body">{tip}</span>
              </p>
            )}
          </>
        )}

        {navView === "new" && (
          <>
            <h1 className="home-view-title">新規</h1>
            <section className="home-section" aria-labelledby="home-new-view-title">
              <h2 id="home-new-view-title">テンプレートから作成</h2>
              {renderTemplateTiles()}
            </section>
          </>
        )}

        {navView === "open" && (
          <>
            <h1 className="home-view-title">開く</h1>
            <section className="home-section">
              <h2>ファイルを開く</h2>
              <div className="home-open-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleOpenFile}
                  title="既存ファイルを開く (Ctrl+O)"
                >
                  ファイルを参照…
                </button>
                <span className="home-open-hint">
                  xlsx / xlsm / csv / tsv / coco に対応
                </span>
              </div>
            </section>
            {renderRecovery()}
            {recentFiles.length > 0 ? (
              renderRecentsPane()
            ) : (
              <p className="home-empty">最近使ったファイルはありません</p>
            )}
          </>
        )}
      </main>

      {galleryOpen && (
        <TemplatesGalleryDialog
          onUseTemplate={(id) => void handleUseTemplate(id)}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </div>
  );
}
