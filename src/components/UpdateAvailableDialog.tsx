import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import "./UpdateAvailableDialog.css";

interface Props {
  currentVersion: string;
  newVersion: string;
  pubDate: string | null;
  /** Markdown release notes. Rendered via react-markdown (Phase 2). */
  notes: string;
  onUpdate: () => void;
  onSkip: () => void;
  onLater: () => void;
  onClose: () => void;
  /**
   * When true, the update is mandatory: Skip + Later buttons are hidden, the
   * dialog cannot be dismissed via Escape or backdrop click, and a prominent
   * security banner is shown. Defaults to false (Phase 1 behavior).
   */
  isForced?: boolean;
}

function formatPubDate(raw: string | null): string {
  if (!raw) return "不明";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  try {
    return d.toLocaleString("ja-JP");
  } catch {
    return d.toISOString();
  }
}

export default function UpdateAvailableDialog({
  currentVersion,
  newVersion,
  pubDate,
  notes,
  onUpdate,
  onSkip,
  onLater,
  onClose,
  isForced = false,
}: Props) {
  const updateBtnRef = useRef<HTMLButtonElement | null>(null);

  // Esc closes ("Later" semantics handled by the parent via onClose), unless
  // the update is forced — in which case the user must take action.
  useEffect(() => {
    if (isForced) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isForced]);

  // Basic focus management: primary action gets focus on mount so keyboard
  // users can press Enter to update without tabbing through the modal.
  useEffect(() => {
    updateBtnRef.current?.focus();
  }, []);

  const handleBackdropClick = () => {
    if (isForced) return;
    onClose();
  };

  return (
    <div className="uad-backdrop" onClick={handleBackdropClick}>
      <div
        className="uad-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uad-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="uad-header">
          <h2 id="uad-title" className="uad-title">
            Coco v{newVersion} が利用可能です
          </h2>
          {!isForced && (
            <button
              type="button"
              className="uad-close"
              onClick={onClose}
              aria-label="閉じる"
            >
              ×
            </button>
          )}
        </header>
        <div className="uad-body">
          {isForced && (
            <div className="uad-forced-banner" role="alert">
              ⚠ このバージョンの更新は必須です (セキュリティ修正)
            </div>
          )}
          <p className="uad-meta">
            <span className="uad-meta-label">現在のバージョン:</span>
            <span className="uad-meta-value">v{currentVersion}</span>
          </p>
          <p className="uad-meta">
            <span className="uad-meta-label">公開日:</span>
            <span className="uad-meta-value">{formatPubDate(pubDate)}</span>
          </p>
          <hr className="uad-divider" />
          <div className="uad-notes-wrap">
            <span className="uad-field-label">リリースノート</span>
            <div className="uad-notes-md">
              {notes ? (
                <ReactMarkdown
                  skipHtml
                  components={{
                    a: ({ node: _node, ...props }) => (
                      <a
                        {...props}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    ),
                  }}
                >
                  {notes}
                </ReactMarkdown>
              ) : (
                <p className="uad-notes-empty">(リリースノートはありません)</p>
              )}
            </div>
          </div>
        </div>
        <footer className="uad-footer">
          {!isForced && (
            <button
              type="button"
              className="uad-btn uad-btn--danger"
              onClick={onSkip}
            >
              このバージョンをスキップ
            </button>
          )}
          <div className="uad-footer-right">
            {!isForced && (
              <button type="button" className="uad-btn" onClick={onLater}>
                後で
              </button>
            )}
            <button
              ref={updateBtnRef}
              type="button"
              className="uad-btn uad-btn--primary"
              onClick={onUpdate}
            >
              今すぐ更新
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
