/**
 * useDaxAutocomplete — keyboard-driven autocomplete hook for DAX formula textareas.
 *
 * Returns `{ isOpen, handleChange, handleKeyDown, dropdown }`. Caller wires
 * `handleChange` / `handleKeyDown` to the textarea events and renders `dropdown`
 * (JSX `<ul>` or `null`) under the textarea.
 *
 * Trigger rules:
 *  - Identifier characters (A-Z, a-z, underscore) → match function names and table names by prefix.
 *  - '[' immediately typed → match column names of the context table.
 *  - ESC → close dropdown without inserting.
 *  - ↑ / ↓ → navigate candidates.
 *  - Enter / Tab → confirm selection; inserts text at caret (functions get trailing `(|)`).
 *
 * Defined as a custom hook (prefix `use*`) — not a component — because it owns
 * React state via `useState` / `useEffect` / `useCallback`. This brings it under
 * the Rules of Hooks linter so conditional usage is caught.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DaxFunctionRef } from "../store/daxEngine";
import "./DaxAutocomplete.css";

export interface DaxTable {
  name: string;
  columns: Array<{ name: string }>;
}

interface Candidate {
  /** Display label (function name, table name, or column name). */
  label: string;
  /** Kind for the badge and insert-text logic. */
  kind: "function" | "table" | "column";
  /** Short description shown in the dropdown. */
  description: string;
  /** Text inserted at caret. `|` marks cursor position after insert. */
  insertText: string;
  /** Full tooltip shown on hover: "signature — description" for functions. */
  tooltip?: string;
}

interface Props {
  /** The controlled textarea element ref. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Current expression value. */
  value: string;
  /** Called when a candidate is selected to produce a new expression string and caret offset. */
  onInsert: (newExpression: string, caretPos: number) => void;
  /** Full DAX function reference. */
  functions: DaxFunctionRef[];
  /** Data model tables for column / table-name suggestions. */
  tables: DaxTable[];
  /**
   * When the editor is a CalculatedColumn, the table whose columns should be
   * suggested when `[` is typed (the "context table").
   * When undefined, the first matching table's columns are suggested.
   */
  contextTableName?: string;
}

// ---------------------------------------------------------------------------
// Token extraction helpers
// ---------------------------------------------------------------------------

/**
 * Returns the identifier prefix that the caret is currently within, or null
 * when the caret is not inside an identifier.
 * e.g.  "SU|M(...)" where | is caret → "SU"
 *       "SUM(Sa|les[..." → "Sa"
 */
function getIdentifierPrefix(text: string, caretPos: number): string | null {
  let start = caretPos;
  while (start > 0 && /[A-Za-z_]/.test(text[start - 1])) {
    start--;
  }
  const prefix = text.slice(start, caretPos);
  return prefix.length > 0 ? prefix : null;
}

/**
 * Returns the partial column name typed after `[`, or null if no `[` before caret.
 * e.g. "Sales[Am|ount" → "Am"
 */
function getColumnPrefix(text: string, caretPos: number): string | null {
  let pos = caretPos - 1;
  // Walk back through column name chars
  while (pos >= 0 && text[pos] !== "[" && text[pos] !== "]") {
    pos--;
  }
  if (pos < 0 || text[pos] !== "[") return null;
  return text.slice(pos + 1, caretPos);
}

// ---------------------------------------------------------------------------
// Build candidates
// ---------------------------------------------------------------------------

function buildCandidates(
  text: string,
  caretPos: number,
  functions: DaxFunctionRef[],
  tables: DaxTable[],
  contextTableName: string | undefined,
): Candidate[] {
  // Column-reference mode: inside [...
  const colPrefix = getColumnPrefix(text, caretPos);
  if (colPrefix !== null) {
    // Determine which table to suggest columns from.
    // Priority: contextTableName → table immediately before `[` → all tables.
    const contextTable =
      tables.find((t) => t.name === contextTableName) ??
      findTableBeforeBracket(text, caretPos, tables);

    const targetTables = contextTable ? [contextTable] : tables;
    const prefix = colPrefix.toUpperCase();

    return targetTables.flatMap((tbl) =>
      tbl.columns
        .filter((col) => col.name.toUpperCase().startsWith(prefix))
        .map((col) => ({
          label: col.name,
          kind: "column" as const,
          description: tbl.name,
          // Replace from the `[` up to caret, close the bracket after column name.
          insertText: col.name + "]",
        })),
    );
  }

  // Identifier mode: the caret is inside an identifier token.
  const prefix = getIdentifierPrefix(text, caretPos);
  if (!prefix) return [];

  const upper = prefix.toUpperCase();

  const functionCandidates: Candidate[] = functions
    .filter((fn) => fn.name.toUpperCase().startsWith(upper))
    .map((fn) => ({
      label: fn.name,
      kind: "function" as const,
      description: fn.description,
      insertText: fn.insertText, // includes | caret hint e.g. "SUM(|)"
      tooltip: `${fn.signature} — ${fn.description}`,
    }));

  const tableCandidates: Candidate[] = tables
    .filter((tbl) => tbl.name.toUpperCase().startsWith(upper))
    .map((tbl) => ({
      label: tbl.name,
      kind: "table" as const,
      description: `${tbl.columns.length} 列`,
      insertText: tbl.name + "[|]",
    }));

  return [...functionCandidates, ...tableCandidates];
}

/**
 * Tries to find a table name that appears immediately before the `[` in the text.
 * e.g. "Sales[" → looks for a table named "Sales".
 */
function findTableBeforeBracket(
  text: string,
  caretPos: number,
  tables: DaxTable[],
): DaxTable | undefined {
  // Find the `[` position
  let bracketPos = caretPos - 1;
  while (bracketPos >= 0 && text[bracketPos] !== "[") {
    bracketPos--;
  }
  if (bracketPos < 0) return undefined;
  // Extract identifier before the `[`
  let end = bracketPos;
  let start = end;
  while (start > 0 && /[A-Za-z_0-9 ]/.test(text[start - 1])) {
    start--;
  }
  const candidate = text.slice(start, end).trimEnd();
  return tables.find((t) => t.name === candidate);
}

// ---------------------------------------------------------------------------
// Apply insert to expression
// ---------------------------------------------------------------------------

/**
 * Given the current expression, caret position, and a selected candidate,
 * returns [newExpression, newCaretPos].
 */
function applyInsert(
  text: string,
  caretPos: number,
  candidate: Candidate,
): [string, number] {
  if (candidate.kind === "column") {
    // Replace from `[` position up to caretPos with the column name + `]`
    let bracketPos = caretPos - 1;
    while (bracketPos >= 0 && text[bracketPos] !== "[") {
      bracketPos--;
    }
    if (bracketPos < 0) {
      // Fallback: just insert
      const newText = text.slice(0, caretPos) + candidate.insertText + text.slice(caretPos);
      return [newText, caretPos + candidate.insertText.length];
    }
    // Keep the `[`, replace everything after it up to caretPos with the column name + `]`
    const prefix = text.slice(0, bracketPos + 1); // includes `[`
    const suffix = text.slice(caretPos);
    const inserted = candidate.insertText; // "ColumnName]"
    const newText = prefix + inserted + suffix;
    return [newText, bracketPos + 1 + inserted.length];
  }

  // Function or table: replace the current identifier prefix.
  let start = caretPos;
  while (start > 0 && /[A-Za-z_]/.test(text[start - 1])) {
    start--;
  }

  const insertRaw = candidate.insertText; // may contain `|`
  const caretHintIndex = insertRaw.indexOf("|");
  const insertText = insertRaw.replace("|", "");

  const newText = text.slice(0, start) + insertText + text.slice(caretPos);
  const newCaret =
    caretHintIndex >= 0
      ? start + caretHintIndex
      : start + insertText.length;

  return [newText, newCaret];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<Candidate["kind"], string> = {
  function: "関数",
  table: "テーブル",
  column: "列",
};

export function useDaxAutocomplete({
  textareaRef,
  value,
  onInsert,
  functions,
  tables,
  contextTableName,
}: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const dropdownRef = useRef<HTMLUListElement>(null);

  const isOpen = candidates.length > 0;

  // Reset active index when candidates change.
  useEffect(() => {
    setActiveIndex(0);
  }, [candidates]);

  // Scroll active item into view.
  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll<HTMLLIElement>("[role='option']");
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, isOpen]);

  const close = useCallback(() => setCandidates([]), []);

  const confirmSelection = useCallback(
    (index: number) => {
      const candidate = candidates[index];
      if (!candidate) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const caretPos = textarea.selectionStart ?? value.length;
      const [newExpression, newCaret] = applyInsert(value, caretPos, candidate);
      onInsert(newExpression, newCaret);
      close();
    },
    [candidates, textareaRef, value, onInsert, close],
  );

  // Exposed handler: call from textarea's onChange.
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const caretPos = e.target.selectionStart ?? 0;
      const text = e.target.value;
      const next = buildCandidates(text, caretPos, functions, tables, contextTableName);
      setCandidates(next);
    },
    [functions, tables, contextTableName],
  );

  // Exposed handler: call from textarea's onKeyDown.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, candidates.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          confirmSelection(activeIndex);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation(); // Don't let MeasureEditorDialog close the dialog
          close();
          break;
        default:
          break;
      }
    },
    [isOpen, candidates.length, activeIndex, confirmSelection, close],
  );

  return {
    isOpen,
    handleChange,
    handleKeyDown,
    dropdown: isOpen ? (
      <ul
        ref={dropdownRef}
        role="listbox"
        aria-label="DAX 候補"
        className="dac-dropdown"
      >
        {candidates.map((c, i) => (
          <li
            key={`${c.kind}:${c.label}`}
            role="option"
            aria-selected={i === activeIndex ? "true" : "false"}
            className="dac-item"
            title={c.tooltip}
            onMouseDown={(e) => {
              // Use mousedown to prevent the textarea from losing focus.
              e.preventDefault();
              confirmSelection(i);
            }}
            onMouseEnter={() => setActiveIndex(i)}
          >
            <span className="dac-item-name">{c.label}</span>
            <span className="dac-item-desc">{c.description}</span>
            <span className="dac-item-kind">{KIND_LABELS[c.kind]}</span>
          </li>
        ))}
      </ul>
    ) : null,
  };
}
