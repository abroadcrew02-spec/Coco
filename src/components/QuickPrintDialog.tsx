import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildPrintHtml,
  type QuickPrintScope,
} from "../store/quickPrint";
import "./QuickPrintDialog.css";

interface Props {
  /** Parsed workbook snapshot (caller is responsible for JSON.parse). */
  snapshot: object;
  /** Active sheet id; null is tolerated (fallback to first sheet). */
  activeSheetId: string | null;
  onClose: () => void;
}

export default function QuickPrintDialog({
  snapshot,
  activeSheetId,
  onClose,
}: Props) {
  const [scope, setScope] = useState<QuickPrintScope>("activeSheet");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Re-build on scope change. `snapshot` is captured once at open time by the
  // EditorScreen (it builds the dialog with the snapshot it had at Ctrl+P
  // time), so the preview is stable while the user toggles scope.
  const html = useMemo(
    () =>
      buildPrintHtml(snapshot, {
        scope,
        activeSheetId: activeSheetId ?? undefined,
      }),
    [snapshot, scope, activeSheetId],
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

  const handlePrint = () => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow;
    if (!win) return;
    // Focus is required on some browsers (Chromium incl. Tauri's webview2)
    // for `print()` to target the iframe document instead of the parent.
    try {
      win.focus();
      win.print();
    } catch {
      // Best-effort: if the browser blocks programmatic print, the user can
      // still right-click the preview iframe and print manually.
    }
  };

  return (
    <div className="qp-backdrop" onClick={onClose}>
      <div
        className="qp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="qp-header">
          <h2 id="qp-title" className="qp-title">印刷プレビュー</h2>
          <button
            type="button"
            className="qp-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="qp-body">
          <div className="qp-scope" role="radiogroup" aria-label="印刷範囲">
            <span className="qp-scope-label">範囲:</span>
            <label>
              <input
                type="radio"
                name="qp-scope"
                value="activeSheet"
                checked={scope === "activeSheet"}
                onChange={() => setScope("activeSheet")}
              />
              <span>アクティブシートのみ</span>
            </label>
            <label>
              <input
                type="radio"
                name="qp-scope"
                value="allSheets"
                checked={scope === "allSheets"}
                onChange={() => setScope("allSheets")}
              />
              <span>すべてのシート</span>
            </label>
          </div>
          <iframe
            ref={iframeRef}
            className="qp-preview-frame"
            title="印刷プレビュー"
            // `srcDoc` is the lowest-friction way to feed a fully-self-contained
            // HTML document into an iframe — no temp file, no blob URL lifecycle
            // to manage. Tauri's webview honors it the same as Chromium.
            srcDoc={html}
            sandbox="allow-same-origin allow-modals"
          />
        </div>
        <footer className="qp-footer">
          <p className="qp-hint">
            ブラウザの印刷ダイアログを開きます。
            「PDF として保存」を選択すれば PDF を生成できます。
          </p>
          <div className="qp-footer-actions">
            <button type="button" className="qp-btn" onClick={onClose}>
              閉じる
            </button>
            <button
              type="button"
              className="qp-btn qp-btn--primary"
              onClick={handlePrint}
            >
              印刷
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
