import { useEffect, useMemo, useRef, useState } from "react";
import {
  currentCellLabel,
  parseNavigationInput,
} from "../store/navigationBox";
import "./NavigationBox.css";

/** A named-range entry as surfaced by the toolbar — the integrator typically
 *  derives this by mapping `FWorkbook.getDefinedNames()`. `target` is the
 *  formula / reference string (e.g. `"=Sheet1!$A$1"`). */
export interface NamedRangeOption {
  name: string;
  target: string;
}

/** Payload the integrator receives on Enter. The integrator resolves
 *  `kind: "named"` by calling `resolveNamedRange` (see store/navigationBox)
 *  and then dispatches to `jumpToA1OnSheet`. `sheetId` is only populated
 *  when the user typed a sheet-qualified ref AND the integrator chose to
 *  pre-resolve the sheet name; otherwise the component leaves it undefined
 *  and passes `sheetName` instead via the parsed result. */
export interface NavigationTarget {
  kind: "cell" | "range" | "named";
  sheetId?: string;
  sheetName?: string;
  a1?: string;
  name?: string;
}

interface Props {
  /** Display name of the currently active sheet (e.g. "Sheet1"). */
  activeSheetName: string;
  /** Active cell or selection in A1 form (e.g. "B5" or "A1:C10"). */
  activeCellRef: string;
  /** Defined names available for autocomplete + named-range resolution. */
  availableNamedRanges: ReadonlyArray<NamedRangeOption>;
  /** Fired on Enter after a successful parse. Invalid input is suppressed. */
  onNavigate: (params: NavigationTarget) => void;
}

/**
 * Compact "Name Box" component — Excel's address input to the left of the
 * formula bar. Displays the active cell address while idle; switches to
 * an editable text field with a named-range autocomplete when focused.
 *
 * Parsing is delegated to `parseNavigationInput` so the same rules drive
 * both autocomplete filtering and Enter handling. The component is purely
 * presentational — actual selection / sheet activation lives in the
 * integrator (EditorScreen wires `jumpToA1OnSheet`).
 */
export default function NavigationBox({
  activeSheetName,
  activeCellRef,
  availableNamedRanges,
  onNavigate,
}: Props) {
  // Idle text = compact A1 (matches Excel — "B5", not "Sheet1!B5"). Switching
  // to the qualified form would be noisy since the active sheet is already
  // shown on the sheet tab strip.
  const idleText = activeCellRef || currentCellLabel(activeSheetName, "A1");

  const [focused, setFocused] = useState(false);
  // While focused, `draft` owns the visible text so the user's typing isn't
  // clobbered by selection-change events firing in the parent.
  const [draft, setDraft] = useState(idleText);
  const [activeAcIndex, setActiveAcIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // When the parent updates the active address (the spreadsheet selection
  // changed) and the input isn't focused, push the new value into the
  // visible draft so the box reflects reality. Skip while focused — that
  // would yank what the user is typing.
  useEffect(() => {
    if (!focused) setDraft(idleText);
  }, [idleText, focused]);

  // Filter named ranges by case-insensitive prefix on the trimmed draft.
  // Empty draft → empty list (the dropdown only appears once the user has
  // typed something, mirroring Excel's behaviour).
  const acMatches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [] as NamedRangeOption[];
    const matches: NamedRangeOption[] = [];
    for (const r of availableNamedRanges) {
      if (r.name.toLowerCase().startsWith(q)) matches.push(r);
      if (matches.length >= 20) break; // cap to keep the dropdown short
    }
    return matches;
  }, [draft, availableNamedRanges]);

  // Clamp the highlighted row when the filtered list shrinks.
  useEffect(() => {
    if (activeAcIndex >= acMatches.length) setActiveAcIndex(0);
  }, [acMatches.length, activeAcIndex]);

  // Keep the highlighted autocomplete row scrolled into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLLIElement>(
      `li[data-index="${activeAcIndex}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeAcIndex]);

  const commit = (text: string) => {
    const parsed = parseNavigationInput(text);
    switch (parsed.kind) {
      case "cell":
      case "range":
        onNavigate({ kind: parsed.kind, a1: parsed.a1 });
        break;
      case "sheetCell":
        onNavigate({ kind: "cell", sheetName: parsed.sheetName, a1: parsed.a1 });
        break;
      case "sheetRange":
        onNavigate({ kind: "range", sheetName: parsed.sheetName, a1: parsed.a1 });
        break;
      case "named":
        onNavigate({ kind: "named", name: parsed.name });
        break;
      case "invalid":
        // Drop the keystroke silently — Excel just plays the system error sound;
        // we restore the idle text below so the box doesn't look "stuck".
        break;
    }
    // After commit, restore the idle representation (matches Excel: the box
    // immediately reflects the new active cell once the navigation lands).
    setDraft(idleText);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // If the autocomplete dropdown has a highlighted entry, prefer that
      // — typing "MyR" and pressing Enter should jump to "MyRange" even
      // when "MyR" alone isn't a valid name.
      const ac = acMatches[activeAcIndex];
      if (ac && acMatches.length > 0) {
        onNavigate({ kind: "named", name: ac.name });
        setDraft(idleText);
        inputRef.current?.blur();
        return;
      }
      commit(draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Revert the draft and drop focus — mirrors Excel's Esc behaviour.
      setDraft(idleText);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      if (acMatches.length === 0) return;
      e.preventDefault();
      setActiveAcIndex((i) => (i + 1) % acMatches.length);
    } else if (e.key === "ArrowUp") {
      if (acMatches.length === 0) return;
      e.preventDefault();
      setActiveAcIndex(
        (i) => (i - 1 + acMatches.length) % acMatches.length,
      );
    }
  };

  const handleFocus = () => {
    setFocused(true);
    setActiveAcIndex(0);
    // Select-all so the user can immediately overwrite the address — mirrors
    // Excel where clicking the Name Box highlights the existing text.
    inputRef.current?.select();
  };

  const handleBlur = () => {
    setFocused(false);
    setDraft(idleText);
  };

  const handleAcClick = (option: NamedRangeOption) => {
    onNavigate({ kind: "named", name: option.name });
    setDraft(idleText);
    inputRef.current?.blur();
  };

  return (
    <div className="nav-box" role="combobox" aria-haspopup="listbox" aria-expanded={focused && acMatches.length > 0}>
      <input
        ref={inputRef}
        type="text"
        className="nav-box__input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        spellCheck={false}
        autoComplete="off"
        aria-label="Name Box"
        title={currentCellLabel(activeSheetName, activeCellRef || "A1")}
      />
      {focused && acMatches.length > 0 && (
        <ul
          ref={listRef}
          className="nav-box__list"
          role="listbox"
          aria-label="Named ranges"
        >
          {acMatches.map((opt, idx) => {
            const isActive = idx === activeAcIndex;
            return (
              <li
                key={opt.name}
                data-index={idx}
                className={
                  "nav-box__row" + (isActive ? " nav-box__row--active" : "")
                }
                role="option"
                aria-selected={isActive}
                // onMouseDown (not onClick) so the click registers before the
                // input's onBlur tears the dropdown down.
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleAcClick(opt);
                }}
                onMouseEnter={() => setActiveAcIndex(idx)}
              >
                <span className="nav-box__row-name">{opt.name}</span>
                <span className="nav-box__row-target">{opt.target}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
