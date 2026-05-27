// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";
import DaxAutocomplete from "./DaxAutocomplete";
import { DAX_FUNCTION_REFERENCE } from "../store/daxEngine";
import type { DaxTable } from "./DaxAutocomplete";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Test harness: a thin wrapper that wires DaxAutocomplete to a textarea.
// ---------------------------------------------------------------------------

const TEST_TABLES: DaxTable[] = [
  {
    name: "Sales",
    columns: [{ name: "Amount" }, { name: "Quantity" }, { name: "Date" }],
  },
  {
    name: "Products",
    columns: [{ name: "Name" }, { name: "Price" }],
  },
];

interface HarnessProps {
  initialValue?: string;
  contextTableName?: string;
  onInsertSpy?: (expr: string, caret: number) => void;
}

function Harness({ initialValue = "", contextTableName, onInsertSpy }: HarnessProps) {
  const [value, setValue] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autocomplete = DaxAutocomplete({
    textareaRef,
    value,
    onInsert: (newExpr, newCaret) => {
      setValue(newExpr);
      onInsertSpy?.(newExpr, newCaret);
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newCaret, newCaret);
      });
    },
    functions: DAX_FUNCTION_REFERENCE,
    tables: TEST_TABLES,
    contextTableName,
  });

  return (
    <div>
      <div className="dac-wrapper">
        <textarea
          ref={textareaRef}
          data-testid="expr-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autocomplete.handleChange(e);
          }}
          onKeyDown={autocomplete.handleKeyDown}
        />
        {autocomplete.dropdown}
      </div>
    </div>
  );
}

// Helper: fire change event while also setting selectionStart to simulate real typing.
function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string, caretPos?: number) {
  const pos = caretPos ?? value.length;
  // Set the value and selectionStart before firing the event.
  Object.defineProperty(textarea, "selectionStart", { configurable: true, get: () => pos });
  fireEvent.change(textarea, { target: { value } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaxAutocomplete — function suggestions", () => {
  it("shows SUM and SUMX when 'SU' is typed", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "SU");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeTruthy();

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("SUM"))).toBe(true);
    expect(labels.some((l) => l.includes("SUMX"))).toBe(true);
  });

  it("shows only CALCULATE when 'CAL' is typed (case-insensitive)", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "cal");

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("CALCULATE"))).toBe(true);
    // COUNT should not appear for prefix "cal"
    expect(labels.some((l) => l.includes("COUNT") && !l.includes("CALCULATE"))).toBe(false);
  });

  it("shows no dropdown for empty identifier", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "");

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("DaxAutocomplete — column suggestions", () => {
  it("shows column names after '[' is typed", () => {
    render(<Harness contextTableName="Sales" />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    // Simulate typing "Sales[" with caret at position 6
    typeIntoTextarea(ta, "Sales[", 6);

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("Amount"))).toBe(true);
    expect(labels.some((l) => l.includes("Quantity"))).toBe(true);
    expect(labels.some((l) => l.includes("Date"))).toBe(true);
  });

  it("filters column names by prefix after '['", () => {
    render(<Harness contextTableName="Sales" />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    // "Sales[Am" with caret at 8
    typeIntoTextarea(ta, "Sales[Am", 8);

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("Amount"))).toBe(true);
    expect(labels.some((l) => l.includes("Quantity"))).toBe(false);
  });
});

describe("DaxAutocomplete — keyboard navigation", () => {
  it("ArrowDown moves highlight to the next item", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "SU");

    // First item should be highlighted initially.
    const optionsBefore = screen.getAllByRole("option");
    expect(optionsBefore[0].getAttribute("aria-selected")).toBe("true");

    // Press ArrowDown.
    fireEvent.keyDown(ta, { key: "ArrowDown" });

    const optionsAfter = screen.getAllByRole("option");
    expect(optionsAfter[0].getAttribute("aria-selected")).toBe("false");
    expect(optionsAfter[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowUp does not go below index 0", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "SU");

    fireEvent.keyDown(ta, { key: "ArrowUp" });

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Escape closes the dropdown without inserting", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "SU");

    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(ta, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    // Value should not have changed.
    expect((ta as HTMLTextAreaElement).value).toBe("SU");
  });
});

describe("DaxAutocomplete — Enter confirms selection", () => {
  it("Enter inserts SUM(|) and places caret inside the parens", () => {
    const onInsertSpy = vi.fn();
    render(<Harness onInsertSpy={onInsertSpy} />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "SU");

    // Select SUM (it should be the first option).
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("SUM");

    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onInsertSpy).toHaveBeenCalledOnce();
    const [newExpr, newCaret] = onInsertSpy.mock.calls[0] as [string, number];
    // SUM(|) is the insertText; the caret hint is inside the parens.
    expect(newExpr).toBe("SUM()");
    // Caret should be at position 4 (inside the parens).
    expect(newCaret).toBe(4);
  });

  it("Tab also confirms selection", () => {
    const onInsertSpy = vi.fn();
    render(<Harness onInsertSpy={onInsertSpy} />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "SU");

    fireEvent.keyDown(ta, { key: "Tab" });

    expect(onInsertSpy).toHaveBeenCalledOnce();
    const [newExpr] = onInsertSpy.mock.calls[0] as [string, number];
    expect(newExpr).toContain("SUM");
  });
});

describe("DaxAutocomplete — table suggestions", () => {
  it("shows table name when typing 'Sal'", () => {
    render(<Harness />);
    const ta = screen.getByTestId("expr-input") as HTMLTextAreaElement;
    typeIntoTextarea(ta, "Sal");

    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("Sales"))).toBe(true);
  });
});
