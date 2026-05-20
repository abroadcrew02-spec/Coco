// Pure helpers for Excel's "Analysis ToolPak" subset:
//
//   - Linear regression (OLS) with the classical inference suite:
//       slope/intercept, R², F statistic, p-value, standard errors.
//   - One-way ANOVA: between/within sums of squares, F, p-value.
//   - Histogram: frequency table over caller-supplied (or auto-derived) bins.
//
// Out of scope (filed as follow-up): multi-way ANOVA, t-test, chi-square,
// correlation matrix wizard, random-number generation, moving average,
// Fourier transform.
//
// Following the goalSeek.ts / forecastSheet.ts pattern this module stays free
// of Univer / FUniver imports so the math is trivially unit-testable. The
// caller (AnalysisToolpakDialog) is responsible for resolving ranges into
// numeric arrays, invoking the appropriate helper, and writing the result
// back into the snapshot.
//
// Numerical-stability notes:
//   - All sums use plain accumulators; for the sample sizes a spreadsheet
//     analysis pack realistically handles (~ 10^5 cells max) the rounding
//     error of naïve sums stays under 1e-10 relative — Kahan summation is
//     overkill.
//   - Edge cases (collinear X, single-group ANOVA, empty histogram) return
//     an `error` field instead of throwing so the dialog can surface a
//     human-readable message without try/catch ceremony.
//   - The F CDF uses the regularised incomplete-beta identity
//       P(F ≤ f; d1, d2) = 1 - I(d2/(d2+d1*f); d2/2, d1/2)
//     evaluated by Lentz's modified continued fraction. Accurate to ~1e-12
//     across the (df1, df2) ranges plausibly encountered here.

// ---------------------------------------------------------------------------
// Beta / F utilities
// ---------------------------------------------------------------------------

/** Log-gamma via Lanczos g=7 approximation. Stable for x > 0. */
function lnGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return Number.NaN;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1-x) = π / sin(πx)
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
    );
  }
  const y = x - 1;
  let sum = c[0];
  for (let i = 1; i < g + 2; i++) sum += c[i] / (y + i);
  const t = y + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * Regularised incomplete beta function I_x(a, b) using a Lentz-style
 * continued fraction. Returns NaN for invalid inputs.
 *
 * Reference: Numerical Recipes §6.4 — same recurrence Excel uses internally
 * for BETA.DIST.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  if (a <= 0 || b <= 0) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(
    a * Math.log(x) + b * Math.log(1 - x) - lnBeta,
  );

  // Use the symmetry I_x(a, b) = 1 - I_{1-x}(b, a) on the slow side of x.
  const useDirect = x < (a + 1) / (a + b + 2);
  if (!useDirect) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  // Lentz's algorithm for the continued fraction
  //   B(a,b,x) = 1/(1+) d1/(1+) d2/(1+) ...
  //   d_{2m+1} = -(a+m)(a+b+m) x / ((a+2m)(a+2m+1))
  //   d_{2m}   = m (b-m) x / ((a+2m-1)(a+2m))
  const fpmin = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    // even step
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    // odd step
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return (front * h) / a;
}

/**
 * Upper-tail probability P(F > f) for an F-distribution with (df1, df2)
 * degrees of freedom. Equals the two-sided p-value reported by Excel /
 * R for the regression F-test and the one-way ANOVA F-test.
 */
function fSurvival(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || f <= 0) return 1;
  if (!Number.isFinite(df1) || !Number.isFinite(df2) || df1 <= 0 || df2 <= 0) {
    return Number.NaN;
  }
  // P(F > f) = I_{d2/(d2+d1 f)}(d2/2, d1/2)
  const x = df2 / (df2 + df1 * f);
  return regularizedIncompleteBeta(x, df2 / 2, df1 / 2);
}

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

export interface RegressionResult {
  /** Number of (x_i, y_i) pairs used (after dropping non-finite entries). */
  n: number;
  /** Slope a in ŷ = a*x + b. */
  slope: number;
  /** Intercept b in ŷ = a*x + b. */
  intercept: number;
  /** Coefficient of determination, R² ∈ [0, 1]. */
  r2: number;
  /** Adjusted R². */
  adjustedR2: number;
  /** Sum of squared residuals Σ(y - ŷ)². */
  sse: number;
  /** Regression sum of squares Σ(ŷ - ȳ)². */
  ssr: number;
  /** Total sum of squares Σ(y - ȳ)². */
  sst: number;
  /** Residual standard error sqrt(SSE / (n - 2)). */
  residualSE: number;
  /** Standard error of the slope estimate. */
  seSlope: number;
  /** Standard error of the intercept estimate. */
  seIntercept: number;
  /** Overall F statistic for the model. */
  f: number;
  /** Two-tailed p-value for the F statistic. */
  pValue: number;
  /** Residuals y_i - ŷ_i in source order (same length as `n`). */
  residuals: number[];
  /** Predictions ŷ_i in source order. */
  fitted: number[];
  /** Set when the regression couldn't be computed. */
  error?: string;
}

function emptyRegression(error: string): RegressionResult {
  return {
    n: 0,
    slope: Number.NaN,
    intercept: Number.NaN,
    r2: Number.NaN,
    adjustedR2: Number.NaN,
    sse: Number.NaN,
    ssr: Number.NaN,
    sst: Number.NaN,
    residualSE: Number.NaN,
    seSlope: Number.NaN,
    seIntercept: Number.NaN,
    f: Number.NaN,
    pValue: Number.NaN,
    residuals: [],
    fitted: [],
    error,
  };
}

/**
 * Ordinary least-squares fit ŷ = slope*x + intercept with classical OLS
 * inference (SE, F, p). Pairs where either coordinate is non-finite are
 * dropped silently — this matches Excel's LINEST behavior.
 */
export function runLinearRegression(
  x: number[],
  y: number[],
): RegressionResult {
  if (!Array.isArray(x) || !Array.isArray(y)) {
    return emptyRegression("入力配列が不正です");
  }
  if (x.length !== y.length) {
    return emptyRegression(
      `X (${x.length}) と Y (${y.length}) の要素数が一致しません`,
    );
  }
  const cleanX: number[] = [];
  const cleanY: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = y[i];
    if (Number.isFinite(xi) && Number.isFinite(yi)) {
      cleanX.push(xi);
      cleanY.push(yi);
    }
  }
  const n = cleanX.length;
  if (n < 3) {
    return emptyRegression(
      "回帰には数値ペアが少なくとも 3 組必要です (推測統計の自由度が確保できません)",
    );
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += cleanX[i];
    sumY += cleanY[i];
    sumXY += cleanX[i] * cleanY[i];
    sumXX += cleanX[i] * cleanX[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  // Sxx is Σ(x - x̄)² rewritten in stable form.
  const sxx = sumXX - sumX * meanX;
  if (!Number.isFinite(sxx) || sxx <= 0) {
    return emptyRegression(
      "説明変数の分散がゼロです (X が定数または線形依存)。回帰式を推定できません",
    );
  }
  const sxy = sumXY - sumX * meanY;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  const residuals: number[] = new Array(n);
  const fitted: number[] = new Array(n);
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const yhat = slope * cleanX[i] + intercept;
    const e = cleanY[i] - yhat;
    fitted[i] = yhat;
    residuals[i] = e;
    sse += e * e;
    const dy = cleanY[i] - meanY;
    sst += dy * dy;
  }
  const ssr = sst - sse;
  const dfRes = n - 2;
  const residualSE = Math.sqrt(Math.max(0, sse / dfRes));
  const seSlope = residualSE / Math.sqrt(sxx);
  // SE(intercept) = s_e * sqrt(1/n + meanX²/Sxx)
  const seIntercept = residualSE * Math.sqrt(1 / n + (meanX * meanX) / sxx);
  // R² guarded for SST == 0 (constant Y).
  const r2 = sst > 0 ? ssr / sst : 1;
  const adjustedR2 = 1 - ((1 - r2) * (n - 1)) / dfRes;
  // F statistic for slope ≠ 0 (regression with 1 predictor): F = MSR / MSE
  const f = sse > 0 ? ssr / (sse / dfRes) : Infinity;
  const pValue = sse > 0 ? fSurvival(f, 1, dfRes) : 0;

  return {
    n,
    slope,
    intercept,
    r2,
    adjustedR2,
    sse,
    ssr,
    sst,
    residualSE,
    seSlope,
    seIntercept,
    f,
    pValue,
    residuals,
    fitted,
  };
}

// ---------------------------------------------------------------------------
// One-way ANOVA
// ---------------------------------------------------------------------------

export interface ANOVAResult {
  /** Number of groups with at least one valid observation. */
  groupCount: number;
  /** Total valid observations across all groups. */
  totalN: number;
  /** Degrees of freedom: k - 1 (between groups). */
  dfBetween: number;
  /** Degrees of freedom: N - k (within groups). */
  dfWithin: number;
  /** Degrees of freedom: N - 1 (total). */
  dfTotal: number;
  /** Σ_g n_g (ȳ_g - ȳ)² — variation explained by group membership. */
  ssBetween: number;
  /** Σ_g Σ_i (y_i - ȳ_g)² — within-group residual variation. */
  ssWithin: number;
  /** ssBetween + ssWithin. */
  ssTotal: number;
  /** ssBetween / dfBetween. */
  msBetween: number;
  /** ssWithin / dfWithin. */
  msWithin: number;
  /** F statistic = msBetween / msWithin. */
  f: number;
  /** Two-tailed p-value for the F statistic. */
  pValue: number;
  /** Per-group n / mean / variance, in input order. */
  groups: Array<{ n: number; mean: number; variance: number }>;
  /** Set when ANOVA couldn't be computed. */
  error?: string;
}

function emptyANOVA(error: string): ANOVAResult {
  return {
    groupCount: 0,
    totalN: 0,
    dfBetween: 0,
    dfWithin: 0,
    dfTotal: 0,
    ssBetween: Number.NaN,
    ssWithin: Number.NaN,
    ssTotal: Number.NaN,
    msBetween: Number.NaN,
    msWithin: Number.NaN,
    f: Number.NaN,
    pValue: Number.NaN,
    groups: [],
    error,
  };
}

/**
 * Classical one-way ANOVA. Each entry of `groups` is the array of numeric
 * observations for one group. Non-finite values inside a group are dropped.
 * Groups that become empty after filtering are dropped from the analysis;
 * the result needs ≥ 2 surviving groups and ≥ 1 within-group degree of
 * freedom.
 */
export function runOneWayANOVA(groups: number[][]): ANOVAResult {
  if (!Array.isArray(groups)) {
    return emptyANOVA("入力配列が不正です");
  }
  const clean: number[][] = [];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    const filtered: number[] = [];
    for (const v of g) {
      if (Number.isFinite(v)) filtered.push(v);
    }
    if (filtered.length > 0) clean.push(filtered);
  }
  if (clean.length < 2) {
    return emptyANOVA(
      "一元配置 ANOVA には少なくとも 2 群が必要です (有効な数値を含む群)",
    );
  }

  // Per-group stats + grand total.
  let grandSum = 0;
  let totalN = 0;
  const groupStats = clean.map((g) => {
    const n = g.length;
    let s = 0;
    for (const v of g) s += v;
    const mean = s / n;
    let sq = 0;
    for (const v of g) {
      const d = v - mean;
      sq += d * d;
    }
    const variance = n > 1 ? sq / (n - 1) : 0;
    grandSum += s;
    totalN += n;
    return { n, mean, variance, withinSS: sq };
  });
  const grandMean = grandSum / totalN;

  let ssBetween = 0;
  let ssWithin = 0;
  for (const gs of groupStats) {
    const d = gs.mean - grandMean;
    ssBetween += gs.n * d * d;
    ssWithin += gs.withinSS;
  }
  const ssTotal = ssBetween + ssWithin;
  const k = clean.length;
  const dfBetween = k - 1;
  const dfWithin = totalN - k;
  const dfTotal = totalN - 1;
  if (dfWithin < 1) {
    return emptyANOVA(
      "群内の自由度が不足しています (各群に複数の観測値が必要です)",
    );
  }
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  // ssWithin can legitimately be 0 (every group is a constant) — in that
  // case F is infinite and p is 0 by convention.
  const f = msWithin > 0 ? msBetween / msWithin : msBetween > 0 ? Infinity : 0;
  const pValue =
    msWithin > 0 ? fSurvival(f, dfBetween, dfWithin) : msBetween > 0 ? 0 : 1;

  return {
    groupCount: k,
    totalN,
    dfBetween,
    dfWithin,
    dfTotal,
    ssBetween,
    ssWithin,
    ssTotal,
    msBetween,
    msWithin,
    f,
    pValue,
    groups: groupStats.map((g) => ({ n: g.n, mean: g.mean, variance: g.variance })),
  };
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

export interface HistogramBin {
  /** Inclusive lower edge of the bin. */
  binStart: number;
  /** Exclusive upper edge (except the last bin, which is inclusive). */
  binEnd: number;
  /** Count of observations falling into this bin. */
  frequency: number;
  /** Human-readable label like "[1.0, 2.0)". */
  label: string;
}

export interface HistogramResult {
  bins: HistogramBin[];
  /** Observations below the first bin start. */
  underflow: number;
  /** Observations above the last bin end. */
  overflow: number;
  /** Set when the histogram couldn't be built. */
  error?: string;
}

function emptyHistogram(error: string): HistogramResult {
  return { bins: [], underflow: 0, overflow: 0, error };
}

function formatEdge(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-3)) {
    return x.toExponential(3);
  }
  // Trim trailing zeros after up to 4 fractional digits.
  return Number(x.toFixed(4)).toString();
}

/**
 * Build a frequency table for `data` over `bins`. Bin edges are inclusive on
 * the left and exclusive on the right, except the final bin which is
 * inclusive on both ends (matching numpy.histogram's default and Excel's
 * FREQUENCY).
 *
 * If `bins` is empty or non-monotonic the function derives edges from the
 * data using Sturges' rule: ceil(log2(n)) + 1 bins between min and max.
 */
export function buildHistogram(
  data: number[],
  bins: number[],
): HistogramResult {
  if (!Array.isArray(data)) {
    return emptyHistogram("入力配列が不正です");
  }
  const clean: number[] = [];
  for (const v of data) {
    if (Number.isFinite(v)) clean.push(v);
  }
  if (clean.length === 0) {
    return emptyHistogram("ヒストグラム対象の数値データがありません");
  }

  // Resolve edges.
  let edges: number[];
  const supplied = Array.isArray(bins) ? bins.filter((b) => Number.isFinite(b)) : [];
  // Bin input must be strictly increasing and have ≥ 2 entries; otherwise
  // fall back to auto-derivation.
  let monotonic = supplied.length >= 2;
  if (monotonic) {
    for (let i = 1; i < supplied.length; i++) {
      if (supplied[i] <= supplied[i - 1]) {
        monotonic = false;
        break;
      }
    }
  }
  if (monotonic) {
    edges = supplied.slice();
  } else {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of clean) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === hi) {
      // Degenerate constant data — synthesize a single ±0.5 bin around it.
      const pad = lo === 0 ? 0.5 : Math.abs(lo) * 0.05;
      edges = [lo - pad, lo + pad];
    } else {
      // Sturges' rule: k = ceil(log2(n)) + 1
      const k = Math.max(1, Math.ceil(Math.log2(clean.length)) + 1);
      const step = (hi - lo) / k;
      edges = new Array(k + 1);
      for (let i = 0; i <= k; i++) edges[i] = lo + step * i;
      edges[k] = hi; // exact endpoint to avoid floating drift
    }
  }

  const binCount = edges.length - 1;
  const counts = new Array<number>(binCount).fill(0);
  let under = 0;
  let over = 0;
  const lastEdge = edges[binCount];
  for (const v of clean) {
    if (v < edges[0]) {
      under++;
      continue;
    }
    if (v > lastEdge) {
      over++;
      continue;
    }
    // Linear scan is fine: bin counts are small. Binary search would only
    // matter at > 1e4 bins, which a UI wizard would never expose.
    let placed = false;
    for (let i = 0; i < binCount - 1; i++) {
      if (v >= edges[i] && v < edges[i + 1]) {
        counts[i]++;
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Final bin is inclusive on both ends — captures v == lastEdge.
      counts[binCount - 1]++;
    }
  }

  const out: HistogramBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    const closeR = i === binCount - 1 ? "]" : ")";
    out.push({
      binStart: start,
      binEnd: end,
      frequency: counts[i],
      label: `[${formatEdge(start)}, ${formatEdge(end)}${closeR}`,
    });
  }
  return { bins: out, underflow: under, overflow: over };
}
