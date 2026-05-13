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
  { keys: ["Ctrl", "F"], description: "ホーム画面: 最近使ったファイルを絞り込み" },
  { keys: ["↑/↓"], description: "ホーム画面: 最近使ったファイルを上下で選択" },
  { keys: ["Enter"], description: "ホーム画面: 選択中のファイルを開く" },
  { keys: ["Ctrl", ","], description: "設定を開く" },
  { keys: ["Ctrl", "/"], description: "このヘルプを表示" },
  { keys: ["F1"], description: "このヘルプを表示（同上）" },
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
              <li>
                <b>.csv / .tsv</b> — UTF-8 BOM / UTF-8 / Shift_JIS を入出力で対応。
                インポートは文字コード・区切り文字を自動検出、エクスポートの
                既定は設定から変更可能
              </li>
              <li><b>.coco</b> — SQLite ベース、原子的保存・履歴対応（オプション）</li>
            </ul>
          </section>
          <section className="help-section">
            <h3>.coco のバージョン履歴</h3>
            <p className="help-about">
              .coco ファイルでは過去 5 回までの保存ポイントが保持されます。
              エディタ画面の「履歴」ボタンから一覧を開き、過去のバージョンを
              閲覧できます（編集後の Ctrl+S は別名保存となり、現在のファイルは
              上書きされません）。
            </p>
          </section>
          <section className="help-section">
            <h3>CSV / TSV インポート時の自動型変換</h3>
            <ul className="help-list">
              <li><b>日付</b> — <code>2026-05-13</code> / <code>2026/05/13</code> は日付セルになります</li>
              <li><b>日時</b> — <code>2026-05-13 12:00:00</code> や ISO <code>T</code> 区切りも対応</li>
              <li><b>時刻</b> — <code>10:30</code> / <code>10:30:00</code> は時刻セルになります</li>
              <li><b>パーセント</b> — <code>50%</code> は 0.5 として読み込み、表示は <code>50%</code></li>
              <li><b>先頭ゼロ保持</b> — <code>0001234</code> や郵便番号は数値化されず文字列のまま</li>
              <li><b>区切り文字判定</b> — <code>.tsv</code> はタブ区切り、<code>.csv</code> でもタブが多い場合は自動でタブ扱い</li>
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
