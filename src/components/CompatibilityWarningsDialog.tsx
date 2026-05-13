import { useEffect } from "react";
import type { CompatibilityWarning } from "../types/workbook";
import "./CompatibilityWarningsDialog.css";

interface Props {
  warnings: CompatibilityWarning[];
  title: string;
  onClose: () => void;
}

// Groups warnings by severity so high-impact items stay near the top.
// Used for both xlsx import and export — the only difference is the title
// (the message strings are already populated server-side).
export default function CompatibilityWarningsDialog({ warnings, title, onClose }: Props) {
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

  const groups: Array<{ severity: CompatibilityWarning["severity"]; label: string }> = [
    { severity: "blocking", label: "ブロック (開けない)" },
    { severity: "warning", label: "警告" },
    { severity: "info", label: "情報" },
  ];

  return (
    <div className="compat-backdrop" onClick={onClose}>
      <div
        className="compat-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compat-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="compat-header">
          <h2 id="compat-title" className="compat-title">{title}</h2>
          <button
            type="button"
            className="compat-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="compat-body">
          {groups.map(({ severity, label }) => {
            const items = warnings.filter((w) => w.severity === severity);
            if (items.length === 0) return null;
            return (
              <section key={severity} className={`compat-section compat-section--${severity}`}>
                <h3 className="compat-section-title">
                  {label} <span className="compat-count">({items.length})</span>
                </h3>
                <ul className="compat-list">
                  {items.map((w, i) => (
                    <li key={i} className="compat-item">
                      <span className="compat-code">{w.code}</span>
                      <span className="compat-message">{w.message}</span>
                      {w.affectedSheets && w.affectedSheets.length > 0 && (
                        <span className="compat-sheets">
                          影響シート: {w.affectedSheets.join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <footer className="compat-footer">
          <button
            type="button"
            className="compat-footer-btn"
            onClick={onClose}
            autoFocus
          >
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}
