// Pure helpers for Excel's "Analysis ToolPak" subset:
//
//   - Linear regression (OLS) with the classical inference suite:
//       slope/intercept, R², F statistic, p-value, standard errors.
//   - One-way ANOVA: between/within sums of squares, F, p-value.
//   - Histogram: frequency table over caller-supplied (or auto-derived) bins.
//
// Follow-up suite (#187 — implemented below the original three):
//   - Two-way ANOVA (Type I SS): main effects + interaction.
//   - t-test: one-sample / two-sample (pooled & Welch) / paired.
//   - Chi-square: goodness-of-fit (1-D) & independence (contingency table).
//   - Correlation matrix: Pearson r and the covariance matrix.
//   - Random-number generation: uniform / normal / Bernoulli / Poisson.
//   - Moving average: simple (window) and exponential (alpha).
//   - Fourier transform: 1-D real FFT → amplitude + phase spectrum.
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

// ===========================================================================
// #187 follow-up — shared distribution helpers
// ===========================================================================
//
// p-values for the t- and chi-square-tests are derived from the same
// regularised special functions used by the F-test above:
//
//   Student-t CDF       F(t; ν) = 1 - ½ I_x(ν/2, ½),  x = ν/(ν+t²)   (t ≥ 0)
//   chi-square upper-tail Q(x; k) = 1 - P(k/2, x/2)   via incomplete gamma
//
// The incomplete-gamma routine is the Numerical Recipes §6.2 pair: a series
// expansion for x < a+1 and a Lentz continued fraction otherwise. Accurate to
// ~1e-12 over the (df, statistic) ranges a spreadsheet analysis pack meets.

/**
 * Two-sided p-value for a Student-t statistic with `df` degrees of freedom.
 * Uses |t| and doubles the upper tail: 2·P(T > |t|).
 */
function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  const at = Math.abs(t);
  // x = df/(df+t²); I_x(df/2, 1/2) = P(T² ≥ t²) = 2·P(T ≥ |t|).
  const x = df / (df + at * at);
  const p = regularizedIncompleteBeta(x, df / 2, 0.5);
  // Clamp tiny FP overshoot.
  return Math.min(1, Math.max(0, p));
}

/**
 * Regularised lower incomplete gamma P(a, x) = γ(a, x) / Γ(a).
 * Series + continued-fraction split per Numerical Recipes §6.2.
 */
function regularizedGammaP(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) {
    return Number.NaN;
  }
  if (x === 0) return 0;
  if (x < a + 1) {
    // Series representation P(a,x) = x^a e^-x Σ ...
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 300; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // Continued fraction for Q(a,x) = 1 - P(a,x).
  const fpmin = 1e-300;
  let b = x + 1 - a;
  let c = 1 / fpmin;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = b + an / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  return 1 - q;
}

/**
 * Upper-tail probability P(χ² > x) for a chi-square distribution with `df`
 * degrees of freedom — the p-value reported by Excel's CHISQ.DIST.RT.
 */
function chiSquareSurvival(x: number, df: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  if (!Number.isFinite(df) || df <= 0) return Number.NaN;
  const p = regularizedGammaP(df / 2, x / 2);
  if (!Number.isFinite(p)) return Number.NaN;
  return Math.min(1, Math.max(0, 1 - p));
}

// ===========================================================================
// Role A — multi-way ANOVA
// ===========================================================================

export interface TwoWayANOVATerm {
  /** Term label: factor-A main effect, factor-B main effect, interaction. */
  source: "factorA" | "factorB" | "interaction" | "error" | "total";
  df: number;
  ss: number;
  ms: number;
  /** F statistic (undefined for error / total rows). */
  f?: number;
  /** Two-sided p-value (undefined for error / total rows). */
  pValue?: number;
}

export interface TwoWayANOVAResult {
  /** Number of factor-A levels. */
  levelsA: number;
  /** Number of factor-B levels. */
  levelsB: number;
  /** Replicates per cell (balanced design assumed). */
  replicates: number;
  /** Total valid observations. */
  totalN: number;
  /** Grand mean of all observations. */
  grandMean: number;
  terms: TwoWayANOVATerm[];
  error?: string;
}

function emptyTwoWayANOVA(error: string): TwoWayANOVAResult {
  return {
    levelsA: 0,
    levelsB: 0,
    replicates: 0,
    totalN: 0,
    grandMean: Number.NaN,
    terms: [],
    error,
  };
}

/**
 * Balanced two-factor ANOVA with replication, Type I (sequential) sums of
 * squares. `cells[i][j]` is the array of replicate observations for level `i`
 * of factor A and level `j` of factor B.
 *
 * The design must be balanced (every cell the same replicate count `r ≥ 1`)
 * — this is what Excel's "Anova: Two-Factor With Replication" tool requires.
 * With `r == 1` the interaction term is not estimable and is folded into the
 * error term (Excel's "Without Replication" behaviour).
 *
 * For a balanced design Type I = Type II = Type III, so the `Type I SS`
 * caveat in the issue only matters for unbalanced data, which is rejected.
 */
export function runTwoWayANOVA(cells: number[][][]): TwoWayANOVAResult {
  if (!Array.isArray(cells) || cells.length < 2) {
    return emptyTwoWayANOVA("二元配置 ANOVA には因子 A の水準が 2 以上必要です");
  }
  const a = cells.length;
  const b = cells[0]?.length ?? 0;
  if (b < 2) {
    return emptyTwoWayANOVA("二元配置 ANOVA には因子 B の水準が 2 以上必要です");
  }
  // Clean every cell and verify the design is balanced.
  const clean: number[][][] = [];
  let replicates = -1;
  for (let i = 0; i < a; i++) {
    if (!Array.isArray(cells[i]) || cells[i].length !== b) {
      return emptyTwoWayANOVA(
        "全ての因子 A 水準で因子 B の水準数が一致している必要があります",
      );
    }
    const rowCells: number[][] = [];
    for (let j = 0; j < b; j++) {
      const filtered: number[] = [];
      for (const v of cells[i][j] ?? []) {
        if (Number.isFinite(v)) filtered.push(v);
      }
      if (filtered.length === 0) {
        return emptyTwoWayANOVA("空のセルがあります (各セルに観測値が必要です)");
      }
      if (replicates === -1) replicates = filtered.length;
      else if (filtered.length !== replicates) {
        return emptyTwoWayANOVA(
          "不釣り合い型データです。各セルの観測数を揃えてください (均衡計画のみ対応)",
        );
      }
      rowCells.push(filtered);
    }
    clean.push(rowCells);
  }
  const r = replicates;
  const totalN = a * b * r;

  // Cell / margin / grand means.
  let grandSum = 0;
  const cellMean: number[][] = [];
  const rowSum = new Array<number>(a).fill(0);
  const colSum = new Array<number>(b).fill(0);
  for (let i = 0; i < a; i++) {
    cellMean.push(new Array<number>(b).fill(0));
    for (let j = 0; j < b; j++) {
      let s = 0;
      for (const v of clean[i][j]) s += v;
      cellMean[i][j] = s / r;
      grandSum += s;
      rowSum[i] += s;
      colSum[j] += s;
    }
  }
  const grandMean = grandSum / totalN;
  const rowMean = rowSum.map((s) => s / (b * r));
  const colMean = colSum.map((s) => s / (a * r));

  // Sums of squares (balanced ⇒ orthogonal decomposition).
  let ssA = 0;
  for (let i = 0; i < a; i++) {
    const d = rowMean[i] - grandMean;
    ssA += b * r * d * d;
  }
  let ssB = 0;
  for (let j = 0; j < b; j++) {
    const d = colMean[j] - grandMean;
    ssB += a * r * d * d;
  }
  let ssCells = 0;
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const d = cellMean[i][j] - grandMean;
      ssCells += r * d * d;
    }
  }
  const ssInteraction = ssCells - ssA - ssB;
  let ssError = 0;
  let ssTotal = 0;
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      for (const v of clean[i][j]) {
        const de = v - cellMean[i][j];
        ssError += de * de;
        const dt = v - grandMean;
        ssTotal += dt * dt;
      }
    }
  }

  const dfA = a - 1;
  const dfB = b - 1;
  const dfAB = dfA * dfB;
  const dfError = a * b * (r - 1);
  const dfTotal = totalN - 1;

  const terms: TwoWayANOVATerm[] = [];
  if (r === 1) {
    // No replication — interaction is confounded with error. Fold it in.
    const dfErr1 = dfAB; // = (a-1)(b-1)
    const msErr = ssInteraction / dfErr1;
    const pushMain = (
      source: TwoWayANOVATerm["source"],
      df: number,
      ss: number,
    ) => {
      const ms = ss / df;
      const f = msErr > 0 ? ms / msErr : Infinity;
      const pValue = msErr > 0 ? fSurvival(f, df, dfErr1) : 0;
      terms.push({ source, df, ss, ms, f, pValue });
    };
    pushMain("factorA", dfA, ssA);
    pushMain("factorB", dfB, ssB);
    terms.push({
      source: "error",
      df: dfErr1,
      ss: ssInteraction,
      ms: msErr,
    });
    terms.push({ source: "total", df: dfTotal, ss: ssTotal, ms: Number.NaN });
    return {
      levelsA: a,
      levelsB: b,
      replicates: r,
      totalN,
      grandMean,
      terms,
    };
  }

  const msError = ssError / dfError;
  const pushTerm = (
    source: TwoWayANOVATerm["source"],
    df: number,
    ss: number,
  ) => {
    const ms = ss / df;
    const f = msError > 0 ? ms / msError : ms > 0 ? Infinity : 0;
    const pValue = msError > 0 ? fSurvival(f, df, dfError) : ms > 0 ? 0 : 1;
    terms.push({ source, df, ss, ms, f, pValue });
  };
  pushTerm("factorA", dfA, ssA);
  pushTerm("factorB", dfB, ssB);
  pushTerm("interaction", dfAB, ssInteraction);
  terms.push({ source: "error", df: dfError, ss: ssError, ms: msError });
  terms.push({ source: "total", df: dfTotal, ss: ssTotal, ms: Number.NaN });

  return { levelsA: a, levelsB: b, replicates: r, totalN, grandMean, terms };
}

// ===========================================================================
// Role A — t-test
// ===========================================================================

export type TTestKind = "oneSample" | "twoSamplePooled" | "welch" | "paired";

export interface TTestResult {
  kind: TTestKind;
  /** Mean of sample 1 (and the only sample for a one-sample test). */
  mean1: number;
  /** Mean of sample 2 (NaN for one-sample). */
  mean2: number;
  /** Difference of means tested (sample1 - sample2, or sample1 - μ₀). */
  meanDiff: number;
  /** Hypothesised mean (one-sample) or hypothesised difference (two-sample). */
  hypothesizedMean: number;
  n1: number;
  n2: number;
  /** Pooled / Welch / paired standard error of the tested difference. */
  standardError: number;
  /** t statistic. */
  t: number;
  /** Degrees of freedom (Welch's df is fractional). */
  df: number;
  /** Two-sided p-value. */
  pValueTwoSided: number;
  /** One-sided p-value (upper tail of |t| direction). */
  pValueOneSided: number;
  error?: string;
}

function emptyTTest(kind: TTestKind, error: string): TTestResult {
  return {
    kind,
    mean1: Number.NaN,
    mean2: Number.NaN,
    meanDiff: Number.NaN,
    hypothesizedMean: Number.NaN,
    n1: 0,
    n2: 0,
    standardError: Number.NaN,
    t: Number.NaN,
    df: Number.NaN,
    pValueTwoSided: Number.NaN,
    pValueOneSided: Number.NaN,
    error,
  };
}

function meanVar(xs: number[]): { n: number; mean: number; variance: number } {
  const n = xs.length;
  let s = 0;
  for (const v of xs) s += v;
  const mean = s / n;
  let sq = 0;
  for (const v of xs) {
    const d = v - mean;
    sq += d * d;
  }
  return { n, mean, variance: n > 1 ? sq / (n - 1) : 0 };
}

/**
 * Student / Welch t-test.
 *
 *   - `oneSample`: tests sample1's mean against `hypothesizedMean` (μ₀).
 *   - `twoSamplePooled`: equal-variance two-sample test (pooled SD).
 *   - `welch`: unequal-variance two-sample test (Welch–Satterthwaite df).
 *   - `paired`: paired test on the per-row differences (sample1 - sample2).
 *
 * `hypothesizedMean` defaults to 0 and, for the two-sample variants, is the
 * hypothesised difference of means (Excel's "Hypothesized Mean Difference").
 * Non-finite values are dropped (pair-wise for the paired test).
 */
export function runTTest(
  sample1: number[],
  sample2: number[],
  kind: TTestKind,
  hypothesizedMean = 0,
): TTestResult {
  if (!Array.isArray(sample1)) return emptyTTest(kind, "入力配列が不正です");
  const h = Number.isFinite(hypothesizedMean) ? hypothesizedMean : 0;

  if (kind === "oneSample") {
    const xs = sample1.filter((v) => Number.isFinite(v));
    if (xs.length < 2) {
      return emptyTTest(kind, "1 標本 t 検定には数値が 2 個以上必要です");
    }
    const { n, mean, variance } = meanVar(xs);
    if (variance <= 0) {
      return emptyTTest(kind, "標本の分散がゼロです。t 統計を計算できません");
    }
    const se = Math.sqrt(variance / n);
    const t = (mean - h) / se;
    const df = n - 1;
    const p2 = tTwoSidedP(t, df);
    return {
      kind,
      mean1: mean,
      mean2: Number.NaN,
      meanDiff: mean - h,
      hypothesizedMean: h,
      n1: n,
      n2: 0,
      standardError: se,
      t,
      df,
      pValueTwoSided: p2,
      pValueOneSided: p2 / 2,
    };
  }

  if (!Array.isArray(sample2)) return emptyTTest(kind, "2 つ目の標本が不正です");

  if (kind === "paired") {
    if (sample1.length !== sample2.length) {
      return emptyTTest(
        kind,
        `対応あり t 検定には同数の標本が必要です (${sample1.length} vs ${sample2.length})`,
      );
    }
    const diffs: number[] = [];
    for (let i = 0; i < sample1.length; i++) {
      const d = sample1[i] - sample2[i];
      if (Number.isFinite(d)) diffs.push(d);
    }
    if (diffs.length < 2) {
      return emptyTTest(kind, "対応あり t 検定には有効なペアが 2 組以上必要です");
    }
    const { n, mean, variance } = meanVar(diffs);
    if (variance <= 0) {
      return emptyTTest(kind, "差の分散がゼロです。t 統計を計算できません");
    }
    const se = Math.sqrt(variance / n);
    const t = (mean - h) / se;
    const df = n - 1;
    const p2 = tTwoSidedP(t, df);
    // mean1/mean2 are the per-sample means for the result table.
    const m1 = meanVar(sample1.filter((v) => Number.isFinite(v))).mean;
    const m2 = meanVar(sample2.filter((v) => Number.isFinite(v))).mean;
    return {
      kind,
      mean1: m1,
      mean2: m2,
      meanDiff: mean,
      hypothesizedMean: h,
      n1: n,
      n2: n,
      standardError: se,
      t,
      df,
      pValueTwoSided: p2,
      pValueOneSided: p2 / 2,
    };
  }

  // Two-sample (pooled or Welch).
  const xs1 = sample1.filter((v) => Number.isFinite(v));
  const xs2 = sample2.filter((v) => Number.isFinite(v));
  if (xs1.length < 2 || xs2.length < 2) {
    return emptyTTest(kind, "2 標本 t 検定には各標本に数値が 2 個以上必要です");
  }
  const s1 = meanVar(xs1);
  const s2 = meanVar(xs2);
  if (s1.variance <= 0 && s2.variance <= 0) {
    return emptyTTest(kind, "両標本の分散がゼロです。t 統計を計算できません");
  }
  const diffMeans = s1.mean - s2.mean;

  if (kind === "twoSamplePooled") {
    const dfPooled = s1.n + s2.n - 2;
    const pooledVar =
      ((s1.n - 1) * s1.variance + (s2.n - 1) * s2.variance) / dfPooled;
    const se = Math.sqrt(pooledVar * (1 / s1.n + 1 / s2.n));
    if (!(se > 0)) {
      return emptyTTest(kind, "プール標準誤差がゼロです。t 統計を計算できません");
    }
    const t = (diffMeans - h) / se;
    const p2 = tTwoSidedP(t, dfPooled);
    return {
      kind,
      mean1: s1.mean,
      mean2: s2.mean,
      meanDiff: diffMeans,
      hypothesizedMean: h,
      n1: s1.n,
      n2: s2.n,
      standardError: se,
      t,
      df: dfPooled,
      pValueTwoSided: p2,
      pValueOneSided: p2 / 2,
    };
  }

  // Welch
  const v1n = s1.variance / s1.n;
  const v2n = s2.variance / s2.n;
  const se = Math.sqrt(v1n + v2n);
  if (!(se > 0)) {
    return emptyTTest(kind, "Welch 標準誤差がゼロです。t 統計を計算できません");
  }
  const t = (diffMeans - h) / se;
  // Welch–Satterthwaite degrees of freedom.
  const df =
    (v1n + v2n) ** 2 /
    (v1n ** 2 / (s1.n - 1) + v2n ** 2 / (s2.n - 1));
  const p2 = tTwoSidedP(t, df);
  return {
    kind,
    mean1: s1.mean,
    mean2: s2.mean,
    meanDiff: diffMeans,
    hypothesizedMean: h,
    n1: s1.n,
    n2: s2.n,
    standardError: se,
    t,
    df,
    pValueTwoSided: p2,
    pValueOneSided: p2 / 2,
  };
}

// ===========================================================================
// Role A — chi-square test
// ===========================================================================

export interface ChiSquareResult {
  mode: "goodnessOfFit" | "independence";
  /** χ² statistic Σ (O - E)² / E. */
  chiSquare: number;
  df: number;
  /** Upper-tail p-value P(χ² > statistic). */
  pValue: number;
  /** Expected counts, same shape as the observed input (row-major). */
  expected: number[][];
  /** Row totals (independence) — single element for goodness-of-fit. */
  rowTotals: number[];
  /** Column totals (independence) — observed table for goodness-of-fit. */
  colTotals: number[];
  /** Grand total of all observed counts. */
  total: number;
  error?: string;
}

function emptyChiSquare(
  mode: ChiSquareResult["mode"],
  error: string,
): ChiSquareResult {
  return {
    mode,
    chiSquare: Number.NaN,
    df: 0,
    pValue: Number.NaN,
    expected: [],
    rowTotals: [],
    colTotals: [],
    total: 0,
    error,
  };
}

/**
 * Chi-square goodness-of-fit test for a 1-D vector of observed counts against
 * expected counts. If `expected` is omitted (or empty) a uniform distribution
 * is assumed. If `expected` is supplied as proportions / unnormalised weights
 * it is rescaled to the observed total.
 *
 * df = (categories - 1). Requires every expected count > 0.
 */
export function runChiSquareGoodnessOfFit(
  observed: number[],
  expected?: number[],
): ChiSquareResult {
  if (!Array.isArray(observed) || observed.length < 2) {
    return emptyChiSquare(
      "goodnessOfFit",
      "適合度検定にはカテゴリが 2 つ以上必要です",
    );
  }
  const obs = observed.map((v) => (Number.isFinite(v) ? v : Number.NaN));
  if (obs.some((v) => !Number.isFinite(v) || v < 0)) {
    return emptyChiSquare(
      "goodnessOfFit",
      "観測度数は非負の数値で指定してください",
    );
  }
  const total = obs.reduce((s, v) => s + v, 0);
  if (total <= 0) {
    return emptyChiSquare("goodnessOfFit", "観測度数の合計がゼロです");
  }

  let expCounts: number[];
  if (Array.isArray(expected) && expected.length > 0) {
    if (expected.length !== obs.length) {
      return emptyChiSquare(
        "goodnessOfFit",
        `期待度数の要素数 (${expected.length}) が観測度数 (${obs.length}) と一致しません`,
      );
    }
    if (expected.some((v) => !Number.isFinite(v) || v < 0)) {
      return emptyChiSquare(
        "goodnessOfFit",
        "期待度数は非負の数値で指定してください",
      );
    }
    const expSum = expected.reduce((s, v) => s + v, 0);
    if (expSum <= 0) {
      return emptyChiSquare("goodnessOfFit", "期待度数の合計がゼロです");
    }
    // Rescale to the observed total so callers may pass proportions.
    expCounts = expected.map((v) => (v / expSum) * total);
  } else {
    const uniform = total / obs.length;
    expCounts = new Array<number>(obs.length).fill(uniform);
  }
  if (expCounts.some((e) => e <= 0)) {
    return emptyChiSquare(
      "goodnessOfFit",
      "期待度数に 0 が含まれます。χ² 統計を計算できません",
    );
  }

  let chi = 0;
  for (let i = 0; i < obs.length; i++) {
    const d = obs[i] - expCounts[i];
    chi += (d * d) / expCounts[i];
  }
  const df = obs.length - 1;
  return {
    mode: "goodnessOfFit",
    chiSquare: chi,
    df,
    pValue: chiSquareSurvival(chi, df),
    expected: [expCounts],
    rowTotals: [total],
    colTotals: obs.slice(),
    total,
  };
}

/**
 * Chi-square test of independence on an r×c contingency table of observed
 * counts. Expected counts are rowTotal·colTotal / grandTotal; df = (r-1)(c-1).
 */
export function runChiSquareIndependence(
  table: number[][],
): ChiSquareResult {
  if (!Array.isArray(table) || table.length < 2) {
    return emptyChiSquare(
      "independence",
      "独立性検定には行が 2 つ以上必要です",
    );
  }
  const cols = table[0]?.length ?? 0;
  if (cols < 2) {
    return emptyChiSquare(
      "independence",
      "独立性検定には列が 2 つ以上必要です",
    );
  }
  for (const row of table) {
    if (!Array.isArray(row) || row.length !== cols) {
      return emptyChiSquare(
        "independence",
        "分割表の各行の列数を揃えてください",
      );
    }
    if (row.some((v) => !Number.isFinite(v) || v < 0)) {
      return emptyChiSquare(
        "independence",
        "観測度数は非負の数値で指定してください",
      );
    }
  }
  const rows = table.length;
  const rowTotals = table.map((r) => r.reduce((s, v) => s + v, 0));
  const colTotals = new Array<number>(cols).fill(0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) colTotals[j] += table[i][j];
  }
  const total = rowTotals.reduce((s, v) => s + v, 0);
  if (total <= 0) {
    return emptyChiSquare("independence", "分割表の合計がゼロです");
  }
  if (rowTotals.some((t) => t === 0) || colTotals.some((t) => t === 0)) {
    return emptyChiSquare(
      "independence",
      "合計が 0 の行または列があります。期待度数を計算できません",
    );
  }

  const expected: number[][] = [];
  let chi = 0;
  for (let i = 0; i < rows; i++) {
    const expRow: number[] = [];
    for (let j = 0; j < cols; j++) {
      const e = (rowTotals[i] * colTotals[j]) / total;
      expRow.push(e);
      const d = table[i][j] - e;
      chi += (d * d) / e;
    }
    expected.push(expRow);
  }
  const df = (rows - 1) * (cols - 1);
  return {
    mode: "independence",
    chiSquare: chi,
    df,
    pValue: chiSquareSurvival(chi, df),
    expected,
    rowTotals,
    colTotals,
    total,
  };
}

// ===========================================================================
// Role B — correlation matrix
// ===========================================================================

export interface CorrelationResult {
  /** Caller-supplied labels for each variable / column. */
  labels: string[];
  /** Number of complete-case rows used (rows with all variables finite). */
  n: number;
  /** Per-variable mean over the complete-case rows. */
  means: number[];
  /** Symmetric Pearson correlation matrix (diagonal = 1). */
  correlation: number[][];
  /** Symmetric sample covariance matrix (n-1 denominator). */
  covariance: number[][];
  error?: string;
}

function emptyCorrelation(error: string): CorrelationResult {
  return {
    labels: [],
    n: 0,
    means: [],
    correlation: [],
    covariance: [],
    error,
  };
}

/**
 * Pearson correlation + sample covariance matrices for `columns` — each entry
 * is one variable's observations. Excel's "Correlation" / "Covariance" tools.
 *
 * Uses complete-case (listwise) deletion: a row contributing a non-finite
 * value in any column is dropped from every column, so the matrix is computed
 * on a consistent set of observations. The covariance uses the sample
 * (n-1) denominator, matching Excel's COVARIANCE.S.
 */
export function runCorrelationMatrix(
  columns: number[][],
  labels?: string[],
): CorrelationResult {
  if (!Array.isArray(columns) || columns.length < 2) {
    return emptyCorrelation("相関行列には変数 (列) が 2 つ以上必要です");
  }
  const k = columns.length;
  const len = columns[0]?.length ?? 0;
  for (const c of columns) {
    if (!Array.isArray(c) || c.length !== len) {
      return emptyCorrelation(
        "全ての変数の観測数を揃えてください (列の長さが不一致)",
      );
    }
  }
  // Listwise deletion.
  const rows: number[][] = [];
  for (let i = 0; i < len; i++) {
    let ok = true;
    const row = new Array<number>(k);
    for (let j = 0; j < k; j++) {
      const v = columns[j][i];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      row[j] = v;
    }
    if (ok) rows.push(row);
  }
  const n = rows.length;
  if (n < 2) {
    return emptyCorrelation(
      "相関を計算するには有効な完全ケースが 2 行以上必要です",
    );
  }

  const means = new Array<number>(k).fill(0);
  for (const row of rows) {
    for (let j = 0; j < k; j++) means[j] += row[j];
  }
  for (let j = 0; j < k; j++) means[j] /= n;

  // Sample covariance (n-1).
  const covariance: number[][] = [];
  for (let a = 0; a < k; a++) covariance.push(new Array<number>(k).fill(0));
  for (const row of rows) {
    for (let a = 0; a < k; a++) {
      const da = row[a] - means[a];
      for (let b = a; b < k; b++) {
        covariance[a][b] += da * (row[b] - means[b]);
      }
    }
  }
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      const cv = covariance[a][b] / (n - 1);
      covariance[a][b] = cv;
      covariance[b][a] = cv;
    }
  }

  // Pearson correlation from the covariance matrix.
  const correlation: number[][] = [];
  for (let a = 0; a < k; a++) correlation.push(new Array<number>(k).fill(0));
  for (let a = 0; a < k; a++) {
    const sa = Math.sqrt(covariance[a][a]);
    for (let b = a; b < k; b++) {
      const sb = Math.sqrt(covariance[b][b]);
      let r: number;
      if (a === b) {
        // Diagonal is 1 unless the variable is constant (variance 0).
        r = sa > 0 ? 1 : Number.NaN;
      } else if (sa > 0 && sb > 0) {
        r = covariance[a][b] / (sa * sb);
        // Clamp FP drift outside [-1, 1].
        r = Math.min(1, Math.max(-1, r));
      } else {
        r = Number.NaN;
      }
      correlation[a][b] = r;
      correlation[b][a] = r;
    }
  }

  const finalLabels =
    Array.isArray(labels) && labels.length === k
      ? labels.slice()
      : columns.map((_, i) => `変数 ${i + 1}`);

  return { labels: finalLabels, n, means, correlation, covariance };
}

// ===========================================================================
// Role C — random-number generation
// ===========================================================================

export type RandomDistribution =
  | "uniform"
  | "normal"
  | "bernoulli"
  | "poisson";

export interface RandomGenParams {
  distribution: RandomDistribution;
  /** Number of values to generate (> 0). */
  count: number;
  /** Optional integer seed for reproducibility. */
  seed?: number;
  /** uniform: inclusive lower bound. */
  min?: number;
  /** uniform: upper bound. */
  max?: number;
  /** normal: mean. */
  mean?: number;
  /** normal: standard deviation (> 0). */
  stdDev?: number;
  /** bernoulli: success probability ∈ [0, 1]. */
  probability?: number;
  /** poisson: rate λ (> 0). */
  lambda?: number;
}

export interface RandomGenResult {
  distribution: RandomDistribution;
  values: number[];
  error?: string;
}

/**
 * Deterministic PRNG — mulberry32. A 32-bit state generator: fast, good
 * enough for analysis-pack sampling, and trivially seedable for reproducible
 * tests. Returns a closure producing uniforms in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a sequence of pseudo-random numbers from the requested
 * distribution. A fixed `seed` makes the sequence reproducible.
 *
 *   - uniform   : continuous on [min, max).
 *   - normal    : Box–Muller transform with the given mean / stdDev.
 *   - bernoulli : 0/1 with success probability `probability`.
 *   - poisson   : non-negative integers via Knuth's algorithm (rate λ).
 */
export function generateRandomNumbers(
  params: RandomGenParams,
): RandomGenResult {
  const { distribution } = params;
  const count = Math.floor(params.count);
  if (!Number.isFinite(count) || count <= 0) {
    return { distribution, values: [], error: "生成個数は 1 以上で指定してください" };
  }
  if (count > 1_000_000) {
    return {
      distribution,
      values: [],
      error: "生成個数が大きすぎます (上限 1,000,000)",
    };
  }
  // Default seed derives from the clock when none is supplied.
  const seed = Number.isFinite(params.seed)
    ? (params.seed as number) >>> 0
    : (Date.now() >>> 0);
  const rng = mulberry32(seed);
  const values: number[] = new Array(count);

  if (distribution === "uniform") {
    const min = Number.isFinite(params.min) ? (params.min as number) : 0;
    const max = Number.isFinite(params.max) ? (params.max as number) : 1;
    if (max <= min) {
      return {
        distribution,
        values: [],
        error: "一様分布: 最大値は最小値より大きくしてください",
      };
    }
    for (let i = 0; i < count; i++) values[i] = min + rng() * (max - min);
    return { distribution, values };
  }

  if (distribution === "normal") {
    const mean = Number.isFinite(params.mean) ? (params.mean as number) : 0;
    const sd = Number.isFinite(params.stdDev) ? (params.stdDev as number) : 1;
    if (!(sd > 0)) {
      return {
        distribution,
        values: [],
        error: "正規分布: 標準偏差は正の値で指定してください",
      };
    }
    // Box–Muller — two uniforms → two independent standard normals.
    for (let i = 0; i < count; i += 2) {
      let u1 = rng();
      const u2 = rng();
      if (u1 < 1e-300) u1 = 1e-300; // guard log(0)
      const r = Math.sqrt(-2 * Math.log(u1));
      const z0 = r * Math.cos(2 * Math.PI * u2);
      const z1 = r * Math.sin(2 * Math.PI * u2);
      values[i] = mean + sd * z0;
      if (i + 1 < count) values[i + 1] = mean + sd * z1;
    }
    return { distribution, values };
  }

  if (distribution === "bernoulli") {
    const p = Number.isFinite(params.probability)
      ? (params.probability as number)
      : 0.5;
    if (p < 0 || p > 1) {
      return {
        distribution,
        values: [],
        error: "ベルヌーイ分布: 成功確率は 0〜1 で指定してください",
      };
    }
    for (let i = 0; i < count; i++) values[i] = rng() < p ? 1 : 0;
    return { distribution, values };
  }

  // poisson — Knuth's multiplicative algorithm.
  const lambda = Number.isFinite(params.lambda)
    ? (params.lambda as number)
    : 1;
  if (!(lambda > 0)) {
    return {
      distribution,
      values: [],
      error: "ポアソン分布: λ は正の値で指定してください",
    };
  }
  const L = Math.exp(-lambda);
  for (let i = 0; i < count; i++) {
    let k = 0;
    let prod = 1;
    // Knuth: multiply uniforms until the running product drops below e^-λ.
    // For large λ this loop is O(λ); analysis-pack λ stays modest.
    do {
      k += 1;
      prod *= rng();
    } while (prod > L);
    values[i] = k - 1;
  }
  return { distribution, values };
}

// ===========================================================================
// Role B — moving average
// ===========================================================================

export interface MovingAverageResult {
  kind: "simple" | "exponential";
  /** Window width (simple) or NaN for exponential. */
  window: number;
  /** Smoothing factor α (exponential) or NaN for simple. */
  alpha: number;
  /**
   * Smoothed series, same length as the (cleaned) input. Leading positions
   * with insufficient history for a simple average hold NaN.
   */
  values: number[];
  error?: string;
}

function emptyMovingAverage(
  kind: MovingAverageResult["kind"],
  error: string,
): MovingAverageResult {
  return { kind, window: Number.NaN, alpha: Number.NaN, values: [], error };
}

/**
 * Simple moving average with a trailing window of `window` observations.
 * Position `i` averages data[i-window+1 .. i]; the first `window-1`
 * positions have no full window and hold NaN (Excel's behaviour).
 *
 * Non-finite values are rejected up front rather than silently dropped —
 * a moving average is order-sensitive so gaps would distort the window.
 */
export function runSimpleMovingAverage(
  data: number[],
  window: number,
): MovingAverageResult {
  if (!Array.isArray(data) || data.length === 0) {
    return emptyMovingAverage("simple", "移動平均の対象データがありません");
  }
  if (data.some((v) => !Number.isFinite(v))) {
    return emptyMovingAverage(
      "simple",
      "移動平均の入力に数値以外が含まれています",
    );
  }
  const w = Math.floor(window);
  if (!Number.isFinite(w) || w < 1) {
    return emptyMovingAverage("simple", "窓幅は 1 以上の整数で指定してください");
  }
  if (w > data.length) {
    return emptyMovingAverage(
      "simple",
      `窓幅 (${w}) がデータ点数 (${data.length}) を超えています`,
    );
  }
  const out = new Array<number>(data.length).fill(Number.NaN);
  let runningSum = 0;
  for (let i = 0; i < data.length; i++) {
    runningSum += data[i];
    if (i >= w) runningSum -= data[i - w];
    if (i >= w - 1) out[i] = runningSum / w;
  }
  return { kind: "simple", window: w, alpha: Number.NaN, values: out };
}

/**
 * Exponential moving average with smoothing factor α ∈ (0, 1].
 *   EMA₀ = data₀
 *   EMAᵢ = α·dataᵢ + (1-α)·EMAᵢ₋₁
 * A larger α weights recent observations more heavily.
 */
export function runExponentialMovingAverage(
  data: number[],
  alpha: number,
): MovingAverageResult {
  if (!Array.isArray(data) || data.length === 0) {
    return emptyMovingAverage(
      "exponential",
      "指数移動平均の対象データがありません",
    );
  }
  if (data.some((v) => !Number.isFinite(v))) {
    return emptyMovingAverage(
      "exponential",
      "指数移動平均の入力に数値以外が含まれています",
    );
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    return emptyMovingAverage(
      "exponential",
      "平滑化係数 α は 0 < α ≤ 1 の範囲で指定してください",
    );
  }
  const out = new Array<number>(data.length);
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = alpha * data[i] + (1 - alpha) * out[i - 1];
  }
  return { kind: "exponential", window: Number.NaN, alpha, values: out };
}

// ===========================================================================
// Role B — Fourier transform
// ===========================================================================

export interface FourierResult {
  /** Number of input samples actually transformed. */
  n: number;
  /** Real part of the spectrum, length n. */
  real: number[];
  /** Imaginary part of the spectrum, length n. */
  imag: number[];
  /** Magnitude |X_k| = sqrt(re²+im²), length n. */
  amplitude: number[];
  /** Phase atan2(im, re) in radians, length n. */
  phase: number[];
  /** Algorithm used — radix-2 Cooley-Tukey or Bluestein for non-2-power n. */
  method: "radix2" | "bluestein";
  error?: string;
}

function emptyFourier(error: string): FourierResult {
  return {
    n: 0,
    real: [],
    imag: [],
    amplitude: [],
    phase: [],
    method: "radix2",
    error,
  };
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must have a length
 * that is an exact power of two. `sign` is -1 for the forward transform.
 */
function fftRadix2(re: number[], im: number[], sign: number): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly stages.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Bluestein's chirp-z algorithm — an O(n log n) DFT for arbitrary (non-power
 * of two) lengths. It expresses the DFT as a convolution evaluated via a
 * padded radix-2 FFT.
 */
function fftBluestein(reIn: number[], imIn: number[], sign: number): void {
  const n = reIn.length;
  // Smallest power of two ≥ 2n-1 for the convolution.
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;

  // Chirp a_k = exp(sign·i·π·k²/n).
  const cosT = new Array<number>(n);
  const sinT = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    // (k² mod 2n) keeps the angle accurate for large k.
    const j = (k * k) % (2 * n);
    const ang = (sign * Math.PI * j) / n;
    cosT[k] = Math.cos(ang);
    sinT[k] = Math.sin(ang);
  }

  // a_k = x_k · chirp_k
  const aRe = new Array<number>(m).fill(0);
  const aIm = new Array<number>(m).fill(0);
  for (let k = 0; k < n; k++) {
    aRe[k] = reIn[k] * cosT[k] - imIn[k] * sinT[k];
    aIm[k] = reIn[k] * sinT[k] + imIn[k] * cosT[k];
  }
  // b_k = conj(chirp_k), defined for -(n-1)..(n-1) and wrapped into [0, m).
  const bRe = new Array<number>(m).fill(0);
  const bIm = new Array<number>(m).fill(0);
  bRe[0] = cosT[0];
  bIm[0] = -sinT[0];
  for (let k = 1; k < n; k++) {
    bRe[k] = cosT[k];
    bIm[k] = -sinT[k];
    bRe[m - k] = cosT[k];
    bIm[m - k] = -sinT[k];
  }

  // Convolution via FFT: c = IFFT(FFT(a)·FFT(b)).
  fftRadix2(aRe, aIm, -1);
  fftRadix2(bRe, bIm, -1);
  const cRe = new Array<number>(m);
  const cIm = new Array<number>(m);
  for (let k = 0; k < m; k++) {
    cRe[k] = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    cIm[k] = aRe[k] * bIm[k] + aIm[k] * bRe[k];
  }
  fftRadix2(cRe, cIm, 1);
  for (let k = 0; k < m; k++) {
    cRe[k] /= m;
    cIm[k] /= m;
  }

  // X_k = chirp_k · c_k
  for (let k = 0; k < n; k++) {
    reIn[k] = cRe[k] * cosT[k] - cIm[k] * sinT[k];
    imIn[k] = cRe[k] * sinT[k] + cIm[k] * cosT[k];
  }
}

/**
 * Forward 1-D discrete Fourier transform of a real-valued signal.
 *
 * Picks radix-2 Cooley-Tukey when the length is an exact power of two,
 * otherwise Bluestein's chirp-z algorithm — both O(n log n), so non-power-of-
 * two inputs incur no accuracy penalty (only a constant-factor slowdown from
 * the padded convolution). The result is the full complex spectrum plus its
 * amplitude (|X_k|) and phase (atan2) for every frequency bin.
 *
 * Round-trip accuracy is ~1e-9 relative for n up to ~2^16; for typical
 * spreadsheet sample counts the error is far below display precision.
 */
export function runFourierTransform(signal: number[]): FourierResult {
  if (!Array.isArray(signal) || signal.length === 0) {
    return emptyFourier("フーリエ変換の対象データがありません");
  }
  if (signal.some((v) => !Number.isFinite(v))) {
    return emptyFourier("フーリエ変換の入力に数値以外が含まれています");
  }
  const n = signal.length;
  const re = signal.slice();
  const im = new Array<number>(n).fill(0);

  const isPow2 = (n & (n - 1)) === 0;
  if (isPow2) {
    fftRadix2(re, im, -1);
  } else {
    fftBluestein(re, im, -1);
  }

  const amplitude = new Array<number>(n);
  const phase = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    amplitude[k] = Math.hypot(re[k], im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return {
    n,
    real: re,
    imag: im,
    amplitude,
    phase,
    method: isPow2 ? "radix2" : "bluestein",
  };
}
