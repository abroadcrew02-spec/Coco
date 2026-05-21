import { describe, it, expect } from "vitest";
import {
  runLinearRegression,
  runOneWayANOVA,
  buildHistogram,
  runTwoWayANOVA,
  runTTest,
  runChiSquareGoodnessOfFit,
  runChiSquareIndependence,
  runCorrelationMatrix,
  generateRandomNumbers,
  runSimpleMovingAverage,
  runExponentialMovingAverage,
  runFourierTransform,
} from "../analysisToolpak";

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

describe("runLinearRegression", () => {
  it("fits a perfect line: ŷ = 2x + 1 → slope=2, intercept=1, R²=1, p≈0", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [3, 5, 7, 9, 11];
    const r = runLinearRegression(x, y);
    expect(r.error).toBeUndefined();
    expect(r.n).toBe(5);
    expect(r.slope).toBeCloseTo(2, 12);
    expect(r.intercept).toBeCloseTo(1, 12);
    expect(r.r2).toBeCloseTo(1, 12);
    expect(r.sse).toBeCloseTo(0, 10);
    expect(r.residualSE).toBeCloseTo(0, 10);
    // SST = Σ(y - ȳ)² = (-4)² + (-2)² + 0 + 2² + 4² = 40
    expect(r.sst).toBeCloseTo(40, 10);
    // F is infinite (SSE = 0); p must be 0 by the helper's convention.
    expect(r.pValue).toBe(0);
  });

  it("matches hand-computed OLS on a noisy 5-point dataset", () => {
    // Hand-derived from the same data Excel / R would see:
    //   x = (1,2,3,4,5), y = (2.1, 4.0, 6.1, 7.9, 10.2)
    //   x̄=3, ȳ=6.06, Sxx=10, Sxy=20.1
    //   slope = 2.01, intercept = 0.03
    //   SSE = 0.051, SST = 40.452, R² ≈ 0.99874
    //   residual SE = sqrt(0.051/3) ≈ 0.1304
    //   F = (SSR/1) / (SSE/3) = 40.401 / 0.017 ≈ 2376
    const x = [1, 2, 3, 4, 5];
    const y = [2.1, 4.0, 6.1, 7.9, 10.2];
    const r = runLinearRegression(x, y);
    expect(r.error).toBeUndefined();
    expect(r.slope).toBeCloseTo(2.01, 6);
    expect(r.intercept).toBeCloseTo(0.03, 6);
    expect(r.r2).toBeCloseTo(0.99874, 3);
    expect(r.residualSE).toBeCloseTo(0.1304, 3);
    expect(r.f).toBeGreaterThan(2000);
    expect(r.f).toBeLessThan(3000);
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(1e-4);
  });

  it("rejects degenerate input: constant X (zero variance)", () => {
    const r = runLinearRegression([2, 2, 2, 2], [1, 2, 3, 4]);
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/分散がゼロ|定数|線形依存/);
  });

  it("rejects too-few-pairs", () => {
    const r = runLinearRegression([1, 2], [1, 2]);
    expect(r.error).toBeDefined();
  });

  it("rejects mismatched lengths", () => {
    const r = runLinearRegression([1, 2, 3], [1, 2]);
    expect(r.error).toMatch(/一致しません/);
  });

  it("drops non-finite pairs silently", () => {
    const x = [1, 2, Number.NaN, 4, 5];
    const y = [3, 5, 99, 9, 11];
    const r = runLinearRegression(x, y);
    expect(r.error).toBeUndefined();
    // Surviving pairs are the perfect line ŷ = 2x + 1.
    expect(r.n).toBe(4);
    expect(r.slope).toBeCloseTo(2, 12);
    expect(r.intercept).toBeCloseTo(1, 12);
  });
});

// ---------------------------------------------------------------------------
// One-way ANOVA
// ---------------------------------------------------------------------------

describe("runOneWayANOVA", () => {
  it("matches hand-computed ANOVA on a 3-group dataset", () => {
    // Equivalent to:
    //   > g1 <- c(6,8,4,5,3); g2 <- c(8,12,9,11,6); g3 <- c(13,9,11,8,7)
    //   > summary(aov(c(g1,g2,g3) ~ factor(rep(1:3, each=5))))
    // Hand-derived:
    //   means: 5.2, 9.2, 9.6  / grand mean: 8.0
    //   SSB = 5 * ((5.2-8)² + (9.2-8)² + (9.6-8)²) = 59.2
    //   SSW = 14.8 + 22.8 + 23.2 = 60.8
    //   MSB = 29.6, MSW = 5.0667, F ≈ 5.8421
    const g1 = [6, 8, 4, 5, 3];
    const g2 = [8, 12, 9, 11, 6];
    const g3 = [13, 9, 11, 8, 7];
    const r = runOneWayANOVA([g1, g2, g3]);
    expect(r.error).toBeUndefined();
    expect(r.groupCount).toBe(3);
    expect(r.totalN).toBe(15);
    expect(r.dfBetween).toBe(2);
    expect(r.dfWithin).toBe(12);
    expect(r.ssBetween).toBeCloseTo(59.2, 6);
    expect(r.ssWithin).toBeCloseTo(60.8, 6);
    expect(r.msBetween).toBeCloseTo(29.6, 6);
    expect(r.msWithin).toBeCloseTo(60.8 / 12, 6);
    expect(r.f).toBeCloseTo(5.8421, 3);
    // p-value for F(2,12) at 5.8421 is approximately 0.0168
    expect(r.pValue).toBeGreaterThan(0.01);
    expect(r.pValue).toBeLessThan(0.025);
  });

  it("F = 0 when all group means are equal", () => {
    const r = runOneWayANOVA([
      [1, 2, 3],
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.ssBetween).toBeCloseTo(0, 10);
    expect(r.f).toBeCloseTo(0, 10);
    expect(r.pValue).toBeCloseTo(1, 5);
  });

  it("rejects a single group (need ≥ 2)", () => {
    const r = runOneWayANOVA([[1, 2, 3]]);
    expect(r.error).toMatch(/少なくとも 2 群/);
  });

  it("rejects when every group has only one observation (df_within = 0)", () => {
    const r = runOneWayANOVA([[1], [2], [3]]);
    expect(r.error).toMatch(/自由度が不足/);
  });

  it("drops non-finite entries inside a group", () => {
    const r = runOneWayANOVA([
      [1, 2, Number.NaN, 3],
      [4, 5, 6, Number.POSITIVE_INFINITY],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.groups[0].n).toBe(3);
    expect(r.groups[1].n).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

describe("buildHistogram", () => {
  it("counts observations using inclusive-left, exclusive-right bins (last bin inclusive)", () => {
    const data = [0, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const bins = [0, 1, 2, 3, 4];
    const r = buildHistogram(data, bins);
    expect(r.error).toBeUndefined();
    expect(r.bins).toHaveLength(4);
    // [0, 1): 0 → 1 obs
    expect(r.bins[0].frequency).toBe(1);
    // [1, 2): 1, 1.5 → 2 obs
    expect(r.bins[1].frequency).toBe(2);
    // [2, 3): 2, 2.5 → 2 obs
    expect(r.bins[2].frequency).toBe(2);
    // [3, 4]: 3, 3.5, 4 → 3 obs (last bin inclusive)
    expect(r.bins[3].frequency).toBe(3);
    expect(r.underflow).toBe(0);
    expect(r.overflow).toBe(0);
  });

  it("counts under/overflow for out-of-range values", () => {
    const r = buildHistogram([-5, 0, 5, 10, 15, 20, 25], [0, 10, 20]);
    expect(r.error).toBeUndefined();
    expect(r.underflow).toBe(1); // -5
    expect(r.overflow).toBe(1); // 25
    // [0, 10): 0, 5 → 2
    expect(r.bins[0].frequency).toBe(2);
    // [10, 20]: 10, 15, 20 → 3 (last bin inclusive)
    expect(r.bins[1].frequency).toBe(3);
  });

  it("falls back to Sturges-rule auto-binning when bins are missing or non-monotonic", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8];
    const r = buildHistogram(data, []);
    expect(r.error).toBeUndefined();
    // Sturges: ceil(log2(8)) + 1 = 4 bins
    expect(r.bins).toHaveLength(4);
    // All 8 observations should be accounted for (no over/underflow).
    const total = r.bins.reduce((s, b) => s + b.frequency, 0);
    expect(total + r.underflow + r.overflow).toBe(8);

    // Non-monotonic supplied bins → same auto-bin path
    const r2 = buildHistogram(data, [3, 1, 5]);
    expect(r2.bins.length).toBeGreaterThan(0);
  });

  it("rejects empty data", () => {
    const r = buildHistogram([Number.NaN, Number.POSITIVE_INFINITY], [0, 1]);
    expect(r.error).toMatch(/数値データがありません/);
  });
});

// ===========================================================================
// #187 — Two-way ANOVA
// ===========================================================================

describe("runTwoWayANOVA", () => {
  it("decomposes a balanced 2×3 design with r=2 into hand-verified SS", () => {
    // Cells laid out [factorA][factorB][replicates].
    //   A1: B1=[3,4]  B2=[5,6]  B3=[7,8]
    //   A2: B1=[4,5]  B2=[6,7]  B3=[8,9]
    // Cell means: 3.5 5.5 7.5 / 4.5 6.5 8.5; grand mean 6.
    //   row means 5.5, 6.5  → SS_A = 3·2·(0.5²+0.5²)            = 3
    //   col means 4, 6, 8   → SS_B = 2·2·(2²+0²+2²)             = 32
    //   SS_cells = 35 ⇒ SS_interaction = 35-3-32                = 0
    //   each cell [x,x+1] ⇒ within SS 0.5, 6 cells ⇒ SS_error   = 3
    const cells = [
      [
        [3, 4],
        [5, 6],
        [7, 8],
      ],
      [
        [4, 5],
        [6, 7],
        [8, 9],
      ],
    ];
    const r = runTwoWayANOVA(cells);
    expect(r.error).toBeUndefined();
    expect(r.levelsA).toBe(2);
    expect(r.levelsB).toBe(3);
    expect(r.replicates).toBe(2);
    expect(r.totalN).toBe(12);
    expect(r.grandMean).toBeCloseTo(6, 10);

    const bySource = Object.fromEntries(r.terms.map((t) => [t.source, t]));
    expect(bySource.factorA.df).toBe(1);
    expect(bySource.factorA.ss).toBeCloseTo(3, 10);
    expect(bySource.factorB.df).toBe(2);
    expect(bySource.factorB.ss).toBeCloseTo(32, 10);
    expect(bySource.interaction.df).toBe(2);
    expect(bySource.interaction.ss).toBeCloseTo(0, 10);
    expect(bySource.error.df).toBe(6);
    expect(bySource.error.ss).toBeCloseTo(3, 10);
    expect(bySource.total.df).toBe(11);
    expect(bySource.total.ss).toBeCloseTo(38, 10);

    // MS_error = 0.5 ⇒ F_A = 6, F_B = 32, F_AB = 0.
    expect(bySource.factorA.f).toBeCloseTo(6, 10);
    expect(bySource.factorB.f).toBeCloseTo(32, 10);
    expect(bySource.interaction.f).toBeCloseTo(0, 10);
    // p-value for F(2,6)=32 is tiny; F(1,6)=6 ≈ 0.0477.
    expect(bySource.factorA.pValue).toBeGreaterThan(0.04);
    expect(bySource.factorA.pValue).toBeLessThan(0.06);
    expect(bySource.factorB.pValue).toBeLessThan(0.001);
  });

  it("folds the interaction into error when r = 1 (no replication)", () => {
    const cells = [
      [[1], [2], [3]],
      [[4], [5], [6]],
    ];
    const r = runTwoWayANOVA(cells);
    expect(r.error).toBeUndefined();
    expect(r.replicates).toBe(1);
    // No interaction term; error df = (a-1)(b-1) = 2.
    const sources = r.terms.map((t) => t.source);
    expect(sources).not.toContain("interaction");
    const err = r.terms.find((t) => t.source === "error");
    expect(err?.df).toBe(2);
  });

  it("rejects an unbalanced design", () => {
    const r = runTwoWayANOVA([
      [
        [1, 2],
        [3],
      ],
      [
        [4, 5],
        [6, 7],
      ],
    ]);
    expect(r.error).toMatch(/不釣り合い|観測数/);
  });

  it("rejects too few factor levels", () => {
    const r = runTwoWayANOVA([[[1, 2], [3, 4]]]);
    expect(r.error).toMatch(/因子 A/);
  });
});

// ===========================================================================
// #187 — t-test
// ===========================================================================

describe("runTTest", () => {
  it("one-sample: tests the mean against μ₀ with t = (x̄-μ₀)/SE", () => {
    // sample [6,8,10]: mean 8, var 4, SE = √(4/3) ≈ 1.1547.
    // against μ₀ = 5 ⇒ t = 3/1.1547 ≈ 2.5981, df = 2.
    const r = runTTest([6, 8, 10], [], "oneSample", 5);
    expect(r.error).toBeUndefined();
    expect(r.mean1).toBeCloseTo(8, 10);
    expect(r.df).toBe(2);
    expect(r.standardError).toBeCloseTo(Math.sqrt(4 / 3), 10);
    expect(r.t).toBeCloseTo(2.5980762, 5);
    // Two-sided p for t(2)=2.598 ≈ 0.12164 (cross-checked with R pt()).
    expect(r.pValueTwoSided).toBeCloseTo(0.12164, 4);
    expect(r.pValueOneSided).toBeCloseTo(0.12164 / 2, 4);
  });

  it("two-sample pooled: hand-verified t and df on equal-variance data", () => {
    // s1=[6,8,10] (mean 8, var 4), s2=[1,3,5] (mean 3, var 4).
    // pooled var = 4, SE = √(4·(1/3+1/3)) = √(8/3) ≈ 1.63299.
    // t = (8-3)/1.63299 ≈ 3.06186, df = 4.
    const r = runTTest([6, 8, 10], [1, 3, 5], "twoSamplePooled");
    expect(r.error).toBeUndefined();
    expect(r.meanDiff).toBeCloseTo(5, 10);
    expect(r.standardError).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(r.t).toBeCloseTo(3.0618622, 5);
    expect(r.df).toBe(4);
    // Two-sided p for t(4)=3.062 ≈ 0.03755 (R pt()).
    expect(r.pValueTwoSided).toBeCloseTo(0.03755, 4);
  });

  it("Welch: fractional Satterthwaite df on unequal-variance data", () => {
    // s1=[6,8,10] (var 4, n3), s2=[2,3,4,5,6] (mean 4, var 2.5, n5).
    // v1/n1=4/3, v2/n2=0.5, SE=√(11/6)≈1.354006, t=4/SE≈2.9541958.
    // df = (11/6)² / ((4/3)²/2 + 0.5²/4) ≈ 3.53286.
    const r = runTTest([6, 8, 10], [2, 3, 4, 5, 6], "welch");
    expect(r.error).toBeUndefined();
    expect(r.standardError).toBeCloseTo(Math.sqrt(11 / 6), 10);
    expect(r.t).toBeCloseTo(4 / Math.sqrt(11 / 6), 10);
    expect(r.t).toBeCloseTo(2.9541958, 6);
    expect(r.df).toBeCloseTo(3.53286, 4);
  });

  it("paired: tests the per-row differences against zero", () => {
    // s1=[10,12,14], s2=[8,11,12]: diffs [2,1,2], mean 5/3, var 1/3.
    // SE = √((1/3)/3) = 1/3, t = (5/3)/(1/3) = 5, df = 2.
    const r = runTTest([10, 12, 14], [8, 11, 12], "paired");
    expect(r.error).toBeUndefined();
    expect(r.meanDiff).toBeCloseTo(5 / 3, 10);
    expect(r.standardError).toBeCloseTo(1 / 3, 10);
    expect(r.t).toBeCloseTo(5, 10);
    expect(r.df).toBe(2);
  });

  it("rejects a paired test with mismatched sample lengths", () => {
    const r = runTTest([1, 2, 3], [1, 2], "paired");
    expect(r.error).toMatch(/同数/);
  });

  it("rejects a one-sample test with fewer than 2 values", () => {
    const r = runTTest([5], [], "oneSample", 0);
    expect(r.error).toMatch(/2 個以上/);
  });
});

// ===========================================================================
// #187 — Chi-square test
// ===========================================================================

describe("runChiSquareGoodnessOfFit", () => {
  it("computes χ² against a uniform expectation (fair-die example)", () => {
    // Observed die rolls [16,8,9,12,5,10], n=60 ⇒ expected 10 each.
    // χ² = (36+4+1+4+25+0)/10 = 7.0, df = 5.
    const r = runChiSquareGoodnessOfFit([16, 8, 9, 12, 5, 10]);
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(60);
    expect(r.chiSquare).toBeCloseTo(7.0, 10);
    expect(r.df).toBe(5);
    // p for χ²(5)=7.0 ≈ 0.22064 (R pchisq upper tail).
    expect(r.pValue).toBeCloseTo(0.22064, 4);
    expect(r.expected[0].every((e) => Math.abs(e - 10) < 1e-9)).toBe(true);
  });

  it("rescales supplied expected proportions to the observed total", () => {
    // Observed [30,30], expected weights [1,1] ⇒ E=[30,30], χ²=0.
    const r = runChiSquareGoodnessOfFit([30, 30], [1, 1]);
    expect(r.error).toBeUndefined();
    expect(r.chiSquare).toBeCloseTo(0, 10);
    expect(r.pValue).toBeCloseTo(1, 6);
  });

  it("rejects mismatched expected length", () => {
    const r = runChiSquareGoodnessOfFit([1, 2, 3], [1, 1]);
    expect(r.error).toMatch(/一致しません/);
  });
});

describe("runChiSquareIndependence", () => {
  it("computes χ² on a 2×2 contingency table with hand-verified expecteds", () => {
    // Table [[10,20],[30,40]]: row totals 30/70, col 40/60, N=100.
    // Expected [[12,18],[28,42]].
    // χ² = 4/12 + 4/18 + 4/28 + 4/42 ≈ 0.79365, df = 1.
    const r = runChiSquareIndependence([
      [10, 20],
      [30, 40],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(100);
    expect(r.df).toBe(1);
    expect(r.expected[0][0]).toBeCloseTo(12, 10);
    expect(r.expected[0][1]).toBeCloseTo(18, 10);
    expect(r.expected[1][0]).toBeCloseTo(28, 10);
    expect(r.expected[1][1]).toBeCloseTo(42, 10);
    expect(r.chiSquare).toBeCloseTo(0.7936508, 5);
    // p for χ²(1)=0.79365 ≈ 0.37304.
    expect(r.pValue).toBeCloseTo(0.37304, 4);
  });

  it("yields χ² = 0 for a perfectly independent table", () => {
    // Proportional rows ⇒ observed == expected ⇒ χ² = 0.
    const r = runChiSquareIndependence([
      [10, 20],
      [20, 40],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.chiSquare).toBeCloseTo(0, 10);
    expect(r.pValue).toBeCloseTo(1, 6);
  });

  it("rejects a ragged table", () => {
    const r = runChiSquareIndependence([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(r.error).toMatch(/列数/);
  });
});

// ===========================================================================
// #187 — Correlation matrix
// ===========================================================================

describe("runCorrelationMatrix", () => {
  it("returns r = 1 / -1 for perfectly (anti)correlated columns", () => {
    // x=[1,2,3], y=2x=[2,4,6], z=-x=[-1,-2,-3].
    const r = runCorrelationMatrix([
      [1, 2, 3],
      [2, 4, 6],
      [-1, -2, -3],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.n).toBe(3);
    expect(r.correlation[0][0]).toBeCloseTo(1, 10);
    expect(r.correlation[0][1]).toBeCloseTo(1, 10);
    expect(r.correlation[0][2]).toBeCloseTo(-1, 10);
    expect(r.correlation[1][2]).toBeCloseTo(-1, 10);
    // Sample covariance cov(x,x)=1, cov(x,y)=2, cov(y,y)=4 (n-1 denom).
    expect(r.covariance[0][0]).toBeCloseTo(1, 10);
    expect(r.covariance[0][1]).toBeCloseTo(2, 10);
    expect(r.covariance[1][1]).toBeCloseTo(4, 10);
  });

  it("matches a hand-computed Pearson r on a non-trivial pair", () => {
    // x=[1,2,3,4,5], y=[2,4,5,4,5]: x̄=3, ȳ=4.
    //   Sxy = Σ(dx·dy) = (-2)(-2)+(-1)(0)+0+1·0+2·1 = 6
    //   Sxx = 10, Syy = 4+0+1+0+1 = 6
    //   r = 6/√(10·6) = 6/√60 ≈ 0.7745967
    const r = runCorrelationMatrix([
      [1, 2, 3, 4, 5],
      [2, 4, 5, 4, 5],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.correlation[0][1]).toBeCloseTo(0.7745967, 6);
    expect(r.correlation).toEqual([
      [r.correlation[0][0], r.correlation[0][1]],
      [r.correlation[1][0], r.correlation[1][1]],
    ]);
    // Symmetry check.
    expect(r.correlation[0][1]).toBeCloseTo(r.correlation[1][0], 12);
  });

  it("uses listwise deletion for rows with a non-finite value", () => {
    const r = runCorrelationMatrix([
      [1, 2, Number.NaN, 4],
      [2, 4, 6, 8],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.n).toBe(3); // the NaN row dropped from both columns
    expect(r.correlation[0][1]).toBeCloseTo(1, 10);
  });

  it("rejects fewer than 2 variables", () => {
    const r = runCorrelationMatrix([[1, 2, 3]]);
    expect(r.error).toMatch(/2 つ以上/);
  });

  it("computes a matrix from NaN-padded equal-length columns with blanks", () => {
    // Regression test for #187 MAJOR: blank cells in a variable range must be
    // passed through as NaN (equal-length columns), not skipped — so listwise
    // deletion can drop incomplete rows instead of erroring on length mismatch.
    // x has a blank in row 2, y has a blank in row 4; both columns length 6.
    // Complete-case rows are 0,1,3,5 -> x=[1,2,4,6], y=[2,4,8,12]=2x.
    const r = runCorrelationMatrix([
      [1, Number.NaN, 3, 4, 5, 6],
      [2, 4, 6, Number.NaN, 10, 12],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.n).toBe(4); // rows 2 and 4 dropped
    expect(r.correlation[0][1]).toBeCloseTo(1, 10);
  });
});

// ===========================================================================
// #187 — Random-number generation
// ===========================================================================

describe("generateRandomNumbers", () => {
  it("is reproducible for a fixed seed and differs across seeds", () => {
    const a = generateRandomNumbers({
      distribution: "uniform",
      count: 50,
      seed: 42,
    });
    const b = generateRandomNumbers({
      distribution: "uniform",
      count: 50,
      seed: 42,
    });
    const c = generateRandomNumbers({
      distribution: "uniform",
      count: 50,
      seed: 99,
    });
    expect(a.values).toEqual(b.values);
    expect(a.values).not.toEqual(c.values);
  });

  it("uniform: stays in [min,max) with mean near the theoretical midpoint", () => {
    const r = generateRandomNumbers({
      distribution: "uniform",
      count: 20000,
      seed: 7,
      min: 10,
      max: 20,
    });
    expect(r.error).toBeUndefined();
    expect(Math.min(...r.values)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...r.values)).toBeLessThan(20);
    const mean = r.values.reduce((s, v) => s + v, 0) / r.values.length;
    // Theoretical mean (min+max)/2 = 15; variance (b-a)²/12 ≈ 8.333.
    expect(mean).toBeCloseTo(15, 0);
    const variance =
      r.values.reduce((s, v) => s + (v - mean) ** 2, 0) / r.values.length;
    expect(variance).toBeGreaterThan(7);
    expect(variance).toBeLessThan(9.5);
  });

  it("normal: sample mean / sd approach the requested parameters", () => {
    const r = generateRandomNumbers({
      distribution: "normal",
      count: 40000,
      seed: 123,
      mean: 5,
      stdDev: 2,
    });
    expect(r.error).toBeUndefined();
    const mean = r.values.reduce((s, v) => s + v, 0) / r.values.length;
    const sd = Math.sqrt(
      r.values.reduce((s, v) => s + (v - mean) ** 2, 0) / r.values.length,
    );
    expect(mean).toBeCloseTo(5, 1);
    expect(sd).toBeCloseTo(2, 1);
  });

  it("bernoulli: only 0/1 values, mean ≈ success probability", () => {
    const r = generateRandomNumbers({
      distribution: "bernoulli",
      count: 30000,
      seed: 5,
      probability: 0.3,
    });
    expect(r.error).toBeUndefined();
    expect(r.values.every((v) => v === 0 || v === 1)).toBe(true);
    const mean = r.values.reduce((s, v) => s + v, 0) / r.values.length;
    expect(mean).toBeCloseTo(0.3, 1);
  });

  it("poisson: non-negative integers with mean ≈ λ (and variance ≈ λ)", () => {
    const r = generateRandomNumbers({
      distribution: "poisson",
      count: 30000,
      seed: 11,
      lambda: 4,
    });
    expect(r.error).toBeUndefined();
    expect(r.values.every((v) => v >= 0 && Number.isInteger(v))).toBe(true);
    const mean = r.values.reduce((s, v) => s + v, 0) / r.values.length;
    const variance =
      r.values.reduce((s, v) => s + (v - mean) ** 2, 0) / r.values.length;
    // Poisson: E[X] = Var[X] = λ.
    expect(mean).toBeCloseTo(4, 0);
    expect(variance).toBeGreaterThan(3);
    expect(variance).toBeLessThan(5);
  });

  it("rejects invalid parameters", () => {
    expect(
      generateRandomNumbers({ distribution: "uniform", count: 0 }).error,
    ).toMatch(/1 以上/);
    expect(
      generateRandomNumbers({
        distribution: "normal",
        count: 10,
        stdDev: -1,
      }).error,
    ).toMatch(/標準偏差/);
    expect(
      generateRandomNumbers({
        distribution: "bernoulli",
        count: 10,
        probability: 1.5,
      }).error,
    ).toMatch(/成功確率/);
  });
});

// ===========================================================================
// #187 — Moving average
// ===========================================================================

describe("runSimpleMovingAverage", () => {
  it("produces trailing-window averages with NaN for the warm-up positions", () => {
    // data [1,2,3,4,5], window 3 ⇒ [NaN,NaN,2,3,4].
    const r = runSimpleMovingAverage([1, 2, 3, 4, 5], 3);
    expect(r.error).toBeUndefined();
    expect(r.window).toBe(3);
    expect(Number.isNaN(r.values[0])).toBe(true);
    expect(Number.isNaN(r.values[1])).toBe(true);
    expect(r.values[2]).toBeCloseTo(2, 10);
    expect(r.values[3]).toBeCloseTo(3, 10);
    expect(r.values[4]).toBeCloseTo(4, 10);
  });

  it("window = 1 reproduces the input series", () => {
    const r = runSimpleMovingAverage([5, 7, 9], 1);
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual([5, 7, 9]);
  });

  it("rejects a window wider than the data and non-numeric input", () => {
    expect(runSimpleMovingAverage([1, 2], 5).error).toMatch(/超えています/);
    expect(
      runSimpleMovingAverage([1, Number.NaN, 3], 2).error,
    ).toMatch(/数値以外/);
  });
});

describe("runExponentialMovingAverage", () => {
  it("applies EMAᵢ = α·xᵢ + (1-α)·EMAᵢ₋₁ with EMA₀ = x₀", () => {
    // data [1,2,3], α=0.5 ⇒ [1, 1.5, 2.25].
    const r = runExponentialMovingAverage([1, 2, 3], 0.5);
    expect(r.error).toBeUndefined();
    expect(r.alpha).toBe(0.5);
    expect(r.values[0]).toBeCloseTo(1, 10);
    expect(r.values[1]).toBeCloseTo(1.5, 10);
    expect(r.values[2]).toBeCloseTo(2.25, 10);
  });

  it("α = 1 reproduces the input series", () => {
    const r = runExponentialMovingAverage([4, 8, 2], 1);
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual([4, 8, 2]);
  });

  it("rejects α outside (0,1]", () => {
    expect(runExponentialMovingAverage([1, 2, 3], 0).error).toMatch(/α/);
    expect(runExponentialMovingAverage([1, 2, 3], 1.5).error).toMatch(/α/);
  });
});

// ===========================================================================
// #187 — Fourier transform
// ===========================================================================

describe("runFourierTransform", () => {
  it("transforms a DC signal (radix-2): all energy in bin 0", () => {
    // [1,1,1,1] ⇒ X = [4,0,0,0].
    const r = runFourierTransform([1, 1, 1, 1]);
    expect(r.error).toBeUndefined();
    expect(r.method).toBe("radix2");
    expect(r.n).toBe(4);
    expect(r.amplitude[0]).toBeCloseTo(4, 9);
    expect(r.amplitude[1]).toBeCloseTo(0, 9);
    expect(r.amplitude[2]).toBeCloseTo(0, 9);
    expect(r.amplitude[3]).toBeCloseTo(0, 9);
  });

  it("transforms a unit impulse: flat amplitude spectrum of 1", () => {
    // [1,0,0,0,0,0,0,0] ⇒ |X_k| = 1 for every k.
    const r = runFourierTransform([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.error).toBeUndefined();
    expect(r.method).toBe("radix2");
    for (let k = 0; k < 8; k++) {
      expect(r.amplitude[k]).toBeCloseTo(1, 9);
    }
  });

  it("recovers a single cosine: peaks at the matching frequency bin", () => {
    // x_t = cos(2π·t/8), n=8. DFT of a pure cosine of integer frequency 1
    // has |X_1| = |X_7| = n/2 = 4, all other bins ≈ 0.
    const n = 8;
    const signal = Array.from({ length: n }, (_, t) =>
      Math.cos((2 * Math.PI * t) / n),
    );
    const r = runFourierTransform(signal);
    expect(r.error).toBeUndefined();
    expect(r.amplitude[1]).toBeCloseTo(4, 8);
    expect(r.amplitude[7]).toBeCloseTo(4, 8);
    expect(r.amplitude[0]).toBeCloseTo(0, 8);
    expect(r.amplitude[2]).toBeCloseTo(0, 8);
    expect(r.amplitude[4]).toBeCloseTo(0, 8);
  });

  it("handles a non-power-of-two length via Bluestein", () => {
    // [1,2,3], n=3 (Bluestein). X_0 = Σx = 6;
    // X_1 = -1.5 + 0.8660254i ⇒ |X_1| = √3 ≈ 1.7320508; X_2 = conj(X_1).
    const r = runFourierTransform([1, 2, 3]);
    expect(r.error).toBeUndefined();
    expect(r.method).toBe("bluestein");
    expect(r.n).toBe(3);
    expect(r.real[0]).toBeCloseTo(6, 8);
    expect(r.imag[0]).toBeCloseTo(0, 8);
    expect(r.amplitude[1]).toBeCloseTo(Math.sqrt(3), 7);
    expect(r.amplitude[2]).toBeCloseTo(Math.sqrt(3), 7);
    expect(r.real[1]).toBeCloseTo(-1.5, 7);
    expect(r.imag[1]).toBeCloseTo(Math.sqrt(3) / 2, 7);
  });

  it("bin 0 always equals the sum of the signal (DC component)", () => {
    const signal = [3, 1, 4, 1, 5, 9, 2, 6, 5]; // n=9, Bluestein
    const r = runFourierTransform(signal);
    expect(r.error).toBeUndefined();
    expect(r.method).toBe("bluestein");
    const sum = signal.reduce((s, v) => s + v, 0);
    expect(r.real[0]).toBeCloseTo(sum, 7);
    expect(r.imag[0]).toBeCloseTo(0, 7);
  });

  it("rejects empty or non-numeric input", () => {
    expect(runFourierTransform([]).error).toMatch(/データがありません/);
    expect(
      runFourierTransform([1, Number.NaN, 3]).error,
    ).toMatch(/数値以外/);
  });
});
