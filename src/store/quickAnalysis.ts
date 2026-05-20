// Pure helpers for the Excel-style "Quick Analysis" popup (Ctrl+Q). Given a
// rectangular range of cell values pulled from the active selection, suggest
// the subset of analysis actions that make sense for that shape of data.
//
// No Univer / React imports — kept side-effect free so it can be unit-tested
// without the editor harness. The integrator in EditorScreen reads values from
// the snapshot, calls `recommendForRange`, and forwards the result into
// `setQuickAnalysisDialog({...})`.
//
// Snapshot shape (Univer 0.5.x + Coco extension) consumed upstream:
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: {
//           <row>: { <col>: { v?: unknown; f?: unknown; p?: unknown } }
//         }
//       }
//     }
//   }
// `rangeValues` here is the already-extracted `[row][col]` slice of `v`s.

export type QuickAnalysisCategory =
  | "format"
  | "chart"
  | "total"
  | "table"
  | "sparkline";

export interface QuickAnalysisOption {
  /** Stable id, dispatched back to the editor's command router. */
  id: string;
  category: QuickAnalysisCategory;
  /** Short label shown on the option button (localized at render time). */
  label: string;
  /** One-line hint shown under the label / on hover. */
  description: string;
  /** When true the option only makes sense for numeric data. */
  requiresNumericData?: boolean;
}

// Catalog is intentionally small — MVP focuses on the most common actions Excel
// surfaces in its Quick Analysis flyout. Order within a category drives the
// rendering order in the dialog.
export const QUICK_ANALYSIS_OPTIONS: readonly QuickAnalysisOption[] = [
  // --- Formatting -----------------------------------------------------------
  {
    id: "format-databar",
    category: "format",
    label: "データバー",
    description: "セル内バーで値の大小を可視化",
    requiresNumericData: true,
  },
  {
    id: "format-colorscale",
    category: "format",
    label: "カラースケール",
    description: "値に応じてセル色をグラデーション",
    requiresNumericData: true,
  },
  {
    id: "format-top10",
    category: "format",
    label: "上位 10",
    description: "上位 10 件を強調表示",
    requiresNumericData: true,
  },
  {
    id: "format-clear",
    category: "format",
    label: "書式クリア",
    description: "選択範囲のセル書式を削除",
  },
  // --- Charts ---------------------------------------------------------------
  {
    id: "chart-line",
    category: "chart",
    label: "折れ線",
    description: "時系列・推移の表示に",
    requiresNumericData: true,
  },
  {
    id: "chart-bar",
    category: "chart",
    label: "棒",
    description: "カテゴリ比較に",
    requiresNumericData: true,
  },
  {
    id: "chart-pie",
    category: "chart",
    label: "円",
    description: "構成比の表示に",
    requiresNumericData: true,
  },
  {
    id: "chart-scatter",
    category: "chart",
    label: "散布図",
    description: "2 値の相関を確認",
    requiresNumericData: true,
  },
  // --- Totals ---------------------------------------------------------------
  {
    id: "total-sum",
    category: "total",
    label: "合計",
    description: "新しい行に SUM を挿入",
    requiresNumericData: true,
  },
  {
    id: "total-average",
    category: "total",
    label: "平均",
    description: "新しい行に AVERAGE を挿入",
    requiresNumericData: true,
  },
  {
    id: "total-count",
    category: "total",
    label: "個数",
    description: "新しい行に COUNTA を挿入",
  },
  {
    id: "total-percent",
    category: "total",
    label: "% (列合計に対する比率)",
    description: "新しい列に比率の式を挿入",
    requiresNumericData: true,
  },
  {
    id: "total-running",
    category: "total",
    label: "累計",
    description: "新しい列に累計を挿入",
    requiresNumericData: true,
  },
  // --- Tables ---------------------------------------------------------------
  {
    id: "table-format",
    category: "table",
    label: "テーブルに変換",
    description: "範囲を Excel テーブルとして書式設定",
  },
  {
    id: "table-pivot",
    category: "table",
    label: "ピボットテーブル",
    description: "範囲からピボットを作成",
  },
  // --- Sparklines -----------------------------------------------------------
  {
    id: "sparkline-line",
    category: "sparkline",
    label: "折れ線スパーク",
    description: "各行/列にインライン折れ線",
    requiresNumericData: true,
  },
  {
    id: "sparkline-column",
    category: "sparkline",
    label: "縦棒スパーク",
    description: "各行/列にインライン縦棒",
    requiresNumericData: true,
  },
  {
    id: "sparkline-winloss",
    category: "sparkline",
    label: "勝敗スパーク",
    description: "正負の方向のみ表示",
    requiresNumericData: true,
  },
] as const;

export type QuickAnalysisDataKind =
  | "all-numeric"
  | "all-text"
  | "mixed"
  | "header-data";

// Treat empty / null / undefined as "blank" — they don't disqualify a range
// from being all-numeric, mirroring Excel's behavior where AVERAGE skips blanks.
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

// Numeric coercion is intentionally narrow: pure JS numbers, or strings that
// parse cleanly as a number (no trailing units, no currency symbols). We don't
// reuse dataValidation.coerceNumber here because Quick Analysis suggestions
// should be conservative — false positives ("looks numeric, isn't") clutter
// the recommendation list.
function isNumericLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return false;
    if (!/^-?\d+(?:\.\d+)?$/.test(t)) return false;
    return Number.isFinite(Number(t));
  }
  return false;
}

function isTextLike(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0 && !isNumericLike(v);
  return false;
}

/**
 * Classify the shape of a 2-D value slice. Used to pick which catalog options
 * to surface as "recommended" in the dialog.
 *
 * Rules:
 *  - All non-blank cells are numeric  → "all-numeric".
 *  - All non-blank cells are text     → "all-text".
 *  - First row is text, remaining rows are mostly numeric → "header-data".
 *  - Anything else                    → "mixed".
 *  - Empty / all-blank slice          → "mixed" (fail-safe; no constraints).
 */
export function inferDataType(values: unknown[][]): QuickAnalysisDataKind {
  if (!values || values.length === 0) return "mixed";
  // Flatten once to test the overall numeric/text balance.
  const flat: unknown[] = [];
  for (const row of values) {
    if (!Array.isArray(row)) continue;
    for (const v of row) flat.push(v);
  }
  const nonBlank = flat.filter((v) => !isBlank(v));
  if (nonBlank.length === 0) return "mixed";

  const numericCount = nonBlank.filter(isNumericLike).length;
  const textCount = nonBlank.filter(isTextLike).length;

  if (numericCount === nonBlank.length) return "all-numeric";
  if (textCount === nonBlank.length) return "all-text";

  // Header detection: at least 2 rows, first row mostly text, remaining rows
  // mostly numeric (≥ 70% of their non-blank cells).
  if (values.length >= 2 && Array.isArray(values[0])) {
    const header = values[0].filter((v) => !isBlank(v));
    const headerTextRatio =
      header.length === 0 ? 0 : header.filter(isTextLike).length / header.length;
    let bodyNonBlank = 0;
    let bodyNumeric = 0;
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (!Array.isArray(row)) continue;
      for (const v of row) {
        if (isBlank(v)) continue;
        bodyNonBlank++;
        if (isNumericLike(v)) bodyNumeric++;
      }
    }
    const bodyNumericRatio =
      bodyNonBlank === 0 ? 0 : bodyNumeric / bodyNonBlank;
    if (headerTextRatio >= 0.6 && bodyNumericRatio >= 0.7) {
      return "header-data";
    }
  }
  return "mixed";
}

/**
 * Recommend the subset of QUICK_ANALYSIS_OPTIONS that fits the given data.
 * Always returns a non-empty list (falls back to the format-clear / table
 * actions which work on any data) so the dialog never renders an empty state.
 *
 * The dialog itself still renders the full catalog (tabbed) — `recommended`
 * is what gets badged / pinned to the top.
 */
export function recommendForRange(
  rangeValues: unknown[][],
): QuickAnalysisOption[] {
  const kind = inferDataType(rangeValues);
  const rowCount = rangeValues?.length ?? 0;
  const colCount =
    rowCount === 0 ? 0 : Math.max(...rangeValues.map((r) => (Array.isArray(r) ? r.length : 0)));
  const singleColumn = colCount === 1 && rowCount >= 2;
  const singleRow = rowCount === 1 && colCount >= 2;

  const want = new Set<string>();
  const add = (...ids: string[]) => ids.forEach((id) => want.add(id));

  switch (kind) {
    case "all-numeric":
      add(
        "chart-line",
        "chart-bar",
        "chart-pie",
        "format-databar",
        "format-colorscale",
        "sparkline-line",
        "sparkline-column",
        "total-sum",
        "total-average",
      );
      break;
    case "all-text":
      // Text-only ranges → counting + table-formatting are the only useful
      // suggestions. Charts / sparklines / numeric CF are silently dropped.
      add("total-count", "table-format", "format-clear");
      break;
    case "header-data":
      add(
        "table-format",
        "chart-bar",
        "chart-line",
        "total-sum",
        "total-average",
        "format-databar",
      );
      break;
    case "mixed":
    default:
      add("table-format", "chart-bar", "total-sum", "total-count");
      break;
  }

  if (singleColumn) add("sparkline-line", "total-sum");
  if (singleRow) add("sparkline-line", "sparkline-column");

  // Preserve catalog order so the dialog renders deterministically.
  return QUICK_ANALYSIS_OPTIONS.filter((opt) => want.has(opt.id));
}

/** Convenience grouping used by the dialog's tab rendering. */
export function optionsByCategory(
  options: readonly QuickAnalysisOption[] = QUICK_ANALYSIS_OPTIONS,
): Record<QuickAnalysisCategory, QuickAnalysisOption[]> {
  const out: Record<QuickAnalysisCategory, QuickAnalysisOption[]> = {
    format: [],
    chart: [],
    total: [],
    table: [],
    sparkline: [],
  };
  for (const opt of options) out[opt.category].push(opt);
  return out;
}
