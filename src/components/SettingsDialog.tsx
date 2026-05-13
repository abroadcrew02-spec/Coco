import { useEffect, useState } from "react";
import { useWorkbookStore } from "../store/useWorkbookStore";
import "./SettingsDialog.css";

interface Props {
  onClose: () => void;
}

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 15_000, label: "15 秒ごと" },
  { ms: 30_000, label: "30 秒ごと（推奨）" },
  { ms: 60_000, label: "1 分ごと" },
  { ms: 300_000, label: "5 分ごと" },
  { ms: 0, label: "無効" },
];

export default function SettingsDialog({ onClose }: Props) {
  const intervalMs = useWorkbookStore((s) => s.autoSaveIntervalMs);
  const setAutoSaveInterval = useWorkbookStore((s) => s.setAutoSaveInterval);
  const [pending, setPending] = useState<number>(intervalMs);

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

  const apply = async () => {
    await setAutoSaveInterval(pending);
    onClose();
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="settings-title" className="settings-title">設定</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="settings-body">
          <section className="settings-section">
            <h3>自動保存の頻度</h3>
            <p className="settings-hint">
              編集後この間隔で自動保存します。`.coco` は同一ファイルへ、xlsx は背後の一時 `.coco` へ書き出します（ユーザーの xlsx は明示保存時のみ更新）。
            </p>
            <div className="settings-radio-group">
              {INTERVAL_OPTIONS.map((opt) => (
                <label key={opt.ms} className="settings-radio">
                  <input
                    type="radio"
                    name="autosave-interval"
                    checked={pending === opt.ms}
                    onChange={() => setPending(opt.ms)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </section>
        </div>
        <footer className="settings-footer">
          <button type="button" className="settings-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={apply}
            disabled={pending === intervalMs}
          >
            適用
          </button>
        </footer>
      </div>
    </div>
  );
}
