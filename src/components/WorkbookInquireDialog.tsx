import { useEffect, useMemo } from "react";
import { computeWorkbookInquire } from "../store/workbookInquire";
import "./WorkbookInquireDialog.css";

interface Props {
  snapshotJson: string;
  onClose: () => void;
}

export default function WorkbookInquireDialog({ snapshotJson, onClose }: Props) {
  const report = useMemo(() => computeWorkbookInquire(snapshotJson), [snapshotJson]);

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
    <div className="wid-backdrop" onClick={onClose}>
      <div
        className="wid-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wid-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wid-header">
          <h2 id="wid-title" className="wid-title">ブック診断 (Inquire)</h2>
          <button type="button" className="wid-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="wid-body">
          <section className="wid-section">
            <h3 className="wid-section-title">概要</h3>
            <div className="wid-grid">
              <div className="wid-stat"><span className="wid-stat-label">シート</span><span className="wid-stat-value">{report.sheets}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">非表示シート</span><span className="wid-stat-value">{report.hiddenSheets}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">名前付き範囲</span><span className="wid-stat-value">{report.namedRanges}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">セル合計</span><span className="wid-stat-value">{report.totalCells.toLocaleString()}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">数式セル</span><span className="wid-stat-value">{report.formulaCells.toLocaleString()}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">値セル</span><span className="wid-stat-value">{report.valueCells.toLocaleString()}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">空セル</span><span className="wid-stat-value">{report.emptyCells.toLocaleString()}</span></div>
            </div>
          </section>

          <section className="wid-section">
            <h3 className="wid-section-title">オブジェクト</h3>
            <div className="wid-grid">
              <div className="wid-stat"><span className="wid-stat-label">画像</span><span className="wid-stat-value">{report.images}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">チャート</span><span className="wid-stat-value">{report.charts}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">ピボット</span><span className="wid-stat-value">{report.pivots}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">コメント</span><span className="wid-stat-value">{report.comments}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">条件付き書式</span><span className="wid-stat-value">{report.conditionalFormatRules}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">データ検証</span><span className="wid-stat-value">{report.dataValidationRules}</span></div>
              <div className="wid-stat"><span className="wid-stat-label">ハイパーリンク</span><span className="wid-stat-value">{report.hyperlinks}</span></div>
            </div>
          </section>

          {report.topFunctions.length > 0 && (
            <section className="wid-section">
              <h3 className="wid-section-title">よく使われる関数 (Top {Math.min(20, report.topFunctions.length)})</h3>
              <table className="wid-table">
                <thead>
                  <tr><th>関数</th><th className="wid-num">回数</th></tr>
                </thead>
                <tbody>
                  {report.topFunctions.map((f) => (
                    <tr key={f.name}>
                      <td><code>{f.name}</code></td>
                      <td className="wid-num">{f.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.formulaDepthHistogram.length > 0 && (
            <section className="wid-section">
              <h3 className="wid-section-title">数式のネスト深度</h3>
              <table className="wid-table">
                <thead>
                  <tr><th>深度</th><th className="wid-num">数式</th></tr>
                </thead>
                <tbody>
                  {report.formulaDepthHistogram.map((d) => (
                    <tr key={d.depth}>
                      <td>{d.depth}</td>
                      <td className="wid-num">{d.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.formulaErrors.length > 0 && (
            <section className="wid-section">
              <h3 className="wid-section-title">数式エラー</h3>
              <table className="wid-table">
                <thead>
                  <tr><th>エラー</th><th className="wid-num">件数</th><th>初出</th></tr>
                </thead>
                <tbody>
                  {report.formulaErrors.map((e) => (
                    <tr key={e.code}>
                      <td><code>{e.code}</code></td>
                      <td className="wid-num">{e.count.toLocaleString()}</td>
                      <td><code>{e.firstAt}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.externalLinks.length > 0 && (
            <section className="wid-section">
              <h3 className="wid-section-title">外部リンク</h3>
              <table className="wid-table">
                <thead>
                  <tr><th>セル</th><th>リンク先</th></tr>
                </thead>
                <tbody>
                  {report.externalLinks.map((l, i) => (
                    <tr key={`${l.ref}-${i}`}>
                      <td><code>{l.ref}</code></td>
                      <td><code>{l.target}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
        <footer className="wid-footer">
          <button type="button" className="wid-btn wid-btn--primary" onClick={onClose}>
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}
