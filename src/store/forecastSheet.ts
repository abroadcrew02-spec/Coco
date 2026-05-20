// Pure helpers for Excel's "Forecast Sheet" (Data → Forecast Sheet) feature.
//
// Excel's variant lets the user select two parallel ranges (X = dates or
// numeric tick marks, Y = observed values) and produces:
//   - a fitted curve (we use linear regression; Excel additionally offers
//     ETS/exponential-smoothing — out of scope for the MVP)
//   - N future predictions extrapolated from that fit
//   - optional 95 %% confidence bounds on each prediction
//
// Snapshot shape (none — this module is stateless):
//   The caller is responsible for reading source ranges out of the active
//   workbook (see ForecastSheetDialog's onApply integration), running this
//   module on the extracted numeric arrays, and writing the resulting table
//   back into a destination range via applyMutatedSnapshot. We deliberately
//   keep this file free of Univer / FUniver imports so the math is trivially
//   testable in isolation, matching the goalSeek.ts / sparklines.ts pattern.
//
// Algorithm: ordinary least-squares linear regression
//   ŷ_i = a*x_i + b
//   a   = (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
//   b   = (Σy   - a*Σx) / n
//
// Confidence intervals (two-sided, level c ∈ (0, 1)):
//   s_e   = sqrt(Σ(y_i - ŷ_i)² / (n - 2))         (residual std error)
//   t_c   ≈ inverse normal CDF at (1 + c) / 2     (large-n approximation)
//   bound = ŷ_i ± t_c * s_e
//
// We approximate t_c with the normal quantile because Coco doesn't ship a
// t-distribution table. For the default c = 0.95 this gives t ≈ 1.96, which
// matches Excel within rounding for any reasonable sample size.
//
// R² (coefficient of determination) is returned so the dialog can surface
// fit quality back to the user:
//   R² = 1 - Σ(y_i - ŷ_i)² / Σ(y_i - ȳ)²

export interface ForecastParams {
  /** Historical independent-variable values (dates → days-since-epoch, etc.). */
  xValues: number[];
  /** Historical dependent-variable values, same length as xValues. */
  yValues: number[];
  /** Number of future periods to predict. */
  periods: number;
  /** Confidence level in (0, 1) — e.g. 0.95 for 95 % bounds. */
  confidenceLevel: number;
}

export interface ForecastResult {
  /** Concatenated historical + forecast x values. Length = xValues.length + periods. */
  xs: number[];
  /** Historical y for the corresponding x; null for forecast rows. */
  ys: (number | null)[];
  /** Predicted ŷ for the forecast rows; one entry per forecast period. */
  forecast: number[];
  /** Lower confidence bound, parallel to `forecast`. */
  lower: number[];
  /** Upper confidence bound, parallel to `forecast`. */
  upper: number[];
  /** Coefficient of determination (1 = perfect fit, 0 = no explanatory power). */
  r2: number;
}

/**
 * Best-effort coercion of arbitrary cell values to a numeric x axis.
 *   - numbers → unchanged
 *   - numeric strings → Number() coercion
 *   - date strings (ISO-like, "yyyy/mm/dd", etc.) parseable by Date() →
 *     days-since-epoch (1970-01-01 UTC at noon to dodge DST drift)
 *   - anything else → NaN, which the caller filters out
 *
 * We use days-since-epoch (not the Excel 1900 serial) because the resulting
 * floats round-trip cleanly through the regression and back without the
 * leap-year-bug correction Excel carries for backwards compatibility.
 */
export function parseXValues(values: unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push(v);
      continue;
    }
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (!trimmed) {
        out.push(Number.NaN);
        continue;
      }
      // Try numeric coercion first — covers "42", "3.14", scientific notation.
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum)) {
        out.push(asNum);
        continue;
      }
      // Fall back to date parsing for "2024-01-15", "2024/01/15", etc. We
      // anchor at UTC noon to avoid timezone rollover changing the integer
      // day index when the system is east of UTC.
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) {
        const days = parsed / (1000 * 60 * 60 * 24);
        out.push(days);
        continue;
      }
      out.push(Number.NaN);
      continue;
    }
    if (v instanceof Date) {
      const t = v.getTime();
      if (Number.isFinite(t)) {
        out.push(t / (1000 * 60 * 60 * 24));
        continue;
      }
    }
    out.push(Number.NaN);
  }
  return out;
}

/**
 * Approximate inverse-normal quantile for the upper tail probability p, where
 * the returned z satisfies Φ(z) = 1 - p. Used to map a confidence level c
 * into a critical value via z = invNorm((1 - c) / 2). Beasley-Springer-Moro
 * rational approximation; accurate to ~1e-9 over (0, 1), more than enough
 * for confidence-band display.
 */
function invNormUpperTail(p: number): number {
  // Convert "upper tail" probability to a CDF probability, then run the
  // standard BSM approximation over (0, 1).
  const q = 1 - p;
  if (q <= 0) return -Infinity;
  if (q >= 1) return Infinity;
  // Coefficients lifted from Wichura (1988) — the AS241 algorithm.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let z: number;
  if (q < pLow) {
    const u = Math.sqrt(-2 * Math.log(q));
    z =
      (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  } else if (q <= pHigh) {
    const u = q - 0.5;
    const r = u * u;
    z =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        u) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const u = Math.sqrt(-2 * Math.log(1 - q));
    z =
      -(
        ((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u +
        c[5]
      ) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  }
  return z;
}

function emptyResult(): ForecastResult {
  return { xs: [], ys: [], forecast: [], lower: [], upper: [], r2: 0 };
}

/**
 * Fit a least-squares line to the (xValues, yValues) pairs and produce
 * `periods` extrapolated predictions extending past the last x. Pairs where
 * either coordinate is non-finite are dropped before fitting. With fewer
 * than 2 valid pairs the result is empty (regression is undefined).
 */
export function runForecast(params: ForecastParams): ForecastResult {
  const { xValues, yValues } = params;
  const periods = Math.max(0, Math.floor(params.periods));
  const c = params.confidenceLevel;
  const confidence = Number.isFinite(c) && c > 0 && c < 1 ? c : 0.95;

  const n0 = Math.min(xValues.length, yValues.length);
  // Filter to clean pairs so a single NaN in the source doesn't poison the
  // regression. We preserve the original order so the historical row layout
  // in the output table stays aligned with the source.
  const cleanX: number[] = [];
  const cleanY: number[] = [];
  for (let i = 0; i < n0; i++) {
    const x = xValues[i];
    const y = yValues[i];
    if (
      typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y)
    ) {
      cleanX.push(x);
      cleanY.push(y);
    }
  }
  const n = cleanX.length;
  if (n < 2 || periods <= 0) {
    // Even with 0 forecast periods we could still echo the historical pairs,
    // but the output table would have nothing to predict; treat as a no-op.
    return emptyResult();
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
  const denom = n * sumXX - sumX * sumX;
  if (!Number.isFinite(denom) || denom === 0) {
    // Vertical line / all-equal x — slope undefined.
    return emptyResult();
  }
  const a = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - a * sumX) / n;

  // Residual SS for both std-error and R².
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yhat = a * cleanX[i] + b;
    const resid = cleanY[i] - yhat;
    ssRes += resid * resid;
    ssTot += (cleanY[i] - meanY) * (cleanY[i] - meanY);
  }
  const stdErr = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  // Use the typical x-step to extend the axis. Equal-spaced source (the
  // common case for time series) gives a stable step; for irregular x we
  // fall back to the mean spacing so we always produce a strictly
  // increasing forecast axis.
  let step = 1;
  if (n >= 2) {
    const span = cleanX[n - 1] - cleanX[0];
    if (Number.isFinite(span) && span > 0) {
      step = span / (n - 1);
    }
  }
  if (!Number.isFinite(step) || step <= 0) step = 1;

  // 95 %% default → upper-tail prob 0.025 → z ≈ 1.96.
  const tCrit = invNormUpperTail((1 - confidence) / 2);

  const xs: number[] = [];
  const ys: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    xs.push(cleanX[i]);
    ys.push(cleanY[i]);
  }
  const lastX = cleanX[n - 1];
  const forecast: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  for (let k = 1; k <= periods; k++) {
    const x = lastX + step * k;
    const yhat = a * x + b;
    xs.push(x);
    ys.push(null);
    forecast.push(yhat);
    lower.push(yhat - tCrit * stdErr);
    upper.push(yhat + tCrit * stdErr);
  }

  return { xs, ys, forecast, lower, upper, r2 };
}
