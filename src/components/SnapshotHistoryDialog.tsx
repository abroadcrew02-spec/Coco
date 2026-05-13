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
export default function SnapshotHistoryDialog({ onClose }: Props) {
  const listSnapshots = useWorkbookStore((s) => s.listSnapshots);
  const openSnapshot = useWorkbookStore((s) => s.openSnapshot);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

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
      </div>
    </div>
  );
}
