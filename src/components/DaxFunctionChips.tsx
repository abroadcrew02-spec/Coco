import { DAX_FUNCTION_REFERENCE, type DaxFunctionRef } from "../store/daxEngine";
import "./DaxFunctionChips.css";

interface Props {
  /** Called with the function's `insertText` (with `|` indicating caret hint). */
  onInsert: (insertText: string) => void;
}

const CATEGORY_LABELS: Record<DaxFunctionRef["category"], string> = {
  aggregate: "集計",
  "row-context": "行コンテキスト",
  filter: "フィルター",
  logical: "論理",
};

const CATEGORY_ORDER: DaxFunctionRef["category"][] = [
  "aggregate",
  "row-context",
  "filter",
  "logical",
];

export default function DaxFunctionChips({ onInsert }: Props) {
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    functions: DAX_FUNCTION_REFERENCE.filter((f) => f.category === cat),
  }));

  return (
    <div className="dfc-root" aria-label="DAX 関数チップス">
      {grouped.map(({ category, label, functions }) => (
        <div key={category} className="dfc-group">
          <span className="dfc-category-label">{label}</span>
          <div className="dfc-chips">
            {functions.map((fn) => (
              <button
                key={fn.name}
                type="button"
                className="dfc-chip"
                title={`${fn.signature} — ${fn.description}`}
                onClick={() => onInsert(fn.insertText)}
              >
                {fn.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
