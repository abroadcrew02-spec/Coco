// Pure secant-method solver for Excel's "Goal Seek" (ゴールシーク) What-If
// analysis. Excel's variant lets the user say "set targetCell to targetValue
// by adjusting changingCell", then iteratively probes changingCell until the
// dependent targetCell converges (or it gives up). The algorithm here is
// adapter-driven so this file stays free of Univer / FUniver imports and is
// trivially testable with a stub adapter.
//
// Snapshot shape (none — this helper is stateless):
//   The caller provides a `GoalSeekAdapter` that knows how to read/write
//   numeric values via the host spreadsheet engine. After each `writeNumeric`
//   the engine is expected to have recomputed dependent formulas so that the
//   next `readNumeric(targetCell)` returns the post-recompute value. In
//   Univer 0.5.x, FUniver's `range.setValue` triggers a synchronous formula
//   recomputation, so this works without explicit awaits — see the dialog
//   integration for the caveat.
//
// Algorithm: secant method
//   x_{n+1} = x_n - (y_n - target) * (x_n - x_{n-1}) / (y_n - y_{n-1})
//   - Bootstrapped by perturbing the initial x by ~1% (or +1 when x0 == 0).
//   - Stop on |y_n - target| < tolerance (default 1e-6).
//   - Cap at maxIter (default 100).
//   - Bail with `diverged` when |error| has failed to strictly decrease for
//     5 consecutive iterations — catches non-monotonic functions and cases
//     where no real solution exists. This is similar to Excel's heuristic.
//   - Bail with `invalid` on non-numeric reads, divide-by-zero in the
//     secant update, or NaN/Infinity propagating into the iterate.

export interface GoalSeekParams {
  /** A1 ref of the cell whose value we want to drive (typically a formula). */
  targetCell: string;
  /** Numeric value we want the targetCell to reach. */
  targetValue: number;
  /** A1 ref of the independent variable cell we're allowed to mutate. */
  changingCell: string;
  /** Cap on iteration count. Defaults to 100. */
  maxIter?: number;
  /** Convergence tolerance on |targetCell - targetValue|. Defaults to 1e-6. */
  tolerance?: number;
}

export interface GoalSeekResult {
  /** True iff `reason === "converged"`. Convenience for callers. */
  ok: boolean;
  /** Number of secant iterations actually performed (does not count bootstrap). */
  iterations: number;
  /** Final value of targetCell at termination. */
  finalValue: number;
  /** |finalValue - targetValue| at termination. */
  finalError: number;
  /** Termination reason; absent only if the function returned mid-flight. */
  reason: "converged" | "max-iter" | "diverged" | "invalid";
  /** Final value written to changingCell. Useful for restore-on-cancel. */
  finalChanging: number;
}

/**
 * Minimal interface the algorithm needs from the host engine. Kept tiny so
 * tests can fake it with a plain object and so this module never reaches into
 * FUniver / Univer types directly.
 */
export interface GoalSeekAdapter {
  /** Returns the numeric value of cellRef, or null if it's missing / non-numeric. */
  readNumeric(cellRef: string): number | null;
  /** Writes value to cellRef. After return, formulas depending on it should be recomputed. */
  writeNumeric(cellRef: string, value: number): void;
}

const DEFAULT_MAX_ITER = 100;
const DEFAULT_TOLERANCE = 1e-6;
const STALL_LIMIT = 5;

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Run the secant-method solver. Mutates `changingCell` via the adapter; on
 * failure (any reason other than "converged") the caller is responsible for
 * deciding whether to restore the original value — `runGoalSeek` deliberately
 * does NOT auto-rollback so the UI can present the "best guess" to the user.
 */
export function runGoalSeek(
  adapter: GoalSeekAdapter,
  params: GoalSeekParams,
): GoalSeekResult {
  const maxIter = params.maxIter ?? DEFAULT_MAX_ITER;
  const tolerance = params.tolerance ?? DEFAULT_TOLERANCE;
  const target = params.targetValue;

  if (!isFiniteNum(target)) {
    return {
      ok: false,
      iterations: 0,
      finalValue: Number.NaN,
      finalError: Number.NaN,
      reason: "invalid",
      finalChanging: Number.NaN,
    };
  }

  const x0Raw = adapter.readNumeric(params.changingCell);
  if (x0Raw === null || !isFiniteNum(x0Raw)) {
    return {
      ok: false,
      iterations: 0,
      finalValue: Number.NaN,
      finalError: Number.NaN,
      reason: "invalid",
      finalChanging: Number.NaN,
    };
  }
  // Seed at the current value to capture y0 without mutating the sheet.
  let xPrev = x0Raw;
  adapter.writeNumeric(params.changingCell, xPrev);
  const y0 = adapter.readNumeric(params.targetCell);
  if (y0 === null || !isFiniteNum(y0)) {
    return {
      ok: false,
      iterations: 0,
      finalValue: Number.NaN,
      finalError: Number.NaN,
      reason: "invalid",
      finalChanging: xPrev,
    };
  }
  let yPrev = y0;
  let errPrev = Math.abs(yPrev - target);

  if (errPrev < tolerance) {
    return {
      ok: true,
      iterations: 0,
      finalValue: yPrev,
      finalError: errPrev,
      reason: "converged",
      finalChanging: xPrev,
    };
  }

  // Perturb to get the second sample needed by the secant formula. Use a
  // 1% step when nonzero so the probe scales with the magnitude; fall back
  // to a unit step at the origin.
  let xCurr = xPrev !== 0 ? xPrev * 1.01 : xPrev + 1;
  // Defensive: if 1% of x is below the tolerance (huge magnitude with FP
  // round-off swallowing the perturbation), nudge harder.
  if (xCurr === xPrev) xCurr = xPrev + 1;
  adapter.writeNumeric(params.changingCell, xCurr);
  const y1 = adapter.readNumeric(params.targetCell);
  if (y1 === null || !isFiniteNum(y1)) {
    return {
      ok: false,
      iterations: 0,
      finalValue: yPrev,
      finalError: errPrev,
      reason: "invalid",
      finalChanging: xCurr,
    };
  }
  let yCurr = y1;
  let errCurr = Math.abs(yCurr - target);

  let stallCount = 0;
  for (let iter = 1; iter <= maxIter; iter++) {
    if (errCurr < tolerance) {
      return {
        ok: true,
        iterations: iter,
        finalValue: yCurr,
        finalError: errCurr,
        reason: "converged",
        finalChanging: xCurr,
      };
    }

    const dy = yCurr - yPrev;
    if (dy === 0 || !isFiniteNum(dy)) {
      // Flat region: secant formula divides by zero. We can't make progress
      // — bail with the best iterate we have.
      return {
        ok: false,
        iterations: iter,
        finalValue: yCurr,
        finalError: errCurr,
        reason: "diverged",
        finalChanging: xCurr,
      };
    }
    const xNext = xCurr - ((yCurr - target) * (xCurr - xPrev)) / dy;
    if (!isFiniteNum(xNext)) {
      return {
        ok: false,
        iterations: iter,
        finalValue: yCurr,
        finalError: errCurr,
        reason: "invalid",
        finalChanging: xCurr,
      };
    }

    adapter.writeNumeric(params.changingCell, xNext);
    const yNext = adapter.readNumeric(params.targetCell);
    if (yNext === null || !isFiniteNum(yNext)) {
      return {
        ok: false,
        iterations: iter,
        finalValue: yCurr,
        finalError: errCurr,
        reason: "invalid",
        finalChanging: xNext,
      };
    }
    const errNext = Math.abs(yNext - target);

    // Divergence heuristic: if the error fails to strictly decrease across
    // STALL_LIMIT consecutive iterations, assume the function is
    // non-monotonic or unsolvable and bail.
    if (errNext >= errCurr) {
      stallCount++;
      if (stallCount >= STALL_LIMIT) {
        return {
          ok: false,
          iterations: iter,
          finalValue: yNext,
          finalError: errNext,
          reason: "diverged",
          finalChanging: xNext,
        };
      }
    } else {
      stallCount = 0;
    }

    xPrev = xCurr;
    yPrev = yCurr;
    errPrev = errCurr;
    xCurr = xNext;
    yCurr = yNext;
    errCurr = errNext;
  }

  return {
    ok: errCurr < tolerance,
    iterations: maxIter,
    finalValue: yCurr,
    finalError: errCurr,
    reason: errCurr < tolerance ? "converged" : "max-iter",
    finalChanging: xCurr,
  };
}
