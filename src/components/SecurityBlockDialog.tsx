import { useEffect } from "react";
import type { CompatibilityWarning } from "../types/workbook";
import "./SecurityBlockDialog.css";

interface Props {
  warnings: CompatibilityWarning[];
  onClose: () => void;
}

// req 7.3: shown when an xlsx fails security_scan and is rejected before any
// import work happens. The user can only close — there is no "force open"
// path because the file was blocked for a hard reason (size, sheet count, etc).
export default function SecurityBlockDialog({ warnings, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const blocking = warnings.filter((w) => w.severity === "blocking");
  const softWarnings = warnings.filter((w) => w.severity !== "blocking");

  return (
    <div className="security-block-backdrop" onClick={onClose}>
      <div
        className="security-block-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="security-block-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="security-block-icon" aria-hidden="true">⛔</div>
        <div className="security-block-body">
          <h2 id="security-block-title" className="security-block-title">
            ファイルを開けません
          </h2>
          <p className="security-block-hint">
            このファイルはセキュリティ上の制限を超えているため、読み込みを中止しました。
            元のファイルは変更されていません。
          </p>
          {blocking.length > 0 && (
            <ul className="security-block-list">
              {blocking.map((w, i) => (
                <li key={i} className="security-block-item security-block-item--blocking">
                  <span className="security-block-code">{w.code}</span>
                  <span className="security-block-message">{w.message}</span>
                </li>
              ))}
            </ul>
          )}
          {softWarnings.length > 0 && (
            <details className="security-block-soft">
              <summary>その他の警告（{softWarnings.length}件）</summary>
              <ul className="security-block-list">
                {softWarnings.map((w, i) => (
                  <li key={i} className="security-block-item">
                    <span className="security-block-code">{w.code}</span>
                    <span className="security-block-message">{w.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="security-block-actions">
            <button
              type="button"
              className="security-block-btn security-block-btn--primary"
              onClick={onClose}
              autoFocus
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
