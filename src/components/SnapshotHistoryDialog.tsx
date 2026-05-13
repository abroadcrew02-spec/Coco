import { useEffect, useState } from "react";
import { useWorkbookStore, type SnapshotMeta } from "../store/useWorkbookStore";
import { recoveryReasonLabel } from "../store/recoveryLabels";
import { timeAgoJa } from "./timeAgo";
import "./SnapshotHistoryDialog.css";

interface Props {
  onClose: () => void;
}

// Lists the .coco file's recorded snapshots (up to MAX_SNAPSHOTS_PER_WORKBOOK
// = 5). Opening a snapshot detaches the working file (path → null) so the
// user cannot overwrite the current state without going through Save As.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SnapshotHistoryDialog({ onClose }: Props) {
  const listSnapshots = useWorkbookStore((s) => s.listSnapshots);
  const openSnapshot = useWorkbookStore((s) => s.openSnapshot);
  const vacuumWorkbook = useWorkbookStore((s) => s.vacuumWorkbook);
  const checkIntegrity = useWorkbookStore((s) => s.checkIntegrity);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [vacuumStatus, setVacuumStatus] = useState<string | null>(null);
  const [vacuumRunning, setVacuumRunning] = useState(false);
  const [integrityStatus, setIntegrityStatus] = useState<string | null>(null);
  const [integrityRunning, setIntegrityRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSnapshots()
      .then((rows) => {
        if (!cancelled) {
          setSnapshots(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshots([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listSnapshots]);

  const handleOpen = async (snapshotId: number) => {
    await openSnapshot(snapshotId);
    onClose();
  };

  const handleVacuum = async () => {
    setVacuumRunning(true);
    setVacuumStatus(null);
    setIntegrityStatus(null);
    const result = await vacuumWorkbook();
    setVacuumRunning(false);
    if (result) {
      const saved = result.beforeBytes - result.afterBytes;
      setVacuumStatus(
        saved > 0
          ? `${formatBytes(saved)} を解放しました（${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)}）`
          : `既に最適化されています（${formatBytes(result.afterBytes)}）`
      );
    } else {
      setVacuumStatus("最適化に失敗しました。エラーバナーをご確認ください。");
    }
  };

  const handleIntegrity = async () => {
    setIntegrityRunning(true);
    setIntegrityStatus(null);
    setVacuumStatus(null);
    const result = await checkIntegrity();
    setIntegrityRunning(false);
    if (result === null) {
      setIntegrityStatus("整合性チェックに失敗しました。エラーバナーをご確認ください。");
    } else if (result.ok) {
      setIntegrityStatus("整合性チェック: 問題ありません ✓");
    } else {
      const head = result.issues.slice(0, 2).join(" / ");
      const more = result.issues.length > 2 ? `（他 ${result.issues.length - 2} 件）` : "";
      setIntegrityStatus(`整合性に問題が検出されました: ${head}${more}`);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Arrow nav + Enter only meaningful while snapshots are loaded.
      const rows = snapshots ?? [];
      if (rows.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, rows.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = rows[selectedIdx];
        if (target) void handleOpen(target.snapshotId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, snapshots, selectedIdx]);

  return (
    <div className="snapshot-backdrop" onClick={onClose}>
      <div
        className="snapshot-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="snapshot-header">
          <h2 id="snapshot-title" className="snapshot-title">スナップショット履歴</h2>
          <button
            type="button"
            className="snapshot-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="snapshot-body">
          <p className="snapshot-hint">
            過去 5 回までの保存ポイントを表示します。選択するとそのバージョンを開きますが、現在のファイルは変更されず、Ctrl+S で別名保存となります。
          </p>
          {loading && <p className="snapshot-empty">読み込み中...</p>}
          {!loading && snapshots && snapshots.length === 0 && (
            <p className="snapshot-empty">スナップショットがありません。</p>
          )}
          {!loading && snapshots && snapshots.length > 0 && (
            <ul className="snapshot-list">
              {snapshots.map((s, idx) => {
                const created = Date.parse(s.createdAt);
                const ageLabel = Number.isFinite(created) ? timeAgoJa(created) : s.createdAt;
                const fullDate = Number.isFinite(created)
                  ? new Date(created).toLocaleString("ja-JP")
                  : s.createdAt;
                const isSelected = idx === selectedIdx;
                return (
                  <li
                    key={s.snapshotId}
                    className={`snapshot-item ${isSelected ? "snapshot-item--selected" : ""}`}
                    onMouseEnter={() => setSelectedIdx(idx)}
                  >
                    <div className="snapshot-item__meta">
                      <span className="snapshot-item__when" title={fullDate}>
                        {ageLabel}
                        {idx === 0 && <span className="snapshot-item__current">（最新）</span>}
                      </span>
                      <span className="snapshot-item__reason">
                        {recoveryReasonLabel(s.reason)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="snapshot-item__open"
                      onClick={() => handleOpen(s.snapshotId)}
                    >
                      このバージョンを開く
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="snapshot-footer">
          <button
            type="button"
            className="snapshot-footer-btn"
            onClick={handleVacuum}
            disabled={vacuumRunning || integrityRunning}
            title="不要領域を解放してファイルサイズを縮小"
          >
            {vacuumRunning ? "最適化中..." : "ファイルを最適化"}
          </button>
          <button
            type="button"
            className="snapshot-footer-btn"
            onClick={handleIntegrity}
            disabled={vacuumRunning || integrityRunning}
            title="SQLite の整合性チェックを実行"
          >
            {integrityRunning ? "確認中..." : "整合性チェック"}
          </button>
          {(vacuumStatus || integrityStatus) && (
            <span className="snapshot-footer-status">
              {vacuumStatus ?? integrityStatus}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
