import { describe, it, expect } from "vitest";
import { runSolver } from "./solver";
import type { GoalSeekAdapter } from "./goalSeek";

// Build a minimal adapter that simulates a workbook with a single formula:
//   objectiveCell = f(changingCell)
// where f is supplied by the test.
function makeAdapter(f: (x: number) => number): GoalSeekAdapter & { value: number } {
  const state = { value: 0, lastY: 0 };
  return {
    value: state.value,
    readNumeric(ref: string) {
      if (ref === "X") return state.value;
      if (ref === "Y") return state.lastY;
      return null;
    },
    writeNumeric(ref: string, v: number) {
      if (ref === "X") {
        state.value = v;
        state.lastY = f(v);
      }
    },
  };
}

describe("runSolver", () => {
  it("minimizes a parabola y = (x-3)^2", () => {
    const adapter = makeAdapter((x) => (x - 3) ** 2);
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "minimize",
      lowerBound: -10,
      upperBound: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.finalChanging).toBeCloseTo(3, 4);
    expect(r.finalObjective).toBeCloseTo(0, 8);
  });

  it("maximizes y = -(x-2)^2 + 5", () => {
    const adapter = makeAdapter((x) => -((x - 2) ** 2) + 5);
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "maximize",
      lowerBound: -10,
      upperBound: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.finalChanging).toBeCloseTo(2, 4);
    expect(r.finalObjective).toBeCloseTo(5, 8);
  });

  it("delegates 'value' goal to Goal Seek and returns its detail", () => {
    const adapter = makeAdapter((x) => 2 * x + 1);
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "value",
      targetValue: 11,
    });
    expect(r.ok).toBe(true);
    expect(r.finalChanging).toBeCloseTo(5, 4);
    expect(r.goalSeekDetail).toBeDefined();
  });

  it("rejects malformed bounds", () => {
    const adapter = makeAdapter((x) => x);
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "minimize",
      lowerBound: 5,
      upperBound: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid");
  });

  it("rejects 'value' without targetValue", () => {
    const adapter = makeAdapter((x) => x);
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "value",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid");
  });

  it("handles a flat constant function with a 'bracket-flat' or converged result", () => {
    const adapter = makeAdapter(() => 7);
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "minimize",
      lowerBound: -10,
      upperBound: 10,
    });
    // Golden-section just collapses the bracket regardless; ok=true,
    // finalObjective stays 7.
    expect(r.finalObjective).toBe(7);
  });

  it("returns invalid when the adapter fails to read the objective", () => {
    let firstCall = true;
    const adapter: GoalSeekAdapter = {
      readNumeric() {
        if (firstCall) {
          firstCall = false;
          return null;
        }
        return null;
      },
      writeNumeric() {},
    };
    const r = runSolver(adapter, {
      objectiveCell: "Y",
      changingCell: "X",
      goal: "minimize",
      lowerBound: 0,
      upperBound: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid");
  });
});
