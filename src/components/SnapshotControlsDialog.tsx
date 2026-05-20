import { useEffect } from "react";
import {
  SNAPSHOT_INTERVAL_OPTIONS,
  snapshotIntervalLabelJa,
  type SnapshotIntervalSetting,
} from "../store/snapshotControls";
import "./SnapshotControlsDialog.css";

// Explicit snapshot-cadence control surface. Two related actions:
//   1. Pick an autosave/snapshot interval bucket (15s / 30s / 1m / 5m /
//      disabled). The chosen bucket is reported via `onIntervalChange` so
//      the host (EditorScreen) can mirror it into the workbook store +
//      localStorage.
//   2. "今すぐスナップショット" button — fires the host-supplied
//      `onSnapshotNow` callback; the host is responsible for translating
//      that into a window event (`coco:snapshot-now`) or a direct
//      `store.save()` call. Keeping the side effect at the host edge keeps
//      this component test-friendly (no Tauri imports here).
//
// The "last snapshot timestamp" + "snapshot count" line is informational —
// loaded by the host from `workbook_list_snapshots` and passed in as props
// so this component does no async work itself.

interface Props {
  currentInterval: SnapshotIntervalSetting;
  lastSnapshotAt: string | null;
  snapshotCount: number;
  onIntervalChange: (interval: SnapshotIntervalSetting) => void;
  onSnapshotNow: () => void;
  onClose: () => void;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "（まだスナップショットがありません）";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString("ja-JP");
}

export default function SnapshotControlsDialog({
  currentInterval,
  lastSnapshotAt,
  snapshotCount,
  onIntervalChange,
  onSnapshotNow,
  onClose,
}: Props) {
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

  return (
    <div className="snapctl-backdrop" onClick={onClose}>
      <div
        className="snapctl-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapctl-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="snapctl-header">
          <h2 id="snapctl-title" className="snapctl-title">
            スナップショット設定
          </h2>
          <button
            type="button"
            className="snapctl-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <div className="snapctl-body">
          <section className="snapctl-section">
            <h3 className="snapctl-section-title">自動スナップショット間隔</h3>
            <p className="snapctl-hint">
              編集中、選択した間隔で自動的にスナップショットを作成します。「無効」を選ぶと自動作成は停止します。
            </p>
            <ul className="snapctl-radio-list" role="radiogroup" aria-label="自動スナップショット間隔">
              {SNAPSHOT_INTERVAL_OPTIONS.map((opt) => {
                const key = String(opt);
                const checked = opt === currentInterval;
                return (
                  <li key={key} className="snapctl-radio-item">
                    <label className="snapctl-radio-label">
                      <input
                        type="radio"
                        name="snapctl-interval"
                        value={key}
                        checked={checked}
                        onChange={() => onIntervalChange(opt)}
                      />
                      <span>{snapshotIntervalLabelJa(opt)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="snapctl-section">
            <h3 className="snapctl-section-title">現在の状況</h3>
            <dl className="snapctl-status">
              <div className="snapctl-status-row">
                <dt>最終スナップショット</dt>
                <dd>{formatTimestamp(lastSnapshotAt)}</dd>
              </div>
              <div className="snapctl-status-row">
                <dt>スナップショット数</dt>
                <dd>{snapshotCount} 件</dd>
              </div>
            </dl>
          </section>
        </div>

        <footer className="snapctl-footer">
          <button
            type="button"
            className="snapctl-btn snapctl-btn--primary"
            onClick={onSnapshotNow}
          >
            今すぐスナップショット
          </button>
          <button
            type="button"
            className="snapctl-btn"
            onClick={onClose}
          >
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}
