import { useEffect, useMemo, useState } from "react";
import "./ConditionalFormattingDialog.css";

// Rule shape mirrors the snapshot's `_conditionalFormatting` entries on the
// Rust side (xlsx_io.rs ConditionalFormattingEntry → JSON object). Optional
// fields are omitted (not nulled) when empty so the JSON stays compact.
export interface CfRule {
  sqref: string;
  type:
    | "cellIs"
    | "containsText"
    | "top10"
    | "duplicateValues"
    | "uniqueValues"
    // #38: above/below the average of the rule's range.
    | "aboveAverage"
    // #38: date in the named relative range (today / yesterday / lastWeek / etc).
    | "timePeriod"
    // new in this round: advanced CF rule types.
    | "dataBar"
    | "colorScale"
    | "iconSet"
    | "expression";
  operator?: string;
  formula1?: string;
  formula2?: string;
  text?: string;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  /** #38: aboveAverage variants — Excel uses bool flags rather than an operator.
   *  When type === "aboveAverage", true means "below average". */
  aboveAverage?: { below?: boolean; equalAverage?: boolean };
  /** #38: timePeriod selector. One of the OOXML period codes Excel writes. */
  timePeriod?:
    | "today"
    | "yesterday"
    | "tomorrow"
    | "last7Days"
    | "thisWeek"
    | "lastWeek"
    | "nextWeek"
    | "thisMonth"
    | "lastMonth"
    | "nextMonth";
  priority?: number;
  stopIfTrue?: boolean;
  // #37: style hints round-trip through xlsx via dxf entries written into
  // xl/styles.xml on export. The cfRule references the dxf via dxfId so
  // Excel renders the user's chosen bold/colors on cells that match.
  style?: { bold?: boolean; fontColor?: string; bgColor?: string };
  // new in this round: dataBar / colorScale / iconSet configuration.
  /** Base color for dataBar. Defaults to #638EC6 (Excel blue). */
  color?: string;
  /** 2-color or 3-color scale variant. */
  colorScaleType?: "2color" | "3color";
  minColor?: string;
  midColor?: string;
  maxColor?: string;
  /** Preset icon style for iconSet rules. */
  iconStyle?: "3arrows" | "3traffic" | "5rating";
}

interface Props {
  sheetName: string;
  initialRules: CfRule[];
  onSave: (next: CfRule[]) => void;
  onClose: () => void;
}

// sqref accepts one or more cell or range references separated by spaces,
// e.g. "A1", "A1:C5", "A1 B2 D4:D10". Sheet qualifiers are intentionally
// rejected since Excel's `<conditionalFormatting@sqref>` is unqualified.
const SQREF_PIECE = /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/;
function isValidSqref(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  const pieces = trimmed.split(/\s+/);
  return pieces.every((p) => SQREF_PIECE.test(p));
}

const RULE_TYPE_LABELS: Record<CfRule["type"], string> = {
  cellIs: "セル値 (cellIs)",
  containsText: "テキスト含む (containsText)",
  top10: "上位/下位 (top10)",
  duplicateValues: "重複値",
  uniqueValues: "一意値",
  aboveAverage: "平均値より上/下 (aboveAverage)",
  timePeriod: "期間 (timePeriod)",
  // new in this round:
  dataBar: "データバー (dataBar)",
  colorScale: "カラースケール (colorScale)",
  iconSet: "アイコンセット (iconSet)",
  expression: "数式 (expression)",
};

// new in this round: icon-set presets shown in the rule editor dropdown.
const ICON_STYLE_OPTIONS: { value: NonNullable<CfRule["iconStyle"]>; label: string }[] = [
  { value: "3arrows", label: "3 矢印 (↑ → ↓)" },
  { value: "3traffic", label: "3 信号 (🔴 🟡 🟢)" },
  { value: "5rating", label: "5 段階評価 (★)" },
];

const TIME_PERIOD_OPTIONS: { value: NonNullable<CfRule["timePeriod"]>; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "yesterday", label: "昨日" },
  { value: "tomorrow", label: "明日" },
  { value: "last7Days", label: "過去7日間" },
  { value: "thisWeek", label: "今週" },
  { value: "lastWeek", label: "先週" },
  { value: "nextWeek", label: "翌週" },
  { value: "thisMonth", label: "今月" },
  { value: "lastMonth", label: "先月" },
  { value: "nextMonth", label: "翌月" },
];

const CELLIS_OPERATORS = [
  { value: "greaterThan", label: "より大きい" },
  { value: "lessThan", label: "より小さい" },
  { value: "equal", label: "等しい" },
  { value: "notEqual", label: "等しくない" },
  { value: "between", label: "次の間" },
  { value: "notBetween", label: "次の間以外" },
  { value: "greaterThanOrEqual", label: "以上" },
  { value: "lessThanOrEqual", label: "以下" },
] as const;

function validate(form: CfRule): string | null {
  if (!isValidSqref(form.sqref))
    return "範囲は A1 / A1:C5 / 複数区切り（半角スペース）で指定してください";
  switch (form.type) {
    case "cellIs":
      if (!form.operator) return "演算子を選択してください";
      if (!(form.formula1 ?? "").trim()) return "比較値（式）を入力してください";
      if (
        (form.operator === "between" || form.operator === "notBetween") &&
        !(form.formula2 ?? "").trim()
      )
        return "between では 2 つの式が必要です";
      break;
    case "containsText":
      if (!(form.text ?? "").trim()) return "対象のテキストを入力してください";
      break;
    case "top10":
      if (!form.rank || form.rank < 1) return "順位 (rank) は 1 以上を指定してください";
      break;
    case "duplicateValues":
    case "uniqueValues":
      break;
    case "aboveAverage":
      // No inputs required — the cfRule defaults to "above the average of
      // the selected range". `aboveAverage.below` flips to below-average.
      break;
    case "timePeriod":
      if (!form.timePeriod) return "期間を選択してください";
      break;
    // new in this round:
    case "dataBar":
      // color defaults to #638EC6 when blank — no required field.
      break;
    case "colorScale":
      if (form.colorScaleType !== "2color" && form.colorScaleType !== "3color")
        return "カラースケール種別を選択してください";
      break;
    case "iconSet":
      if (!form.iconStyle) return "アイコンスタイルを選択してください";
      break;
    case "expression":
      if (!(form.formula1 ?? "").trim()) return "数式を入力してください (例: =A1>10)";
      break;
  }
  return null;
}

function emptyForm(): CfRule {
  return {
    sqref: "",
    type: "cellIs",
    operator: "greaterThan",
    formula1: "",
    style: { bold: false, fontColor: "", bgColor: "" },
  };
}

// Clone a rule into the form's mutable shape (deep-copy the style bag so the
// list entry isn't aliased by in-progress edits).
function ruleToForm(r: CfRule): CfRule {
  return {
    ...r,
    style: r.style ? { ...r.style } : { bold: false, fontColor: "", bgColor: "" },
  };
}

function summarize(r: CfRule): string {
  switch (r.type) {
    case "cellIs":
      return `${RULE_TYPE_LABELS[r.type]} · ${r.operator ?? ""} ${r.formula1 ?? ""}${
        r.formula2 ? ` / ${r.formula2}` : ""
      }`;
    case "containsText":
      return `${RULE_TYPE_LABELS[r.type]} · "${r.text ?? ""}"`;
    case "top10":
      return `${RULE_TYPE_LABELS[r.type]} · ${r.bottom ? "下位" : "上位"} ${r.rank ?? 10}${
        r.percent ? "%" : ""
      }`;
    case "aboveAverage": {
      const dir = r.aboveAverage?.below ? "未満" : "より上";
      const eq = r.aboveAverage?.equalAverage ? " (平均含む)" : "";
      return `${RULE_TYPE_LABELS[r.type]} · 平均値${dir}${eq}`;
    }
    case "timePeriod": {
      const opt = TIME_PERIOD_OPTIONS.find((o) => o.value === r.timePeriod);
      return `${RULE_TYPE_LABELS[r.type]} · ${opt?.label ?? r.timePeriod ?? ""}`;
    }
    // new in this round:
    case "dataBar":
      return `Data bar (${r.color ?? "#638EC6"})`;
    case "colorScale":
      return `Color scale ${r.colorScaleType === "3color" ? "3" : "2"}`;
    case "iconSet": {
      const opt = ICON_STYLE_OPTIONS.find((o) => o.value === r.iconStyle);
      return `Icon set ${opt?.label ?? r.iconStyle ?? ""}`;
    }
    case "expression":
      return `Formula: ${r.formula1 ?? ""}`;
    default:
      return RULE_TYPE_LABELS[r.type];
  }
}

function styleHint(s?: CfRule["style"]): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.bold) parts.push("太字");
  if (s.fontColor) parts.push(`文字色 ${s.fontColor}`);
  if (s.bgColor) parts.push(`背景 ${s.bgColor}`);
  return parts.join(" / ");
}

export default function ConditionalFormattingDialog({
  sheetName,
  initialRules,
  onSave,
  onClose,
}: Props) {
  const [rules, setRules] = useState<CfRule[]>(() =>
    initialRules.map((r) => ({ ...r, style: r.style ? { ...r.style } : undefined })),
  );
  // -1 = adding a new rule; null = form closed.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<CfRule>(() => emptyForm());
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isDirty = useMemo(() => {
    if (rules.length !== initialRules.length) return true;
    // Shallow-compare each rule field by stringifying — fast enough for the
    // PoC sizes (a handful of rules per sheet) and avoids hand-rolling a
    // structural comparator over an optional-heavy shape.
    return JSON.stringify(rules) !== JSON.stringify(initialRules);
  }, [rules, initialRules]);

  const openAddForm = () => {
    setEditingIndex(-1);
    setForm(emptyForm());
    setFormError(null);
  };

  const openEditForm = (idx: number) => {
    setEditingIndex(idx);
    setForm(ruleToForm(rules[idx]));
    setFormError(null);
  };

  const cancelForm = () => {
    setEditingIndex(null);
    setFormError(null);
  };

  const submitForm = () => {
    if (editingIndex === null) return;
    const err = validate(form);
    if (err) {
      setFormError(err);
      return;
    }
    const isAdding = editingIndex === -1;
    // Strip empty optional fields so the saved rule matches the Rust-side
    // "omit when absent" snapshot policy. When updating, preserve the
    // original rule's priority so we don't churn render order.
    const clean: CfRule = {
      sqref: form.sqref.trim(),
      type: form.type,
      priority: isAdding ? rules.length + 1 : rules[editingIndex].priority ?? editingIndex + 1,
    };
    if (form.type === "cellIs") {
      clean.operator = form.operator;
      clean.formula1 = (form.formula1 ?? "").trim();
      if (form.operator === "between" || form.operator === "notBetween") {
        clean.formula2 = (form.formula2 ?? "").trim();
      }
    } else if (form.type === "containsText") {
      clean.operator = "containsText";
      clean.text = (form.text ?? "").trim();
    } else if (form.type === "top10") {
      clean.rank = form.rank ?? 10;
      if (form.percent) clean.percent = true;
      if (form.bottom) clean.bottom = true;
    } else if (form.type === "aboveAverage") {
      // #38: aboveAverage carries only its two bool toggles.
      if (form.aboveAverage?.below || form.aboveAverage?.equalAverage) {
        clean.aboveAverage = {};
        if (form.aboveAverage.below) clean.aboveAverage.below = true;
        if (form.aboveAverage.equalAverage) clean.aboveAverage.equalAverage = true;
      }
    } else if (form.type === "timePeriod") {
      // #38: timePeriod carries the chosen period code.
      clean.timePeriod = form.timePeriod;
    } else if (form.type === "dataBar") {
      // new in this round: dataBar carries an optional base color.
      if (form.color) clean.color = form.color;
    } else if (form.type === "colorScale") {
      // new in this round: colorScale carries variant + 2 or 3 colors.
      clean.colorScaleType = form.colorScaleType ?? "2color";
      if (form.minColor) clean.minColor = form.minColor;
      if (clean.colorScaleType === "3color" && form.midColor) clean.midColor = form.midColor;
      if (form.maxColor) clean.maxColor = form.maxColor;
    } else if (form.type === "iconSet") {
      // new in this round: iconSet carries the preset style name.
      clean.iconStyle = form.iconStyle ?? "3arrows";
    } else if (form.type === "expression") {
      // new in this round: expression carries the formula text in formula1.
      clean.formula1 = (form.formula1 ?? "").trim();
    }
    // Skip authoring-time style for dataBar / colorScale / iconSet — those
    // rule types generate their own per-cell styles and a user-picked bg
    // would shadow them.
    const acceptsAuthorStyle =
      form.type !== "dataBar" && form.type !== "colorScale" && form.type !== "iconSet";
    const styleHasValue =
      acceptsAuthorStyle &&
      form.style &&
      (form.style.bold || form.style.fontColor || form.style.bgColor);
    if (styleHasValue) {
      const s: NonNullable<CfRule["style"]> = {};
      if (form.style?.bold) s.bold = true;
      if (form.style?.fontColor) s.fontColor = form.style.fontColor;
      if (form.style?.bgColor) s.bgColor = form.style.bgColor;
      clean.style = s;
    }
    if (isAdding) {
      setRules([...rules, clean]);
    } else {
      const next = rules.slice();
      next[editingIndex] = clean;
      setRules(next);
    }
    setEditingIndex(null);
    setFormError(null);
  };

  const deleteRule = (idx: number) => {
    setRules(rules.filter((_, i) => i !== idx));
    if (editingIndex === idx) setEditingIndex(null);
  };

  const apply = () => {
    onSave(rules);
    onClose();
  };

  return (
    <div className="cf-backdrop" onClick={onClose}>
      <div
        className="cf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cf-header">
          <h2 id="cf-title" className="cf-title">条件付き書式 — {sheetName}</h2>
          <button type="button" className="cf-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="cf-body">
          {rules.length === 0 ? (
            <p className="cf-empty">このシートに条件付き書式はまだ登録されていません。</p>
          ) : (
            <ul className="cf-list" aria-label="登録済みの条件付き書式">
              {rules.map((r, idx) => {
                const styleText = styleHint(r.style);
                const isEditing = editingIndex === idx;
                return (
                  <li
                    key={`${r.sqref}-${idx}`}
                    className={`cf-item${isEditing ? " cf-item--editing" : ""}`}
                  >
                    <div className="cf-item-text">
                      <span className="cf-item-sqref">{r.sqref}</span>
                      <span className="cf-item-summary">{summarize(r)}</span>
                      {styleText && <span className="cf-item-style">書式: {styleText}</span>}
                    </div>
                    <div className="cf-item-actions">
                      <button
                        type="button"
                        className="cf-btn"
                        onClick={() => openEditForm(idx)}
                        aria-label={`${r.sqref} のルールを編集`}
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        className="cf-btn cf-btn--danger"
                        onClick={() => deleteRule(idx)}
                        aria-label={`${r.sqref} のルールを削除`}
                      >
                        削除
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {editingIndex === null ? (
            <button type="button" className="cf-btn cf-btn--add" onClick={openAddForm}>
              + 追加
            </button>
          ) : (
            <div className="cf-form" role="group" aria-label="条件付き書式の編集フォーム">
              <h3 className="cf-form-title">
                {editingIndex === -1 ? "新しい条件付き書式" : "条件付き書式を編集"}
              </h3>
              <label className="cf-field">
                <span className="cf-field-label">範囲 (sqref)</span>
                <input
                  type="text"
                  className="cf-input"
                  value={form.sqref}
                  onChange={(e) => setForm({ ...form, sqref: e.target.value })}
                  placeholder="A1:A100"
                  autoFocus
                />
              </label>
              <label className="cf-field">
                <span className="cf-field-label">ルール種別</span>
                <select
                  className="cf-input"
                  value={form.type}
                  onChange={(e) =>
                    setForm({ ...form, type: e.target.value as CfRule["type"] })
                  }
                >
                  {(Object.keys(RULE_TYPE_LABELS) as CfRule["type"][]).map((t) => (
                    <option key={t} value={t}>
                      {RULE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>

              {form.type === "cellIs" && (
                <>
                  <label className="cf-field">
                    <span className="cf-field-label">演算子</span>
                    <select
                      className="cf-input"
                      value={form.operator ?? "greaterThan"}
                      onChange={(e) => setForm({ ...form, operator: e.target.value })}
                    >
                      {CELLIS_OPERATORS.map((op) => (
                        <option key={op.value} value={op.value}>
                          {op.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cf-field">
                    <span className="cf-field-label">比較値 / 式</span>
                    <input
                      type="text"
                      className="cf-input"
                      value={form.formula1 ?? ""}
                      onChange={(e) => setForm({ ...form, formula1: e.target.value })}
                      placeholder="100 / A1 / SUM($B$1:$B$10)"
                    />
                  </label>
                  {(form.operator === "between" || form.operator === "notBetween") && (
                    <label className="cf-field">
                      <span className="cf-field-label">上限値 / 式</span>
                      <input
                        type="text"
                        className="cf-input"
                        value={form.formula2 ?? ""}
                        onChange={(e) => setForm({ ...form, formula2: e.target.value })}
                        placeholder="200"
                      />
                    </label>
                  )}
                </>
              )}

              {form.type === "containsText" && (
                <label className="cf-field">
                  <span className="cf-field-label">含むテキスト</span>
                  <input
                    type="text"
                    className="cf-input"
                    value={form.text ?? ""}
                    onChange={(e) => setForm({ ...form, text: e.target.value })}
                    placeholder="エラー"
                  />
                </label>
              )}

              {form.type === "top10" && (
                <>
                  <label className="cf-field">
                    <span className="cf-field-label">順位 N</span>
                    <input
                      type="number"
                      className="cf-input"
                      value={form.rank ?? 10}
                      min={1}
                      onChange={(e) =>
                        setForm({ ...form, rank: parseInt(e.target.value, 10) || 0 })
                      }
                    />
                  </label>
                  <label className="cf-checkbox">
                    <input
                      type="checkbox"
                      checked={!!form.bottom}
                      onChange={(e) => setForm({ ...form, bottom: e.target.checked })}
                    />
                    <span>下位（チェックなしは上位）</span>
                  </label>
                  <label className="cf-checkbox">
                    <input
                      type="checkbox"
                      checked={!!form.percent}
                      onChange={(e) => setForm({ ...form, percent: e.target.checked })}
                    />
                    <span>パーセント指定</span>
                  </label>
                </>
              )}

              {form.type === "aboveAverage" && (
                <>
                  <label className="cf-checkbox">
                    <input
                      type="checkbox"
                      checked={!!form.aboveAverage?.below}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          aboveAverage: {
                            ...(form.aboveAverage ?? {}),
                            below: e.target.checked,
                          },
                        })
                      }
                    />
                    <span>平均値より下（チェックなしは平均値より上）</span>
                  </label>
                  <label className="cf-checkbox">
                    <input
                      type="checkbox"
                      checked={!!form.aboveAverage?.equalAverage}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          aboveAverage: {
                            ...(form.aboveAverage ?? {}),
                            equalAverage: e.target.checked,
                          },
                        })
                      }
                    />
                    <span>平均値ちょうども含める</span>
                  </label>
                </>
              )}

              {form.type === "timePeriod" && (
                <label className="cf-field">
                  <span className="cf-field-label">期間</span>
                  <select
                    className="cf-select"
                    value={form.timePeriod ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        timePeriod:
                          (e.target.value as NonNullable<CfRule["timePeriod"]>) || undefined,
                      })
                    }
                  >
                    <option value="">（選択してください）</option>
                    {TIME_PERIOD_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* new in this round: dataBar — just a base-color picker. */}
              {form.type === "dataBar" && (
                <label className="cf-field cf-field--inline">
                  <span className="cf-field-label">バーの色</span>
                  <input
                    type="color"
                    className="cf-color"
                    value={form.color || "#638EC6"}
                    onChange={(e) => setForm({ ...form, color: e.target.value })}
                  />
                </label>
              )}

              {/* new in this round: colorScale — variant + 2/3 colors. */}
              {form.type === "colorScale" && (
                <>
                  <label className="cf-field">
                    <span className="cf-field-label">スケール種別</span>
                    <select
                      className="cf-input"
                      value={form.colorScaleType ?? "2color"}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          colorScaleType: e.target.value as "2color" | "3color",
                        })
                      }
                    >
                      <option value="2color">2 色</option>
                      <option value="3color">3 色</option>
                    </select>
                  </label>
                  <label className="cf-field cf-field--inline">
                    <span className="cf-field-label">最小値の色</span>
                    <input
                      type="color"
                      className="cf-color"
                      value={form.minColor || "#F8696B"}
                      onChange={(e) => setForm({ ...form, minColor: e.target.value })}
                    />
                  </label>
                  {form.colorScaleType === "3color" && (
                    <label className="cf-field cf-field--inline">
                      <span className="cf-field-label">中央値の色</span>
                      <input
                        type="color"
                        className="cf-color"
                        value={form.midColor || "#FFEB84"}
                        onChange={(e) => setForm({ ...form, midColor: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="cf-field cf-field--inline">
                    <span className="cf-field-label">最大値の色</span>
                    <input
                      type="color"
                      className="cf-color"
                      value={form.maxColor || "#63BE7B"}
                      onChange={(e) => setForm({ ...form, maxColor: e.target.value })}
                    />
                  </label>
                </>
              )}

              {/* new in this round: iconSet — preset dropdown. */}
              {form.type === "iconSet" && (
                <label className="cf-field">
                  <span className="cf-field-label">アイコンスタイル</span>
                  <select
                    className="cf-input"
                    value={form.iconStyle ?? "3arrows"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        iconStyle: e.target.value as NonNullable<CfRule["iconStyle"]>,
                      })
                    }
                  >
                    {ICON_STYLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* new in this round: expression — formula text input. */}
              {form.type === "expression" && (
                <label className="cf-field">
                  <span className="cf-field-label">数式</span>
                  <input
                    type="text"
                    className="cf-input"
                    value={form.formula1 ?? ""}
                    onChange={(e) => setForm({ ...form, formula1: e.target.value })}
                    placeholder="=A1>10 / =ISBLANK(A1) / =MOD(ROW(),2)=0"
                  />
                </label>
              )}

              {/* dataBar / colorScale / iconSet manage their own visuals — no
                  authoring style fieldset for them. */}
              {form.type !== "dataBar" &&
                form.type !== "colorScale" &&
                form.type !== "iconSet" && (
              <fieldset className="cf-style">
                <legend className="cf-field-label">書式</legend>
                <label className="cf-checkbox">
                  <input
                    type="checkbox"
                    checked={!!form.style?.bold}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        style: { ...(form.style ?? {}), bold: e.target.checked },
                      })
                    }
                  />
                  <span>太字</span>
                </label>
                <label className="cf-field cf-field--inline">
                  <span className="cf-field-label">文字色</span>
                  <input
                    type="color"
                    className="cf-color"
                    value={form.style?.fontColor || "#000000"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        style: { ...(form.style ?? {}), fontColor: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="cf-field cf-field--inline">
                  <span className="cf-field-label">背景色</span>
                  <input
                    type="color"
                    className="cf-color"
                    value={form.style?.bgColor || "#ffeb9c"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        style: { ...(form.style ?? {}), bgColor: e.target.value },
                      })
                    }
                  />
                </label>
              </fieldset>
              )}

              {formError && <p className="cf-error">{formError}</p>}
              <div className="cf-form-actions">
                <button type="button" className="cf-btn" onClick={cancelForm}>
                  キャンセル
                </button>
                <button
                  type="button"
                  className="cf-btn cf-btn--primary"
                  onClick={submitForm}
                >
                  {editingIndex === -1 ? "追加" : "更新"}
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="cf-footer">
          <p className="cf-hint">
            条件付き書式ルール（cellIs / containsText / top10 / 重複 / 一意）を作成します。
            ルール本体はスナップショットに書き込まれ、xlsx 保存時に保持されます。
            視覚的なハイライトは保存して再オープン後に反映されます (PoC)。
          </p>
          <div className="cf-footer-actions">
            <button type="button" className="cf-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="cf-btn cf-btn--primary"
              onClick={apply}
              disabled={!isDirty}
            >
              適用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
