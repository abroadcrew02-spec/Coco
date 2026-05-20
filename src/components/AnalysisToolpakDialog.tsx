import { useEffect, useState } from "react";
import "./AnalysisToolpakDialog.css";

// A1 range parser regex (matches ForecastSheetDialog).
const RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

export type AnalysisKind =
  | "regression"
  | "anova"
  | "histogram"
  | "anova2"
  | "ttest"
  | "chisquare"
  | "correlation"
  | "random"
  | "movingAverage"
  | "fourier";

export type TTestVariant =
  | "oneSample"
  | "twoSamplePooled"
  | "welch"
  | "paired";

export type ChiSquareVariant = "goodnessOfFit" | "independence";

export type RandomDistributionKind =
  | "uniform"
  | "normal"
  | "bernoulli"
  | "poisson";

export type MovingAverageVariant = "simple" | "exponential";

export interface AnalysisApplyParams {
  kind: AnalysisKind;
  /** Regression: X range. Histogram / single-range tools: data range. */
  primaryRange: string;
  /** Regression: Y range. t-test: second sample. Unused otherwise. */
  secondaryRange?: string;
  /** ANOVA: one range per group (comma- or newline-separated). */
  groupRanges?: string[];
  /** Histogram: optional explicit bin edges (numeric, ascending). */
  binEdges?: number[];
  /** Two-way ANOVA: rectangular block range; per-cell replicate count. */
  blockRange?: string;
  levelsA?: number;
  levelsB?: number;
  replicates?: number;
  /** t-test variant + hypothesised mean / difference. */
  tTestVariant?: TTestVariant;
  hypothesizedMean?: number;
  /** Chi-square variant; expected range for goodness-of-fit (optional). */
  chiSquareVariant?: ChiSquareVariant;
  expectedRange?: string;
  /** Correlation: one range per variable (comma- or newline-separated). */
  variableRanges?: string[];
  /** Random-number generation parameters. */
  randomDistribution?: RandomDistributionKind;
  randomCount?: number;
  randomSeed?: number;
  randomMin?: number;
  randomMax?: number;
  randomMean?: number;
  randomStdDev?: number;
  randomProbability?: number;
  randomLambda?: number;
  /** Moving average variant + parameters. */
  movingAverageVariant?: MovingAverageVariant;
  movingWindow?: number;
  movingAlpha?: number;
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

function parseGroupRanges(
  raw: string,
  minCount: number,
  noun: string,
): { ranges: string[]; error: string | null } {
  const parts = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < minCount) {
    return {
      ranges: [],
      error: `${noun}には少なくとも ${minCount} つの範囲が必要です`,
    };
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

/** Parse a positive integer field; returns NaN + an error message on failure. */
function parsePositiveInt(
  label: string,
  raw: string,
  min: number,
): { value: number; error: string | null } {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    return {
      value: Number.NaN,
      error: `${label}は ${min} 以上の整数で指定してください`,
    };
  }
  return { value: n, error: null };
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
  // Two-way ANOVA
  const [blockRange, setBlockRange] = useState(initialRange || "A2:C7");
  const [levelsAText, setLevelsAText] = useState("2");
  const [levelsBText, setLevelsBText] = useState("3");
  const [replicatesText, setReplicatesText] = useState("1");
  // t-test
  const [tVariant, setTVariant] = useState<TTestVariant>("twoSamplePooled");
  const [sample1Range, setSample1Range] = useState(initialRange || "A2:A10");
  const [sample2Range, setSample2Range] = useState("B2:B10");
  const [hypMeanText, setHypMeanText] = useState("0");
  // Chi-square
  const [chiVariant, setChiVariant] = useState<ChiSquareVariant>(
    "goodnessOfFit",
  );
  const [observedRange, setObservedRange] = useState(initialRange || "A2:A6");
  const [expectedRange, setExpectedRange] = useState("");
  const [contingencyRange, setContingencyRange] = useState(
    initialRange || "A2:C4",
  );
  // Correlation
  const [variablesText, setVariablesText] = useState("A2:A20\nB2:B20\nC2:C20");
  // Random
  const [randomDist, setRandomDist] =
    useState<RandomDistributionKind>("normal");
  const [randomCountText, setRandomCountText] = useState("100");
  const [randomSeedText, setRandomSeedText] = useState("");
  const [randomMinText, setRandomMinText] = useState("0");
  const [randomMaxText, setRandomMaxText] = useState("1");
  const [randomMeanText, setRandomMeanText] = useState("0");
  const [randomStdText, setRandomStdText] = useState("1");
  const [randomProbText, setRandomProbText] = useState("0.5");
  const [randomLambdaText, setRandomLambdaText] = useState("3");
  // Moving average
  const [maVariant, setMaVariant] = useState<MovingAverageVariant>("simple");
  const [maDataRange, setMaDataRange] = useState(initialRange || "A2:A20");
  const [maWindowText, setMaWindowText] = useState("3");
  const [maAlphaText, setMaAlphaText] = useState("0.3");
  // Fourier
  const [fourierRange, setFourierRange] = useState(initialRange || "A2:A17");

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
      if (xErr) return setError(xErr);
      const yErr = validateRange("Y 範囲", yRange);
      if (yErr) return setError(yErr);
      setError(null);
      onApply({
        kind: "regression",
        primaryRange: xRange.trim(),
        secondaryRange: yRange.trim(),
      });
      return;
    }
    if (kind === "anova") {
      const parsed = parseGroupRanges(groupsText, 2, "ANOVA");
      if (parsed.error) return setError(parsed.error);
      setError(null);
      onApply({
        kind: "anova",
        primaryRange: parsed.ranges[0],
        groupRanges: parsed.ranges,
      });
      return;
    }
    if (kind === "histogram") {
      const dErr = validateRange("データ範囲", dataRange);
      if (dErr) return setError(dErr);
      const binsParsed = parseBinEdges(binsText);
      if (binsParsed.error) return setError(binsParsed.error);
      setError(null);
      onApply({
        kind: "histogram",
        primaryRange: dataRange.trim(),
        binEdges: binsParsed.edges,
      });
      return;
    }
    if (kind === "anova2") {
      const rErr = validateRange("データブロック範囲", blockRange);
      if (rErr) return setError(rErr);
      const la = parsePositiveInt("因子 A の水準数", levelsAText, 2);
      if (la.error) return setError(la.error);
      const lb = parsePositiveInt("因子 B の水準数", levelsBText, 2);
      if (lb.error) return setError(lb.error);
      const rep = parsePositiveInt("セルあたり繰り返し数", replicatesText, 1);
      if (rep.error) return setError(rep.error);
      setError(null);
      onApply({
        kind: "anova2",
        primaryRange: blockRange.trim(),
        blockRange: blockRange.trim(),
        levelsA: la.value,
        levelsB: lb.value,
        replicates: rep.value,
      });
      return;
    }
    if (kind === "ttest") {
      const s1Err = validateRange("標本 1 の範囲", sample1Range);
      if (s1Err) return setError(s1Err);
      let s2: string | undefined;
      if (tVariant !== "oneSample") {
        const s2Err = validateRange("標本 2 の範囲", sample2Range);
        if (s2Err) return setError(s2Err);
        s2 = sample2Range.trim();
      }
      const hyp = Number(hypMeanText);
      if (!Number.isFinite(hyp)) {
        return setError("仮説平均 (差) は数値で指定してください");
      }
      setError(null);
      onApply({
        kind: "ttest",
        primaryRange: sample1Range.trim(),
        secondaryRange: s2,
        tTestVariant: tVariant,
        hypothesizedMean: hyp,
      });
      return;
    }
    if (kind === "chisquare") {
      if (chiVariant === "goodnessOfFit") {
        const oErr = validateRange("観測度数の範囲", observedRange);
        if (oErr) return setError(oErr);
        const trimmedExp = expectedRange.trim();
        if (trimmedExp && !RANGE_RE.test(trimmedExp)) {
          return setError(
            "期待度数の範囲は A1 形式で指定してください (空欄で一様分布)",
          );
        }
        setError(null);
        onApply({
          kind: "chisquare",
          primaryRange: observedRange.trim(),
          chiSquareVariant: "goodnessOfFit",
          expectedRange: trimmedExp || undefined,
        });
        return;
      }
      const cErr = validateRange("分割表の範囲", contingencyRange);
      if (cErr) return setError(cErr);
      setError(null);
      onApply({
        kind: "chisquare",
        primaryRange: contingencyRange.trim(),
        chiSquareVariant: "independence",
      });
      return;
    }
    if (kind === "correlation") {
      const parsed = parseGroupRanges(variablesText, 2, "相関行列");
      if (parsed.error) return setError(parsed.error);
      setError(null);
      onApply({
        kind: "correlation",
        primaryRange: parsed.ranges[0],
        variableRanges: parsed.ranges,
      });
      return;
    }
    if (kind === "random") {
      const cnt = parsePositiveInt("生成個数", randomCountText, 1);
      if (cnt.error) return setError(cnt.error);
      let seed: number | undefined;
      if (randomSeedText.trim()) {
        const s = Number(randomSeedText);
        if (!Number.isFinite(s) || !Number.isInteger(s)) {
          return setError("シードは整数で指定してください (空欄でランダム)");
        }
        seed = s;
      }
      const params: AnalysisApplyParams = {
        kind: "random",
        primaryRange: "",
        randomDistribution: randomDist,
        randomCount: cnt.value,
        randomSeed: seed,
      };
      if (randomDist === "uniform") {
        const lo = Number(randomMinText);
        const hi = Number(randomMaxText);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          return setError("一様分布: 最小値・最大値は数値で指定してください");
        }
        if (hi <= lo) {
          return setError("一様分布: 最大値は最小値より大きくしてください");
        }
        params.randomMin = lo;
        params.randomMax = hi;
      } else if (randomDist === "normal") {
        const mean = Number(randomMeanText);
        const sd = Number(randomStdText);
        if (!Number.isFinite(mean) || !Number.isFinite(sd)) {
          return setError("正規分布: 平均・標準偏差は数値で指定してください");
        }
        if (sd <= 0) return setError("正規分布: 標準偏差は正の値で指定してください");
        params.randomMean = mean;
        params.randomStdDev = sd;
      } else if (randomDist === "bernoulli") {
        const p = Number(randomProbText);
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          return setError("ベルヌーイ分布: 成功確率は 0〜1 で指定してください");
        }
        params.randomProbability = p;
      } else {
        const lambda = Number(randomLambdaText);
        if (!Number.isFinite(lambda) || lambda <= 0) {
          return setError("ポアソン分布: λ は正の値で指定してください");
        }
        params.randomLambda = lambda;
      }
      setError(null);
      onApply(params);
      return;
    }
    if (kind === "movingAverage") {
      const dErr = validateRange("データ範囲", maDataRange);
      if (dErr) return setError(dErr);
      if (maVariant === "simple") {
        const w = parsePositiveInt("窓幅", maWindowText, 1);
        if (w.error) return setError(w.error);
        setError(null);
        onApply({
          kind: "movingAverage",
          primaryRange: maDataRange.trim(),
          movingAverageVariant: "simple",
          movingWindow: w.value,
        });
        return;
      }
      const alpha = Number(maAlphaText);
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
        return setError("平滑化係数 α は 0 < α ≤ 1 の範囲で指定してください");
      }
      setError(null);
      onApply({
        kind: "movingAverage",
        primaryRange: maDataRange.trim(),
        movingAverageVariant: "exponential",
        movingAlpha: alpha,
      });
      return;
    }
    // fourier
    const fErr = validateRange("信号データ範囲", fourierRange);
    if (fErr) return setError(fErr);
    setError(null);
    onApply({ kind: "fourier", primaryRange: fourierRange.trim() });
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
          <label className="atp-field">
            <span className="atp-field-label">分析タイプ</span>
            <select
              className="atp-input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as AnalysisKind);
                setError(null);
              }}
              aria-label="分析タイプ"
            >
              <option value="regression">線形回帰</option>
              <option value="anova">一元配置 ANOVA</option>
              <option value="anova2">二元配置 ANOVA</option>
              <option value="ttest">t 検定</option>
              <option value="chisquare">カイ二乗検定</option>
              <option value="correlation">相関行列</option>
              <option value="histogram">ヒストグラム</option>
              <option value="random">乱数生成</option>
              <option value="movingAverage">移動平均</option>
              <option value="fourier">フーリエ変換</option>
            </select>
          </label>

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
                />
              </label>
              <p className="atp-hint">
                F 統計・p 値・群間/群内平方和を新規シートに出力します。
              </p>
            </>
          )}

          {kind === "anova2" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">
                  データブロック範囲 (行 = 因子A×繰り返し、列 = 因子B)
                </span>
                <input
                  type="text"
                  className="atp-input"
                  value={blockRange}
                  onChange={(e) => setBlockRange(e.target.value)}
                  placeholder="A2:C7"
                />
              </label>
              <div className="atp-row">
                <label className="atp-field">
                  <span className="atp-field-label">因子 A 水準数</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={levelsAText}
                    onChange={(e) => setLevelsAText(e.target.value)}
                  />
                </label>
                <label className="atp-field">
                  <span className="atp-field-label">因子 B 水準数</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={levelsBText}
                    onChange={(e) => setLevelsBText(e.target.value)}
                  />
                </label>
                <label className="atp-field">
                  <span className="atp-field-label">繰り返し数</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={replicatesText}
                    onChange={(e) => setReplicatesText(e.target.value)}
                  />
                </label>
              </div>
              <p className="atp-hint">
                主効果・交互作用の SS / F / p 値を出力します (均衡計画、Type I
                SS)。繰り返し数が 1 のとき交互作用は誤差に含めます。
              </p>
            </>
          )}

          {kind === "ttest" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">検定タイプ</span>
                <select
                  className="atp-input"
                  value={tVariant}
                  onChange={(e) =>
                    setTVariant(e.target.value as TTestVariant)
                  }
                >
                  <option value="oneSample">1 標本</option>
                  <option value="twoSamplePooled">
                    2 標本 (等分散プール)
                  </option>
                  <option value="welch">2 標本 (Welch・分散不等)</option>
                  <option value="paired">対応あり (ペア)</option>
                </select>
              </label>
              <label className="atp-field">
                <span className="atp-field-label">標本 1 の範囲</span>
                <input
                  type="text"
                  className="atp-input"
                  value={sample1Range}
                  onChange={(e) => setSample1Range(e.target.value)}
                  placeholder="A2:A10"
                />
              </label>
              {tVariant !== "oneSample" && (
                <label className="atp-field">
                  <span className="atp-field-label">標本 2 の範囲</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={sample2Range}
                    onChange={(e) => setSample2Range(e.target.value)}
                    placeholder="B2:B10"
                  />
                </label>
              )}
              <label className="atp-field">
                <span className="atp-field-label">
                  {tVariant === "oneSample"
                    ? "仮説平均 (μ₀)"
                    : "仮説平均差"}
                </span>
                <input
                  type="text"
                  className="atp-input"
                  value={hypMeanText}
                  onChange={(e) => setHypMeanText(e.target.value)}
                  placeholder="0"
                />
              </label>
              <p className="atp-hint">
                t 統計・自由度・両側/片側 p 値を新規シートに出力します。
              </p>
            </>
          )}

          {kind === "chisquare" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">検定タイプ</span>
                <select
                  className="atp-input"
                  value={chiVariant}
                  onChange={(e) =>
                    setChiVariant(e.target.value as ChiSquareVariant)
                  }
                >
                  <option value="goodnessOfFit">適合度検定 (1 次元)</option>
                  <option value="independence">独立性検定 (分割表)</option>
                </select>
              </label>
              {chiVariant === "goodnessOfFit" ? (
                <>
                  <label className="atp-field">
                    <span className="atp-field-label">観測度数の範囲</span>
                    <input
                      type="text"
                      className="atp-input"
                      value={observedRange}
                      onChange={(e) => setObservedRange(e.target.value)}
                      placeholder="A2:A6"
                    />
                  </label>
                  <label className="atp-field">
                    <span className="atp-field-label">
                      期待度数の範囲 (任意、空欄で一様分布)
                    </span>
                    <input
                      type="text"
                      className="atp-input"
                      value={expectedRange}
                      onChange={(e) => setExpectedRange(e.target.value)}
                      placeholder="B2:B6"
                    />
                  </label>
                </>
              ) : (
                <label className="atp-field">
                  <span className="atp-field-label">
                    分割表の範囲 (r×c の矩形)
                  </span>
                  <input
                    type="text"
                    className="atp-input"
                    value={contingencyRange}
                    onChange={(e) => setContingencyRange(e.target.value)}
                    placeholder="A2:C4"
                  />
                </label>
              )}
              <p className="atp-hint">
                χ² 統計・自由度・p 値・期待度数表を新規シートに出力します。
              </p>
            </>
          )}

          {kind === "correlation" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">
                  変数ごとの範囲 (改行またはカンマ区切り、2 変数以上)
                </span>
                <textarea
                  className="atp-textarea"
                  rows={4}
                  value={variablesText}
                  onChange={(e) => setVariablesText(e.target.value)}
                  placeholder={"A2:A20\nB2:B20\nC2:C20"}
                />
              </label>
              <p className="atp-hint">
                Pearson 相関係数行列と共分散行列を新規シートに出力します。
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

          {kind === "random" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">分布</span>
                <select
                  className="atp-input"
                  value={randomDist}
                  onChange={(e) =>
                    setRandomDist(e.target.value as RandomDistributionKind)
                  }
                >
                  <option value="uniform">一様分布</option>
                  <option value="normal">正規分布</option>
                  <option value="bernoulli">ベルヌーイ分布</option>
                  <option value="poisson">ポアソン分布</option>
                </select>
              </label>
              <div className="atp-row">
                <label className="atp-field">
                  <span className="atp-field-label">生成個数</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={randomCountText}
                    onChange={(e) => setRandomCountText(e.target.value)}
                  />
                </label>
                <label className="atp-field">
                  <span className="atp-field-label">
                    シード (任意・再現用)
                  </span>
                  <input
                    type="text"
                    className="atp-input"
                    value={randomSeedText}
                    onChange={(e) => setRandomSeedText(e.target.value)}
                    placeholder="例: 42"
                  />
                </label>
              </div>
              {randomDist === "uniform" && (
                <div className="atp-row">
                  <label className="atp-field">
                    <span className="atp-field-label">最小値</span>
                    <input
                      type="text"
                      className="atp-input"
                      value={randomMinText}
                      onChange={(e) => setRandomMinText(e.target.value)}
                    />
                  </label>
                  <label className="atp-field">
                    <span className="atp-field-label">最大値</span>
                    <input
                      type="text"
                      className="atp-input"
                      value={randomMaxText}
                      onChange={(e) => setRandomMaxText(e.target.value)}
                    />
                  </label>
                </div>
              )}
              {randomDist === "normal" && (
                <div className="atp-row">
                  <label className="atp-field">
                    <span className="atp-field-label">平均</span>
                    <input
                      type="text"
                      className="atp-input"
                      value={randomMeanText}
                      onChange={(e) => setRandomMeanText(e.target.value)}
                    />
                  </label>
                  <label className="atp-field">
                    <span className="atp-field-label">標準偏差</span>
                    <input
                      type="text"
                      className="atp-input"
                      value={randomStdText}
                      onChange={(e) => setRandomStdText(e.target.value)}
                    />
                  </label>
                </div>
              )}
              {randomDist === "bernoulli" && (
                <label className="atp-field">
                  <span className="atp-field-label">成功確率 p (0〜1)</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={randomProbText}
                    onChange={(e) => setRandomProbText(e.target.value)}
                  />
                </label>
              )}
              {randomDist === "poisson" && (
                <label className="atp-field">
                  <span className="atp-field-label">平均発生率 λ</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={randomLambdaText}
                    onChange={(e) => setRandomLambdaText(e.target.value)}
                  />
                </label>
              )}
              <p className="atp-hint">
                乱数列を新規シートに出力します。シードを固定すると再現可能です。
              </p>
            </>
          )}

          {kind === "movingAverage" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">タイプ</span>
                <select
                  className="atp-input"
                  value={maVariant}
                  onChange={(e) =>
                    setMaVariant(e.target.value as MovingAverageVariant)
                  }
                >
                  <option value="simple">単純移動平均</option>
                  <option value="exponential">指数移動平均</option>
                </select>
              </label>
              <label className="atp-field">
                <span className="atp-field-label">データ範囲</span>
                <input
                  type="text"
                  className="atp-input"
                  value={maDataRange}
                  onChange={(e) => setMaDataRange(e.target.value)}
                  placeholder="A2:A20"
                />
              </label>
              {maVariant === "simple" ? (
                <label className="atp-field">
                  <span className="atp-field-label">窓幅</span>
                  <input
                    type="text"
                    className="atp-input"
                    value={maWindowText}
                    onChange={(e) => setMaWindowText(e.target.value)}
                  />
                </label>
              ) : (
                <label className="atp-field">
                  <span className="atp-field-label">
                    平滑化係数 α (0 &lt; α ≤ 1)
                  </span>
                  <input
                    type="text"
                    className="atp-input"
                    value={maAlphaText}
                    onChange={(e) => setMaAlphaText(e.target.value)}
                  />
                </label>
              )}
              <p className="atp-hint">
                平滑化系列を新規シートに出力します。
              </p>
            </>
          )}

          {kind === "fourier" && (
            <>
              <label className="atp-field">
                <span className="atp-field-label">信号データ範囲 (実数列)</span>
                <input
                  type="text"
                  className="atp-input"
                  value={fourierRange}
                  onChange={(e) => setFourierRange(e.target.value)}
                  placeholder="A2:A17"
                />
              </label>
              <p className="atp-hint">
                振幅スペクトルと位相を新規シートに出力します (2 冪長は
                Cooley-Tukey、それ以外は Bluestein)。
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
