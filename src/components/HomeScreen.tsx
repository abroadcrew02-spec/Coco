import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { requestSettings, requestHelp } from "../hooks/useGlobalShortcuts";
import { useEditorPreload } from "../hooks/useEditorPreload";
import { routeOpenPath } from "../store/pathRouter";
import { recoveryReasonLabel } from "../store/recoveryLabels";
import { friendlyError } from "../store/errorMessages";
import { timeAgoJa } from "./timeAgo";
import type { RecentFile, RecoveryCandidate } from "../types/workbook";
import "./HomeScreen.css";

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
  } = useWorkbookStore();

  // Inline filter — shown only when there are enough recents to make
  // scanning awkward. Below the threshold, an input would just be noise.
  const FILTER_THRESHOLD = 6;
  const [filterQuery, setFilterQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // Sort pinned entries to the top; otherwise preserve the backend's
  // last_opened DESC order. Stable sort ensures non-pinned items keep their
  // relative order from the backend response.
  const sortedRecents = [...recentFiles].sort((a, b) => {
    const ap = pinnedPaths.includes(a.path) ? 1 : 0;
    const bp = pinnedPaths.includes(b.path) ? 1 : 0;
    return bp - ap;
  });
  const filteredRecents = filterQuery.trim()
    ? sortedRecents.filter((f) =>
        f.name.toLowerCase().includes(filterQuery.trim().toLowerCase()) ||
        f.path.toLowerCase().includes(filterQuery.trim().toLowerCase())
      )
    : sortedRecents;

  // Ctrl/Cmd+F focuses the recents filter (when present). Escape inside the
  // input clears the query without losing focus. The home screen is the only
  // place this shortcut routes — the editor delegates Ctrl+F to Univer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        if (filterInputRef.current) {
          e.preventDefault();
          filterInputRef.current.focus();
          filterInputRef.current.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEditorPreload();

  const handleOpenFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "Excel / Coco / CSV", extensions: ["xlsx", "xlsm", "coco", "csv"] },
        { name: "Excel Files", extensions: ["xlsx", "xlsm"] },
        { name: "Coco Files", extensions: ["coco"] },
        { name: "CSV Files", extensions: ["csv"] },
      ],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const route = routeOpenPath(path);
    if (route.kind === "coco") await openCoco(route.path);
    else if (route.kind === "csv") await importCsv(route.path);
    else if (route.kind === "xlsx") await importXlsx(route.path);
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

  return (
    <div className="home-screen">
      <div className="home-header">
        <h1 className="home-title">Coco</h1>
        <p className="home-subtitle">ローカルファースト表計算</p>
        <div className="home-header-actions">
          <button
            type="button"
            className="home-icon-btn"
            onClick={requestHelp}
            title="ヘルプ (F1)"
            aria-label="ヘルプ"
          >
            ?
          </button>
          <button
            type="button"
            className="home-icon-btn"
            onClick={requestSettings}
            title="設定"
            aria-label="設定"
          >
            ⚙
          </button>
        </div>
      </div>
      <div className="home-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={newWorkbook}
          title="新規ワークブックを作成 (Ctrl+N)"
        >
          新規ワークブック
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleOpenFile}
          title="既存ファイルを開く (Ctrl+O)"
        >
          ファイルを開く
        </button>
      </div>
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
      {recoveryCandidates.length > 0 && (
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
      )}
      {recentFiles.length > 0 && (
        <div className="home-section">
          <div className="home-section-header">
            <h2>最近使ったファイル</h2>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                if (window.confirm("最近使ったファイル一覧をすべて削除しますか？")) {
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
          <ul className="recent-list">
            {filteredRecents.map((f: RecentFile) => {
              const opened = Date.parse(f.lastOpened);
              const ageLabel = Number.isFinite(opened) ? timeAgoJa(opened) : null;
              const fullDate = Number.isFinite(opened)
                ? new Date(opened).toLocaleString("ja-JP")
                : f.lastOpened;
              const isPinned = pinnedPaths.includes(f.path);
              return (
              <li
                key={f.path}
                className={`recent-item ${!f.exists ? "recent-item--missing" : ""} ${isPinned ? "recent-item--pinned" : ""}`}
                onClick={() => handleRecentFile(f)}
              >
                <span className="recent-name">
                  {isPinned && <span className="recent-pin-indicator" aria-hidden="true">📌</span>}
                  {f.name}
                </span>
                <span className="recent-path">{f.path}</span>
                {ageLabel && (
                  <span className="recent-when" title={`最終アクセス: ${fullDate}`}>
                    {ageLabel}
                  </span>
                )}
                {!f.exists && <span className="recent-badge">見つかりません</span>}
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
              </li>
              );
            })}
          </ul>
        </div>
      )}
      {recentFiles.length === 0 && recoveryCandidates.length === 0 && (
        <p className="home-empty">最近使ったファイルはありません</p>
      )}
    </div>
  );
}
