import { describe, it, expect } from "vitest";
import {
  runLinearRegression,
  runOneWayANOVA,
  buildHistogram,
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
