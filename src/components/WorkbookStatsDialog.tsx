import { useEffect, useState } from "react";
import {
  formatBytes,
  type WorkbookStatsBundle,
} from "../store/workbookStats";
import "./WorkbookStatsDialog.css";

type TabId = "overview" | "perSheet" | "features" | "dataTypes";

interface Props {
  /** Pre-computed stats bundle (collectWorkbookStats(snapshot)). */
  stats: WorkbookStatsBundle;
  /** Re-run collectWorkbookStats against the current snapshot. */
  onRefresh: () => void;
  onClose: () => void;
}

const TAB_LABELS_JA: Record<TabId, string> = {
  overview: "概要",
  perSheet: "シート別",
  features: "機能の利用",
  dataTypes: "データ種別",
};

/**
 * Workbook-wide statistics dashboard. Tabs surface different facets of the
 * snapshot — overview totals, per-sheet table, feature usage counts, and a
 * data-type histogram. All numbers come from `collectWorkbookStats` on the
 * EditorScreen side; this component owns only render + tab state + refresh
 * button wiring (the refresh callback re-runs collection in the parent).
 *
 * The dialog is intentionally read-only: no mutations, no jumps — just an
 * at-a-glance dashboard. Escape / backdrop / × all close.
 */
export default function WorkbookStatsDialog({ stats, onRefresh, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("overview");

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

  const fmt = (n: number) => n.toLocaleString("ja-JP");

  return (
    <div className="wsd-backdrop" onClick={onClose}>
      <div
        className="wsd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wsd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wsd-header">
          <h2 id="wsd-title" className="wsd-title">
            ブック統計
          </h2>
          <button
            type="button"
            className="wsd-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>

        <nav className="wsd-tabs" role="tablist">
          {(Object.keys(TAB_LABELS_JA) as TabId[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "wsd-tab wsd-tab--active" : "wsd-tab"}
              onClick={() => setTab(id)}
            >
              {TAB_LABELS_JA[id]}
            </button>
          ))}
        </nav>

        <div className="wsd-body">
          {tab === "overview" && (
            <section className="wsd-section">
              <table className="wsd-table wsd-table--kv">
                <tbody>
                  <tr>
                    <th>シート数</th>
                    <td>{fmt(stats.overview.sheetCount)}</td>
                  </tr>
                  <tr>
                    <th>非表示シート</th>
                    <td>{fmt(stats.overview.hiddenSheetCount)}</td>
                  </tr>
                  <tr>
                    <th>総セル数 (入力済み)</th>
                    <td>{fmt(stats.overview.totalCells)}</td>
                  </tr>
                  <tr>
                    <th>数式セル数</th>
                    <td>{fmt(stats.overview.formulaCells)}</td>
                  </tr>
                  <tr>
                    <th>スナップショット サイズ</th>
                    <td>{formatBytes(stats.overview.sizeBytes)}</td>
                  </tr>
                  <tr>
                    <th>ユニーク スタイル数</th>
                    <td>{fmt(stats.styles.uniqueStyles)}</td>
                  </tr>
                  <tr>
                    <th>ユニーク 表示形式数</th>
                    <td>{fmt(stats.styles.uniqueNumberFormats)}</td>
                  </tr>
                </tbody>
              </table>

              {stats.topSheets.length > 0 && (
                <>
                  <h3 className="wsd-subhead">セル数の多いシート Top 5</h3>
                  <table className="wsd-table">
                    <thead>
                      <tr>
                        <th>シート</th>
                        <th className="wsd-num">セル数</th>
                        <th className="wsd-num">数式数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.topSheets.map((s) => (
                        <tr key={s.sheetId}>
                          <td>{s.sheetName}</td>
                          <td className="wsd-num">{fmt(s.cellCount)}</td>
                          <td className="wsd-num">{fmt(s.formulaCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </section>
          )}

          {tab === "perSheet" && (
            <section className="wsd-section">
              {stats.perSheet.length === 0 ? (
                <p className="wsd-empty">シートがありません</p>
              ) : (
                <table className="wsd-table">
                  <thead>
                    <tr>
                      <th>シート</th>
                      <th className="wsd-num">セル数</th>
                      <th className="wsd-num">数式数</th>
                      <th className="wsd-num">結合セル</th>
                      <th className="wsd-num">CF</th>
                      <th className="wsd-num">DV</th>
                      <th className="wsd-num">コメント</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.perSheet.map((s) => (
                      <tr key={s.sheetId}>
                        <td>{s.sheetName}</td>
                        <td className="wsd-num">{fmt(s.cellCount)}</td>
                        <td className="wsd-num">{fmt(s.formulaCount)}</td>
                        <td className="wsd-num">{fmt(s.mergedCount)}</td>
                        <td className="wsd-num">{fmt(s.cfRules)}</td>
                        <td className="wsd-num">{fmt(s.dvRules)}</td>
                        <td className="wsd-num">{fmt(s.commentCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {tab === "features" && (
            <section className="wsd-section">
              <table className="wsd-table wsd-table--kv">
                <tbody>
                  <tr>
                    <th>ハイパーリンク</th>
                    <td>{fmt(stats.features.hyperlinks)}</td>
                  </tr>
                  <tr>
                    <th>コメント</th>
                    <td>{fmt(stats.features.comments)}</td>
                  </tr>
                  <tr>
                    <th>データの入力規則 (DV)</th>
                    <td>{fmt(stats.features.dataValidations)}</td>
                  </tr>
                  <tr>
                    <th>条件付き書式 (CF)</th>
                    <td>{fmt(stats.features.conditionalFormats)}</td>
                  </tr>
                  <tr>
                    <th>スパークライン</th>
                    <td>{fmt(stats.features.sparklines)}</td>
                  </tr>
                  <tr>
                    <th>グラフ</th>
                    <td>{fmt(stats.features.charts)}</td>
                  </tr>
                  <tr>
                    <th>テーブル</th>
                    <td>{fmt(stats.features.tables)}</td>
                  </tr>
                  <tr>
                    <th>ピボットテーブル</th>
                    <td>{fmt(stats.features.pivots)}</td>
                  </tr>
                  <tr>
                    <th>スライサー</th>
                    <td>{fmt(stats.features.slicers)}</td>
                  </tr>
                  <tr>
                    <th>名前付き範囲</th>
                    <td>{fmt(stats.features.namedRanges)}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {tab === "dataTypes" && (
            <section className="wsd-section">
              <table className="wsd-table wsd-table--kv">
                <tbody>
                  <tr>
                    <th>数値</th>
                    <td>{fmt(stats.dataTypes.numeric)}</td>
                  </tr>
                  <tr>
                    <th>テキスト</th>
                    <td>{fmt(stats.dataTypes.text)}</td>
                  </tr>
                  <tr>
                    <th>数式</th>
                    <td>{fmt(stats.dataTypes.formula)}</td>
                  </tr>
                  <tr>
                    <th>真偽値</th>
                    <td>{fmt(stats.dataTypes.boolean)}</td>
                  </tr>
                  <tr>
                    <th>空白</th>
                    <td>{fmt(stats.dataTypes.blank)}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}
        </div>

        <footer className="wsd-footer">
          <button type="button" className="wsd-btn" onClick={onRefresh}>
            更新
          </button>
          <button
            type="button"
            className="wsd-btn wsd-btn--primary"
            onClick={onClose}
          >
            閉じる
          </button>
        </footer>
      </div>
    </div>
  );
}
