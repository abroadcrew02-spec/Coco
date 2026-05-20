import { useEffect, useState } from "react";
import "./AnalysisToolpakDialog.css";

// A1 range parser regex (matches ForecastSheetDialog).
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

export type AnalysisKind = "regression" | "anova" | "histogram";

export interface AnalysisApplyParams {
  kind: AnalysisKind;
  /** Regression: X range. Histogram: data range. */
  primaryRange: string;
  /** Regression: Y range. Unused for histogram. */
  secondaryRange?: string;
  /** ANOVA: one range per group (comma- or newline-separated). */
  groupRanges?: string[];
  /** Histogram: optional explicit bin edges (numeric, ascending). */
  binEdges?: number[];
}

interface Props {
  initialRange: string;
  onApply: (params: AnalysisApplyParams) => void;
  onClose: () => void;
}

function validateRange(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label}は必須です`;
  if (!RANGE_RE.test(trimmed)) {
    return `${label}は A1 形式の範囲で指定してください (例: A2:A10)`;
  }
  return null;
}

function parseGroupRanges(raw: string): { ranges: string[]; error: string | null } {
  const parts = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 2) {
    return { ranges: [], error: "ANOVA には少なくとも 2 つの範囲が必要です" };
  }
  for (const p of parts) {
    if (!RANGE_RE.test(p)) {
      return { ranges: [], error: `「${p}」は A1 形式の範囲ではありません` };
    }
  }
  return { ranges: parts, error: null };
}

function parseBinEdges(raw: string): { edges: number[]; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { edges: [], error: null }; // auto-bin
  const parts = trimmed.split(/[\s,]+/).filter((s) => s.length > 0);
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) {
      return { edges: [], error: `ビン境界 「${p}」 は数値として解釈できません` };
    }
    nums.push(n);
  }
  if (nums.length === 1) {
    return { edges: [], error: "ビン境界は 2 つ以上指定してください (例: 0, 10, 20)" };
  }
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] <= nums[i - 1]) {
      return { edges: [], error: "ビン境界は昇順 (狭義単調) で指定してください" };
    }
  }
  return { edges: nums, error: null };
}

export default function AnalysisToolpakDialog({
  initialRange,
  onApply,
  onClose,
}: Props) {
  const [kind, setKind] = useState<AnalysisKind>("regression");
  const [xRange, setXRange] = useState(initialRange || "A2:A10");
  const [yRange, setYRange] = useState("B2:B10");
  const [dataRange, setDataRange] = useState(initialRange || "A2:A20");
  const [binsText, setBinsText] = useState("");
  const [groupsText, setGroupsText] = useState("A2:A10\nB2:B10");
  const [error, setError] = useState<string | null>(null);

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

  const handleApply = () => {
    if (kind === "regression") {
      const xErr = validateRange("X 範囲", xRange);
      if (xErr) {
        setError(xErr);
        return;
      }
      const yErr = validateRange("Y 範囲", yRange);
      if (yErr) {
        setError(yErr);
        return;
      }
      setError(null);
      onApply({
        kind: "regression",
        primaryRange: xRange.trim(),
        secondaryRange: yRange.trim(),
      });
      return;
    }
    if (kind === "anova") {
      const parsed = parseGroupRanges(groupsText);
      if (parsed.error) {
        setError(parsed.error);
        return;
      }
      setError(null);
      onApply({
        kind: "anova",
        primaryRange: parsed.ranges[0],
        groupRanges: parsed.ranges,
      });
      return;
    }
    // histogram
    const dErr = validateRange("データ範囲", dataRange);
    if (dErr) {
      setError(dErr);
      return;
    }
    const binsParsed = parseBinEdges(binsText);
    if (binsParsed.error) {
      setError(binsParsed.error);
      return;
    }
    setError(null);
    onApply({
      kind: "histogram",
      primaryRange: dataRange.trim(),
      binEdges: binsParsed.edges,
    });
  };

  return (
    <div className="atp-backdrop" onClick={onClose}>
      <div
        className="atp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="atp-header">
          <h2 id="atp-title" className="atp-title">分析ツールパック</h2>
          <button
            type="button"
            className="atp-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </header>
        <div className="atp-body">
          <div className="atp-kind-group" role="radiogroup" aria-label="分析タイプ">
            <label className="atp-kind">
              <input
                type="radio"
                name="atp-kind"
                value="regression"
                checked={kind === "regression"}
                onChange={() => setKind("regression")}
              />
              <span>線形回帰</span>
            </label>
            <label className="atp-kind">
              <input
                type="radio"
                name="atp-kind"
                value="anova"
                checked={kind === "anova"}
                onChange={() => setKind("anova")}
              />
              <span>一元配置 ANOVA</span>
            </label>
            <label className="atp-kind">
              <input
                type="radio"
                name="atp-kind"
                value="histogram"
                checked={kind === "histogram"}
                onChange={() => setKind("histogram")}
              />
              <span>ヒストグラム</span>
            </label>
          </div>

          {kind === "regression" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">X 範囲 (説明変数)</span>
                <input
                  type="text"
                  className="atp-input"
                  value={xRange}
                  onChange={(e) => setXRange(e.target.value)}
                  placeholder="A2:A10"
                  autoFocus
                />
              </label>
              <label className="atp-field">
                <span className="atp-field-label">Y 範囲 (目的変数)</span>
                <input
                  type="text"
                  className="atp-input"
                  value={yRange}
                  onChange={(e) => setYRange(e.target.value)}
                  placeholder="B2:B10"
                />
              </label>
              <p className="atp-hint">
                係数・R²・F 統計・p 値・標準誤差を新規シートに出力します。
              </p>
            </>
          )}

          {kind === "anova" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">
                  群ごとの範囲 (改行またはカンマ区切り、2 群以上)
                </span>
                <textarea
                  className="atp-textarea"
                  rows={4}
                  value={groupsText}
                  onChange={(e) => setGroupsText(e.target.value)}
                  placeholder={"A2:A10\nB2:B10\nC2:C10"}
                  autoFocus
                />
              </label>
              <p className="atp-hint">
                F 統計・p 値・群間/群内平方和を新規シートに出力します。
              </p>
            </>
          )}

          {kind === "histogram" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">データ範囲</span>
                <input
                  type="text"
                  className="atp-input"
                  value={dataRange}
                  onChange={(e) => setDataRange(e.target.value)}
                  placeholder="A2:A20"
                  autoFocus
                />
              </label>
              <label className="atp-field">
                <span className="atp-field-label">
                  ビン境界 (任意、空欄で自動 / 例: 0, 10, 20, 30)
                </span>
                <input
                  type="text"
                  className="atp-input"
                  value={binsText}
                  onChange={(e) => setBinsText(e.target.value)}
                  placeholder="0, 10, 20, 30"
                />
              </label>
              <p className="atp-hint">
                空欄の場合は Sturges 法でビン数を自動決定します。
              </p>
            </>
          )}

          {error && <p className="atp-error">{error}</p>}
        </div>
        <footer className="atp-footer">
          <button type="button" className="atp-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="atp-btn atp-btn--primary"
            onClick={handleApply}
          >
            実行
          </button>
        </footer>
      </div>
    </div>
  );
}
