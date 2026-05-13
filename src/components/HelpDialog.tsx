import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import "./HelpDialog.css";

interface Props {
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  description: string;
}

const APP_SHORTCUTS: Shortcut[] = [
  { keys: ["Ctrl", "N"], description: "新規ワークブック" },
  { keys: ["Ctrl", "O"], description: "ファイルを開く" },
  { keys: ["Ctrl", "S"], description: "保存（既定パスへ上書き）" },
  { keys: ["Ctrl", "Shift", "S"], description: "名前を付けて保存" },
  { keys: ["F1"], description: "このヘルプを表示" },
];

const UNIVER_SHORTCUTS: Shortcut[] = [
  { keys: ["Ctrl", "Z"], description: "元に戻す" },
  { keys: ["Ctrl", "Y"], description: "やり直し" },
  { keys: ["Ctrl", "C"], description: "コピー" },
  { keys: ["Ctrl", "X"], description: "切り取り" },
  { keys: ["Ctrl", "V"], description: "貼り付け" },
  { keys: ["Ctrl", "F"], description: "検索" },
  { keys: ["Ctrl", "H"], description: "置換" },
];

export default function HelpDialog({ onClose }: Props) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "F1") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
  }, []);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="help-header">
          <h2 id="help-title" className="help-title">Coco — ヘルプ</h2>
          <button type="button" className="help-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="help-body">
          <section className="help-section">
            <h3>キーボードショートカット（Coco）</h3>
            <table className="help-table">
              <tbody>
                {APP_SHORTCUTS.map((s, i) => (
                  <tr key={i}>
                    <td className="help-keys">
                      {s.keys.map((k, j) => (
                        <span key={j} className="help-key">{k}</span>
                      ))}
                    </td>
                    <td className="help-desc">{s.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="help-section">
            <h3>編集ショートカット（Univer 標準）</h3>
            <table className="help-table">
              <tbody>
                {UNIVER_SHORTCUTS.map((s, i) => (
                  <tr key={i}>
                    <td className="help-keys">
                      {s.keys.map((k, j) => (
                        <span key={j} className="help-key">{k}</span>
                      ))}
                    </td>
                    <td className="help-desc">{s.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="help-footnote">
              macOS では Ctrl の代わりに Cmd を使えます。
            </p>
          </section>
          <section className="help-section">
            <h3>対応ファイル形式</h3>
            <ul className="help-list">
              <li><b>.xlsx</b> — Excel ワークブック（既定の保存形式）</li>
              <li><b>.xlsm</b> — マクロ付き Excel ワークブック（読み込みのみ、マクロは破棄）</li>
              <li><b>.csv</b> — UTF-8 BOM 付き CSV（入出力対応）</li>
              <li><b>.coco</b> — SQLite ベース、原子的保存・履歴対応（オプション）</li>
            </ul>
          </section>
          <section className="help-section">
            <h3>このアプリについて</h3>
            <p className="help-about">
              Coco{version ? ` v${version}` : ""} · ローカルファースト表計算<br />
              ライセンス: Apache-2.0 · 表計算エンジン: Univer (Apache-2.0)
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
