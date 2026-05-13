import { open } from "@tauri-apps/plugin-dialog";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { requestSettings, requestHelp } from "../hooks/useGlobalShortcuts";
import { useEditorPreload } from "../hooks/useEditorPreload";
import { routeOpenPath } from "../store/pathRouter";
import { recoveryReasonLabel } from "../store/recoveryLabels";
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
  } = useWorkbookStore();

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
            {recoveryCandidates.map((c: RecoveryCandidate) => (
              <li key={c.candidateId} className="recovery-item">
                <div className="recovery-item__main">
                  <span className="recovery-item__title">{c.originalPath ?? "無題のワークブック"}</span>
                  <span className="recovery-date">
                    {new Date(c.savedAt).toLocaleString("ja-JP")} · {recoveryReasonLabel(c.reason)}
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
            ))}
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
          <ul className="recent-list">
            {recentFiles.map((f: RecentFile) => (
              <li
                key={f.path}
                className={`recent-item ${!f.exists ? "recent-item--missing" : ""}`}
                onClick={() => handleRecentFile(f)}
              >
                <span className="recent-name">{f.name}</span>
                <span className="recent-path">{f.path}</span>
                {!f.exists && <span className="recent-badge">見つかりません</span>}
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
            ))}
          </ul>
        </div>
      )}
      {recentFiles.length === 0 && recoveryCandidates.length === 0 && (
        <p className="home-empty">最近使ったファイルはありません</p>
      )}
    </div>
  );
}
