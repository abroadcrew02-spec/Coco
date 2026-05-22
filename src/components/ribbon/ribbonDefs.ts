// Ribbon declarative model — issue #198 (Excel-like ribbon UI).
//
// The ribbon is data-driven: this file declares the tab → group → button
// hierarchy once, and `Ribbon.tsx` renders it generically. Two action kinds
// are supported:
//
//   editorCommand  — fires the existing `coco:editor-command` window event
//                    with one of EditorScreen's 108 command ids. No new
//                    command ids are invented here (issue constraint).
//   univer         — invokes a Univer-native operation through the facade
//                    (FRange.setFontWeight, FWorkbook.undo, ...). These are
//                    wired in `Ribbon.tsx` via the `onUniverAction` callback
//                    so the heavy `fUniverRef` plumbing stays in EditorScreen.
//
// Keeping the model declarative makes the command-id ↔ EditorScreen integrity
// trivially testable (see ribbonDefs.test.ts) and lets a11y / keyboard
// handling live entirely in the renderer.

import type { StringKey } from "../../i18n/locale";

/** A Univer-native operation id. The renderer maps each to a facade call. */
export type UniverActionId =
  | "paste"
  | "copy"
  | "bold"
  | "italic"
  | "underline"
  | "fontColor"
  | "fillColor"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignTop"
  | "alignMiddle"
  | "alignBottom"
  | "wrapText"
  | "mergeCells"
  | "unmergeCells"
  | "increaseDecimal"
  | "decreaseDecimal"
  | "commaStyle"
  | "undo"
  | "redo";

/** Discriminated union: a button either fires an existing editor command or
 *  a Univer-native facade operation. */
export type RibbonAction =
  | { kind: "editorCommand"; commandId: string }
  | { kind: "univer"; op: UniverActionId };

export interface RibbonButtonDef {
  /** Stable id — unique across the whole ribbon, used as React key + test hook. */
  id: string;
  /** i18n key for the visible (possibly abbreviated) label. */
  labelKey: StringKey;
  /** Optional glyph (emoji / unicode). Purely decorative — aria-hidden. */
  icon?: string;
  action: RibbonAction;
  /** Visual variant (Excel-style). `large` = big vertical button occupying a
   *  full group row; `small` = compact horizontal button. Defaults to `small`. */
  size?: "large" | "small";
  /** Optional i18n key for the full tooltip / aria-label text. When the
   *  visible label is abbreviated, this carries the unshortened description.
   *  Falls back to `labelKey` when absent. */
  tooltipKey?: StringKey;
}

export interface RibbonGroupDef {
  id: string;
  labelKey: StringKey;
  buttons: RibbonButtonDef[];
}

export interface RibbonTabDef {
  id: string;
  labelKey: StringKey;
  groups: RibbonGroupDef[];
}

const editorCommand = (commandId: string): RibbonAction => ({
  kind: "editorCommand",
  commandId,
});
const univer = (op: UniverActionId): RibbonAction => ({ kind: "univer", op });

// --- Home --------------------------------------------------------------------
const homeTab: RibbonTabDef = {
  id: "home",
  labelKey: "ribbon.tab.home",
  groups: [
    {
      id: "clipboard",
      labelKey: "ribbon.group.clipboard",
      buttons: [
        { id: "paste", labelKey: "ribbon.btn.paste", icon: "📋", action: univer("paste"), size: "large" },
        { id: "copy", labelKey: "ribbon.btn.copy", icon: "⧉", action: univer("copy") },
        {
          id: "format-painter",
          labelKey: "ribbon.btn.formatPainter",
          icon: "🖌",
          action: editorCommand("format-painter"),
        },
      ],
    },
    {
      id: "font",
      labelKey: "ribbon.group.font",
      buttons: [
        { id: "bold", labelKey: "ribbon.btn.bold", icon: "B", action: univer("bold") },
        { id: "italic", labelKey: "ribbon.btn.italic", icon: "I", action: univer("italic") },
        { id: "underline", labelKey: "ribbon.btn.underline", icon: "U", action: univer("underline") },
        {
          id: "font-color",
          labelKey: "ribbon.btn.fontColor.short",
          tooltipKey: "ribbon.btn.fontColor",
          icon: "A",
          action: univer("fontColor"),
        },
        {
          id: "fill-color",
          labelKey: "ribbon.btn.fillColor.short",
          tooltipKey: "ribbon.btn.fillColor",
          icon: "🖍",
          action: univer("fillColor"),
        },
        { id: "borders", labelKey: "ribbon.btn.borders", icon: "▦", action: editorCommand("format-borders") },
      ],
    },
    {
      id: "alignment",
      labelKey: "ribbon.group.alignment",
      buttons: [
        { id: "align-left", labelKey: "ribbon.btn.alignLeft", icon: "⬅", action: univer("alignLeft") },
        { id: "align-center", labelKey: "ribbon.btn.alignCenter", icon: "↔", action: univer("alignCenter") },
        { id: "align-right", labelKey: "ribbon.btn.alignRight", icon: "➡", action: univer("alignRight") },
        { id: "align-top", labelKey: "ribbon.btn.alignTop", icon: "⬆", action: univer("alignTop") },
        {
          id: "align-middle",
          labelKey: "ribbon.btn.alignMiddle.short",
          tooltipKey: "ribbon.btn.alignMiddle",
          icon: "⬍",
          action: univer("alignMiddle"),
        },
        { id: "align-bottom", labelKey: "ribbon.btn.alignBottom", icon: "⬇", action: univer("alignBottom") },
        {
          id: "wrap-text",
          labelKey: "ribbon.btn.wrapText.short",
          tooltipKey: "ribbon.btn.wrapText",
          icon: "↵",
          action: univer("wrapText"),
        },
        {
          id: "merge-cells",
          labelKey: "ribbon.btn.mergeCells.short",
          tooltipKey: "ribbon.btn.mergeCells",
          icon: "⊞",
          action: univer("mergeCells"),
        },
        {
          id: "unmerge-cells",
          labelKey: "ribbon.btn.unmergeCells.short",
          tooltipKey: "ribbon.btn.unmergeCells",
          icon: "⊟",
          action: univer("unmergeCells"),
        },
      ],
    },
    {
      id: "number",
      labelKey: "ribbon.group.number",
      buttons: [
        {
          id: "number-format",
          labelKey: "ribbon.btn.numberFormat",
          icon: "🔢",
          action: editorCommand("format-number"),
          size: "large",
        },
        { id: "currency", labelKey: "ribbon.btn.currency", icon: "¥", action: editorCommand("format-currency") },
        { id: "percent", labelKey: "ribbon.btn.percent", icon: "%", action: editorCommand("format-percent") },
        {
          id: "comma-style",
          labelKey: "ribbon.btn.commaStyle.short",
          tooltipKey: "ribbon.btn.commaStyle",
          icon: ",",
          action: univer("commaStyle"),
        },
        {
          id: "increase-decimal",
          labelKey: "ribbon.btn.increaseDecimal.short",
          tooltipKey: "ribbon.btn.increaseDecimal",
          icon: "←.0",
          action: univer("increaseDecimal"),
        },
        {
          id: "decrease-decimal",
          labelKey: "ribbon.btn.decreaseDecimal.short",
          tooltipKey: "ribbon.btn.decreaseDecimal",
          icon: ".0→",
          action: univer("decreaseDecimal"),
        },
      ],
    },
    {
      id: "styles",
      labelKey: "ribbon.group.styles",
      buttons: [
        {
          id: "cell-styles",
          labelKey: "ribbon.btn.cellStyles",
          icon: "🎨",
          action: editorCommand("format-cell-styles"),
          size: "large",
        },
        {
          id: "conditional-format",
          labelKey: "ribbon.btn.conditionalFormat",
          icon: "▤",
          action: editorCommand("format-conditional"),
        },
        { id: "table", labelKey: "ribbon.btn.table", icon: "⊞", action: editorCommand("insert-table") },
      ],
    },
    {
      id: "cells",
      labelKey: "ribbon.group.cells",
      buttons: [
        { id: "tab-color", labelKey: "ribbon.btn.tabColor", icon: "🏷", action: editorCommand("format-tab-color") },
        { id: "cell-format", labelKey: "ribbon.btn.cellFormat", icon: "⚙", action: editorCommand("format-manage-codes") },
        { id: "page-setup", labelKey: "ribbon.btn.pageSetup", icon: "📐", action: editorCommand("file-page-setup") },
      ],
    },
    {
      id: "editing",
      labelKey: "ribbon.group.editing",
      buttons: [
        {
          id: "auto-sum",
          labelKey: "ribbon.btn.autoSum",
          icon: "Σ",
          action: editorCommand("data-autosum"),
          size: "large",
        },
        { id: "sort", labelKey: "ribbon.btn.sort", icon: "↕", action: editorCommand("data-sort") },
        { id: "filter-search", labelKey: "ribbon.btn.filterSearch", icon: "▽", action: editorCommand("data-filter-search") },
        {
          id: "find-replace",
          labelKey: "ribbon.btn.findReplace",
          icon: "🔍",
          action: editorCommand("edit-find-replace-all"),
        },
      ],
    },
  ],
};

// --- Insert ------------------------------------------------------------------
const insertTab: RibbonTabDef = {
  id: "insert",
  labelKey: "ribbon.tab.insert",
  groups: [
    {
      id: "tables",
      labelKey: "ribbon.group.tables",
      buttons: [
        {
          id: "ins-table",
          labelKey: "ribbon.btn.table",
          icon: "⊞",
          action: editorCommand("insert-table"),
          size: "large",
        },
        { id: "ins-pivot", labelKey: "ribbon.btn.pivot", icon: "📊", action: editorCommand("insert-pivot") },
      ],
    },
    {
      id: "illustrations",
      labelKey: "ribbon.group.illustrations",
      buttons: [
        { id: "ins-image", labelKey: "ribbon.btn.image", icon: "🖼", action: editorCommand("insert-image") },
        { id: "ins-shape", labelKey: "ribbon.btn.shape", icon: "⬠", action: editorCommand("insert-shape") },
        { id: "ins-camera", labelKey: "ribbon.btn.camera", icon: "📷", action: editorCommand("insert-camera") },
      ],
    },
    {
      id: "charts",
      labelKey: "ribbon.group.charts",
      buttons: [
        {
          id: "ins-chart",
          labelKey: "ribbon.btn.chart",
          icon: "📈",
          action: editorCommand("insert-chart"),
          size: "large",
        },
        {
          id: "ins-recommended-charts",
          labelKey: "ribbon.btn.recommendedCharts",
          icon: "✨",
          action: editorCommand("insert-recommended-charts"),
        },
      ],
    },
    {
      id: "sparklines",
      labelKey: "ribbon.group.sparklines",
      buttons: [
        { id: "ins-sparkline", labelKey: "ribbon.btn.sparkline", icon: "〰", action: editorCommand("insert-sparkline") },
      ],
    },
    {
      id: "filters",
      labelKey: "ribbon.group.filters",
      buttons: [
        { id: "ins-slicer", labelKey: "ribbon.btn.slicer", icon: "▥", action: editorCommand("insert-slicer") },
      ],
    },
    {
      id: "links",
      labelKey: "ribbon.group.links",
      buttons: [
        { id: "ins-hyperlink", labelKey: "ribbon.btn.hyperlink", icon: "🔗", action: editorCommand("insert-hyperlink") },
        { id: "ins-cell-link", labelKey: "ribbon.btn.cellLink", icon: "⛓", action: editorCommand("insert-cell-link") },
      ],
    },
    {
      id: "text",
      labelKey: "ribbon.group.text",
      buttons: [
        { id: "ins-comment", labelKey: "ribbon.btn.comment", icon: "💬", action: editorCommand("insert-comment") },
        { id: "ins-symbol", labelKey: "ribbon.btn.symbol", icon: "Ω", action: editorCommand("insert-symbol") },
        { id: "ins-function", labelKey: "ribbon.btn.insertFunction", icon: "fx", action: editorCommand("insert-function") },
      ],
    },
    {
      id: "controls",
      labelKey: "ribbon.group.controls",
      buttons: [
        { id: "ins-checkbox", labelKey: "ribbon.btn.checkbox", icon: "☑", action: editorCommand("insert-checkbox") },
        { id: "ins-radio", labelKey: "ribbon.btn.radioButton", icon: "◉", action: editorCommand("insert-radio-button") },
        { id: "ins-spin", labelKey: "ribbon.btn.spinButton", icon: "⇅", action: editorCommand("insert-spin-button") },
        { id: "ins-scrollbar", labelKey: "ribbon.btn.scrollBar", icon: "▭", action: editorCommand("insert-scroll-bar") },
      ],
    },
  ],
};

// --- Formulas ----------------------------------------------------------------
const formulasTab: RibbonTabDef = {
  id: "formulas",
  labelKey: "ribbon.tab.formulas",
  groups: [
    {
      id: "function-library",
      labelKey: "ribbon.group.functionLibrary",
      buttons: [
        {
          id: "fx-insert-function",
          labelKey: "ribbon.btn.insertFunction",
          icon: "fx",
          action: editorCommand("insert-function"),
          size: "large",
        },
        { id: "fx-auto-sum", labelKey: "ribbon.btn.autoSum", icon: "Σ", action: editorCommand("data-autosum") },
      ],
    },
    {
      id: "defined-names",
      labelKey: "ribbon.group.definedNames",
      buttons: [
        {
          id: "fx-named-ranges",
          labelKey: "ribbon.btn.namedRanges",
          icon: "🏷",
          action: editorCommand("data-named-ranges"),
        },
      ],
    },
    {
      id: "formula-auditing",
      labelKey: "ribbon.group.formulaAuditing",
      buttons: [
        { id: "fx-trace", labelKey: "ribbon.btn.tracePanel", icon: "🧭", action: editorCommand("view-trace-panel") },
        {
          id: "fx-show-formulas",
          labelKey: "ribbon.btn.showFormulas",
          icon: "ƒ",
          action: editorCommand("view-show-formulas"),
        },
        {
          id: "fx-error-checking",
          labelKey: "ribbon.btn.errorChecking",
          icon: "⚠",
          action: editorCommand("tools-error-checking"),
        },
      ],
    },
    {
      id: "calculation",
      labelKey: "ribbon.group.calculation",
      buttons: [
        { id: "fx-calc-options", labelKey: "ribbon.btn.calcOptions", icon: "⚙", action: editorCommand("calc-options") },
        { id: "fx-recalc-all", labelKey: "ribbon.btn.recalcAll", icon: "↻", action: editorCommand("calc-recalc-all") },
        {
          id: "fx-recalc-sheet",
          labelKey: "ribbon.btn.recalcSheet",
          icon: "⟳",
          action: editorCommand("calc-recalc-sheet"),
        },
      ],
    },
  ],
};

// --- Data --------------------------------------------------------------------
const dataTab: RibbonTabDef = {
  id: "data",
  labelKey: "ribbon.tab.data",
  groups: [
    {
      id: "get-data",
      labelKey: "ribbon.group.getData",
      buttons: [
        {
          id: "data-csv-import",
          labelKey: "ribbon.btn.csvImportWizard",
          icon: "📥",
          action: editorCommand("file-csv-import-wizard"),
          size: "large",
        },
        {
          id: "data-import-sheet",
          labelKey: "ribbon.btn.importSheet",
          icon: "📄",
          action: editorCommand("file-import-sheet"),
        },
        {
          id: "data-connections",
          labelKey: "ribbon.btn.dataConnections",
          icon: "🔌",
          action: editorCommand("data-data-connections"),
        },
      ],
    },
    {
      id: "sort-filter",
      labelKey: "ribbon.group.sortFilter",
      buttons: [
        { id: "data-sort", labelKey: "ribbon.btn.sort", icon: "↕", action: editorCommand("data-sort") },
        {
          id: "data-advanced-filter",
          labelKey: "ribbon.btn.advancedFilter",
          icon: "▽",
          action: editorCommand("data-advanced-filter"),
        },
        {
          id: "data-filter-search",
          labelKey: "ribbon.btn.filterSearch",
          icon: "🔎",
          action: editorCommand("data-filter-search"),
        },
        {
          id: "data-sort-by-color",
          labelKey: "ribbon.btn.sortByColor",
          icon: "🌈",
          action: editorCommand("data-sort-by-color"),
        },
        {
          id: "data-filter-by-color",
          labelKey: "ribbon.btn.filterByColor",
          icon: "🎨",
          action: editorCommand("data-filter-by-color"),
        },
      ],
    },
    {
      id: "data-tools",
      labelKey: "ribbon.group.dataTools",
      buttons: [
        {
          id: "data-text-to-columns",
          labelKey: "ribbon.btn.textToColumns",
          icon: "⫶",
          action: editorCommand("data-text-to-columns"),
        },
        {
          id: "data-remove-duplicates",
          labelKey: "ribbon.btn.removeDuplicates",
          icon: "⊗",
          action: editorCommand("data-remove-duplicates"),
        },
        {
          id: "data-validation",
          labelKey: "ribbon.btn.dataValidation.short",
          tooltipKey: "ribbon.btn.dataValidation",
          icon: "✓",
          action: editorCommand("data-validation"),
        },
        { id: "data-flash-fill", labelKey: "ribbon.btn.flashFill", icon: "⚡", action: editorCommand("edit-flash-fill") },
        { id: "data-form", labelKey: "ribbon.btn.dataForm", icon: "🗒", action: editorCommand("data-form") },
        { id: "data-smart-date", labelKey: "ribbon.btn.smartDate", icon: "📅", action: editorCommand("data-smart-date") },
        { id: "data-bulk-clean", labelKey: "ribbon.btn.bulkClean", icon: "🧹", action: editorCommand("data-bulk-clean") },
        {
          id: "data-convert-to-range",
          labelKey: "ribbon.btn.convertToRange",
          icon: "▦",
          action: editorCommand("data-convert-to-range"),
        },
        {
          id: "data-range-compare",
          labelKey: "ribbon.btn.rangeCompare",
          icon: "⇄",
          action: editorCommand("data-range-compare"),
        },
      ],
    },
    {
      id: "forecast",
      labelKey: "ribbon.group.forecast",
      buttons: [
        {
          id: "data-forecast-sheet",
          labelKey: "ribbon.btn.forecastSheet",
          icon: "📈",
          action: editorCommand("data-forecast-sheet"),
        },
        {
          id: "data-analysis-toolpak",
          labelKey: "ribbon.btn.analysisToolpak",
          icon: "🧮",
          action: editorCommand("tools-analysis-toolpak"),
        },
      ],
    },
    {
      id: "outline",
      labelKey: "ribbon.group.outline",
      buttons: [
        {
          id: "data-outline-groups",
          labelKey: "ribbon.btn.outlineGroups",
          icon: "⊞",
          action: editorCommand("data-outline-groups"),
        },
        { id: "data-subtotal", labelKey: "ribbon.btn.subtotal", icon: "∑", action: editorCommand("data-subtotal") },
      ],
    },
  ],
};

// --- Review ------------------------------------------------------------------
const reviewTab: RibbonTabDef = {
  id: "review",
  labelKey: "ribbon.tab.review",
  groups: [
    {
      id: "proofing",
      labelKey: "ribbon.group.proofing",
      buttons: [
        {
          id: "rev-spell-check",
          labelKey: "ribbon.btn.spellCheck",
          icon: "✓",
          action: editorCommand("tools-spell-check"),
          size: "large",
        },
        {
          id: "rev-error-checking",
          labelKey: "ribbon.btn.errorChecking",
          icon: "⚠",
          action: editorCommand("tools-error-checking"),
        },
      ],
    },
    {
      id: "comments",
      labelKey: "ribbon.group.comments",
      buttons: [
        { id: "rev-comment", labelKey: "ribbon.btn.comment", icon: "💬", action: editorCommand("insert-comment") },
        {
          id: "rev-comments-manager",
          labelKey: "ribbon.btn.commentsManager",
          icon: "🗂",
          action: editorCommand("view-comments-manager"),
        },
        {
          id: "rev-show-all-comments",
          labelKey: "ribbon.btn.showAllComments.short",
          tooltipKey: "ribbon.btn.showAllComments",
          icon: "👁",
          action: editorCommand("view-show-all-comments"),
        },
      ],
    },
    {
      id: "protect",
      labelKey: "ribbon.group.protect",
      buttons: [
        {
          id: "rev-sheet-protection",
          labelKey: "ribbon.btn.sheetProtection",
          icon: "🔒",
          action: editorCommand("tools-sheet-protection"),
        },
      ],
    },
    {
      id: "inspect",
      labelKey: "ribbon.group.inspect",
      buttons: [
        {
          id: "rev-document-inspector",
          labelKey: "ribbon.btn.documentInspector",
          icon: "🔬",
          action: editorCommand("tools-document-inspector"),
        },
        {
          id: "rev-workbook-stats",
          labelKey: "ribbon.btn.workbookStats",
          icon: "📊",
          action: editorCommand("view-workbook-stats"),
        },
      ],
    },
  ],
};

// --- View --------------------------------------------------------------------
const viewTab: RibbonTabDef = {
  id: "view",
  labelKey: "ribbon.tab.view",
  groups: [
    {
      id: "show-hide",
      labelKey: "ribbon.group.showHide",
      buttons: [
        {
          id: "view-show-formulas",
          labelKey: "ribbon.btn.showFormulas",
          icon: "ƒ",
          action: editorCommand("view-show-formulas"),
          size: "large",
        },
        { id: "view-page-setup", labelKey: "ribbon.btn.pageSetup", icon: "📐", action: editorCommand("file-page-setup") },
        { id: "view-quick-print", labelKey: "ribbon.btn.quickPrint", icon: "🖨", action: editorCommand("file-quick-print") },
      ],
    },
    {
      id: "window",
      labelKey: "ribbon.group.window",
      buttons: [
        { id: "view-go-to", labelKey: "ribbon.btn.goTo", icon: "🧭", action: editorCommand("edit-go-to") },
        {
          id: "view-watch-window",
          labelKey: "ribbon.btn.watchWindow",
          icon: "👁",
          action: editorCommand("view-watch-window"),
        },
        {
          id: "view-watch-add",
          labelKey: "ribbon.btn.watchAddActive",
          icon: "➕",
          action: editorCommand("watch-add-active"),
        },
      ],
    },
    {
      id: "panels",
      labelKey: "ribbon.group.panels",
      buttons: [
        { id: "view-tables-panel", labelKey: "ribbon.btn.tablesPanel", icon: "⊞", action: editorCommand("view-tables-panel") },
        {
          id: "view-sparklines-panel",
          labelKey: "ribbon.btn.sparklinesPanel",
          icon: "〰",
          action: editorCommand("view-sparklines-panel"),
        },
        {
          id: "view-pivots-panel",
          labelKey: "ribbon.btn.pivotsPanel",
          icon: "📊",
          action: editorCommand("view-pivots-panel"),
        },
        {
          id: "view-slicers-panel",
          labelKey: "ribbon.btn.slicersPanel",
          icon: "▥",
          action: editorCommand("view-slicers-panel"),
        },
        {
          id: "view-charts-canvas-panel",
          labelKey: "ribbon.btn.chartsCanvasPanel",
          icon: "📈",
          action: editorCommand("view-charts-canvas-panel"),
        },
        {
          id: "view-camera-panel",
          labelKey: "ribbon.btn.cameraPanel",
          icon: "📷",
          action: editorCommand("view-camera-panel"),
        },
        {
          id: "view-errors-panel",
          labelKey: "ribbon.btn.errorsPanel",
          icon: "⚠",
          action: editorCommand("view-errors-panel"),
        },
        {
          id: "view-bookmarks-panel",
          labelKey: "ribbon.btn.bookmarksPanel",
          icon: "🔖",
          action: editorCommand("view-bookmarks-panel"),
        },
        {
          id: "view-hyperlink-manager",
          labelKey: "ribbon.btn.hyperlinkManager",
          icon: "🔗",
          action: editorCommand("view-hyperlink-manager"),
        },
        {
          id: "view-image-manager",
          labelKey: "ribbon.btn.imageManager",
          icon: "🖼",
          action: editorCommand("view-image-manager"),
        },
        { id: "view-sheet-note", labelKey: "ribbon.btn.sheetNote", icon: "📝", action: editorCommand("view-sheet-note") },
      ],
    },
    {
      id: "snapshots",
      labelKey: "ribbon.group.snapshots",
      buttons: [
        { id: "view-snapshots", labelKey: "ribbon.btn.snapshots", icon: "🕑", action: editorCommand("view-snapshots") },
        { id: "view-snapshot-now", labelKey: "ribbon.btn.snapshotNow", icon: "📸", action: editorCommand("snapshot-now") },
        {
          id: "view-snapshot-diff",
          labelKey: "ribbon.btn.snapshotDiff",
          icon: "⇄",
          action: editorCommand("view-snapshot-diff"),
        },
        {
          id: "view-snapshot-controls",
          labelKey: "ribbon.btn.snapshotControls",
          icon: "⚙",
          action: editorCommand("view-snapshot-controls"),
        },
      ],
    },
  ],
};

/** The complete ribbon model, in tab order. */
export const RIBBON_TABS: RibbonTabDef[] = [
  homeTab,
  insertTab,
  formulasTab,
  dataTab,
  reviewTab,
  viewTab,
];

/** Flat list of every editor-command id referenced by the ribbon — used by
 *  the integrity test to assert each id is dispatchable by EditorScreen. */
export function ribbonEditorCommandIds(): string[] {
  const ids: string[] = [];
  for (const tab of RIBBON_TABS) {
    for (const group of tab.groups) {
      for (const btn of group.buttons) {
        if (btn.action.kind === "editorCommand") ids.push(btn.action.commandId);
      }
    }
  }
  return ids;
}
