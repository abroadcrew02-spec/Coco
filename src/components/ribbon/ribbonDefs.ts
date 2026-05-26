// Ribbon declarative model — issue #198 (Excel-like ribbon UI).
//
// The ribbon is data-driven: this file declares the tab → group → button
// hierarchy once, and `Ribbon.tsx` renders it generically. Three action kinds
// are supported:
//
//   editorCommand  — fires the existing `coco:editor-command` window event
//                    with one of EditorScreen's 108 command ids. No new
//                    command ids are invented here (issue constraint).
//   univer         — invokes a Univer-native operation through the facade
//                    (FRange.setFontWeight, FWorkbook.undo, ...). These are
//                    wired in `Ribbon.tsx` via the `onUniverAction` callback
//                    so the heavy `fUniverRef` plumbing stays in EditorScreen.
//   menuAction     — emits the `menu-action` window event (#202): the same
//                    event the (now removed) Tauri native menu fired. Routes
//                    file/store operations (new/open/save/export/settings...)
//                    through the existing `useMenuActions` dispatcher so the
//                    File tab works without re-implementing those flows.
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

/** Discriminated union: a button fires an existing editor command, a
 *  Univer-native facade operation, or a native-menu action id (#202).
 *
 *  #202 Phase 3: the `univer` variant may carry an optional `color` — color
 *  palette dropdown items (font / fill color) reuse the existing
 *  `fontColor` / `fillColor` ops but supply the chosen color directly, so the
 *  former `window.prompt` color input is gone (also folds in #199). */
export type RibbonAction =
  | { kind: "editorCommand"; commandId: string }
  | { kind: "univer"; op: UniverActionId; color?: string }
  | { kind: "menuAction"; menuId: string }
  // #204: in-app navigation back to the start screen. Unlike the other kinds
  // it carries no command id — the renderer invokes the `onGoHome` prop, which
  // EditorScreen wires to the unsaved-changes-guarded `goHomeAfterConfirm`.
  | { kind: "goHome" };

/** #202 Phase 3: a single item inside a dropdown menu. Fires one of the same
 *  `RibbonAction` kinds a top-level button does — no new command ids invented. */
export interface RibbonDropdownItemDef {
  /** Stable id — unique within the dropdown, used as React key + test hook. */
  id: string;
  /** i18n key for the item's visible label. */
  labelKey: StringKey;
  /** Optional glyph shown left of the label. Decorative — aria-hidden. */
  icon?: string;
  action: RibbonAction;
}

/** #202 Phase 3: dropdown definition attached to a `RibbonButtonDef`. A button
 *  that owns one renders a caret (▾) and, on click, opens a popover. Two
 *  shapes are supported via the `kind` discriminant:
 *
 *    menu     — a flat list of `RibbonDropdownItemDef` rows (paste-special,
 *               number-format presets, ...).
 *    palette  — a color-swatch grid (#199): each swatch fires the button's own
 *               `univer` op with the picked `color`. */
export type RibbonDropdownDef =
  | { kind: "menu"; items: RibbonDropdownItemDef[] }
  | {
      kind: "palette";
      /** The Univer op each swatch fires (`fontColor` / `fillColor`). */
      op: UniverActionId;
    };

export interface RibbonButtonDef {
  /** Stable id — unique across the whole ribbon, used as React key + test hook. */
  id: string;
  /** i18n key for the visible (possibly abbreviated) label. */
  labelKey: StringKey;
  /** Optional glyph (emoji / unicode). Purely decorative — aria-hidden. */
  icon?: string;
  action: RibbonAction;
  /** #202 Phase 3: optional dropdown. When present the button renders a caret
   *  and opening it shows a menu / color palette; the bare `action` still
   *  fires on a plain click (Excel's split-button behaviour). */
  dropdown?: RibbonDropdownDef;
  /** Visual variant (Excel-style). `large` = big vertical button occupying a
   *  full group row; `small` = compact horizontal button. Defaults to `small`. */
  size?: "large" | "small";
  /** Optional i18n key for the full tooltip / aria-label text. When the
   *  visible label is abbreviated, this carries the unshortened description.
   *  Falls back to `labelKey` when absent. */
  tooltipKey?: StringKey;
  /** When true the button renders icon-only (no visible label) — used for
   *  Excel's compact controls (B/I/U, alignment, number symbols). The full
   *  description is preserved in `title` / `aria-label` via tooltipKey/labelKey.
   *  Ignored for `large` buttons, which always show their label. */
  iconOnly?: boolean;
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
const menuAction = (menuId: string): RibbonAction => ({
  kind: "menuAction",
  menuId,
});
const goHome = (): RibbonAction => ({ kind: "goHome" });

/** #202 Phase 3 / #199: the color-palette swatch grid. Two rows — a standard
 *  spectrum and a neutral ramp — chosen to mirror Excel's "標準の色". Each
 *  entry is a hex string handed straight to the `fontColor` / `fillColor`
 *  Univer op. The renderer also offers an "other color" `<input type=color>`
 *  so any color outside the grid stays reachable. */
export const RIBBON_COLOR_SWATCHES: readonly string[] = [
  "#000000", "#404040", "#808080", "#bfbfbf", "#ffffff",
  "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050",
  "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0",
];

// --- File --------------------------------------------------------------------
// #202: replaces the removed Tauri native "ファイル" menu. File / store
// operations route through `menuAction` (the `menu-action` window event) so
// the existing `useMenuActions` dispatcher handles them unchanged.
const fileTab: RibbonTabDef = {
  id: "file",
  labelKey: "ribbon.tab.file",
  groups: [
    {
      id: "file-workbook",
      labelKey: "ribbon.group.fileWorkbook",
      buttons: [
        // #204: the former standalone "← Home" strip button, folded into the
        // File tab. Fires the `goHome` action, which the renderer routes to the
        // `onGoHome` prop (unsaved-changes-guarded start-screen navigation).
        {
          id: "file-go-home",
          labelKey: "ribbon.btn.goHome",
          icon: "←",
          action: goHome(),
          size: "large",
        },
        {
          id: "file-new",
          labelKey: "ribbon.btn.new",
          icon: "🗋",
          action: menuAction("new"),
          size: "large",
        },
        {
          id: "file-open",
          labelKey: "ribbon.btn.open",
          icon: "📂",
          action: menuAction("open"),
          size: "large",
        },
        {
          id: "file-templates",
          labelKey: "ribbon.btn.templates",
          icon: "🗎",
          action: editorCommand("file-templates"),
        },
      ],
    },
    {
      id: "file-save",
      labelKey: "ribbon.group.fileSave",
      buttons: [
        {
          id: "file-save",
          labelKey: "ribbon.btn.save",
          icon: "💾",
          action: menuAction("save"),
          size: "large",
        },
        {
          id: "file-save-as",
          labelKey: "ribbon.btn.saveAs",
          icon: "🗃",
          action: menuAction("save-as"),
        },
        { id: "file-snapshot-now", labelKey: "ribbon.btn.snapshotNow", icon: "📸", action: editorCommand("snapshot-now") },
      ],
    },
    {
      id: "file-import",
      labelKey: "ribbon.group.fileImport",
      buttons: [
        {
          id: "file-csv-import-wizard",
          labelKey: "ribbon.btn.csvImportWizard",
          icon: "📥",
          action: editorCommand("file-csv-import-wizard"),
        },
        {
          id: "file-import-sheet",
          labelKey: "ribbon.btn.importSheet",
          icon: "📄",
          action: editorCommand("file-import-sheet"),
        },
        {
          id: "file-import-workspace-bundle",
          labelKey: "ribbon.btn.importWorkspaceBundle",
          icon: "🗜",
          action: menuAction("import-workspace-bundle"),
        },
      ],
    },
    {
      id: "file-export",
      labelKey: "ribbon.group.fileExport",
      buttons: [
        { id: "file-export-xlsx", labelKey: "ribbon.btn.exportXlsx", icon: "📊", action: menuAction("export-xlsx") },
        { id: "file-export-csv", labelKey: "ribbon.btn.exportCsv", icon: "📑", action: menuAction("export-csv") },
        { id: "file-export-html", labelKey: "ribbon.btn.exportHtml", icon: "🌐", action: menuAction("export-html") },
        { id: "file-export-pdf", labelKey: "ribbon.btn.exportPdf", icon: "📕", action: menuAction("export-pdf") },
        {
          id: "file-export-workspace-bundle",
          labelKey: "ribbon.btn.exportWorkspaceBundle",
          icon: "🗜",
          action: menuAction("export-workspace-bundle"),
        },
      ],
    },
    {
      id: "file-print",
      labelKey: "ribbon.group.filePrint",
      buttons: [
        {
          id: "file-page-setup",
          labelKey: "ribbon.btn.pageSetup",
          icon: "📐",
          action: editorCommand("file-page-setup"),
        },
        {
          id: "file-quick-print",
          labelKey: "ribbon.btn.quickPrint",
          icon: "🖨",
          action: editorCommand("file-quick-print"),
        },
      ],
    },
    {
      id: "file-app",
      labelKey: "ribbon.group.fileApp",
      buttons: [
        {
          id: "file-settings",
          labelKey: "ribbon.btn.settings",
          icon: "⚙",
          action: menuAction("settings"),
          size: "large",
        },
        { id: "file-help", labelKey: "ribbon.btn.help", icon: "❓", action: menuAction("help") },
        {
          id: "file-check-update",
          labelKey: "ribbon.btn.checkUpdate",
          icon: "⟲",
          action: editorCommand("help-check-update"),
        },
        // #202: the native menu's "終了" had no ribbon home after the menu was
        // removed — restore reachability via the `close` menu-action.
        { id: "file-close", labelKey: "ribbon.btn.close", icon: "⏻", action: menuAction("close") },
      ],
    },
  ],
};

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
        { id: "bold", labelKey: "ribbon.btn.bold", icon: "B", action: univer("bold"), iconOnly: true },
        { id: "italic", labelKey: "ribbon.btn.italic", icon: "I", action: univer("italic"), iconOnly: true },
        { id: "underline", labelKey: "ribbon.btn.underline", icon: "U", action: univer("underline"), iconOnly: true },
        {
          id: "font-color",
          labelKey: "ribbon.btn.fontColor.short",
          tooltipKey: "ribbon.btn.fontColor",
          icon: "A",
          action: univer("fontColor"),
          iconOnly: true,
          // #202 Phase 3 (folds in #199): a color palette replaces the old
          // window.prompt — each swatch fires `fontColor` with its color.
          dropdown: { kind: "palette", op: "fontColor" },
        },
        {
          id: "fill-color",
          labelKey: "ribbon.btn.fillColor.short",
          tooltipKey: "ribbon.btn.fillColor",
          icon: "🖍",
          action: univer("fillColor"),
          iconOnly: true,
          dropdown: { kind: "palette", op: "fillColor" },
        },
        { id: "borders", labelKey: "ribbon.btn.borders", icon: "▦", action: editorCommand("format-borders"), iconOnly: true },
      ],
    },
    {
      id: "alignment",
      labelKey: "ribbon.group.alignment",
      buttons: [
        { id: "align-left", labelKey: "ribbon.btn.alignLeft", icon: "⬅", action: univer("alignLeft"), iconOnly: true },
        { id: "align-center", labelKey: "ribbon.btn.alignCenter", icon: "↔", action: univer("alignCenter"), iconOnly: true },
        { id: "align-right", labelKey: "ribbon.btn.alignRight", icon: "➡", action: univer("alignRight"), iconOnly: true },
        { id: "align-top", labelKey: "ribbon.btn.alignTop", icon: "⬆", action: univer("alignTop"), iconOnly: true },
        {
          id: "align-middle",
          labelKey: "ribbon.btn.alignMiddle.short",
          tooltipKey: "ribbon.btn.alignMiddle",
          icon: "⬍",
          action: univer("alignMiddle"),
          iconOnly: true,
        },
        { id: "align-bottom", labelKey: "ribbon.btn.alignBottom", icon: "⬇", action: univer("alignBottom"), iconOnly: true },
        {
          id: "wrap-text",
          labelKey: "ribbon.btn.wrapText.short",
          tooltipKey: "ribbon.btn.wrapText",
          icon: "↵",
          action: univer("wrapText"),
          iconOnly: true,
        },
        {
          id: "merge-cells",
          labelKey: "ribbon.btn.mergeCells.short",
          tooltipKey: "ribbon.btn.mergeCells",
          icon: "⊞",
          action: univer("mergeCells"),
          iconOnly: true,
        },
        {
          id: "unmerge-cells",
          labelKey: "ribbon.btn.unmergeCells.short",
          tooltipKey: "ribbon.btn.unmergeCells",
          icon: "⊟",
          action: univer("unmergeCells"),
          iconOnly: true,
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
          // #202 Phase 3: Excel's number-format dropdown. Only ids that map to
          // an existing editor command are listed — 標準/数値 open the format
          // dialog (`format-number`), 通貨/% reuse the quick-format commands.
          dropdown: {
            kind: "menu",
            items: [
              {
                id: "number-format-general",
                labelKey: "ribbon.menu.numberFormat.general",
                action: editorCommand("format-number"),
              },
              {
                id: "number-format-number",
                labelKey: "ribbon.menu.numberFormat.number",
                action: editorCommand("format-number"),
              },
              {
                id: "number-format-currency",
                labelKey: "ribbon.btn.currency",
                icon: "¥",
                action: editorCommand("format-currency"),
              },
              {
                id: "number-format-percent",
                labelKey: "ribbon.btn.percent",
                icon: "%",
                action: editorCommand("format-percent"),
              },
              {
                id: "number-format-more",
                labelKey: "ribbon.menu.numberFormat.more",
                action: editorCommand("format-number"),
              },
            ],
          },
        },
        { id: "currency", labelKey: "ribbon.btn.currency", icon: "¥", action: editorCommand("format-currency"), iconOnly: true },
        { id: "percent", labelKey: "ribbon.btn.percent", icon: "%", action: editorCommand("format-percent"), iconOnly: true },
        {
          id: "comma-style",
          labelKey: "ribbon.btn.commaStyle.short",
          tooltipKey: "ribbon.btn.commaStyle",
          icon: ",",
          action: univer("commaStyle"),
          iconOnly: true,
        },
        {
          id: "increase-decimal",
          labelKey: "ribbon.btn.increaseDecimal.short",
          tooltipKey: "ribbon.btn.increaseDecimal",
          icon: "←.0",
          action: univer("increaseDecimal"),
          iconOnly: true,
        },
        {
          id: "decrease-decimal",
          labelKey: "ribbon.btn.decreaseDecimal.short",
          tooltipKey: "ribbon.btn.decreaseDecimal",
          icon: ".0→",
          action: univer("decreaseDecimal"),
          iconOnly: true,
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
        {
          id: "cf-manage-rules",
          labelKey: "ribbon.btn.cfManageRules",
          icon: "📋",
          action: editorCommand("format-cf-manage-rules"),
        },
        {
          id: "quick-cf",
          labelKey: "ribbon.btn.quickCf",
          icon: "✨",
          action: editorCommand("format-quick-cf"),
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
          id: "data-get-transform",
          labelKey: "ribbon.btn.getTransform",
          icon: "⚡",
          action: editorCommand("data-get-transform"),
          size: "large",
        },
        {
          id: "data-manage-queries",
          labelKey: "ribbon.btn.manageQueries",
          icon: "📋",
          action: editorCommand("data-manage-queries"),
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

// --- Tools -------------------------------------------------------------------
// #202: replaces the removed Tauri native "ツール" menu — the what-if / macro /
// scripting long-tail plus calculation and sheet-management commands that have
// no natural home on the other Excel tabs.
const toolsTab: RibbonTabDef = {
  id: "tools",
  labelKey: "ribbon.tab.tools",
  groups: [
    {
      id: "tools-what-if",
      labelKey: "ribbon.group.whatIf",
      buttons: [
        {
          id: "tools-goal-seek",
          labelKey: "ribbon.btn.goalSeek",
          icon: "🎯",
          action: editorCommand("tools-goal-seek"),
          size: "large",
        },
        { id: "tools-scenarios", labelKey: "ribbon.btn.scenarios", icon: "🗂", action: editorCommand("tools-scenarios") },
        { id: "tools-solver", labelKey: "ribbon.btn.solver", icon: "🧮", action: editorCommand("tools-solver") },
        {
          id: "tools-quick-analysis",
          labelKey: "ribbon.btn.quickAnalysis",
          icon: "⚡",
          action: editorCommand("edit-quick-analysis"),
        },
      ],
    },
    {
      id: "tools-automation",
      labelKey: "ribbon.group.automation",
      buttons: [
        {
          id: "tools-macro",
          labelKey: "ribbon.btn.macro",
          icon: "▶",
          action: editorCommand("tools-macro"),
          size: "large",
        },
        {
          id: "tools-script-editor",
          labelKey: "ribbon.btn.scriptEditor",
          icon: "🧩",
          action: editorCommand("tools-script-editor"),
        },
        {
          id: "tools-custom-lists",
          labelKey: "ribbon.btn.customLists",
          icon: "🗒",
          action: editorCommand("settings-custom-lists"),
        },
      ],
    },
    {
      id: "tools-calculation",
      labelKey: "ribbon.group.calculation",
      buttons: [
        { id: "tools-calc-options", labelKey: "ribbon.btn.calcOptions", icon: "⚙", action: editorCommand("calc-options") },
        { id: "tools-recalc-all", labelKey: "ribbon.btn.recalcAll", icon: "↻", action: editorCommand("calc-recalc-all") },
        {
          id: "tools-recalc-sheet",
          labelKey: "ribbon.btn.recalcSheet",
          icon: "⟳",
          action: editorCommand("calc-recalc-sheet"),
        },
      ],
    },
    {
      id: "tools-sheet",
      labelKey: "ribbon.group.sheet",
      buttons: [
        {
          id: "tools-sheet-hide",
          labelKey: "ribbon.btn.sheetHide",
          icon: "🙈",
          action: editorCommand("sheet-hide-active"),
        },
        {
          id: "tools-sheet-unhide",
          labelKey: "ribbon.btn.sheetUnhide",
          icon: "👀",
          action: editorCommand("sheet-unhide"),
        },
        {
          id: "tools-sheet-move-copy",
          labelKey: "ribbon.btn.sheetMoveCopy",
          icon: "🗐",
          action: editorCommand("sheet-move-copy"),
        },
      ],
    },
    {
      id: "tools-navigation",
      labelKey: "ribbon.group.navigation",
      buttons: [
        { id: "tools-go-to", labelKey: "ribbon.btn.goTo", icon: "🧭", action: editorCommand("edit-go-to") },
        {
          id: "tools-bookmark-add",
          labelKey: "ribbon.btn.bookmarkAdd",
          icon: "🔖",
          action: editorCommand("bookmark-add-current"),
        },
        {
          id: "tools-command-palette",
          labelKey: "ribbon.btn.commandPalette",
          icon: "⌘",
          action: editorCommand("edit-command-palette"),
        },
      ],
    },
  ],
};

/** The complete ribbon model, in tab order. */
export const RIBBON_TABS: RibbonTabDef[] = [
  fileTab,
  homeTab,
  insertTab,
  formulasTab,
  dataTab,
  reviewTab,
  viewTab,
  toolsTab,
];

/** Every `RibbonAction` the ribbon can fire — a button's bare action plus, for
 *  buttons that own a `menu` dropdown, each menu item's action. Palette
 *  dropdowns fire the button's own `univer` op (covered by the bare action) so
 *  contribute no extra actions. Used by the integrity helpers below. */
function allRibbonActions(): RibbonAction[] {
  const actions: RibbonAction[] = [];
  for (const tab of RIBBON_TABS) {
    for (const group of tab.groups) {
      for (const btn of group.buttons) {
        actions.push(btn.action);
        if (btn.dropdown?.kind === "menu") {
          for (const item of btn.dropdown.items) actions.push(item.action);
        }
      }
    }
  }
  return actions;
}

/** Flat list of every editor-command id referenced by the ribbon — used by
 *  the integrity test to assert each id is dispatchable by EditorScreen.
 *  #202 Phase 3: also covers ids reachable only via a dropdown menu item. */
export function ribbonEditorCommandIds(): string[] {
  return allRibbonActions()
    .filter((a): a is Extract<RibbonAction, { kind: "editorCommand" }> => a.kind === "editorCommand")
    .map((a) => a.commandId);
}

/** Flat list of every native-menu action id referenced by the ribbon (#202) —
 *  used by the integrity test to assert each is handled by `useMenuActions`. */
export function ribbonMenuActionIds(): string[] {
  return allRibbonActions()
    .filter((a): a is Extract<RibbonAction, { kind: "menuAction" }> => a.kind === "menuAction")
    .map((a) => a.menuId);
}
