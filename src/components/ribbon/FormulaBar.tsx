// Formula bar — issue #198.
//
// The Excel "Name Box + formula input" strip that sits directly below the
// ribbon. The Name Box is the existing `NavigationBox` component, reused
// verbatim. The formula input shows the active cell's formula (or literal
// value) and commits edits back through `onCommit`.
//
// The component is presentational: EditorScreen owns the Univer facade and
// passes the current cell text in via `cellText`, plus an `onCommit` that
// writes the new value to the active range. `cellRef` is shown in the Name
// Box and `cellText` is mirrored into the editable input while not focused
// (mirrors NavigationBox's focus-guard pattern so typing isn't clobbered).

import { useEffect, useRef, useState } from "react";
import NavigationBox, {
  type NamedRangeOption,
  type NavigationTarget,
} from "../NavigationBox";
import { t } from "../../i18n/locale";
import "./FormulaBar.css";

interface Props {
  /** Active sheet display name — forwarded to the Name Box. */
  activeSheetName: string;
  /** Active cell / range in A1 form — forwarded to the Name Box. */
  activeCellRef: string;
  /** Defined names for the Name Box autocomplete. */
  availableNamedRanges: ReadonlyArray<NamedRangeOption>;
  /** Name Box navigation callback. */
  onNavigate: (target: NavigationTarget) => void;
  /** The active cell's formula string, or its literal value as text. */
  cellText: string;
  /** Commit a new value/formula to the active cell. */
  onCommit: (value: string) => void;
}

export default function FormulaBar({
  activeSheetName,
  activeCellRef,
  availableNamedRanges,
  onNavigate,
  cellText,
  onCommit,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(cellText);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror the upstream cell text into the draft while the input isn't being
  // edited — keeps the bar in sync as the user moves the selection.
  useEffect(() => {
    if (!focused) setDraft(cellText);
  }, [cellText, focused]);

  const commit = () => {
    onCommit(draft);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(cellText);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="formula-bar" role="group" aria-label={t("ribbon.formulaBar.label")}>
      <div className="formula-bar__namebox">
        <NavigationBox
          activeSheetName={activeSheetName}
          activeCellRef={activeCellRef}
          availableNamedRanges={availableNamedRanges}
          onNavigate={onNavigate}
        />
      </div>
      <span className="formula-bar__fx" aria-hidden="true">
        fx
      </span>
      <input
        ref={inputRef}
        type="text"
        className="formula-bar__input"
        value={draft}
        placeholder={t("ribbon.formulaBar.placeholder")}
        aria-label={t("ribbon.formulaBar.label")}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDraft(cellText);
        }}
      />
    </div>
  );
}
