// #239 Solver — univariate optimization MVP for "set X by adjusting Y to
// minimize / maximize / equal target". Pure / framework-free so the algorithm
// is unit-testable without Univer.
//
// Scope (MVP):
//   - SINGLE changing cell only (multivariate Solver is a follow-up).
//   - Three goals: minimize, maximize, set-to-value.
//   - Optional [lowerBound, upperBound] on the changing cell.
//   - No explicit constraints other than the bounds (penalty-based
//     multi-constraint solver is a follow-up).
//
// Algorithms:
//   - "value" goal → delegates to the existing Goal Seek secant solver.
//   - "minimize" / "maximize" → golden-section search on the bracket.
//     The bracket needs to be unimodal in [lo, hi]. For multimodal landscapes
//     the result is a local optimum; we surface the value to the user and let
//     them iterate.
//
// Adapter contract (same as goalSeek.ts) — the host engine writes the
// candidate value and reads back the objective after formula recomputation.

import {
  runGoalSeek,
  type GoalSeekAdapter,
  type GoalSeekResult,
} from "./goalSeek";

export type SolverGoal = "minimize" | "maximize" | "value";

export interface SolverParams {
  /** A1 ref of the cell whose value we want to drive. */
  objectiveCell: string;
  /** Type of optimization. */
  goal: SolverGoal;
  /** Used only when goal === "value". */
  targetValue?: number;
  /** A1 ref of the independent variable cell we're allowed to mutate. */
  changingCell: string;
  /** Optional lower bound on the changing cell. Defaults to -1e6. */
  lowerBound?: number;
  /** Optional upper bound on the changing cell. Defaults to +1e6. */
  upperBound?: number;
  /** Cap on iteration count. Defaults to 200. */
  maxIter?: number;
  /** Tolerance on the changing-cell interval width. Defaults to 1e-6. */
  tolerance?: number;
}

export interface SolverResult {
  ok: boolean;
  iterations: number;
  /** Final objective value (the value at the objectiveCell). */
  finalObjective: number;
  /** Final value we wrote to changingCell. */
  finalChanging: number;
  reason: "converged" | "max-iter" | "invalid" | "bracket-flat" | "delegated";
  /** When goal === "value", the underlying GoalSeek result (for transparency). */
  goalSeekDetail?: GoalSeekResult;
}

const DEFAULT_MAX_ITER = 200;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_BOUND = 1e6;
const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2; // ≈ 0.618

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Probe the objective at `x` via the adapter; returns null on read/write failure. */
function probe(
  adapter: GoalSeekAdapter,
  changingCell: string,
  objectiveCell: string,
  x: number,
): number | null {
  if (!isFiniteNum(x)) return null;
  adapter.writeNumeric(changingCell, x);
  const y = adapter.readNumeric(objectiveCell);
  return y === null || !isFiniteNum(y) ? null : y;
}

/**
 * Golden-section search on [lo, hi]. Caller supplies the sign (1 for
 * minimize, -1 for maximize via signed comparison). Returns null on read
 * failure (caller handles).
 */
function goldenSection(
  adapter: GoalSeekAdapter,
  params: Required<
    Pick<SolverParams, "objectiveCell" | "changingCell" | "maxIter" | "tolerance">
  > & { lo: number; hi: number; sign: 1 | -1 },
): SolverResult {
  const { lo: loInit, hi: hiInit, sign, maxIter, tolerance } = params;
  let lo = loInit;
  let hi = hiInit;
  let x1 = hi - GOLDEN_RATIO * (hi - lo);
  let x2 = lo + GOLDEN_RATIO * (hi - lo);
  let f1 = probe(adapter, params.changingCell, params.objectiveCell, x1);
  let f2 = probe(adapter, params.changingCell, params.objectiveCell, x2);
  if (f1 === null || f2 === null) {
    return {
      ok: false,
      iterations: 0,
      finalObjective: Number.NaN,
      finalChanging: x1,
      reason: "invalid",
    };
  }
  let iter = 0;
  while (Math.abs(hi - lo) > tolerance && iter < maxIter) {
    iter++;
    // Compare sign*f1 vs sign*f2: minimize → smaller is better;
    // maximize → larger is better (sign = -1 inverts the comparison).
    if (sign * f1 < sign * f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - GOLDEN_RATIO * (hi - lo);
      const nf = probe(adapter, params.changingCell, params.objectiveCell, x1);
      if (nf === null) {
        return {
          ok: false,
          iterations: iter,
          finalObjective: f2,
          finalChanging: x1,
          reason: "invalid",
        };
      }
      f1 = nf;
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + GOLDEN_RATIO * (hi - lo);
      const nf = probe(adapter, params.changingCell, params.objectiveCell, x2);
      if (nf === null) {
        return {
          ok: false,
          iterations: iter,
          finalObjective: f1,
          finalChanging: x2,
          reason: "invalid",
        };
      }
      f2 = nf;
    }
  }
  const bestX = sign * f1 < sign * f2 ? x1 : x2;
  const bestF = sign * f1 < sign * f2 ? f1 : f2;
  // Lock the best estimate in place so the workbook reflects the result.
  adapter.writeNumeric(params.changingCell, bestX);
  return {
    ok: Math.abs(hi - lo) <= tolerance,
    iterations: iter,
    finalObjective: bestF,
    finalChanging: bestX,
    reason: Math.abs(hi - lo) <= tolerance ? "converged" : "max-iter",
  };
}

export function runSolver(adapter: GoalSeekAdapter, params: SolverParams): SolverResult {
  const lo = params.lowerBound ?? -DEFAULT_BOUND;
  const hi = params.upperBound ?? DEFAULT_BOUND;
  const maxIter = params.maxIter ?? DEFAULT_MAX_ITER;
  const tolerance = params.tolerance ?? DEFAULT_TOLERANCE;

  if (!isFiniteNum(lo) || !isFiniteNum(hi) || hi <= lo) {
    return {
      ok: false,
      iterations: 0,
      finalObjective: Number.NaN,
      finalChanging: Number.NaN,
      reason: "invalid",
    };
  }

  if (params.goal === "value") {
    if (params.targetValue === undefined || !isFiniteNum(params.targetValue)) {
      return {
        ok: false,
        iterations: 0,
        finalObjective: Number.NaN,
        finalChanging: Number.NaN,
        reason: "invalid",
      };
    }
    const gs = runGoalSeek(adapter, {
      targetCell: params.objectiveCell,
      targetValue: params.targetValue,
      changingCell: params.changingCell,
      maxIter,
      tolerance,
    });
    return {
      ok: gs.ok,
      iterations: gs.iterations,
      finalObjective: gs.finalValue,
      finalChanging: gs.finalChanging,
      reason: gs.ok ? "converged" : "delegated",
      goalSeekDetail: gs,
    };
  }

  return goldenSection(adapter, {
    objectiveCell: params.objectiveCell,
    changingCell: params.changingCell,
    maxIter,
    tolerance,
    lo,
    hi,
    sign: params.goal === "minimize" ? 1 : -1,
  });
}
