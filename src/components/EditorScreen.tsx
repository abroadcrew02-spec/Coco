import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Univer,
  UniverInstanceType,
  LocaleType,
  CommandType,
  CustomCommandExecutionError,
  type IWorkbookData,
} from "@univerjs/core";
import { defaultTheme } from "@univerjs/design";
import { UniverRenderEnginePlugin } from "@univerjs/engine-render";
import { UniverFormulaEnginePlugin } from "@univerjs/engine-formula";
import { UniverUIPlugin } from "@univerjs/ui";
import { UniverDocsPlugin } from "@univerjs/docs";
import { UniverDocsUIPlugin } from "@univerjs/docs-ui";
import { UniverSheetsPlugin } from "@univerjs/sheets";
import { UniverSheetsUIPlugin } from "@univerjs/sheets-ui";
import { UniverSheetsFormulaPlugin } from "@univerjs/sheets-formula";
import { UniverSheetsFormulaUIPlugin } from "@univerjs/sheets-formula-ui";
import { UniverFindReplacePlugin } from "@univerjs/find-replace";
import { UniverSheetsFindReplacePlugin } from "@univerjs/sheets-find-replace";
import { UniverSheetsFilterPlugin } from "@univerjs/sheets-filter";
import { FUniver } from "@univerjs/facade";

import "@univerjs/design/lib/index.css";
import "@univerjs/ui/lib/index.css";
import "@univerjs/docs-ui/lib/index.css";
import "@univerjs/sheets-ui/lib/index.css";
import "@univerjs/sheets-formula-ui/lib/index.css";
import "@univerjs/find-replace/lib/index.css";

import { undoRedoOverride } from "./univerUndoRedoOverride";
import { registerCocoContextMenu } from "./univerContextMenu";
import { buildCocoUniverLocale } from "./cocoUniverLocale";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { useAutoSave } from "../hooks/useAutoSave";
import type { CompatibilityWarning } from "../types/workbook";
import SheetPickerModal from "./SheetPickerModal";
import SaveFailureDialog from "./SaveFailureDialog";
import BusyOverlay from "./BusyOverlay";
import SnapshotHistoryDialog from "./SnapshotHistoryDialog";
import CompatibilityWarningsDialog from "./CompatibilityWarningsDialog";
import NamedRangesDialog, { type NamedRangeEntry } from "./NamedRangesDialog";
import DataValidationDialog, { type DataValidationEntry } from "./DataValidationDialog";
import ConditionalFormattingDialog, { type CfRule } from "./ConditionalFormattingDialog";
import InsertHyperlinkDialog, { type HyperlinkFormValue } from "./InsertHyperlinkDialog";
import {
  patchHyperlinkRenders,
  lookupHyperlink,
  classifyHyperlink,
  chooseHyperlinkRestyle,
} from "./hyperlinkRender";
import { patchCfRenders } from "./conditionalFormatRender";
import { patchOutlineRenders } from "./outlineRender";
import { patchTableRenders } from "./tableRender";
import { patchSparklineRenders } from "./sparklineRender";
import OutlineGroupDialog from "./OutlineGroupDialog";
import { type OutlineGroup, addGroup as addOutlineGroup } from "../store/outlineGroups";
import InsertTableDialog from "./InsertTableDialog";
import TableInfoPanel from "./TableInfoPanel";
import {
  type TableEntry,
  collectAllTableNames,
  removeTable,
  renameTable as renameWorkbookTable,
} from "../store/tables";
import InsertSparklineDialog from "./InsertSparklineDialog";
import SparklineListPanel from "./SparklineListPanel";
import {
  type SparklineEntry,
  addSparkline,
  removeSparkline,
} from "../store/sparklines";
import PageSetupDialog from "./PageSetupDialog";
import {
  type PageSetupValue,
  getPageSetup,
  setPageSetup,
} from "../store/pageSetup";
import ThreadedCommentDialog from "./ThreadedCommentDialog";
import {
  type ThreadedComment,
  normalizeToThread,
} from "../store/threadedComments";
import CellStylesDialog from "./CellStylesDialog";
import {
  type CellStylePreset,
  applyPresetToRange,
} from "../store/cellStyles";
import GoalSeekDialog from "./GoalSeekDialog";
import { type GoalSeekAdapter } from "../store/goalSeek";
import { patchShowFormulasView } from "./showFormulasRender";
import { patchErrorIndicators } from "./errorIndicatorRender";
import { collectAuditIssues } from "../store/formulaAudit";
import ErrorIndicatorsPanel from "./ErrorIndicatorsPanel";
import ErrorCheckingDialog from "./ErrorCheckingDialog";
import SubtotalDialog from "./SubtotalDialog";
import {
  type SubtotalParams,
  applySubtotals,
  stripSubtotalRows,
} from "../store/subtotals";
import RemoveDuplicatesDialog from "./RemoveDuplicatesDialog";
import {
  type RemoveDuplicatesParams,
  applyToSheet as applyRemoveDupesToSheet,
} from "../store/removeDuplicates";
import TextToColumnsDialog from "./TextToColumnsDialog";
import {
  type TextToColumnsParams,
  type SheetData as TtcSheetData,
} from "../store/textToColumns";
import {
  applyToSheet as applyTextToColumnsToSheet,
} from "../store/textToColumns";
import AdvancedFilterDialog from "./AdvancedFilterDialog";
import {
  type AdvancedFilterParams,
  applyAdvancedFilter,
} from "../store/advancedFilter";
import FlashFillDialog from "./FlashFillDialog";
import {
  type FlashFillTransform,
  runFlashFill,
  describeTransform,
} from "../store/flashFill";
import InsertPivotDialog from "./InsertPivotDialog";
import PivotListPanel from "./PivotListPanel";
import {
  type PivotConfig,
  type PivotEntry,
  type WorkbookPivotSnapshot,
  generatePivotName,
  collectAllPivotNames,
  inferFieldNames,
  computePivot,
  addPivot as addPivotToSheet,
  refreshPivot as refreshPivotInSheet,
  parseA1Range as parsePivotA1Range,
  cellToA1 as pivotCellToA1,
} from "../store/pivots";
import ChartCanvasPanel from "./ChartCanvasPanel";
import InsertSlicerDialog from "./InsertSlicerDialog";
import SlicerPanel from "./SlicerPanel";
import {
  type SlicerEntry,
  type WorkbookSlicerSnapshot,
  generateSlicerName,
  removeSlicer as removeSlicerHelper,
  toggleSlicerValue as toggleSlicerValueHelper,
} from "../store/slicers";
import { patchSlicerFilters } from "./slicerRender";
import QuickAnalysisDialog from "./QuickAnalysisDialog";
import {
  type QuickAnalysisOption,
  recommendForRange,
} from "../store/quickAnalysis";
import FormulaTracePanel from "./FormulaTracePanel";
import UnhideSheetDialog from "./UnhideSheetDialog";
import {
  hideSheet,
  unhideSheet,
  listHiddenSheets,
  listVisibleSheets,
} from "../store/sheetVisibility";
import MoveCopySheetDialog from "./MoveCopySheetDialog";
import {
  moveSheet,
  copySheet,
  listSheetsInOrder,
} from "../store/moveCopySheet";
import InsertFunctionDialog from "./InsertFunctionDialog";
import CustomListsDialog from "./CustomListsDialog";
import CalculationOptionsDialog from "./CalculationOptionsDialog";
import {
  type CalcMode,
  getCalcMode,
  setCalcMode as persistCalcMode,
} from "../store/calcMode";
import WatchWindowPanel from "./WatchWindowPanel";
import {
  addWatch,
  loadWatchList,
  saveWatchList,
} from "../store/watchList";
import { toA1Ref } from "../store/formulaAudit";
import ScenarioManagerDialog from "./ScenarioManagerDialog";
import {
  type ScenarioAdapter,
  type ScenarioEntry,
  type WorkbookScenarioSnapshot,
  listScenarios,
  addScenario,
  removeScenario,
  applyScenario,
  captureFromCurrentValues,
} from "../store/scenarios";
import ForecastSheetDialog, { type ForecastApplyParams } from "./ForecastSheetDialog";
import { runForecast, parseXValues } from "../store/forecastSheet";
import RecommendedChartsDialog from "./RecommendedChartsDialog";
import { type ChartRecommendation, analyzeRange } from "../store/recommendedCharts";
import CfRuleManagerDialog from "./CfRuleManagerDialog";
import {
  type WorkbookCfSnapshot,
  reorderRule as reorderCfRule,
  deleteRule as deleteCfRule,
} from "../store/cfRuleManager";
import SnapshotDiffDialog from "./SnapshotDiffDialog";
// Single-thread InsertCommentDialog superseded by ThreadedCommentDialog;
// its CommentEntry type lives in its own module for other consumers.
import InsertChartDialog, { type ChartFormValue } from "./InsertChartDialog";
import NumberFormatDialog, { type NumberFormatValue } from "./NumberFormatDialog";
import InsertImageDialog, {
  type ImageFormValue,
  type ImagePickResult,
} from "./InsertImageDialog";
import SortDialog, { type SortFormValue } from "./SortDialog";
import SheetTabColorDialog from "./SheetTabColorDialog";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";
import CommentIndicatorsPanel from "./CommentIndicatorsPanel";
import ChartPreviewPanel from "./ChartPreviewPanel";
import { computeChartPreviews, type ChartPreview } from "./chartPreviewData";
import ImagePreviewPanel from "./ImagePreviewPanel";
import { requestSettings, requestHelp } from "../hooks/useGlobalShortcuts";
import { confirmDiscardIfUnsaved } from "../store/dirtyGuard";
import { routeOpenPath } from "../store/pathRouter";
import { registerSnapshotFlush } from "../store/snapshotSync";
import { timeAgoJa } from "./timeAgo";
import {
  computeSnapshotStats,
  formatSnapshotStats,
  shouldSkipBackgroundSnapshotSync,
} from "../store/snapshotStats";
import { isSheetProtectedInSnapshot } from "../store/sheetProtection";
import { extractCellStyle, applyCellStyle } from "../store/formatPainter";
import { inferAutoSumRange, buildSumFormula } from "../store/autoSum";
import {
  applyQuickNumberFormat,
  QUICK_FMT_CURRENCY,
  QUICK_FMT_PERCENT,
} from "../store/quickNumberFormat";
import {
  computeCommentIndicators,
  type CommentIndicator,
} from "../store/commentIndicators";
import {
  computeImagePreviews,
  colRowToA1,
  type ImagePreview,
} from "../store/imagePreviews";
import { validateMutation, extractCellWrites } from "../store/dataValidation";
import { getLocale, t } from "../i18n/locale";
import "./EditorScreen.css";

// req 5.4.1: "loading" blocks editing (snapshot is being replaced); "saving"
// and "exporting" let the user keep working since edits race the operation.
const BUSY_LABELS: Partial<Record<string, { label: string; blocking: boolean }>> = {
  loading: { label: "読み込み中...", blocking: true },
  saving: { label: "保存中...", blocking: false },
  exporting: { label: "エクスポート中...", blocking: false },
};

const SAVE_STATUS_LABELS: Record<string, string> = {
  loading: "読み込み中...",
  import_warning: "インポート警告あり",
  unsaved: "未保存",
  saving: "保存中...",
  saved: "保存済み",
  auto_saved: "自動保存済み",
  save_failed: "保存失敗",
  exporting: "エクスポート中...",
  export_done: "エクスポート完了",
  export_failed: "エクスポート失敗",
  recovery_available: "復元候補あり",
};

const EDITOR_NOT_READY_MESSAGE =
  "エディタを初期化中です。少し待ってからもう一度実行してください。";
const SNAPSHOT_UNAVAILABLE_MESSAGE =
  "ワークブックの内容を取得できませんでした。ホームへ戻って、もう一度開き直してください。";

export default function EditorScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Univer | null>(null);
  const fUniverRef = useRef<FUniver | null>(null);
  // Stable refs for the openX dialog handlers so the Univer context-menu
  // commands (registered once at mount with empty-deps useEffect) always
  // see the *latest* React-side openX function, not the one captured at
  // first render. Each render syncs the current openX values below.
  const openCommentDialogRef = useRef<() => void>(() => {});
  const openHyperlinkDialogRef = useRef<() => void>(() => {});
  const openNumberFormatDialogRef = useRef<() => void>(() => {});

  const {
    saveStatus,
    importWarnings,
    exportWarnings,
    currentHandle,
    currentSnapshotJson,
    lastError,
    lastSavedAt,
    save,
    promptSaveAs,
    dismissSaveError,
    exportXlsx,
    listSheetNames,
    exportCsvToPath,
    goHome,
    dismissWarnings,
    dismissExportWarnings,
    updateSnapshot,
    pushCocoCheckpoint,
    markDirty,
    newWorkbook,
    openCoco,
    importXlsx,
    importCsv,
  } = useWorkbookStore();

  // #97: wrapper for apply-style snapshot mutations (AutoSum, format painter,
  // hyperlink, CF, DV, chart, image, comment, quick number format). These
  // operations bypass Univer's commandService — without this checkpoint,
  // Ctrl+Alt+Z (Coco undo) can't roll them back. Univer-mediated mutations
  // (typing, insertDefinedName, etc.) keep using updateSnapshot directly so
  // Univer's own Ctrl+Z still owns those.
  const applyMutatedSnapshot = useCallback(
    (newSnapshotJson: string) => {
      pushCocoCheckpoint(useWorkbookStore.getState().currentSnapshotJson);
      updateSnapshot(newSnapshotJson);
    },
    [pushCocoCheckpoint, updateSnapshot],
  );

  const [sheetPicker, setSheetPicker] = useState<{ id: string; name: string }[] | null>(null);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [editorInitError, setEditorInitError] = useState<string | null>(null);
  const [editorOperationError, setEditorOperationError] = useState<string | null>(null);
  // Command palette (Ctrl+Shift+P / Cmd+Shift+P). Boolean state — the command
  // list is rebuilt on every render so the palette always sees the latest
  // handler closures and store actions.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [warningsDialog, setWarningsDialog] = useState<null | "import" | "export">(null);
  // Named-ranges dialog state: null while closed; once opened we snapshot the
  // current set so the user can cancel out without mutating the workbook.
  const [namedRanges, setNamedRanges] = useState<NamedRangeEntry[] | null>(null);
  // Data-validation dialog state: null while closed; opened with the rules for
  // the currently-active sheet. Edits are flushed straight into the snapshot
  // because Univer has no first-class DV API we wire to here.
  const [dvDialog, setDvDialog] = useState<
    null | { sheetId: string; sheetName: string; rules: DataValidationEntry[] }
  >(null);
  // Conditional-formatting dialog state. We snapshot the active sheet's
  // current rules + the sheet name when opening so the user can cancel out.
  const [cfDialog, setCfDialog] = useState<
    { sheetName: string; sheetId: string; rules: CfRule[] } | null
  >(null);
  // Insert-hyperlink dialog state: when non-null the dialog is open with the
  // captured active-cell ref + sheet id snapshotted at open time. We pin the
  // sheet id so the user can apply later even if the underlying selection moves.
  const [hyperlinkCtx, setHyperlinkCtx] = useState<
    | { sheetId: string; cell: string; display: string }
    | null
  >(null);
  // Comment dialog state: null while closed. Captures the active sheet + cell
  // at open time so subsequent selection changes don't move the target.
  const [commentDialog, setCommentDialog] = useState<{
    sheetId: string;
    cellRef: string;
    existing: ThreadedComment | null;
  } | null>(null);
  // Chart dialog state: null while closed. Pins the active sheet and the
  // range derived from the current selection at open time so the user's
  // input lands on a stable target even if focus shifts.
  const [chartDialog, setChartDialog] = useState<{
    sheetId: string;
    range: string;
  } | null>(null);
  // Number-format dialog state: null while closed. Captures the active sheet
  // + the bounding rows/cols of the selection (inclusive) at open time, plus
  // a human-readable range label and the format code of the anchor cell for
  // the dialog to pre-select a matching preset.
  const [numFmtDialog, setNumFmtDialog] = useState<{
    sheetId: string;
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    rangeLabel: string;
    initialCode: string;
  } | null>(null);
  // Insert-image dialog: null while closed. Captures the active sheet + the
  // top-left of the active range so the image anchors where the user clicked.
  const [imageDialog, setImageDialog] = useState<{
    sheetId: string;
    cell: string;
  } | null>(null);
  // Sort dialog: null while closed. Pins the active sheet + a default A1 range
  // derived from the current selection at open time so the user's input lands
  // on a stable target even if focus shifts.
  const [sortDialog, setSortDialog] = useState<{
    sheetId: string;
    range: string;
  } | null>(null);
  // Tab-color dialog state. Captures the active sheet id + name + the
  // currently-applied color at open time so the dialog can preselect the
  // matching swatch and so the apply callback writes to a stable target
  // (mirrors the sheet-protection / number-format pinning pattern).
  const [tabColorDialog, setTabColorDialog] = useState<{
    sheetId: string;
    sheetName: string;
    initialColor: string | null;
  } | null>(null);
  // Row/column outline dialog. Pins the active sheet + a snapshot of its
  // existing groups + the current selection rect at open time.
  const [outlineDialog, setOutlineDialog] = useState<{
    sheetId: string;
    sheetName: string;
    rows: OutlineGroup[];
    cols: OutlineGroup[];
    selection: { startRow: number; endRow: number; startCol: number; endCol: number } | null;
  } | null>(null);
  // Insert-Table dialog state. Pins active sheet + default range at open time.
  const [tableDialog, setTableDialog] = useState<{
    sheetId: string;
    range: string;
  } | null>(null);
  // Toggleable sidebars (initial: closed).
  const [tablesPanelOpen, setTablesPanelOpen] = useState(false);
  // Insert-Sparkline dialog state. Pins active sheet + default source + anchor.
  const [sparklineDialog, setSparklineDialog] = useState<{
    sheetId: string;
    sourceRange: string;
    anchorCell: string;
  } | null>(null);
  const [sparklinesPanelOpen, setSparklinesPanelOpen] = useState(false);
  // Page Setup dialog state. Pins active sheet + a copy of its effective page setup.
  const [pageSetupDialog, setPageSetupDialog] = useState<{
    sheetId: string;
    sheetName: string;
    initial: PageSetupValue;
  } | null>(null);
  // Cell Styles gallery dialog.
  const [cellStylesDialog, setCellStylesDialog] = useState<{
    sheetId: string;
    range: string;
  } | null>(null);
  // Goal Seek dialog state. Adapter wraps Univer FUniver to read/write values.
  const [goalSeekState, setGoalSeekState] = useState<{
    targetCell: string;
    changingCell: string;
    adapter: GoalSeekAdapter;
  } | null>(null);
  // Formula audit: Ctrl+` shows formula text in cells.
  const [showFormulasMode, setShowFormulasMode] = useState(false);
  const [errorsPanelOpen, setErrorsPanelOpen] = useState(false);
  const [errorCheckingOpen, setErrorCheckingOpen] = useState(false);
  // Wave 3 data-tab features.
  const [subtotalDialog, setSubtotalDialog] = useState<{
    sheetId: string;
    range: string;
    sheetSnapshot: { cellData?: Record<string, Record<string, unknown>>; rowData?: Record<string, unknown> };
  } | null>(null);
  const [removeDuplicatesDialog, setRemoveDuplicatesDialog] = useState<{
    sheetId: string;
    range: string;
    sheetSnapshot: { cellData?: Record<string, Record<string, unknown>> };
  } | null>(null);
  const [textToColumnsDialog, setTextToColumnsDialog] = useState<{
    sheetId: string;
    range: string;
    sampleRows: string[];
  } | null>(null);
  const [advancedFilterDialog, setAdvancedFilterDialog] = useState<{
    sheetId: string;
    range: string;
  } | null>(null);
  const [flashFillDialog, setFlashFillDialog] = useState<{
    sheetId: string;
    col: number;
    transform: FlashFillTransform;
    filled: string[];
    sourceCol: string[];
    examplesMask: boolean[];
  } | null>(null);
  // Wave 4
  const [pivotDialog, setPivotDialog] = useState<{
    sheetId: string;
    sourceRange: string;
    destCell: string;
    fieldNames: string[];
  } | null>(null);
  const [pivotsPanelOpen, setPivotsPanelOpen] = useState(false);
  const [chartsCanvasPanelOpen, setChartsCanvasPanelOpen] = useState(false);
  const [slicerDialogOpen, setSlicerDialogOpen] = useState(false);
  const [slicersPanelOpen, setSlicersPanelOpen] = useState(false);
  const [quickAnalysisDialog, setQuickAnalysisDialog] = useState<{
    sheetId: string;
    range: string;
    rangeLabel: string;
    cellCount: number;
    recommended: QuickAnalysisOption[];
  } | null>(null);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
  const [traceActiveSheetId, setTraceActiveSheetId] = useState<string | null>(null);
  const [traceActiveRow, setTraceActiveRow] = useState<number | null>(null);
  const [traceActiveCol, setTraceActiveCol] = useState<number | null>(null);
  // Wave 5
  const [unhideDialog, setUnhideDialog] = useState<{ hiddenSheets: { sheetId: string; name: string }[] } | null>(null);
  const [moveCopyDialog, setMoveCopyDialog] = useState<{
    sheetId: string;
    sheetName: string;
    sheets: { sheetId: string; name: string }[];
  } | null>(null);
  const [insertFunctionCtx, setInsertFunctionCtx] = useState<{ sheetId: string; cellRef: string } | null>(null);
  const [customListsCtx, setCustomListsCtx] = useState<{ initialActiveRange: string } | null>(null);
  const [calcOptionsOpen, setCalcOptionsOpen] = useState(false);
  const [calcMode, setCalcModeState] = useState<CalcMode>(() => getCalcMode());
  const [watchWindowOpen, setWatchWindowOpen] = useState(false);
  // Wave 6
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [scenarioAdapter, setScenarioAdapter] = useState<ScenarioAdapter | null>(null);
  const [forecastDialog, setForecastDialog] = useState<{ xRange: string; yRange: string } | null>(null);
  const [recommendedChartsDialog, setRecommendedChartsDialog] = useState<{
    sheetId: string;
    range: string;
    recommendations: ChartRecommendation[];
  } | null>(null);
  const [cfManagerOpen, setCfManagerOpen] = useState(false);
  const [snapshotDiffOpen, setSnapshotDiffOpen] = useState(false);
  const [snapshotDiffOptions, setSnapshotDiffOptions] = useState<Array<{ id: string; label: string }>>([]);
  // Format Painter (書式コピー) state. Excel's paintbrush:
  //   - "idle"   : tool is off.
  //   - "single" : armed for one paste; next selection-change applies + deactivates.
  //   - "sticky" : applies on every selection-change until ESC (or another single click on the button).
  // `pendingFormat` holds the style payload captured at activation time. We
  // capture once when the tool is armed so that user-driven selection changes
  // after activation don't reset the source.
  const [formatPainterMode, setFormatPainterMode] = useState<
    "idle" | "single" | "sticky"
  >("idle");
  const pendingFormatRef = useRef<Record<string, unknown> | null>(null);
  // Latches the selection range that was active *at activation time* so the
  // selection-change listener can ignore the initial fire if Univer happens to
  // emit one synchronously when the user clicks the button.
  const formatPainterArmedAtRef = useRef<number>(0);

  const getReadyWorkbook = useCallback((label: string) => {
    const fUniver = fUniverRef.current;
    let workbook: ReturnType<FUniver["getActiveWorkbook"]> | null | undefined = null;
    try {
      workbook = fUniver?.getActiveWorkbook();
    } catch {
      workbook = null;
    }
    if (!fUniver || !workbook) {
      setEditorOperationError(`${label}: ${EDITOR_NOT_READY_MESSAGE}`);
      return null;
    }
    setEditorOperationError(null);
    return { fUniver, workbook };
  }, []);

  const getSnapshotForTool = useCallback(
    (label: string): Record<string, unknown> | null => {
      if (!currentSnapshotJson) {
        setEditorOperationError(`${label}: ${SNAPSHOT_UNAVAILABLE_MESSAGE}`);
        return null;
      }
      try {
        const snapshot = JSON.parse(currentSnapshotJson) as Record<string, unknown>;
        setEditorOperationError(null);
        return snapshot;
      } catch {
        setEditorOperationError(`${label}: ${SNAPSHOT_UNAVAILABLE_MESSAGE}`);
        return null;
      }
    },
    [currentSnapshotJson],
  );

  // Read all named ranges from the live Univer workbook via the facade
  // (FWorkbook.getDefinedNames). Falls back to an empty list if the facade
  // hasn't initialized yet or the workbook isn't available.
  const readNamedRanges = useCallback((): NamedRangeEntry[] => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return [];
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return [];
    try {
      const defined = workbook.getDefinedNames();
      return defined.map((d) => ({
        name: d.getName(),
        formula: d.getFormulaOrRefString(),
      }));
    } catch {
      return [];
    }
  }, []);

  // Apply a new array of named ranges back to Univer as a diff:
  //   - delete entries no longer present (match by original name)
  //   - insert / update remaining entries
  // We re-insert renamed entries (delete-then-insert) because the facade's
  // updateDefinedNameBuilder requires a builder param keyed off the existing
  // FDefinedName, and the simpler insertDefinedName(name, formulaOrRef)
  // entry-point already covers both add + replace via Univer's internal
  // dedup. Sheet-scope is preserved as-is (the dialog doesn't edit scope).
  const applyNamedRanges = useCallback(
    (next: NamedRangeEntry[]) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const before = readNamedRanges();
      const beforeMap = new Map(before.map((r) => [r.name, r]));
      const afterMap = new Map(next.map((r) => [r.name, r]));
      // Delete names that were removed entirely.
      for (const r of before) {
        if (!afterMap.has(r.name)) {
          try {
            workbook.deleteDefinedName(r.name);
          } catch {
            // Best-effort: a deletion failure leaves the entry in Univer,
            // which the user will see when re-opening the dialog.
          }
        }
      }
      // Insert / replace remaining entries. insertDefinedName accepts either
      // a bare reference ("Sheet1!$A$1") or a formula starting with "=";
      // Univer normalizes both internally.
      for (const r of next) {
        const existing = beforeMap.get(r.name);
        if (existing && existing.formula === r.formula) continue;
        try {
          if (existing) {
            // Replace by delete-then-insert so the new formula takes effect
            // without needing the FDefinedName builder dance.
            workbook.deleteDefinedName(r.name);
          }
          workbook.insertDefinedName(r.name, r.formula);
        } catch {
          // Best-effort: swallow individual failures so one bad entry
          // doesn't abort the whole batch.
        }
      }
      // Re-snapshot — the mutation listener also fires on these commands,
      // but kicking the snapshot here makes the change visible immediately
      // for the Save button enablement.
      updateSnapshot(JSON.stringify(workbook.save()));
    },
    [readNamedRanges, updateSnapshot],
  );

  const openNamedRangesDialog = useCallback(() => {
    if (!getReadyWorkbook("名前付き範囲")) return;
    setNamedRanges(readNamedRanges());
  }, [getReadyWorkbook, readNamedRanges]);

  // Data-validation dialog plumbing. We work directly on the snapshot JSON
  // rather than going through Univer because the @univerjs/sheets-data
  // -validation plugin isn't registered in this build and the round-trip
  // already drives off the snapshot's `_dataValidations[]` field. MVP scope:
  // target sheetOrder[0] (the typical single-sheet xlsx); a future cut can
  // surface a sheet picker.
  const openDataValidationDialog = useCallback(() => {
    if (!getReadyWorkbook("データの入力規則")) return;
    const snap = getSnapshotForTool("データの入力規則") as {
      sheetOrder?: string[];
      sheets?: Record<string, { name?: string; _dataValidations?: DataValidationEntry[] }>;
    } | null;
    if (!snap) return;
    const sheetId = snap.sheetOrder?.[0];
    if (!sheetId || !snap.sheets || !snap.sheets[sheetId]) {
      setEditorOperationError("データの入力規則: 編集できるシートがありません。");
      return;
    }
    const sheet = snap.sheets[sheetId];
    const rules = Array.isArray(sheet._dataValidations)
      ? sheet._dataValidations.map((r) => ({ ...r }))
      : [];
    setDvDialog({ sheetId, sheetName: sheet.name ?? sheetId, rules });
  }, [getReadyWorkbook, getSnapshotForTool]);

  const applyDataValidations = useCallback(
    (next: DataValidationEntry[]) => {
      if (!dvDialog) return;
      const snap = getSnapshotForTool("データの入力規則") as {
        sheets?: Record<string, { _dataValidations?: DataValidationEntry[] }>;
      } | null;
      if (!snap) return;
      if (!snap.sheets || !snap.sheets[dvDialog.sheetId]) {
        setEditorOperationError("データの入力規則: 対象シートが見つかりません。");
        return;
      }
      const sheet = snap.sheets[dvDialog.sheetId];
      // Opt-in field: drop the key entirely when the list is empty so a
      // sheet that never had DV doesn't gain an empty array on round-trip
      // (mirrors the Rust side's emission policy in xlsx_io.rs).
      if (next.length === 0) {
        delete sheet._dataValidations;
      } else {
        sheet._dataValidations = next;
      }
      applyMutatedSnapshot(JSON.stringify(snap));
    },
    [dvDialog, getSnapshotForTool, applyMutatedSnapshot],
  );

  // TODO(cf): live in-grid CF highlighting (see docs/TODOS.md#high-cf-live-render)
  // Conditional formatting is currently round-tripped at the snapshot level
  // (xlsx_io.rs preserves _conditionalFormatting per sheet). The Univer CF
  // plugin uses a different rule model (IRange + dxf-style IStyleBase), so for
  // this PoC we author into the snapshot directly: read → edit → write back via
  // updateSnapshot. Live highlighting is therefore deferred until save+reopen.
  const openCfDialog = useCallback(() => {
    const ready = getReadyWorkbook("条件付き書式");
    if (!ready) return;
    const { workbook } = ready;
    const activeSheet = workbook.getActiveSheet();
    if (!activeSheet) return;
    const sheetId = activeSheet.getSheetId();
    const sheetName = activeSheet.getSheetName();
    let rules: CfRule[] = [];
    try {
      const snap = currentSnapshotJson ? JSON.parse(currentSnapshotJson) : null;
      const sheetObj = snap?.sheets?.[sheetId];
      const arr = sheetObj?._conditionalFormatting;
      if (Array.isArray(arr)) {
        rules = arr as CfRule[];
      }
    } catch {
      rules = [];
    }
    setCfDialog({ sheetName, sheetId, rules });
  }, [currentSnapshotJson, getReadyWorkbook]);

  // Persist authored CF rules back into the workbook snapshot. We re-derive
  // the snapshot from the live Univer workbook (not the cached
  // currentSnapshotJson) so we don't clobber edits the user made while the
  // dialog was open, then splice in `_conditionalFormatting` for the target
  // sheet and push the result through updateSnapshot.
  const applyCfRules = useCallback(
    (sheetId: string, next: CfRule[]) => {
      const ready = getReadyWorkbook("条件付き書式");
      if (!ready) return;
      const { workbook } = ready;
      const fresh = workbook.save() as unknown as {
        sheets: Record<string, Record<string, unknown>>;
      };
      const sheetObj = fresh.sheets?.[sheetId];
      if (!sheetObj) {
        setEditorOperationError("条件付き書式: 対象シートが見つかりません。");
        return;
      }
      if (next.length === 0) {
        // Mirror the Rust "omit when empty" convention on the export side so
        // a sheet that loses all its rules doesn't keep a stray empty array.
        delete sheetObj._conditionalFormatting;
      } else {
        sheetObj._conditionalFormatting = next;
      }
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [getReadyWorkbook, applyMutatedSnapshot],
  );

  // Snapshot the active sheet + cell when the user invokes Insert Hyperlink.
  // We pin both so the apply step targets the cell the user saw at open time,
  // even if focus moves while the dialog is up. Falls back to Sheet1!A1 when
  // there's no live selection.
  const openHyperlinkDialog = useCallback(() => {
    const ready = getReadyWorkbook("ハイパーリンク");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let cell = "A1";
    let display = "";
    try {
      const sel = sheet.getSelection();
      const range = sel?.getActiveRange();
      if (range) {
        // Use the top-left of the active range as the anchor (mirrors Excel's
        // Insert Hyperlink behavior on a multi-cell selection).
        const a1 = range.getA1Notation();
        cell = a1.includes(":") ? a1.split(":")[0] : a1;
        const value = range.getValue();
        if (typeof value === "string" && value) display = value;
        else if (typeof value === "number") display = String(value);
      }
    } catch {
      // Best-effort: fall back to the A1 default.
    }
    setHyperlinkCtx({ sheetId, cell, display });
  }, [getReadyWorkbook]);

  // Append the new hyperlink to `sheets.<id>._hyperlinks` in the snapshot and
  // reload Univer from it. We go snapshot-level because Univer 0.5.x's facade
  // doesn't expose a stable hyperlink API; the round-trip path in xlsx_io.rs
  // (parse_xlsx_hyperlinks / build_hyperlink_from_snapshot) is the source of
  // truth for the shape: { cell, target, display?, tooltip? }.
  //
  // Live restyle: `patchHyperlinkRenders` only fires at createUnit time, so
  // updateSnapshot alone wouldn't repaint the cell in-session (the underline
  // / blue would surface only after save+reopen). We therefore drive the
  // Univer facade imperatively after the snapshot push — getRange(cell) →
  // setFontColor + setFontLine("underline"), plus setValue(label) when the
  // cell is currently empty. `chooseHyperlinkRestyle` centralizes that
  // decision so it stays in lock step with the boot-time patch.
  const applyHyperlink = useCallback(
    (value: HyperlinkFormValue) => {
      if (!hyperlinkCtx) return;
      const ready = getReadyWorkbook("ハイパーリンク");
      if (!ready) return;
      const { workbook } = ready;
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const sheets = (snapshot.sheets as Record<string, Record<string, unknown>> | undefined) ?? {};
      const sheetObj = sheets[hyperlinkCtx.sheetId];
      if (!sheetObj) {
        setEditorOperationError("ハイパーリンク: 対象シートが見つかりません。");
        return;
      }
      const existing = Array.isArray(sheetObj._hyperlinks)
        ? (sheetObj._hyperlinks as Array<Record<string, unknown>>)
        : [];
      // Drop any prior link on the same cell — Excel only allows one
      // hyperlink per cell, and the rels writer on export would otherwise
      // emit two competing r:id entries for the same ref.
      const filtered = existing.filter((e) => e.cell !== value.cell);
      const entry: Record<string, string> = {
        cell: value.cell,
        target: value.target,
      };
      if (value.display) entry.display = value.display;
      if (value.tooltip) entry.tooltip = value.tooltip;
      sheetObj._hyperlinks = [...filtered, entry];
      applyMutatedSnapshot(JSON.stringify(snapshot));

      // Imperative restyle so the link appears blue+underlined immediately.
      // Best-effort: any facade exception is swallowed (the snapshot patch
      // will still take effect on next createUnit, matching the prior
      // behavior).
      try {
        const sheet = workbook.getSheetBySheetId(hyperlinkCtx.sheetId);
        if (!sheet) return;
        const range = sheet.getRange(value.cell);
        if (!range) return;
        const currentValue = range.getValue();
        const restyle = chooseHyperlinkRestyle(
          { cell: value.cell, target: value.target, display: value.display },
          currentValue,
        );
        if (!restyle) return;
        if (restyle.value !== null) range.setValue(restyle.value);
        range.setFontColor(restyle.color);
        range.setFontLine("underline");
      } catch {
        // Facade rejected the call (e.g. sheet was deleted mid-session).
        // The snapshot path already succeeded so the link is still saved.
      }
    },
    [getReadyWorkbook, hyperlinkCtx, applyMutatedSnapshot],
  );

  // Resolve a default author for new comments. localStorage > navigator hints
  // > "Author" fallback. The browser renderer can't read the OS username
  // directly, so we persist the user's chosen name across sessions instead.
  const resolveDefaultAuthor = useCallback((): string => {
    try {
      const stored = window.localStorage.getItem("coco.commentAuthor");
      if (stored && stored.trim()) return stored.trim();
    } catch {
      // localStorage may throw in private mode — fall through.
    }
    return "Author";
  }, []);

  // Convert (row, col) -> A1 notation. col is 0-based. Mirrors Excel's
  // 26-letter base-26 column naming (A..Z, AA..AZ, ...).
  const toA1 = (row: number, col: number): string => {
    let n = col;
    let letters = "";
    while (true) {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      const next = Math.floor(n / 26) - 1;
      if (next < 0) break;
      n = next;
    }
    return `${letters}${row + 1}`;
  };

  // Open the comment dialog targeting the current active cell. Reads the
  // existing comment (if any) from the snapshot's `_comments` array for the
  // active sheet so editing pre-fills the form correctly.
  const openCommentDialog = useCallback(() => {
    const ready = getReadyWorkbook("コメント");
    if (!ready) return;
    const { workbook } = ready;
    const worksheet = workbook.getActiveSheet();
    if (!worksheet) return;
    const selection = worksheet.getSelection();
    const activeRange = selection?.getActiveRange();
    // Fall back to A1 if there's no selection (shouldn't happen in practice
    // but keeps the dialog resilient to edge cases like an empty workbook).
    const row = activeRange?.getRow() ?? 0;
    const col = activeRange?.getColumn() ?? 0;
    const cellRef = toA1(row, col);
    const sheetId = worksheet.getSheetId();

    let existing: ThreadedComment | null = null;
    if (currentSnapshotJson) {
      try {
        const snap = JSON.parse(currentSnapshotJson) as {
          sheets?: Record<string, { _comments?: Array<Record<string, unknown>> }>;
        };
        const arr = snap.sheets?.[sheetId]?._comments ?? [];
        const found = arr.find((c) => (c.cell ?? c.cellRef) === cellRef);
        if (found) existing = normalizeToThread(found);
      } catch {
        // Bad snapshot JSON: treat as no existing comment; the apply path
        // also re-parses defensively so we don't poison the snapshot.
      }
    }
    setCommentDialog({ sheetId, cellRef, existing });
  }, [currentSnapshotJson, getReadyWorkbook]);

  // Apply (insert or update) a comment in the snapshot's `sheets.<id>._comments`
  // array. Matches by cell ref — if one exists for this cell, replace it;
  // otherwise append. Always re-stringifies and pushes back via updateSnapshot
  // so the save button enables and the auto-save path picks up the change.
  const applyComment = useCallback(
    (sheetId: string, entry: ThreadedComment) => {
      const snap = getSnapshotForTool("コメント") as {
        sheets?: Record<string, { _comments?: Array<Record<string, unknown>> }>;
      } | null;
      if (!snap) return;
      if (!snap.sheets) snap.sheets = {};
      if (!snap.sheets[sheetId]) snap.sheets[sheetId] = {};
      const list = snap.sheets[sheetId]._comments ?? [];
      // Persist both legacy keys (cell/text) and new keys (cellRef/body) so
      // CommentIndicatorsPanel (legacy reader) and ThreadedCommentDialog
      // (new reader) both see the same row.
      const row: Record<string, unknown> = {
        cell: entry.cellRef,
        cellRef: entry.cellRef,
        text: entry.body,
        body: entry.body,
      };
      if (entry.author) row.author = entry.author;
      if (entry.createdAt) row.createdAt = entry.createdAt;
      if (entry.replies && entry.replies.length > 0) row.replies = entry.replies;
      if (entry.resolved) {
        row.resolved = true;
        if (entry.resolvedAt) row.resolvedAt = entry.resolvedAt;
        if (entry.resolvedBy) row.resolvedBy = entry.resolvedBy;
      }
      const idx = list.findIndex((c) => (c.cell ?? c.cellRef) === entry.cellRef);
      if (idx >= 0) {
        list[idx] = row;
      } else {
        list.push(row);
      }
      snap.sheets[sheetId]._comments = list;
      applyMutatedSnapshot(JSON.stringify(snap));
      // Persist the chosen author so the next new-comment dialog pre-fills it.
      if (entry.author && entry.author.trim()) {
        try {
          window.localStorage.setItem("coco.commentAuthor", entry.author.trim());
        } catch {
          // Best-effort: ignore quota / private-mode errors.
        }
      }
    },
    [getSnapshotForTool, applyMutatedSnapshot],
  );

  // Toggle sheet protection (read-only marker) on the active sheet. Writes
  // into `sheets.<id>._protected = { protected: true }` (or removes the key
  // entirely when turning protection off, mirroring the Rust "omit when
  // empty" convention). Round-trips through xlsx via `<sheetProtection
  // sheet="1"/>`. Password isn't surfaced in the toolbar — the snapshot
  // schema supports `password?: string` for future expansion.
  const toggleSheetProtection = useCallback(() => {
    const ready = getReadyWorkbook("シート保護");
    if (!ready) return;
    const { workbook } = ready;
    const activeSheet = workbook.getActiveSheet();
    if (!activeSheet) return;
    const sheetId = activeSheet.getSheetId();

    // Re-derive snapshot from live Univer so we don't clobber concurrent edits.
    const fresh = workbook.save() as unknown as {
      sheets?: Record<string, { _protected?: { protected?: boolean; password?: string } }>;
    };
    if (!fresh.sheets || !fresh.sheets[sheetId]) return;
    const sheet = fresh.sheets[sheetId];
    const currentlyProtected = sheet._protected?.protected === true;
    if (currentlyProtected) {
      delete sheet._protected;
    } else {
      sheet._protected = { protected: true };
    }
    applyMutatedSnapshot(JSON.stringify(fresh));
  }, [getReadyWorkbook, applyMutatedSnapshot]);

  // Open the tab-color dialog targeting the active sheet. We re-derive the
  // snapshot from Univer so the dialog sees the current `_tabColor` even if
  // it was just changed in another flow. Display name comes from the facade.
  const openTabColorDialog = useCallback(() => {
    const ready = getReadyWorkbook("シートタブの色");
    if (!ready) return;
    const { workbook } = ready;
    const activeSheet = workbook.getActiveSheet();
    if (!activeSheet) return;
    const sheetId = activeSheet.getSheetId();
    const sheetName = activeSheet.getSheetName();
    let initialColor: string | null = null;
    const fresh = workbook.save() as unknown as {
      sheets?: Record<string, { _tabColor?: string }>;
    };
    const raw = fresh.sheets?.[sheetId]?._tabColor;
    if (typeof raw === "string" && raw.trim()) {
      initialColor = raw.trim();
    }
    setTabColorDialog({ sheetId, sheetName, initialColor });
  }, [getReadyWorkbook]);

  // Apply (or clear) the chosen tab color to the snapshot. Sets
  // `sheets.<id>._tabColor = "#RRGGBB"` on apply, or deletes the key when the
  // user picks "remove color" (keeps the round-trip clean — Rust omits the
  // field when absent). Mirrors the toggleSheetProtection write pattern.
  const applyTabColor = useCallback(
    (sheetId: string, color: string | null) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _tabColor?: string }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      if (color === null) {
        delete sheet._tabColor;
      } else {
        sheet._tabColor = color;
      }
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  // --- Outline grouping (Excel-style row/column outline) ---------------------
  const openOutlineDialog = useCallback(() => {
    const ready = getReadyWorkbook("グループ化");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const sheetName = sheet.getSheetName();
    const fresh = workbook.save() as unknown as {
      sheets?: Record<string, { _outlineRows?: OutlineGroup[]; _outlineCols?: OutlineGroup[] }>;
    };
    const stored = fresh.sheets?.[sheetId];
    const rows = Array.isArray(stored?._outlineRows) ? stored!._outlineRows! : [];
    const cols = Array.isArray(stored?._outlineCols) ? stored!._outlineCols! : [];
    let selection: { startRow: number; endRow: number; startCol: number; endCol: number } | null = null;
    try {
      const sel = sheet.getSelection();
      const range = sel?.getActiveRange();
      if (range) {
        const startRow = range.getRow();
        const startCol = range.getColumn();
        const height = (range as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
        const width = (range as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
        selection = {
          startRow,
          endRow: startRow + Math.max(0, height - 1),
          startCol,
          endCol: startCol + Math.max(0, width - 1),
        };
      }
    } catch {
      // best-effort
    }
    setOutlineDialog({ sheetId, sheetName, rows, cols, selection });
  }, [getReadyWorkbook]);

  const applyOutline = useCallback(
    (sheetId: string, rows: OutlineGroup[], cols: OutlineGroup[]) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _outlineRows?: OutlineGroup[]; _outlineCols?: OutlineGroup[] }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      sheet._outlineRows = rows;
      sheet._outlineCols = cols;
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );
  // Suppress unused-warning: helper is re-exported for dialog convenience.
  void addOutlineGroup;

  // --- Tables (Excel-style ListObject) ---------------------------------------
  const openTableDialog = useCallback(() => {
    const ready = getReadyWorkbook("テーブル");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1";
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) range = r.getA1Notation();
    } catch {
      // best-effort
    }
    setTableDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  const applyTable = useCallback(
    (sheetId: string, entry: TableEntry) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _tables?: TableEntry[] }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      const existing = Array.isArray(sheet._tables) ? sheet._tables : [];
      sheet._tables = [...existing, entry];
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const deleteTable = useCallback(
    (sheetId: string, name: string) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _tables?: TableEntry[] }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      sheet._tables = removeTable(sheet as { _tables?: TableEntry[] }, name);
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const renameTableAcrossWorkbook = useCallback(
    (oldName: string, newName: string) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _tables?: TableEntry[] }>;
      };
      const ok = renameWorkbookTable(fresh as { sheets?: Record<string, { _tables?: TableEntry[] }> }, oldName, newName);
      if (!ok) return;
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  // --- Sparklines ------------------------------------------------------------
  const openSparklineDialog = useCallback(() => {
    const ready = getReadyWorkbook("スパークライン");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let sourceRange = "A1:C1";
    let anchorCell = "D1";
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) {
        sourceRange = r.getA1Notation();
        // Default anchor: one cell to the right of the source range's top-right.
        const startCol = r.getColumn();
        const startRow = r.getRow();
        const width = (r as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
        const anchorColIdx = startCol + width;
        const colLetters = (() => {
          let n = anchorColIdx + 1;
          let out = "";
          while (n > 0) {
            const rem = (n - 1) % 26;
            out = String.fromCharCode(65 + rem) + out;
            n = Math.floor((n - 1) / 26);
          }
          return out;
        })();
        anchorCell = `${colLetters}${startRow + 1}`;
      }
    } catch {
      // best-effort
    }
    setSparklineDialog({ sheetId, sourceRange, anchorCell });
  }, [getReadyWorkbook]);

  const applySparkline = useCallback(
    (sheetId: string, entry: SparklineEntry) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _sparklines?: SparklineEntry[] }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      sheet._sparklines = addSparkline(sheet as { _sparklines?: SparklineEntry[] }, entry);
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const deleteSparkline = useCallback(
    (sheetId: string, cell: string) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { _sparklines?: SparklineEntry[] }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      sheet._sparklines = removeSparkline(sheet as { _sparklines?: SparklineEntry[] }, cell);
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  // --- Page Setup ------------------------------------------------------------
  const openPageSetupDialog = useCallback(() => {
    const ready = getReadyWorkbook("ページ設定");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const sheetName = sheet.getSheetName();
    const fresh = workbook.save() as unknown as Parameters<typeof getPageSetup>[0];
    const initial = getPageSetup(fresh, sheetId);
    setPageSetupDialog({ sheetId, sheetName, initial });
  }, [getReadyWorkbook]);

  const applyPageSetup = useCallback(
    (value: PageSetupValue) => {
      if (!pageSetupDialog) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save();
      const json = JSON.stringify(fresh);
      try {
        const next = setPageSetup(json, pageSetupDialog.sheetId, value);
        applyMutatedSnapshot(next);
      } catch (e) {
        setEditorOperationError(`ページ設定: ${(e as Error).message}`);
      }
    },
    [pageSetupDialog, applyMutatedSnapshot],
  );

  // --- Cell Styles gallery ---------------------------------------------------
  const openCellStylesDialog = useCallback(() => {
    const ready = getReadyWorkbook("セルスタイル");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1";
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) range = r.getA1Notation();
    } catch {
      // best-effort
    }
    setCellStylesDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  const applyCellStylePreset = useCallback(
    (preset: CellStylePreset, range: string) => {
      if (!cellStylesDialog) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save();
      const json = JSON.stringify(fresh);
      // Parse range to rect; the dialog supplies an A1 like "A1:C10" with or
      // without a sheet qualifier. Strip the sheet prefix if present.
      const cleaned = range.includes("!") ? range.split("!").slice(1).join("!") : range;
      const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(cleaned.trim());
      if (!m) return;
      const colLetterToIndex = (s: string) => {
        let n = 0;
        for (const ch of s.toUpperCase()) {
          n = n * 26 + (ch.charCodeAt(0) - 64);
        }
        return n - 1;
      };
      const c1 = colLetterToIndex(m[1]);
      const r1 = parseInt(m[2], 10) - 1;
      const c2 = m[3] ? colLetterToIndex(m[3]) : c1;
      const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
      const rect = {
        r1: Math.min(r1, r2),
        c1: Math.min(c1, c2),
        r2: Math.max(r1, r2),
        c2: Math.max(c1, c2),
      };
      try {
        const next = applyPresetToRange(json, cellStylesDialog.sheetId, rect, preset.id);
        applyMutatedSnapshot(next);
      } catch (e) {
        setEditorOperationError(`セルスタイル: ${(e as Error).message}`);
      }
    },
    [cellStylesDialog, applyMutatedSnapshot],
  );

  // --- Goal Seek -------------------------------------------------------------
  const openGoalSeekDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    const sheet = workbook?.getActiveSheet();
    if (!workbook || !sheet) return;
    let activeRef = "B5";
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) activeRef = r.getA1Notation();
    } catch {
      // best-effort
    }
    const adapter: GoalSeekAdapter = {
      readNumeric(cellRef: string) {
        const r = sheet.getRange(cellRef);
        const v = r?.getValue();
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string" && v.trim() !== "") {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      },
      writeNumeric(cellRef: string, value: number) {
        sheet.getRange(cellRef)?.setValue(value);
      },
    };
    setGoalSeekState({ targetCell: activeRef, changingCell: "A1", adapter });
  }, []);

  // --- Subtotals -------------------------------------------------------------
  const openSubtotalDialog = useCallback(() => {
    const ready = getReadyWorkbook("小計");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>>; rowData?: Record<string, unknown> }>;
    };
    let range = "A1:A1";
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        range = a1.includes(":") ? a1 : `${a1}:${a1}`;
      }
    } catch {
      // best-effort
    }
    setSubtotalDialog({ sheetId, range, sheetSnapshot: snap.sheets?.[sheetId] ?? {} });
  }, [getReadyWorkbook]);

  const applySubtotal = useCallback(
    (sheetId: string, params: SubtotalParams) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, {
          cellData?: Record<string, Record<string, unknown>>;
          rowData?: Record<string, unknown>;
          _outlineRows?: Array<{ start: number; end: number; level: number; collapsed?: boolean }>;
        }>;
      };
      const sheet = fresh.sheets?.[sheetId];
      if (!sheet) return;
      const result = applySubtotals(sheet, params);
      sheet.cellData = result.newCellData;
      if (params.addOutline && result.outlineGroups && result.outlineGroups.length > 0) {
        const existing = Array.isArray(sheet._outlineRows) ? sheet._outlineRows : [];
        sheet._outlineRows = [...existing, ...result.outlineGroups];
      }
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const clearSubtotals = useCallback(
    (sheetId: string, groupCol: number) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
      };
      const sheet = fresh.sheets?.[sheetId];
      if (!sheet?.cellData) return;
      sheet.cellData = stripSubtotalRows(sheet.cellData, groupCol);
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  // --- Remove Duplicates -----------------------------------------------------
  const openRemoveDuplicatesDialog = useCallback(() => {
    const ready = getReadyWorkbook("重複の削除");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
    };
    let range = "A1:A1";
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        range = a1.includes(":") ? a1 : `${a1}:${a1}`;
      }
    } catch {
      // best-effort
    }
    setRemoveDuplicatesDialog({ sheetId, range, sheetSnapshot: snap.sheets?.[sheetId] ?? {} });
  }, [getReadyWorkbook]);

  const applyRemoveDuplicates = useCallback(
    (params: RemoveDuplicatesParams) => {
      if (!removeDuplicatesDialog) return;
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
      };
      const sheet = fresh.sheets?.[removeDuplicatesDialog.sheetId];
      if (!sheet) return;
      const result = applyRemoveDupesToSheet(sheet, params);
      fresh.sheets![removeDuplicatesDialog.sheetId] = result.sheetWithRemoved as typeof sheet;
      applyMutatedSnapshot(JSON.stringify(fresh));
      setEditorOperationError(
        `重複削除: ${result.removedCount} 行を削除しました。${result.keptCount} 行残っています。`,
      );
    },
    [removeDuplicatesDialog, applyMutatedSnapshot],
  );

  // --- Text to Columns -------------------------------------------------------
  const openTextToColumnsDialog = useCallback(() => {
    const ready = getReadyWorkbook("区切り位置");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }>;
    };
    let range = "A1";
    let sampleRows: string[] = [];
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) range = r.getA1Notation();
      const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?[A-Za-z]+\$?(\d+))?$/.exec(range);
      if (m) {
        const colLetters = m[1].toUpperCase();
        let col = 0;
        for (const ch of colLetters) col = col * 26 + (ch.charCodeAt(0) - 64);
        col -= 1;
        const startRow = parseInt(m[2], 10) - 1;
        const endRow = m[3] ? parseInt(m[3], 10) - 1 : startRow;
        const cellData = snap.sheets?.[sheetId]?.cellData ?? {};
        for (let r2 = startRow; r2 <= Math.min(startRow + 4, endRow); r2++) {
          const v = cellData[String(r2)]?.[String(col)]?.v;
          sampleRows.push(v == null ? "" : String(v));
        }
      }
    } catch {
      // best-effort
    }
    setTextToColumnsDialog({ sheetId, range, sampleRows });
  }, [getReadyWorkbook]);

  const applyTextToColumns = useCallback(
    (params: TextToColumnsParams) => {
      if (!textToColumnsDialog) return;
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, TtcSheetData>;
      };
      const sheet = fresh.sheets?.[textToColumnsDialog.sheetId];
      if (!sheet) return;
      const result = applyTextToColumnsToSheet(sheet, params);
      fresh.sheets![textToColumnsDialog.sheetId] = result.sheetMutated;
      applyMutatedSnapshot(JSON.stringify(fresh));
      if (result.overwrittenCells > 0) {
        setEditorOperationError(`区切り位置: ${result.overwrittenCells} セルを上書きしました。`);
      }
    },
    [textToColumnsDialog, applyMutatedSnapshot],
  );

  // --- Advanced Filter -------------------------------------------------------
  const openAdvancedFilterDialog = useCallback(() => {
    const ready = getReadyWorkbook("フィルターの詳細設定");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1:A1";
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        range = a1.includes(":") ? a1 : `${a1}:${a1}`;
      }
    } catch {
      // best-effort
    }
    setAdvancedFilterDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  const applyAdvancedFilterAction = useCallback(
    (params: AdvancedFilterParams) => {
      if (!advancedFilterDialog) return;
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, unknown>;
      };
      const sheet = fresh.sheets?.[advancedFilterDialog.sheetId];
      if (!sheet) return;
      const result = applyAdvancedFilter(sheet, params);
      if (params.mode === "inPlace" && result.mutatedSheet) {
        fresh.sheets![advancedFilterDialog.sheetId] = result.mutatedSheet;
      } else if (params.mode === "copyTo" && result.copyOutput && params.destination) {
        // Write copyOutput into cellData starting at destination.
        const s = sheet as { cellData?: Record<string, Record<string, unknown>> };
        if (!s.cellData) s.cellData = {};
        result.copyOutput.forEach((row, ri) => {
          const targetRow = params.destination!.row + ri;
          if (!s.cellData![String(targetRow)]) s.cellData![String(targetRow)] = {};
          row.forEach((val, ci) => {
            const targetCol = params.destination!.col + ci;
            s.cellData![String(targetRow)][String(targetCol)] = { v: val };
          });
        });
      }
      applyMutatedSnapshot(JSON.stringify(fresh));
      setEditorOperationError(`フィルター: ${result.matchedRows.length} 件一致しました。`);
    },
    [advancedFilterDialog, applyMutatedSnapshot],
  );

  // --- Flash Fill ------------------------------------------------------------
  const openFlashFillDialog = useCallback(() => {
    const ready = getReadyWorkbook("フラッシュフィル");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let col = -1;
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) col = r.getColumn();
    } catch {
      // best-effort
    }
    if (col <= 0) {
      setEditorOperationError("フラッシュフィル: 2 列目以降の列を選択してください。");
      return;
    }
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }>;
    };
    const cellData = snap.sheets?.[sheetId]?.cellData ?? {};
    const rowKeys = Object.keys(cellData).map(Number).filter(Number.isFinite);
    const maxRow = rowKeys.length ? Math.max(...rowKeys) : 0;
    const sourceCol: string[] = [];
    const targetCol: (string | null)[] = [];
    for (let r2 = 0; r2 <= maxRow; r2++) {
      const src = cellData[String(r2)]?.[String(col - 1)]?.v;
      const tgt = cellData[String(r2)]?.[String(col)]?.v;
      sourceCol.push(src == null ? "" : String(src));
      targetCol.push(tgt == null || tgt === "" ? null : String(tgt));
    }
    const result = runFlashFill(sourceCol, targetCol);
    if (!result) {
      setEditorOperationError("フラッシュフィル: パターンを検出できませんでした。");
      return;
    }
    const examplesMask = targetCol.map((v) => v !== null);
    setFlashFillDialog({
      sheetId,
      col,
      transform: result.transform,
      filled: result.filled,
      sourceCol,
      examplesMask,
    });
  }, [getReadyWorkbook]);

  const acceptFlashFill = useCallback(() => {
    if (!flashFillDialog) return;
    const fUniver = fUniverRef.current;
    const workbook = fUniver?.getActiveWorkbook();
    if (!workbook) {
      setFlashFillDialog(null);
      return;
    }
    const fresh = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
    };
    const sheet = fresh.sheets?.[flashFillDialog.sheetId];
    if (!sheet) {
      setFlashFillDialog(null);
      return;
    }
    if (!sheet.cellData) sheet.cellData = {};
    const colKey = String(flashFillDialog.col);
    flashFillDialog.filled.forEach((v, r) => {
      if (flashFillDialog.examplesMask[r]) return; // user-typed examples: keep
      if (v === "") return;
      const rowKey = String(r);
      if (!sheet.cellData![rowKey]) sheet.cellData![rowKey] = {};
      (sheet.cellData![rowKey] as Record<string, unknown>)[colKey] = { v };
    });
    applyMutatedSnapshot(JSON.stringify(fresh));
    setFlashFillDialog(null);
  }, [flashFillDialog, applyMutatedSnapshot]);

  // --- Pivot Tables ----------------------------------------------------------
  const openPivotDialog = useCallback(() => {
    const ready = getReadyWorkbook("ピボットテーブル");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; s?: unknown } | undefined> | undefined> }>;
    };
    let sourceRange = "A1:A1";
    let destCell = "F1";
    let parsedRange: { r1: number; c1: number; r2: number; c2: number } | null = null;
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        sourceRange = a1.includes(":") ? a1 : `${a1}:${a1}`;
        const parsed = parsePivotA1Range(sourceRange);
        if (parsed) {
          parsedRange = parsed.range;
          destCell = pivotCellToA1(parsed.range.r1, parsed.range.c2 + 2);
        }
      }
    } catch {
      // best-effort
    }
    const cellData = snap.sheets?.[sheetId]?.cellData;
    const fieldNames = parsedRange ? inferFieldNames(cellData, parsedRange, true) : [];
    setPivotDialog({ sheetId, sourceRange, destCell, fieldNames });
  }, [getReadyWorkbook]);

  const applyPivot = useCallback(
    (config: PivotConfig) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookPivotSnapshot & {
        sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
      };
      const src = fresh.sheets?.[config.source.sheetId];
      if (!src) return;
      // Slice source cells into a 2-D array
      const sourceCells: Array<Array<unknown>> = [];
      const cellData = (src.cellData ?? {}) as Record<string, Record<string, { v?: unknown }>>;
      for (let r = config.source.range.r1; r <= config.source.range.r2; r++) {
        const row: unknown[] = [];
        for (let c = config.source.range.c1; c <= config.source.range.c2; c++) {
          row.push(cellData[String(r)]?.[String(c)]?.v ?? null);
        }
        sourceCells.push(row);
      }
      const result = computePivot(sourceCells, config);
      const name = generatePivotName(collectAllPivotNames(fresh));
      const entry: PivotEntry = { ...config, name };
      // Write output to destination
      const destSheet = src;
      if (!destSheet.cellData) destSheet.cellData = {};
      for (let r = 0; r < result.output.length; r++) {
        const row = result.output[r];
        const targetRow = config.destination.row + r;
        const rowKey = String(targetRow);
        if (!destSheet.cellData[rowKey]) destSheet.cellData[rowKey] = {};
        for (let c = 0; c < row.length; c++) {
          (destSheet.cellData[rowKey] as Record<string, unknown>)[String(config.destination.col + c)] = { v: row[c] };
        }
      }
      addPivotToSheet(fresh, entry);
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const refreshPivotByName = useCallback(
    (name: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookPivotSnapshot;
      const res = refreshPivotInSheet(fresh, name);
      if (res.ok) applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const deletePivot = useCallback(
    (sheetId: string, name: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookPivotSnapshot;
      const sheet = fresh.sheets?.[sheetId];
      if (!sheet) return;
      sheet._pivots = (sheet._pivots ?? []).filter((p) => p.name !== name);
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  // --- Slicers ---------------------------------------------------------------
  const openSlicerDialog = useCallback(() => {
    if (!getReadyWorkbook("スライサー")) return;
    setSlicerDialogOpen(true);
  }, [getReadyWorkbook]);

  const availableSlicerTables = useMemo(() => {
    if (!currentSnapshotJson) return [];
    let parsed: { sheetOrder?: string[]; sheets?: Record<string, { name?: string; _tables?: TableEntry[] } | undefined> };
    try {
      parsed = JSON.parse(currentSnapshotJson);
    } catch {
      return [];
    }
    const out: Array<{ name: string; sheetId: string; columns: string[] }> = [];
    const sheets = parsed.sheets ?? {};
    const order = parsed.sheetOrder ?? Object.keys(sheets);
    for (const sid of order) {
      const sh = sheets[sid];
      if (!Array.isArray(sh?._tables)) continue;
      for (const t of sh!._tables!) {
        if (t?.name) out.push({ name: t.name, sheetId: sid, columns: (t.columns ?? []).map((c) => c.name) });
      }
    }
    return out;
  }, [currentSnapshotJson]);

  const applySlicer = useCallback(
    (entry: SlicerEntry, sheetId: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookSlicerSnapshot;
      if (!fresh.sheets?.[sheetId]) return;
      // Auto-generate name if blank
      const allNames: string[] = [];
      for (const sid of Object.keys(fresh.sheets)) {
        const arr = fresh.sheets[sid]?._slicers ?? [];
        for (const s of arr) if (s?.name) allNames.push(s.name);
      }
      const named: SlicerEntry = { ...entry, name: entry.name || generateSlicerName(allNames) };
      const sheet = fresh.sheets[sheetId]!;
      sheet._slicers = [...(sheet._slicers ?? []), named];
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  const deleteSlicer = useCallback(
    (_sheetId: string, name: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookSlicerSnapshot;
      applyMutatedSnapshot(JSON.stringify(removeSlicerHelper(fresh, name)));
    },
    [applyMutatedSnapshot],
  );

  const toggleSlicer = useCallback(
    (name: string, value: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookSlicerSnapshot;
      if (toggleSlicerValueHelper(fresh, name, value)) {
        applyMutatedSnapshot(JSON.stringify(fresh));
      }
    },
    [applyMutatedSnapshot],
  );

  // --- Quick Analysis --------------------------------------------------------
  const openQuickAnalysisDialog = useCallback(() => {
    const ready = getReadyWorkbook("クイック分析");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const r = sheet.getSelection()?.getActiveRange();
    if (!r) return;
    const rangeLabel = r.getA1Notation();
    const range = rangeLabel.includes(":") ? rangeLabel : `${rangeLabel}:${rangeLabel}`;
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }>;
    };
    const cellData = snap.sheets?.[sheetId]?.cellData ?? {};
    const startRow = r.getRow();
    const startCol = r.getColumn();
    const height = (r as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
    const width = (r as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
    const endRow = startRow + Math.max(0, height - 1);
    const endCol = startCol + Math.max(0, width - 1);
    const values: unknown[][] = [];
    for (let row = startRow; row <= endRow; row++) {
      const slice: unknown[] = [];
      const rowObj = cellData[String(row)];
      for (let col = startCol; col <= endCol; col++) {
        slice.push(rowObj?.[String(col)]?.v ?? null);
      }
      values.push(slice);
    }
    const cellCount = values.length * (values[0]?.length ?? 0);
    setQuickAnalysisDialog({
      sheetId,
      range,
      rangeLabel,
      cellCount,
      recommended: recommendForRange(values),
    });
  }, [getReadyWorkbook]);

  // --- Active-cell tracking for FormulaTracePanel ---------------------------
  // Track Univer's active selection so the Trace panel can show precedents/dependents
  // for the currently selected cell. Only listens while the panel is open to avoid
  // unnecessary work.
  useEffect(() => {
    if (!tracePanelOpen) return;
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    // Poll every 300ms for the active selection — Univer's selection observable
    // API has changed across 0.5.x patches; polling is a robust MVP path.
    const tick = () => {
      try {
        const sheet = workbook.getActiveSheet();
        if (!sheet) return;
        const r = sheet.getSelection()?.getActiveRange();
        if (!r) return;
        setTraceActiveSheetId(sheet.getSheetId());
        setTraceActiveRow(r.getRow());
        setTraceActiveCol(r.getColumn());
      } catch {
        // ignore
      }
    };
    tick();
    const id = window.setInterval(tick, 300);
    return () => window.clearInterval(id);
  }, [tracePanelOpen]);

  // --- Sheet Visibility (Hide/Unhide) ---------------------------------------
  const hideActiveSheet = useCallback(() => {
    const ready = getReadyWorkbook("シートを非表示");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const fresh = JSON.stringify(workbook.save());
    if (listVisibleSheets(fresh).length <= 1) {
      setEditorOperationError("シートを非表示: 表示中のシートが 1 枚しかないため非表示にできません。");
      return;
    }
    const next = hideSheet(fresh, sheetId);
    if (next !== fresh) applyMutatedSnapshot(next);
  }, [getReadyWorkbook, applyMutatedSnapshot]);

  const openUnhideDialog = useCallback(() => {
    const ready = getReadyWorkbook("シートの再表示");
    if (!ready) return;
    const fresh = JSON.stringify(ready.workbook.save());
    setUnhideDialog({ hiddenSheets: listHiddenSheets(fresh) });
  }, [getReadyWorkbook]);

  const applyUnhide = useCallback(
    (sheetId: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = JSON.stringify(workbook.save());
      const next = unhideSheet(fresh, sheetId);
      if (next !== fresh) applyMutatedSnapshot(next);
    },
    [applyMutatedSnapshot],
  );

  // --- Move / Copy Sheet -----------------------------------------------------
  const openMoveCopySheetDialog = useCallback(() => {
    const ready = getReadyWorkbook("シートの移動 / コピー");
    if (!ready) return;
    const { workbook } = ready;
    const active = workbook.getActiveSheet();
    if (!active) return;
    const sheetId = active.getSheetId();
    const sheetName = active.getSheetName();
    const snap = JSON.stringify(workbook.save());
    setMoveCopyDialog({ sheetId, sheetName, sheets: listSheetsInOrder(snap) });
  }, [getReadyWorkbook]);

  const applyMoveCopy = useCallback(
    (sheetId: string, params: { targetIndex: number; createCopy: boolean }) => {
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      const fresh = JSON.stringify(wb.save());
      const next = params.createCopy
        ? copySheet(fresh, sheetId, params.targetIndex).json
        : moveSheet(fresh, sheetId, params.targetIndex);
      applyMutatedSnapshot(next);
    },
    [applyMutatedSnapshot],
  );

  // --- Insert Function -------------------------------------------------------
  const openInsertFunctionDialog = useCallback(() => {
    const ready = getReadyWorkbook("関数の挿入");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    let cellRef = "A1";
    try {
      const a1 = sheet.getSelection()?.getActiveRange()?.getA1Notation() ?? "A1";
      cellRef = a1.includes(":") ? a1.split(":")[0] : a1;
    } catch {
      // best-effort
    }
    setInsertFunctionCtx({ sheetId: sheet.getSheetId(), cellRef });
  }, [getReadyWorkbook]);

  const applyInsertFunction = useCallback(
    (text: string) => {
      if (!insertFunctionCtx) return;
      const ready = getReadyWorkbook("関数の挿入");
      if (!ready) return;
      const { workbook } = ready;
      const sheet = workbook.getActiveSheet();
      sheet?.getRange(insertFunctionCtx.cellRef)?.setValue(text);
    },
    [getReadyWorkbook, insertFunctionCtx],
  );

  // --- Custom Lists ----------------------------------------------------------
  const openCustomListsDialog = useCallback(() => {
    const ready = getReadyWorkbook("ユーザー設定リスト");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    let active = "A1";
    try {
      const sel = sheet?.getSelection();
      const range = sel?.getActiveRange();
      if (range) active = range.getA1Notation();
    } catch {
      // best-effort
    }
    setCustomListsCtx({ initialActiveRange: active });
  }, [getReadyWorkbook]);

  const applyCustomList = useCallback(
    (range: string, items: string[]) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      const sheetId = sheet.getSheetId();
      const fresh = workbook.save() as unknown as {
        sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
      };
      const sheetObj = fresh.sheets?.[sheetId];
      if (!sheetObj) return;
      if (!sheetObj.cellData) sheetObj.cellData = {};
      const m = /^\$?([A-Za-z]+)\$?(\d+)/.exec(range.trim());
      if (!m) return;
      let col = 0;
      for (const c of m[1].toUpperCase()) col = col * 26 + (c.charCodeAt(0) - 64);
      col -= 1;
      const startRow = parseInt(m[2], 10) - 1;
      for (let i = 0; i < items.length; i++) {
        const r = String(startRow + i);
        const c = String(col);
        if (!sheetObj.cellData[r]) sheetObj.cellData[r] = {};
        (sheetObj.cellData[r] as Record<string, unknown>)[c] = { v: items[i] };
      }
      applyMutatedSnapshot(JSON.stringify(fresh));
    },
    [applyMutatedSnapshot],
  );

  // --- Watch Window ----------------------------------------------------------
  const addActiveCellToWatch = useCallback(() => {
    const fUniver = fUniverRef.current;
    const workbook = fUniver?.getActiveWorkbook();
    if (!workbook) return;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const r = sheet.getSelection()?.getActiveRange();
    if (!r) return;
    const sheetId = sheet.getSheetId();
    const sheetName = sheet.getSheetName();
    const cellRef = toA1Ref(r.getRow(), r.getColumn());
    const current = loadWatchList();
    const next = addWatch(current, { sheetId, sheetName, cellRef });
    if (next !== current) {
      saveWatchList(next);
      setWatchWindowOpen(true);
    }
  }, []);

  // --- Scenario Manager ------------------------------------------------------
  const openScenarioManagerDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    const adapter: ScenarioAdapter = {
      readCell(ref) {
        try {
          const sheet = workbook.getActiveSheet();
          return sheet?.getRange(ref)?.getValue();
        } catch {
          return undefined;
        }
      },
      writeCell(ref, value) {
        try {
          const sheet = workbook.getActiveSheet();
          sheet?.getRange(ref)?.setValue(value as never);
        } catch {
          // best-effort
        }
      },
    };
    setScenarioAdapter(adapter);
    setScenariosOpen(true);
  }, []);

  // --- Forecast Sheet --------------------------------------------------------
  const openForecastSheetDialog = useCallback(() => {
    const ready = getReadyWorkbook("予測シート");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
    if (!sheet) return;
    let xRange = "A2:A10";
    let yRange = "B2:B10";
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        const m = /^([^!]*!?)\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(a1);
        if (m && m[2].toUpperCase() !== m[4].toUpperCase()) {
          xRange = `${m[1]}${m[2]}${m[3]}:${m[2]}${m[5]}`;
          yRange = `${m[1]}${m[4]}${m[3]}:${m[4]}${m[5]}`;
        } else {
          xRange = a1;
        }
      }
    } catch {
      // best-effort
    }
    setForecastDialog({ xRange, yRange });
  }, [getReadyWorkbook]);

  const applyForecastResult = useCallback(
    (p: ForecastApplyParams) => {
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      const snap = wb.save() as unknown as {
        sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
      };
      const sheetId = wb.getActiveSheet()?.getSheetId();
      const sheet = sheetId ? snap.sheets?.[sheetId] : undefined;
      if (!sheet) return;
      // Simple range parser (local — Forecast helper has its own)
      const parseRange = (a1: string): { r1: number; c1: number; r2: number; c2: number } | null => {
        const m = /^(?:[^!]+!)?\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(a1.trim());
        if (!m) return null;
        const colToIdx = (s: string) => {
          let n = 0;
          for (const c of s.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
          return n - 1;
        };
        return { c1: colToIdx(m[1]), r1: parseInt(m[2], 10) - 1, c2: colToIdx(m[3]), r2: parseInt(m[4], 10) - 1 };
      };
      const parseCell = (a1: string): { row: number; col: number } | null => {
        const m = /^(?:[^!]+!)?\$?([A-Za-z]+)\$?(\d+)$/.exec(a1.trim());
        if (!m) return null;
        let col = 0;
        for (const c of m[1].toUpperCase()) col = col * 26 + (c.charCodeAt(0) - 64);
        return { col: col - 1, row: parseInt(m[2], 10) - 1 };
      };
      const xParsed = parseRange(p.xRange);
      const yParsed = parseRange(p.yRange);
      const dst = parseCell(p.destination);
      if (!xParsed || !yParsed || !dst) return;
      const readVals = (pr: { r1: number; c1: number; r2: number; c2: number }): unknown[] => {
        const out: unknown[] = [];
        for (let r = pr.r1; r <= pr.r2; r++) {
          for (let c = pr.c1; c <= pr.c2; c++) {
            const cell = (sheet.cellData?.[String(r)] as Record<string, { v?: unknown }> | undefined)?.[String(c)];
            out.push(cell?.v);
          }
        }
        return out;
      };
      const xs = parseXValues(readVals(xParsed));
      const ys = readVals(yParsed).map((v) => (typeof v === "number" ? v : Number(v)));
      const result = runForecast({
        xValues: xs,
        yValues: ys,
        periods: p.periods,
        confidenceLevel: p.confidence,
      });
      const cd = sheet.cellData ?? (sheet.cellData = {});
      const headers = p.showConfidence ? ["X", "Y (実測)", "予測", "下限", "上限"] : ["X", "Y (実測)", "予測"];
      headers.forEach((h, i) => {
        if (!cd[String(dst.row)]) cd[String(dst.row)] = {};
        (cd[String(dst.row)] as Record<string, unknown>)[String(dst.col + i)] = { v: h };
      });
      const histN = result.xs.length - result.forecast.length;
      for (let i = 0; i < result.xs.length; i++) {
        const rowKey = String(dst.row + 1 + i);
        if (!cd[rowKey]) cd[rowKey] = {};
        const r = cd[rowKey] as Record<string, unknown>;
        r[String(dst.col)] = { v: result.xs[i] };
        r[String(dst.col + 1)] = { v: result.ys[i] ?? "" };
        if (i >= histN) {
          const k = i - histN;
          r[String(dst.col + 2)] = { v: result.forecast[k] };
          if (p.showConfidence) {
            r[String(dst.col + 3)] = { v: result.lower[k] };
            r[String(dst.col + 4)] = { v: result.upper[k] };
          }
        }
      }
      applyMutatedSnapshot(JSON.stringify(snap));
    },
    [applyMutatedSnapshot],
  );

  // --- Recommended Charts ----------------------------------------------------
  const openRecommendedChartsDialog = useCallback(() => {
    const ready = getReadyWorkbook("おすすめグラフ");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1";
    let values: unknown[][] = [];
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) {
        range = r.getA1Notation();
        const v = (r as unknown as { getValues?: () => unknown[][] }).getValues?.();
        if (Array.isArray(v)) values = v;
      }
    } catch {
      // best-effort
    }
    const recs = analyzeRange(values, true);
    setRecommendedChartsDialog({ sheetId, range, recommendations: recs });
  }, [getReadyWorkbook]);

  const applyRecommendedChart = useCallback(
    (type: string, range: string) => {
      if (!recommendedChartsDialog) return;
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      const snap = wb.save() as unknown as Record<string, unknown>;
      const sheets = (snap.sheets as Record<string, Record<string, unknown>>) ?? {};
      const sheetObj = sheets[recommendedChartsDialog.sheetId];
      if (!sheetObj) return;
      const existing = Array.isArray(sheetObj._charts) ? (sheetObj._charts as unknown[]) : [];
      sheetObj._charts = [...existing, { range, type }];
      applyMutatedSnapshot(JSON.stringify(snap));
    },
    [recommendedChartsDialog, applyMutatedSnapshot],
  );

  // --- Snapshot Diff ---------------------------------------------------------
  const openSnapshotDiffDialog = useCallback(async () => {
    if (!currentHandle?.path) {
      setEditorOperationError("スナップショット比較: ファイルを保存してから利用してください。");
      return;
    }
    try {
      const rows = await invoke<Array<{ snapshotId: number; createdAt: string }>>("workbook_list_snapshots", {
        path: currentHandle.path,
      });
      setSnapshotDiffOptions(
        rows.map((r) => ({
          id: String(r.snapshotId),
          label: `${new Date(r.createdAt).toLocaleString("ja-JP")} (#${r.snapshotId})`,
        })),
      );
      setSnapshotDiffOpen(true);
    } catch (e) {
      setEditorOperationError(`スナップショット比較: ${(e as Error).message}`);
    }
  }, [currentHandle]);

  const loadSnapshotJsonById = useCallback(
    async (id: string): Promise<string | null> => {
      if (!currentHandle?.path) return null;
      try {
        const r = await invoke<{ handle?: { snapshotJson?: string } }>("workbook_open_snapshot", {
          path: currentHandle.path,
          snapshotId: Number(id),
        });
        return r.handle?.snapshotJson ?? null;
      } catch {
        return null;
      }
    },
    [currentHandle],
  );

  // Shared utility: jump active selection to A1 cell/range on a given sheet.
  // Used by TableInfoPanel and SparklineListPanel.
  const jumpToA1OnSheet = useCallback((sheetId: string, a1: string) => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    try {
      const sheet = workbook.getSheetBySheetId
        ? workbook.getSheetBySheetId(sheetId)
        : null;
      if (sheet) {
        // best-effort sheet activation; not all Univer versions expose this
        const w = workbook as unknown as { setActiveSheet?: (s: unknown) => void };
        w.setActiveSheet?.(sheet);
        const range = (sheet as unknown as { getRange?: (a1: string) => unknown }).getRange?.(a1);
        if (range) {
          const r = range as { activate?: () => void };
          r.activate?.();
        }
      }
    } catch {
      // best-effort silent
    }
  }, []);

  // Reactive flag: is the active sheet currently protected per the snapshot?
  // Derived from `currentSnapshotJson` so the button label flips immediately
  // when toggleSheetProtection updates the store.
  const activeSheetProtected = (() => {
    if (!currentSnapshotJson) return false;
    // We can't easily get the live active sheet id here without a render
    // dependency on Univer, so fall back to the first sheet. The toggle
    // button always operates on the truly-active sheet via Univer's facade;
    // the label is just a quick hint and will be wrong for non-first sheets
    // until the snapshot re-derives. This is acceptable for the MVP.
    let sid: string | undefined = fUniverRef.current
      ?.getActiveWorkbook()
      ?.getActiveSheet()
      ?.getSheetId();
    if (!sid) {
      try {
        const snap = JSON.parse(currentSnapshotJson) as { sheetOrder?: string[] };
        sid = snap.sheetOrder?.[0];
      } catch {
        return false;
      }
    }
    return isSheetProtectedInSnapshot(currentSnapshotJson, sid ?? null);
  })();

  // Ref the latest snapshot JSON so the live command-blocking guard (registered
  // once at mount) can read it without re-subscribing on every keystroke.
  const snapshotRef = useRef(currentSnapshotJson);
  useEffect(() => {
    snapshotRef.current = currentSnapshotJson;
  }, [currentSnapshotJson]);

  // Remove the comment for a given cell from the snapshot, if present.
  // No-op when the sheet has no `_comments` array or the cell isn't in it.
  const deleteComment = useCallback(
    (sheetId: string, cellRef: string) => {
      if (!currentSnapshotJson) return;
      let snap: {
        sheets?: Record<string, { _comments?: Array<Record<string, unknown>> }>;
      };
      try {
        snap = JSON.parse(currentSnapshotJson);
      } catch {
        return;
      }
      const list = snap.sheets?.[sheetId]?._comments;
      if (!list) return;
      const next = list.filter((c) => (c.cell ?? c.cellRef) !== cellRef);
      if (next.length === list.length) return;
      if (next.length === 0) {
        // Drop the key entirely so the round-trip stays clean (Rust side
        // omits `_comments` when empty).
        delete snap.sheets![sheetId]._comments;
      } else {
        snap.sheets![sheetId]._comments = next;
      }
      applyMutatedSnapshot(JSON.stringify(snap));
    },
    [currentSnapshotJson, applyMutatedSnapshot],
  );

  // Derive the comment indicator list from the live snapshot so the panel
  // updates whenever a comment is added, edited, or deleted. #94: memoize on
  // currentSnapshotJson — on large workbooks the JSON.parse + walk cost is
  // measurable and gets paid on every unrelated re-render (toolbar mode
  // toggles, focus changes, etc.) without it.
  const commentIndicators: CommentIndicator[] = useMemo(
    () => computeCommentIndicators(currentSnapshotJson),
    [currentSnapshotJson],
  );

  // Derive the chart preview list from the live snapshot so the panel
  // updates whenever a chart is added/removed or its source data changes.
  // #94: memoize for the same reason as commentIndicators.
  const chartPreviews: ChartPreview[] = useMemo(
    () => computeChartPreviews(currentSnapshotJson),
    [currentSnapshotJson],
  );

  // Jump the Univer selection to a chart's source range when the user
  // clicks an entry in ChartPreviewPanel. Same best-effort pattern as the
  // comment indicator jump.
  const jumpToChartRange = useCallback((preview: ChartPreview) => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    try {
      const target = workbook.getSheetBySheetId(preview.sheetId);
      if (!target) return;
      const active = workbook.getActiveSheet();
      if (!active || active.getSheetId() !== preview.sheetId) {
        workbook.setActiveSheet(target);
      }
      const range = target.getRange(preview.range);
      if (range) range.activate();
    } catch {
      // Best-effort: swallow facade exceptions so a bad chart entry doesn't
      // crash the panel.
    }
  }, []);

  // Derive the embedded-image preview list from the live snapshot so the
  // panel updates when an image is inserted (G4) or after an xlsx is
  // freshly loaded (E1 stamped `_preservedParts`).
  const imagePreviews: ImagePreview[] = computeImagePreviews(currentSnapshotJson);

  // Jump the Univer selection to an image's anchor cell when the user
  // clicks a thumbnail.
  const jumpToImageCell = useCallback((image: ImagePreview) => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    try {
      const target = workbook.getSheetBySheetId(image.sheetId);
      if (!target) return;
      const active = workbook.getActiveSheet();
      if (!active || active.getSheetId() !== image.sheetId) {
        workbook.setActiveSheet(target);
      }
      const a1 = colRowToA1(image.fromCol, image.fromRow);
      const range = target.getRange(a1);
      if (range) range.activate();
    } catch {
      // Best-effort: swallow facade exceptions so a bad anchor doesn't
      // crash the panel.
    }
  }, []);

  // Jump the Univer selection to a commented cell when the user clicks an
  // entry in CommentIndicatorsPanel. Switches sheets first if needed, then
  // sets the active range to the target A1 cell. Best-effort — silent
  // no-op if Univer's facade isn't ready or the sheet/cell can't be found
  // (the panel still works as a read-only directory in that case).
  const jumpToCommentCell = useCallback((indicator: CommentIndicator) => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    try {
      const target = workbook.getSheetBySheetId(indicator.sheetId);
      if (!target) return;
      const active = workbook.getActiveSheet();
      if (!active || active.getSheetId() !== indicator.sheetId) {
        workbook.setActiveSheet(target);
      }
      const range = target.getRange(indicator.cell);
      if (range) range.activate();
    } catch {
      // Best-effort: swallow facade exceptions so a bad indicator entry
      // doesn't crash the panel.
    }
  }, []);

  // TODO(chart): live in-grid chart rendering for newly authored charts (see docs/TODOS.md#high-chart-live)
  // Open the chart dialog targeting the active sheet's current selection.
  // The Univer @univerjs/sheets-chart plugin isn't in this build, so the
  // dialog persists into `sheets.<id>._charts` (snapshot-level). The xlsx
  // round-trip preserves existing chart blobs byte-for-byte (xlsx_io.rs),
  // but newly authored entries are data-only — re-emitting chart OOXML is
  // out of scope here. Falls back to A1 if there's no live selection.
  const openChartDialog = useCallback(() => {
    const ready = getReadyWorkbook("グラフ");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1";
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) range = r.getA1Notation();
    } catch {
      // Best-effort: keep the A1 default if Univer's selection API throws.
    }
    setChartDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  // Append the authored chart to `sheets.<id>._charts` in the live workbook
  // snapshot. We re-derive from FWorkbook.save() (rather than the cached
  // currentSnapshotJson) so the apply doesn't clobber edits made while the
  // dialog was open. The on-disk shape is { range, type, title? } — matches
  // the dialog's emitted value plus the field rename (chartType -> type).
  const applyChart = useCallback(
    (value: ChartFormValue) => {
      if (!chartDialog) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const sheets = (snapshot.sheets as Record<string, Record<string, unknown>> | undefined) ?? {};
      const sheetObj = sheets[chartDialog.sheetId];
      if (!sheetObj) return;
      const existing = Array.isArray(sheetObj._charts)
        ? (sheetObj._charts as Array<Record<string, unknown>>)
        : [];
      const entry: Record<string, string> = {
        range: value.range,
        type: value.chartType,
      };
      if (value.title) entry.title = value.title;
      sheetObj._charts = [...existing, entry];
      applyMutatedSnapshot(JSON.stringify(snapshot));
    },
    [chartDialog, applyMutatedSnapshot],
  );

  // Number-format dialog plumbing. Captures the active selection's bounding
  // rows/cols + the anchor cell's existing `_fmt` (so the dialog can pre-select
  // a preset) and stashes them in state. We pin coords at open time so the
  // user can confirm later even if focus moves.
  const openNumberFormatDialog = useCallback(() => {
    const ready = getReadyWorkbook("表示形式");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const sheetName = sheet.getSheetName();
    let startRow = 0;
    let endRow = 0;
    let startCol = 0;
    let endCol = 0;
    let rangeLabel = `${sheetName}!A1`;
    try {
      const sel = sheet.getSelection();
      const range = sel?.getActiveRange();
      if (range) {
        startRow = range.getRow();
        startCol = range.getColumn();
        // Univer's facade only exposes width/height on FRange — derive the
        // end coords from the width/height so we cover multi-cell selections.
        const height = (range as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
        const width = (range as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
        endRow = startRow + Math.max(0, height - 1);
        endCol = startCol + Math.max(0, width - 1);
        rangeLabel = `${sheetName}!${range.getA1Notation()}`;
      }
    } catch {
      // Best-effort: fall back to A1 single cell.
    }

    // Read existing _fmt on the anchor cell, if any, from the live snapshot.
    let initialCode = "";
    if (currentSnapshotJson) {
      try {
        const snap = JSON.parse(currentSnapshotJson) as {
          sheets?: Record<
            string,
            { cellData?: Record<string, Record<string, { _fmt?: string }>> }
          >;
        };
        const cell = snap.sheets?.[sheetId]?.cellData?.[String(startRow)]?.[String(startCol)];
        if (cell && typeof cell._fmt === "string") initialCode = cell._fmt;
      } catch {
        // Malformed snapshot — leave initialCode empty so "General" is picked.
      }
    }
    setNumFmtDialog({
      sheetId,
      startRow,
      endRow,
      startCol,
      endCol,
      rangeLabel,
      initialCode,
    });
  }, [currentSnapshotJson, getReadyWorkbook]);

  // Apply a format code to every cell in the captured selection by walking
  // the snapshot directly: read → mutate cellData[r][c]._fmt → write back via
  // updateSnapshot. We use the snapshot path because Univer 0.5.x's facade
  // exposes setNumberFormat only via the optional @univerjs/sheets-numfmt
  // plugin, which Coco doesn't register; the round-trip in xlsx_io.rs is
  // already keyed off the per-cell `_fmt` field, so this is the simplest
  // path that preserves the format through save/load.
  const applyNumberFormat = useCallback(
    (value: NumberFormatValue) => {
      if (!numFmtDialog) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      // Re-derive the snapshot from Univer (not the cached JSON) so we don't
      // clobber edits the user made while the dialog was open.
      const snapshot = workbook.save() as unknown as {
        sheets?: Record<
          string,
          {
            cellData?: Record<
              string,
              Record<string, Record<string, unknown> | undefined>
            >;
          }
        >;
      };
      const sheetObj = snapshot.sheets?.[numFmtDialog.sheetId];
      if (!sheetObj) return;
      if (!sheetObj.cellData) sheetObj.cellData = {};
      const cellData = sheetObj.cellData;
      const code = value.code.trim();
      for (let r = numFmtDialog.startRow; r <= numFmtDialog.endRow; r++) {
        const rowKey = String(r);
        if (!cellData[rowKey]) cellData[rowKey] = {};
        const row = cellData[rowKey];
        for (let c = numFmtDialog.startCol; c <= numFmtDialog.endCol; c++) {
          const colKey = String(c);
          const existing = row[colKey];
          if (code) {
            // Create the cell if it didn't exist (formatting a blank cell is
            // legitimate — Excel keeps the style on empty cells too).
            const cell = existing ?? {};
            cell._fmt = code;
            row[colKey] = cell;
          } else if (existing) {
            // Empty code means "General" → drop the _fmt key entirely so the
            // round-trip stays clean (Rust side omits unset formats).
            delete existing._fmt;
          }
        }
      }
      applyMutatedSnapshot(JSON.stringify(snapshot));
    },
    [numFmtDialog, applyMutatedSnapshot],
  );

  // AutoSum (Σ / Alt+=). Excel's heuristic: look for a contiguous run of
  // numeric cells *above* the active cell, fall back to *left* if none. Write
  // `=SUM(start:end)` into the active cell via the snapshot's cellData.f so
  // Univer's formula engine evaluates it on next paint. We route through the
  // snapshot (not FRange.setValue("=SUM(...)")) because the snapshot path
  // composes with our other mutations and matches the rest of EditorScreen.
  const applyAutoSum = useCallback(() => {
    const ready = getReadyWorkbook("オートSUM");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let row = 0;
    let col = 0;
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) {
        row = r.getRow();
        col = r.getColumn();
      }
    } catch {
      // Fall back to A1.
    }
    // Re-derive the snapshot from Univer so we see the latest edits.
    const snapshot = workbook.save() as unknown as {
      sheets?: Record<
        string,
        {
          cellData?: Record<
            string,
            Record<string, Record<string, unknown> | undefined>
          >;
        }
      >;
    };
    const inferred = inferAutoSumRange(JSON.stringify(snapshot), sheetId, row, col);
    if (!inferred) return; // No numeric neighbours — no-op.
    const formula = buildSumFormula(inferred);
    const sheetObj = snapshot.sheets?.[sheetId];
    if (!sheetObj) return;
    if (!sheetObj.cellData) sheetObj.cellData = {};
    const cellData = sheetObj.cellData;
    const rowKey = String(row);
    if (!cellData[rowKey]) cellData[rowKey] = {};
    const existing = cellData[rowKey][String(col)];
    // #103: anchor cell already has a value (label like "合計", another
    // formula, etc.) → confirm before destroying it. Empty cells (no `v`
    // and no `f`) overwrite silently as before.
    const hasValue =
      existing &&
      (existing.v !== undefined ||
        (typeof existing.f === "string" && (existing.f as string).length > 0));
    if (hasValue) {
      const preview =
        existing.v !== undefined ? String(existing.v) : String(existing.f ?? "");
      const trimmed = preview.length > 40 ? preview.slice(0, 40) + "…" : preview;
      const ok = window.confirm(
        `アクティブセルに値 "${trimmed}" があります。${formula} で上書きしますか？`,
      );
      if (!ok) return;
    }
    const cell = existing ?? {};
    cell.f = formula;
    // Drop any stale literal value — Univer will recompute via the formula.
    delete cell.v;
    cellData[rowKey][String(col)] = cell;
    applyMutatedSnapshot(JSON.stringify(snapshot));
  }, [getReadyWorkbook, applyMutatedSnapshot]);

  // Quick-format buttons (通貨 / %). Reuses the same snapshot-level _fmt path
  // as the Number Format dialog but skips the dialog — one click applies a
  // preset. Range = current selection (multi-cell ok).
  const applyQuickFormat = useCallback(
    (code: string) => {
      const ready = getReadyWorkbook("表示形式");
      if (!ready) return;
      const { workbook } = ready;
      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      const sheetId = sheet.getSheetId();
      let startRow = 0;
      let endRow = 0;
      let startCol = 0;
      let endCol = 0;
      try {
        const sel = sheet.getSelection();
        const range = sel?.getActiveRange();
        if (range) {
          startRow = range.getRow();
          startCol = range.getColumn();
          const height =
            (range as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
          const width =
            (range as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
          endRow = startRow + Math.max(0, height - 1);
          endCol = startCol + Math.max(0, width - 1);
        }
      } catch {
        // Fall back to single A1 cell.
      }
      // Re-derive the snapshot so we don't clobber concurrent edits.
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const nextJson = applyQuickNumberFormat(
        JSON.stringify(snapshot),
        sheetId,
        { startRow, endRow, startCol, endCol },
        code,
      );
      applyMutatedSnapshot(nextJson);
    },
    [getReadyWorkbook, applyMutatedSnapshot],
  );

  // Insert-image dialog plumbing. Snapshots the active sheet + the top-left of
  // the active range so the image anchors at the user's actual cursor cell.
  const openImageDialog = useCallback(() => {
    const ready = getReadyWorkbook("画像挿入");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let cell = "A1";
    try {
      const sel = sheet.getSelection();
      const range = sel?.getActiveRange();
      if (range) {
        const a1 = range.getA1Notation();
        cell = a1.includes(":") ? a1.split(":")[0] : a1;
      }
    } catch {
      // fall back to A1
    }
    setImageDialog({ sheetId, cell });
  }, [getReadyWorkbook]);

  // Tauri-side file picker for the image dialog. Opens the OS open-dialog,
  // reads the chosen file via our `read_file_bytes_base64` command, and
  // returns the prepared payload. Returns null if the user cancels.
  const pickImageFile = useCallback(async (): Promise<ImagePickResult | null> => {
    const chosen = await openDialog({
      title: "画像ファイルを選択",
      multiple: false,
      filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif"] }],
    });
    if (!chosen) return null;
    const path = typeof chosen === "string" ? chosen : chosen[0];
    if (!path) return null;
    const base64 = await invoke<string>("read_file_bytes_base64", { path });
    const name = path.split(/[\\/]/).pop() ?? path;
    // Normalize "jpeg" → "jpg" so the media part name stays in the canonical
    // form Excel/rust_xlsxwriter use (`xl/media/imageN.jpg`).
    const extRaw = (name.split(".").pop() ?? "").toLowerCase();
    const ext = extRaw === "jpeg" ? "jpg" : extRaw;
    return { ext, base64, name };
  }, []);

  // Parse a single-cell A1 ref → 0-based (col, row). Returns null on bad input.
  const a1ToColRow = (a1: string): { col: number; row: number } | null => {
    const m = /^\$?([A-Za-z]+)\$?([1-9]\d*)$/.exec(a1.trim());
    if (!m) return null;
    const letters = m[1].toUpperCase();
    let col = 0;
    for (let i = 0; i < letters.length; i++) {
      col = col * 26 + (letters.charCodeAt(i) - 64);
    }
    return { col: col - 1, row: parseInt(m[2], 10) - 1 };
  };

  // Apply the new image by mutating the snapshot's `_preservedParts`.
  // Returns null on success, or a user-visible error string on rejection
  // (#50: surface failures back to the dialog instead of silently closing it).
  const applyImage = useCallback(
    (value: ImageFormValue): string | null => {
      if (!imageDialog) return "ダイアログの状態が無効です";
      const fUniver = fUniverRef.current;
      if (!fUniver) return "ワークブックがまだ準備できていません";
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return "アクティブなワークブックがありません";
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const sheetOrder = (snapshot.sheetOrder as string[] | undefined) ?? [];
      const sheetIdx = sheetOrder.indexOf(imageDialog.sheetId);
      if (sheetIdx < 0) return "対象シートが見つかりません";
      const pos = a1ToColRow(value.cell);
      if (!pos) return "アンカーセルの解析に失敗しました";

      type PreservedPart = string;
      type SheetRef = {
        drawingRid?: string | null;
        drawingTarget?: string | null;
        pivotRels?: Array<{ rid: string; target: string }>;
      } | null;
      const preserved = (snapshot._preservedParts as
        | {
            parts?: Record<string, PreservedPart>;
            sheetRefs?: SheetRef[];
            contentTypes?: string;
          }
        | undefined) ?? {};
      const parts: Record<string, PreservedPart> = { ...(preserved.parts ?? {}) };
      const sheetRefs: SheetRef[] = (preserved.sheetRefs ?? []).slice();

      const existing = sheetRefs[sheetIdx];
      if (existing && existing.drawingRid) {
        // #50: previously silently logged + returned. Surface the limitation
        // so the user understands why their insert was rejected.
        return "このシートには既に図形/画像があります。現状は1シートに1つまで挿入できます。";
      }

      const usedImageNums = new Set<number>();
      const usedDrawingNums = new Set<number>();
      for (const key of Object.keys(parts)) {
        const mImg = /^xl\/media\/image(\d+)\.[a-zA-Z]+$/.exec(key);
        if (mImg) usedImageNums.add(parseInt(mImg[1], 10));
        const mDr = /^xl\/drawings\/drawing(\d+)\.xml$/.exec(key);
        if (mDr) usedDrawingNums.add(parseInt(mDr[1], 10));
      }
      let imgN = 1;
      while (usedImageNums.has(imgN)) imgN++;
      let drN = 1;
      while (usedDrawingNums.has(drN)) drN++;

      const mediaName = `xl/media/image${imgN}.${value.ext}`;
      const drawingName = `xl/drawings/drawing${drN}.xml`;
      const drawingRelsName = `xl/drawings/_rels/drawing${drN}.xml.rels`;

      const fromCol = pos.col;
      const fromRow = pos.row;
      const toCol = fromCol + 4;
      const toRow = fromRow + 10;
      const drawingXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
        ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
        ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<xdr:twoCellAnchor editAs="oneCell">` +
        `<xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
        `<xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
        `<xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:pic>` +
        `<xdr:nvPicPr>` +
        `<xdr:cNvPr id="2" name="Picture 1"/>` +
        `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>` +
        `</xdr:nvPicPr>` +
        `<xdr:blipFill>` +
        `<a:blip r:embed="rId1"/>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</xdr:blipFill>` +
        `<xdr:spPr>` +
        `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `</xdr:spPr>` +
        `</xdr:pic>` +
        `<xdr:clientData/>` +
        `</xdr:twoCellAnchor>` +
        `</xdr:wsDr>`;

      const drawingRelsXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"` +
        ` Target="../media/image${imgN}.${value.ext}"/>` +
        `</Relationships>`;

      const xmlToB64 = (s: string): string => {
        const bytes = new TextEncoder().encode(s);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      };

      parts[mediaName] = value.base64;
      parts[drawingName] = xmlToB64(drawingXml);
      parts[drawingRelsName] = xmlToB64(drawingRelsXml);

      while (sheetRefs.length <= sheetIdx) sheetRefs.push(null);
      sheetRefs[sheetIdx] = {
        drawingRid: "rId1",
        drawingTarget: `../drawings/drawing${drN}.xml`,
        pivotRels: existing?.pivotRels ?? [],
      };

      (snapshot as Record<string, unknown>)._preservedParts = {
        ...preserved,
        parts,
        sheetRefs,
      };

      applyMutatedSnapshot(JSON.stringify(snapshot));
      return null;
    },
    [imageDialog, applyMutatedSnapshot],
  );

  // Open the sort dialog with the active sheet + a default range derived from
  // the current selection. Falls back to A1:A1 when there's no live selection.
  const openSortDialog = useCallback(() => {
    const ready = getReadyWorkbook("並べ替え");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1:A1";
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        // Single-cell selections aren't sortable — promote to a self range so
        // the dialog's validation can prompt the user to widen it.
        range = a1.includes(":") ? a1 : `${a1}:${a1}`;
      }
    } catch {
      // Best-effort: keep the A1:A1 default.
    }
    setSortDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  // Apply a sort by mutating the snapshot's cellData for the target sheet in
  // place. Univer 0.5.x doesn't expose a stable FRange.sort() in this build
  // (sheets-sort isn't installed), so we do the row reordering ourselves:
  //   1. Parse the A1 range into start/end row+col.
  //   2. Collect each row's cellData (per-cell shallow copy) within the
  //      column window.
  //   3. Sort the rows by the requested keys (asc/desc), comparing numerically
  //      when both sides are numeric, otherwise as case-insensitive strings.
  //   4. Write the rows back into cellData in the new order, dropping any
  //      old cells in the affected columns that aren't replaced.
  const applySort = useCallback(
    (value: SortFormValue) => {
      if (!sortDialog) return;
      const ready = getReadyWorkbook("並べ替え");
      if (!ready) return;
      const { workbook } = ready;
      const snapshot = workbook.save() as unknown as {
        sheets?: Record<
          string,
          {
            cellData?: Record<
              string,
              Record<string, Record<string, unknown> | undefined>
            >;
          }
        >;
      };
      const sheetObj = snapshot.sheets?.[sortDialog.sheetId];
      if (!sheetObj) {
        setEditorOperationError("並べ替え: 対象シートが見つかりません。");
        return;
      }
      if (!sheetObj.cellData) sheetObj.cellData = {};
      const cellData = sheetObj.cellData;

      // Strip an optional "Sheet!" prefix; the apply targets the captured
      // sheetId already so a prefix from another sheet would just be ignored
      // anyway. We're permissive on this.
      const bareRange = value.range.includes("!")
        ? value.range.split("!")[1]
        : value.range;
      const m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(bareRange);
      if (!m) return;
      const colLettersToIdx = (letters: string): number => {
        let n = 0;
        for (const ch of letters.toUpperCase()) {
          n = n * 26 + (ch.charCodeAt(0) - 64);
        }
        return n - 1;
      };
      const c1 = colLettersToIdx(m[1]);
      const r1 = parseInt(m[2], 10) - 1;
      const c2 = colLettersToIdx(m[3]);
      const r2 = parseInt(m[4], 10) - 1;
      const startRow = Math.min(r1, r2);
      const endRow = Math.max(r1, r2);
      const startCol = Math.min(c1, c2);
      const endCol = Math.max(c1, c2);
      const firstSortRow = value.hasHeader ? startRow + 1 : startRow;
      if (firstSortRow > endRow) return;

      // Pull each row (only the columns inside the range) into an array so
      // we can reorder by index without mutating cellData mid-iteration.
      type RowSlice = Record<string, Record<string, unknown> | undefined>;
      const slices: RowSlice[] = [];
      for (let r = firstSortRow; r <= endRow; r++) {
        const slice: RowSlice = {};
        const src = cellData[String(r)];
        if (src) {
          for (let c = startCol; c <= endCol; c++) {
            const cell = src[String(c)];
            if (cell !== undefined) slice[String(c)] = cell;
          }
        }
        slices.push(slice);
      }

      const readSortValue = (slice: RowSlice, colIdx: number): unknown => {
        const cell = slice[String(colIdx)];
        if (!cell) return undefined;
        // Univer cell shape: { v: primitive } | { p: rich-text doc }. For the
        // PoC we compare on `v`; rich-text cells fall back to an empty string.
        const v = (cell as { v?: unknown }).v;
        return v;
      };

      const compare = (a: RowSlice, b: RowSlice): number => {
        for (const lv of value.levels) {
          // Convert 1-based column to absolute 0-based index inside cellData.
          const absCol = startCol + (lv.column - 1);
          const av = readSortValue(a, absCol);
          const bv = readSortValue(b, absCol);
          // Empty / undefined always sorts last regardless of direction
          // (mirrors Excel's "blanks at the bottom" convention).
          const aEmpty = av === undefined || av === null || av === "";
          const bEmpty = bv === undefined || bv === null || bv === "";
          if (aEmpty && bEmpty) continue;
          if (aEmpty) return 1;
          if (bEmpty) return -1;
          let cmp = 0;
          if (typeof av === "number" && typeof bv === "number") {
            cmp = av - bv;
          } else {
            const as = String(av).toLowerCase();
            const bs = String(bv).toLowerCase();
            cmp = as < bs ? -1 : as > bs ? 1 : 0;
          }
          if (cmp !== 0) return lv.ascending ? cmp : -cmp;
        }
        return 0;
      };

      slices.sort(compare);

      // Wipe the original rows' columns inside the range, then write back the
      // sorted slices. We avoid deleting whole rows so cells outside the
      // column window stay put.
      for (let r = firstSortRow; r <= endRow; r++) {
        const row = cellData[String(r)];
        if (!row) continue;
        for (let c = startCol; c <= endCol; c++) {
          delete row[String(c)];
        }
      }
      for (let i = 0; i < slices.length; i++) {
        const r = firstSortRow + i;
        const rowKey = String(r);
        if (!cellData[rowKey]) cellData[rowKey] = {};
        const row = cellData[rowKey];
        for (const [colKey, cell] of Object.entries(slices[i])) {
          if (cell !== undefined) row[colKey] = cell;
        }
      }

      applyMutatedSnapshot(JSON.stringify(snapshot));
    },
    [getReadyWorkbook, sortDialog, applyMutatedSnapshot],
  );

  // Format Painter: capture the anchor cell's style from the live workbook
  // snapshot and arm the tool. `mode` distinguishes single-shot vs sticky;
  // a fresh activation while already armed cycles through (single → sticky → idle).
  const activateFormatPainter = useCallback(
    (mode: "single" | "sticky") => {
      const ready = getReadyWorkbook("書式コピー");
      if (!ready) return;
      const { workbook } = ready;
      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      const sheetId = sheet.getSheetId();
      let row = 0;
      let col = 0;
      try {
        const sel = sheet.getSelection();
        const range = sel?.getActiveRange();
        if (range) {
          row = range.getRow();
          col = range.getColumn();
        }
      } catch {
        // Best-effort: fall back to A1.
      }
      // Re-derive snapshot from Univer so we see the latest style edits that
      // might not have made it into currentSnapshotJson yet (300ms debounce).
      let style: Record<string, unknown> | null = null;
      try {
        const snap = JSON.stringify(workbook.save());
        style = extractCellStyle(snap, sheetId, row, col);
      } catch {
        style = null;
      }
      // Even when the anchor cell has no style we still arm the tool — the
      // user can pick up a "no style" eraser semantic, but for the MVP we
      // just no-op in that case to avoid surprising the user.
      if (!style) {
        // eslint-disable-next-line no-console
        console.warn("書式コピー: コピー元のセルに書式がありません");
        return;
      }
      pendingFormatRef.current = style;
      formatPainterArmedAtRef.current = Date.now();
      setFormatPainterMode(mode);
    },
    [getReadyWorkbook],
  );

  const deactivateFormatPainter = useCallback(() => {
    pendingFormatRef.current = null;
    setFormatPainterMode("idle");
  }, []);

  // Toolbar button click handler. Tracks single vs double click so we can
  // distinguish "apply once" (single click) from "stay active" (double click).
  // We use a short timer to defer the single-click action so a follow-up click
  // can promote it into a double-click — matches the canonical Excel UX.
  const formatPainterClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFormatPainterClick = useCallback(() => {
    // Toggle off if already active in either mode.
    if (formatPainterMode !== "idle") {
      if (formatPainterClickTimerRef.current) {
        clearTimeout(formatPainterClickTimerRef.current);
        formatPainterClickTimerRef.current = null;
      }
      deactivateFormatPainter();
      return;
    }
    // Defer single-click activation briefly so a double-click promotes to sticky.
    if (formatPainterClickTimerRef.current) {
      clearTimeout(formatPainterClickTimerRef.current);
    }
    formatPainterClickTimerRef.current = setTimeout(() => {
      formatPainterClickTimerRef.current = null;
      activateFormatPainter("single");
    }, 220);
  }, [formatPainterMode, activateFormatPainter, deactivateFormatPainter]);

  // Wire the format-painter "apply on next selection" listener. Subscribes to
  // FWorkbook.onSelectionChange once the workbook is mounted; the listener
  // pulls the pending style + active sheet + new selection ranges and writes
  // through updateSnapshot. Single mode deactivates after the first apply;
  // sticky mode keeps going until ESC.
  useEffect(() => {
    if (formatPainterMode === "idle") return;
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    const onSelectionChange = (workbook as unknown as {
      onSelectionChange?: (cb: (ranges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>) => void) => { dispose: () => void };
    }).onSelectionChange;
    if (typeof onSelectionChange !== "function") return;

    const disposable = onSelectionChange.call(workbook, (ranges) => {
      // Ignore the synchronous initial fire that some Univer versions emit
      // when a listener is attached — debounce ~50ms against arm time.
      if (Date.now() - formatPainterArmedAtRef.current < 50) return;
      const style = pendingFormatRef.current;
      if (!style) return;
      if (!Array.isArray(ranges) || ranges.length === 0) return;
      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      const sheetId = sheet.getSheetId();
      // Re-derive snapshot live so we don't clobber concurrent edits.
      let snapJson: string;
      try {
        snapJson = JSON.stringify(workbook.save());
      } catch {
        return;
      }
      let next = snapJson;
      for (const r of ranges) {
        if (
          typeof r?.startRow !== "number" ||
          typeof r?.endRow !== "number" ||
          typeof r?.startColumn !== "number" ||
          typeof r?.endColumn !== "number"
        ) {
          continue;
        }
        next = applyCellStyle(
          next,
          sheetId,
          {
            startRow: r.startRow,
            endRow: r.endRow,
            startCol: r.startColumn,
            endCol: r.endColumn,
          },
          style,
        );
      }
      if (next !== snapJson) {
        applyMutatedSnapshot(next);
      }
      if (formatPainterMode === "single") {
        deactivateFormatPainter();
      }
    });

    return () => disposable.dispose();
  }, [formatPainterMode, applyMutatedSnapshot, deactivateFormatPainter]);

  // Open-file flow for the command palette. Mirrors useGlobalShortcuts' Ctrl+O
  // logic so the palette and the keyboard binding stay in lock step. We can't
  // simply reuse the hook because that listener is registered higher up in
  // App; routing through the store actions directly is cleaner than firing a
  // synthetic keyboard event.
  const openFromPalette = useCallback(async () => {
    if (!confirmDiscardIfUnsaved()) return;
    const selected = await openDialog({
      multiple: false,
      filters: [
        { name: "Excel / CSV / TSV", extensions: ["xlsx", "xlsm", "csv", "tsv"] },
        { name: "Excel Files", extensions: ["xlsx", "xlsm"] },
        { name: "CSV / TSV Files", extensions: ["csv", "tsv"] },
      ],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    const route = routeOpenPath(path);
    if (route.kind === "coco") await openCoco(route.path);
    else if (route.kind === "csv") await importCsv(route.path);
    else if (route.kind === "xlsx") await importXlsx(route.path);
  }, [openCoco, importXlsx, importCsv]);

  const newFromPalette = useCallback(async () => {
    if (!confirmDiscardIfUnsaved()) return;
    await newWorkbook();
  }, [newWorkbook]);

  // Build the command palette's command list. Each entry pairs an existing
  // handler with a label, optional category, and shortcut hint. We rebuild
  // every render so callbacks always see the latest closures (cheap — ~20
  // objects).
  const paletteCommands: PaletteCommand[] = [
    {
      id: "file.save",
      label: "保存",
      category: "ファイル",
      shortcut: "Ctrl+S",
      keywords: "save",
      run: () => void save(),
    },
    {
      id: "file.saveAs",
      label: "名前を付けて保存",
      category: "ファイル",
      shortcut: "Ctrl+Shift+S",
      keywords: "save as",
      run: () => void promptSaveAs(),
    },
    {
      id: "file.open",
      label: "ファイルを開く",
      category: "ファイル",
      shortcut: "Ctrl+O",
      keywords: "open",
      run: () => void openFromPalette(),
    },
    {
      id: "file.new",
      label: "新規ワークブック",
      category: "ファイル",
      shortcut: "Ctrl+N",
      keywords: "new",
      run: () => void newFromPalette(),
    },
    {
      id: "file.exportXlsx",
      label: "xlsx としてエクスポート",
      category: "エクスポート",
      keywords: "export xlsx",
      run: () => void exportXlsx(),
    },
    {
      id: "file.exportCsv",
      label: "CSV としてエクスポート",
      category: "エクスポート",
      keywords: "export csv",
      run: () => void handleCsvExport(),
    },
    {
      id: "insert.hyperlink",
      label: "ハイパーリンクを挿入",
      category: "挿入",
      shortcut: "Ctrl+K",
      keywords: "hyperlink link",
      run: openHyperlinkDialog,
    },
    {
      id: "insert.comment",
      label: "コメントを挿入 / 編集",
      category: "挿入",
      shortcut: "Shift+F2",
      keywords: "comment note",
      run: openCommentDialog,
    },
    {
      id: "insert.chart",
      label: "グラフを挿入",
      category: "挿入",
      keywords: "chart graph",
      run: openChartDialog,
    },
    {
      id: "insert.image",
      label: "画像を挿入",
      category: "挿入",
      keywords: "image picture",
      run: openImageDialog,
    },
    {
      id: "insert.namedRange",
      label: "名前付き範囲を編集",
      category: "挿入",
      shortcut: "Ctrl+F3",
      keywords: "named range name manager",
      run: openNamedRangesDialog,
    },
    {
      id: "format.conditional",
      label: "条件付き書式",
      category: "書式",
      shortcut: "Ctrl+F8",
      keywords: "conditional formatting cf",
      run: openCfDialog,
    },
    {
      id: "format.dataValidation",
      label: "データの入力規則",
      category: "書式",
      keywords: "data validation dv",
      run: openDataValidationDialog,
    },
    {
      id: "format.numberFormat",
      label: "表示形式",
      category: "書式",
      shortcut: "Ctrl+1",
      keywords: "number format cells",
      run: openNumberFormatDialog,
    },
    {
      id: "format.tabColor",
      label: "シートタブの色",
      category: "書式",
      keywords: "tab color sheet",
      run: openTabColorDialog,
    },
    {
      id: "format.painter",
      label: "書式のコピー / 貼り付け",
      category: "書式",
      keywords: "format painter brush",
      run: handleFormatPainterClick,
    },
    {
      id: "format.protection",
      label: activeSheetProtected ? "シート保護を解除" : "シートを保護",
      category: "書式",
      keywords: "protect sheet readonly",
      run: toggleSheetProtection,
    },
    {
      id: "data.sort",
      label: "並べ替え",
      category: "データ",
      keywords: "sort",
      run: openSortDialog,
    },
    {
      id: "view.snapshots",
      label: "スナップショット履歴",
      category: "表示",
      keywords: "history snapshots",
      run: () => setSnapshotsOpen(true),
    },
    {
      id: "view.settings",
      label: "設定",
      category: "表示",
      shortcut: "Ctrl+,",
      keywords: "settings preferences",
      run: () => requestSettings(),
    },
    {
      id: "view.help",
      label: "ヘルプ",
      category: "表示",
      shortcut: "F1",
      keywords: "help shortcuts",
      run: () => requestHelp(),
    },
  ];

  useAutoSave();

  // Keyboard shortcuts (req 4.6): Ctrl+S / Cmd+S = save; Ctrl+Shift+S / Cmd+Shift+S = save as.
  // Ctrl+F3 opens the named-ranges dialog — Excel's convention for "Name Manager".
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "p" || e.key === "P")) {
        // VS Code / Slack convention. Some browsers map Ctrl+Shift+P to print
        // preview, but that mapping is owned by Chromium and only fires on
        // browser-chrome focus — inside a Tauri WebView the page-level listener
        // wins, so preventDefault here is enough to keep the binding ours.
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        promptSaveAs();
      } else if (mod && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        save();
      } else if (mod && e.key === "F3") {
        e.preventDefault();
        openNamedRangesDialog();
      } else if (mod && (e.key === "F8" || e.key === "f8")) {
        // Excel binds Ctrl+F8 to "Workbook Size" — we don't implement that
        // legacy dialog, so we reuse the binding for our authoring dialog
        // since the closest stock Excel binding (Home → Conditional Formatting)
        // is a ribbon path with no portable shortcut.
        e.preventDefault();
        openCfDialog();
      } else if (mod && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        // Ctrl+K / Cmd+K — Excel's Insert Hyperlink shortcut.
        e.preventDefault();
        openHyperlinkDialog();
      } else if (!mod && e.shiftKey && e.key === "F2") {
        // Shift+F2 is Excel's convention for "Insert / Edit Cell Comment".
        e.preventDefault();
        openCommentDialog();
      } else if (mod && !e.shiftKey && e.key === "1") {
        // Ctrl+1 / Cmd+1 — Excel's "Format Cells" dialog. We narrow it to the
        // Number Format dialog for the PoC.
        e.preventDefault();
        openNumberFormatDialog();
      } else if (!mod && e.key === "Escape" && formatPainterMode !== "idle") {
        // ESC exits the Format Painter tool (matches Excel's UX).
        e.preventDefault();
        deactivateFormatPainter();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "=") {
        // Alt+= — Excel's AutoSum shortcut. Writes =SUM(...) into the active
        // cell, inferring the range from numeric neighbours.
        e.preventDefault();
        applyAutoSum();
      }
    },
    [
      save,
      promptSaveAs,
      openNamedRangesDialog,
      openCfDialog,
      openHyperlinkDialog,
      openCommentDialog,
      openNumberFormatDialog,
      formatPainterMode,
      deactivateFormatPainter,
      applyAutoSum,
    ]
  );

  const runCsvExport = useCallback(
    async (sheet: { id: string; name: string }) => {
      const defaultName = currentHandle?.path
        ? currentHandle.path.replace(/\.[^./\\]*$/, "") + `_${sheet.name}.csv`
        : `${sheet.name}.csv`;
      const baseName = defaultName.split(/[\\/]/).pop() ?? "Untitled.csv";
      const chosen = await saveDialog({
        title: `CSV としてエクスポート — ${sheet.name}`,
        defaultPath: baseName,
        filters: [
          { name: "CSV (カンマ区切り)", extensions: ["csv"] },
          { name: "TSV (タブ区切り)", extensions: ["tsv"] },
        ],
      });
      if (!chosen) return;
      await exportCsvToPath(chosen, sheet.id);
    },
    [currentHandle, exportCsvToPath]
  );

  const handleCsvExport = useCallback(async () => {
    if (!getReadyWorkbook("CSV エクスポート")) return;
    const sheets = await listSheetNames();
    if (sheets.length === 0) {
      setEditorOperationError("CSV エクスポート: エクスポートできるシートがまだありません。");
      return;
    }
    setEditorOperationError(null);
    if (sheets.length === 1) {
      await runCsvExport(sheets[0]);
      return;
    }
    setSheetPicker(sheets);
  }, [getReadyWorkbook, listSheetNames, runCsvExport]);

  const runEditorCommand = useCallback((id: string) => {
    switch (id) {
      case "edit-command-palette":
        setPaletteOpen(true);
        break;
      case "view-snapshots":
        setSnapshotsOpen(true);
        break;
      case "insert-hyperlink":
        openHyperlinkDialog();
        break;
      case "insert-comment":
        openCommentDialog();
        break;
      case "insert-chart":
        openChartDialog();
        break;
      case "insert-image":
        openImageDialog();
        break;
      case "format-number":
        openNumberFormatDialog();
        break;
      case "format-currency":
        applyQuickFormat(QUICK_FMT_CURRENCY);
        break;
      case "format-percent":
        applyQuickFormat(QUICK_FMT_PERCENT);
        break;
      case "format-conditional":
        openCfDialog();
        break;
      case "format-painter":
        handleFormatPainterClick();
        break;
      case "format-tab-color":
        openTabColorDialog();
        break;
      case "data-sort":
        openSortDialog();
        break;
      case "data-validation":
        openDataValidationDialog();
        break;
      case "data-named-ranges":
        openNamedRangesDialog();
        break;
      case "data-autosum":
        applyAutoSum();
        break;
      case "tools-sheet-protection":
        toggleSheetProtection();
        break;
      case "data-outline-groups":
        openOutlineDialog();
        break;
      case "insert-table":
        openTableDialog();
        break;
      case "insert-sparkline":
        openSparklineDialog();
        break;
      case "file-page-setup":
        openPageSetupDialog();
        break;
      case "view-tables-panel":
        setTablesPanelOpen((v) => !v);
        break;
      case "view-sparklines-panel":
        setSparklinesPanelOpen((v) => !v);
        break;
      case "format-cell-styles":
        openCellStylesDialog();
        break;
      case "tools-goal-seek":
        openGoalSeekDialog();
        break;
      case "tools-error-checking":
        setErrorCheckingOpen(true);
        break;
      case "view-show-formulas":
        setShowFormulasMode((v) => !v);
        break;
      case "view-errors-panel":
        setErrorsPanelOpen((v) => !v);
        break;
      case "data-subtotal":
        openSubtotalDialog();
        break;
      case "data-remove-duplicates":
        openRemoveDuplicatesDialog();
        break;
      case "data-text-to-columns":
        openTextToColumnsDialog();
        break;
      case "data-advanced-filter":
        openAdvancedFilterDialog();
        break;
      case "edit-flash-fill":
        openFlashFillDialog();
        break;
      case "insert-pivot":
        openPivotDialog();
        break;
      case "view-pivots-panel":
        setPivotsPanelOpen((v) => !v);
        break;
      case "view-charts-canvas-panel":
        setChartsCanvasPanelOpen((v) => !v);
        break;
      case "insert-slicer":
        openSlicerDialog();
        break;
      case "view-slicers-panel":
        setSlicersPanelOpen((v) => !v);
        break;
      case "edit-quick-analysis":
        openQuickAnalysisDialog();
        break;
      case "view-trace-panel":
        setTracePanelOpen((v) => !v);
        break;
      case "sheet-hide-active":
        hideActiveSheet();
        break;
      case "sheet-unhide":
        openUnhideDialog();
        break;
      case "sheet-move-copy":
        openMoveCopySheetDialog();
        break;
      case "insert-function":
        openInsertFunctionDialog();
        break;
      case "settings-custom-lists":
        openCustomListsDialog();
        break;
      case "calc-options":
        setCalcOptionsOpen(true);
        break;
      case "calc-recalc-all":
        window.dispatchEvent(new CustomEvent("coco:calc-recalc", { detail: { scope: "all" } }));
        break;
      case "calc-recalc-sheet":
        window.dispatchEvent(new CustomEvent("coco:calc-recalc", { detail: { scope: "sheet" } }));
        break;
      case "view-watch-window":
        setWatchWindowOpen((v) => !v);
        break;
      case "watch-add-active":
        addActiveCellToWatch();
        break;
      case "tools-scenarios":
        openScenarioManagerDialog();
        break;
      case "data-forecast-sheet":
        openForecastSheetDialog();
        break;
      case "insert-recommended-charts":
        openRecommendedChartsDialog();
        break;
      case "format-cf-manage-rules":
        setCfManagerOpen(true);
        break;
      case "view-snapshot-diff":
        void openSnapshotDiffDialog();
        break;
    }
  }, [
    openHyperlinkDialog,
    openCommentDialog,
    openChartDialog,
    openImageDialog,
    openNumberFormatDialog,
    applyQuickFormat,
    openCfDialog,
    handleFormatPainterClick,
    openTabColorDialog,
    openSortDialog,
    openDataValidationDialog,
    openNamedRangesDialog,
    applyAutoSum,
    toggleSheetProtection,
    openOutlineDialog,
    openTableDialog,
    openSparklineDialog,
    openPageSetupDialog,
    openCellStylesDialog,
    openGoalSeekDialog,
    openSubtotalDialog,
    openRemoveDuplicatesDialog,
    openTextToColumnsDialog,
    openAdvancedFilterDialog,
    openFlashFillDialog,
    openPivotDialog,
    openSlicerDialog,
    openQuickAnalysisDialog,
    hideActiveSheet,
    openUnhideDialog,
    openMoveCopySheetDialog,
    openInsertFunctionDialog,
    openCustomListsDialog,
    addActiveCellToWatch,
    openScenarioManagerDialog,
    openForecastSheetDialog,
    openRecommendedChartsDialog,
    openSnapshotDiffDialog,
  ]);

  // Export every sheet in the workbook as a separate <sheetName>.csv file
  // inside a user-chosen directory. Multi-sheet workbooks only — the single
  // -sheet case routes through runCsvExport which already prompts for a path.
  const runBulkCsvExport = useCallback(
    async (sheets: { id: string; name: string }[]) => {
      const chosenDir = await openDialog({ directory: true, multiple: false });
      if (!chosenDir) return;
      const dir = typeof chosenDir === "string" ? chosenDir : chosenDir[0];
      // Sanitize sheet names that contain path-illegal characters before
      // joining onto the directory; replace with "_" rather than reject so a
      // sheet named "Q1/2026" still produces a file.
      const sanitize = (n: string) => n.replace(/[\\/:*?"<>|]/g, "_");
      const outputs = sheets.map((sheet) => {
        const safeName = sanitize(sheet.name).trim() || "Sheet";
        const fileName = `${safeName}.csv`;
        // Cross-platform path join: use forward slash; both Windows and Unix
        // accept it in Tauri command paths.
        return { sheet, path: `${dir}/${fileName}` };
      });
      const seen = new Set<string>();
      const duplicate = outputs.find(({ path }) => {
        const key = path.toLowerCase();
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });
      if (duplicate) {
        setEditorOperationError("CSV エクスポート: シート名の変換後に同じファイル名になるため中止しました。");
        return;
      }
      const existing = await invoke<string[]>("existing_csv_export_paths", {
        paths: outputs.map((output) => output.path),
      });
      if (existing.length > 0) {
        const ok = window.confirm(
          `既存の CSV ファイル ${existing.length} 件を上書きします。続行しますか？`
        );
        if (!ok) return;
      }
      for (const { sheet, path } of outputs) {
        // Sequential — parallel writes would race on the rotate-backups
        // logic and confuse error reporting.
        await exportCsvToPath(path, sheet.id);
      }
    },
    [exportCsvToPath]
  );

  // Listen for the menu-driven CSV export request (App-level menu can't reach
  // the sheet picker state here directly, so the menu hook fires a window event).
  useEffect(() => {
    const onMenuCsvExport = () => {
      void handleCsvExport();
    };
    window.addEventListener("coco:menu-csv-export", onMenuCsvExport);
    return () => window.removeEventListener("coco:menu-csv-export", onMenuCsvExport);
  }, [handleCsvExport]);

  useEffect(() => {
    const onEditorCommand = (event: Event) => {
      const id = event instanceof CustomEvent ? event.detail : null;
      if (typeof id === "string") runEditorCommand(id);
    };
    window.addEventListener("coco:editor-command", onEditorCommand);
    return () => window.removeEventListener("coco:editor-command", onEditorCommand);
  }, [runEditorCommand]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Sync the openX refs with the current useCallback identities every
  // render. The Univer context-menu commands (registered once at mount)
  // read .current at invocation time, so this keeps them up to date
  // without re-registering against Univer on every render.
  openCommentDialogRef.current = openCommentDialog;
  openHyperlinkDialogRef.current = openHyperlinkDialog;
  openNumberFormatDialogRef.current = openNumberFormatDialog;

  // Mount Univer
  useEffect(() => {
    if (!containerRef.current) return;
    setEditorOperationError(null);

    let univer: Univer | null = null;
    let contextMenuReg: ReturnType<typeof registerCocoContextMenu> | null = null;

    try {
      // #95 note: Univer 0.5.x does not ship a `JA_JP` LocaleType, so the
      // app locale is always served from the EN_US slot — `buildCocoUniverLocale`
      // returns the JA override when getLocale() is "ja-JP". When Univer adds
      // JA_JP natively, switch this to `LocaleType.JA_JP` and split the
      // locales bundle accordingly. See cocoUniverLocale.ts for the
      // override list.
      univer = new Univer({
        theme: defaultTheme,
        locale: LocaleType.EN_US,
        locales: {
          [LocaleType.EN_US]: buildCocoUniverLocale(getLocale()),
        },
        // FR-011: bump the per-unit undo stack from Univer's default 20 to 100.
        override: undoRedoOverride,
      });

      univer.registerPlugin(UniverRenderEnginePlugin);
      univer.registerPlugin(UniverFormulaEnginePlugin);
      univer.registerPlugin(UniverUIPlugin, {
        container: "univer-container",
        header: true,
        footer: true,
      });
      univer.registerPlugin(UniverDocsPlugin, { hasScroll: false });
      univer.registerPlugin(UniverDocsUIPlugin);
      univer.registerPlugin(UniverSheetsPlugin);
      univer.registerPlugin(UniverSheetsUIPlugin);
      univer.registerPlugin(UniverSheetsFormulaPlugin);
      univer.registerPlugin(UniverSheetsFormulaUIPlugin);
      // Find/Replace (Ctrl+F / Ctrl+H) — base plugin provides the dialog/services,
      // the sheets adapter wires it to the active worksheet.
      univer.registerPlugin(UniverFindReplacePlugin);
      univer.registerPlugin(UniverSheetsFindReplacePlugin);
      // FR-009: Sort + Filter.
      // Sort is wired via the SortDialog (toolbar "↕ 並べ替え") which writes
      // sorted rows back into the snapshot's cellData directly — this build
      // doesn't include @univerjs/sheets-sort. Filter is now provided by
      // @univerjs/sheets-filter (registered below); the snapshot round-trip for
      // auto-filter is preserved by xlsx_io.rs (commit 74594d0). The filter
      // package doesn't ship a separate -ui companion or locale bundle in
      // 0.5.x, so there's nothing extra to merge into `locales`.
      univer.registerPlugin(UniverSheetsFilterPlugin);

      // Create workbook from snapshot or default empty workbook. We pipe the
      // snapshot through `patchHyperlinkRenders` first so every cell listed in
      // `_hyperlinks` arrives at Univer pre-styled (blue + underline) with the
      // link label as its value. The patch is pure / idempotent — the round
      // -trip writer ignores the inline style we add since the `_hyperlinks`
      // array is its source of truth for re-emitting the actual <hyperlink>
      // elements on xlsx export.
      const initialData: Partial<IWorkbookData> = currentSnapshotJson
        ? patchShowFormulasView(
            patchErrorIndicators(
              patchCfRenders(
                patchSparklineRenders(
                  patchTableRenders(
                    patchSlicerFilters(
                      patchOutlineRenders(patchHyperlinkRenders(JSON.parse(currentSnapshotJson))),
                    ),
                  ),
                ),
              ),
            ),
            showFormulasMode,
          )
        : {
            id: "coco-workbook",
            name: "Coco Workbook",
            appVersion: "0.1.0",
            locale: LocaleType.EN_US,
            styles: {},
            sheetOrder: ["sheet-1"],
            sheets: {
              "sheet-1": {
                id: "sheet-1",
                name: "Sheet1",
                cellData: {},
                rowCount: 1000,
                columnCount: 100,
              },
            },
          };
      univer.createUnit(UniverInstanceType.UNIVER_SHEET, initialData as IWorkbookData);

      univerRef.current = univer;
      fUniverRef.current = FUniver.newAPI(univer);
      if (!fUniverRef.current.getActiveWorkbook()) {
        throw new Error("Active workbook is not available");
      }

      // Wire Coco-specific entries (Insert Comment / Hyperlink / Number Format)
      // into the cell context menu. We forward to the ref-held callbacks so
      // the menu always invokes the latest React-side dialog opener.
      contextMenuReg = registerCocoContextMenu(univer, {
        openCommentDialog: () => openCommentDialogRef.current(),
        openHyperlinkDialog: () => openHyperlinkDialogRef.current(),
        openNumberFormatDialog: () => openNumberFormatDialogRef.current(),
      });
    } catch (e) {
      contextMenuReg?.dispose();
      univer?.dispose();
      univerRef.current = null;
      fUniverRef.current = null;
      setEditorInitError(String(e));
      return;
    }

    return () => {
      contextMenuReg?.dispose();
      univer?.dispose();
      univerRef.current = null;
      fUniverRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync snapshot to store on data mutations (skip selection/scroll operations).
  // Debounce by 300ms so rapid typing doesn't thrash the store on every keystroke.
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let idleCallback: number | null = null;
    let idleFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const syncSnapshot = () => {
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      updateSnapshot(JSON.stringify(workbook.save()));
    };

    const cancelPendingSnapshotSync = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (idleCallback !== null) {
        window.cancelIdleCallback(idleCallback);
        idleCallback = null;
      }
      if (idleFallbackTimer) {
        clearTimeout(idleFallbackTimer);
        idleFallbackTimer = null;
      }
    };

    // #87: large-workbook back-off. For tiny workbooks we keep the
    // requestIdleCallback path (essentially immediate). For workbooks past
    // the size/cell threshold we still sync, just on a longer leash, so the
    // protection / data-validation / hyperlink guards (which read
    // snapshotRef.current in onBeforeCommandExecute) eventually see fresh
    // state. Previously a single skip would freeze snapshotRef indefinitely
    // and the guards would consult stale data for the rest of the session.
    const LARGE_WORKBOOK_SYNC_LEASH_MS = 2_000;
    const scheduleSnapshotSync = () => {
      if (shouldSkipBackgroundSnapshotSync(snapshotRef.current)) {
        idleFallbackTimer = setTimeout(() => {
          idleFallbackTimer = null;
          syncSnapshot();
        }, LARGE_WORKBOOK_SYNC_LEASH_MS);
        return;
      }
      if (typeof window.requestIdleCallback === "function") {
        idleCallback = window.requestIdleCallback(() => {
          idleCallback = null;
          syncSnapshot();
        });
        return;
      }
      idleFallbackTimer = setTimeout(() => {
        idleFallbackTimer = null;
        syncSnapshot();
      }, 0);
    };

    const unregisterSnapshotFlush = registerSnapshotFlush(() => {
      cancelPendingSnapshotSync();
      syncSnapshot();
    });

    const disposable = fUniver.onCommandExecuted((info) => {
      if (info.type !== CommandType.MUTATION) return;
      markDirty();
      cancelPendingSnapshotSync();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        scheduleSnapshotSync();
      }, 300);
    });

    return () => {
      cancelPendingSnapshotSync();
      unregisterSnapshotFlush();
      disposable.dispose();
    };
  }, [markDirty, updateSnapshot]);

  // Live sheet-protection enforcement. G3 marks `_protected` in the snapshot
  // and round-trips it through xlsx, but Univer itself doesn't know about
  // that key — so without this guard the user could still type into a
  // "protected" sheet. We hook `onBeforeCommandExecute` (which maps to
  // Univer's `beforeCommandExecuted` — listeners can throw to cancel) and
  // reject any mutation whose `params.subUnitId` matches a sheet currently
  // marked protected in the snapshot. Throwing `CustomCommandExecutionError`
  // is the documented "polite" cancel — Univer's CommandService catches it
  // and returns `false` instead of bubbling the error to the console.
  //
  // We only block CommandType.MUTATION (the low-level data-changing ops);
  // selection / scroll / zoom are typed as OPERATION and pass through. The
  // toggle button itself doesn't go through commandService (it writes the
  // snapshot via the Zustand store), so unlocking still works.
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;
    let lastWarnAt = 0;

    const disposable = fUniver.onBeforeCommandExecute((info) => {
      if (info.type !== CommandType.MUTATION) return;
      const params = info.params as { subUnitId?: unknown } | undefined;
      const subUnitId = typeof params?.subUnitId === "string" ? params.subUnitId : null;
      if (!subUnitId) return;
      if (!isSheetProtectedInSnapshot(snapshotRef.current, subUnitId)) return;
      // Rate-limit the warning so a single keystroke (which fans out to
      // multiple mutations) doesn't spam the console.
      const now = Date.now();
      if (now - lastWarnAt > 500) {
        lastWarnAt = now;
        // eslint-disable-next-line no-console
        console.warn("シートは保護されています");
      }
      throw new CustomCommandExecutionError("sheet is protected");
    });

    return () => disposable.dispose();
  }, []);

  // Live data-validation enforcement. B2 round-trips `_dataValidations[]`
  // through xlsx and F2 added an authoring dialog, but without this guard a
  // user can still type anything into a cell with a DV rule. We mirror the
  // sheet-protection hook above: hook `onBeforeCommandExecute`, decode the
  // SetRangeValuesMutation params, and reject the mutation if any cell write
  // violates a rule on its sheet. CustomCommandExecutionError cancels the
  // mutation politely (no console error).
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;
    let lastWarnAt = 0;

    const disposable = fUniver.onBeforeCommandExecute((info) => {
      if (info.type !== CommandType.MUTATION) return;
      const { subUnitId, writes } = extractCellWrites(info.params);
      if (!subUnitId || writes.length === 0) return;
      for (const w of writes) {
        const err = validateMutation(snapshotRef.current, subUnitId, w.row, w.col, w.value);
        if (err) {
          const now = Date.now();
          if (now - lastWarnAt > 500) {
            lastWarnAt = now;
            // eslint-disable-next-line no-console
            console.warn(`入力規則違反: ${err.message}`);
          }
          throw new CustomCommandExecutionError(`data validation: ${err.code}`);
        }
      }
    });

    return () => disposable.dispose();
  }, []);

  // In-grid hyperlink follow (Phase 2). The render side is handled by
  // `patchHyperlinkRenders` at unit creation; this hook adds the *click*
  // behavior. We use the sheets-ui `onCellClick` facade event (mixed onto
  // FWorkbook by `@univerjs/sheets-ui/facade`, auto-imported via
  // `@univerjs/facade`) — that fires with the (unitId, subUnitId, row, col)
  // of the clicked cell, which is everything we need to look up an entry
  // in `_hyperlinks` and route it. External links go through the Rust
  // `open_url` command (cmd /c start | open | xdg-open, scheme-allowlisted
  // to http(s) / mailto / file in shell.rs). Internal `#Sheet!A1` targets
  // route through the facade itself (setActiveSheet + setActiveRange) so
  // the jump stays in-app.
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;

    // The mixin signature is on FWorkbookSheetsUIMixin; `getActiveWorkbook`
    // returns the base FWorkbook type because Univer doesn't auto-narrow.
    // Defensive cast: if the host build somehow strips the sheets-ui facade
    // we bail out cleanly instead of throwing on workbook.onCellClick.
    const onCellClick = (workbook as unknown as {
      onCellClick?: (cb: (cell: { location: { subUnitId: string; row: number; col: number } }) => void) => { dispose: () => void };
    }).onCellClick;
    if (typeof onCellClick !== "function") return;

    const disposable = onCellClick.call(workbook, (cell) => {
      const { subUnitId, row, col } = cell.location ?? {};
      if (typeof subUnitId !== "string" || typeof row !== "number" || typeof col !== "number") {
        return;
      }
      const entry = lookupHyperlink(snapshotRef.current, subUnitId, row, col);
      if (!entry) return;
      const classified = classifyHyperlink(entry.target);
      if (!classified) return;
      if (classified.kind === "external") {
        // Fire-and-forget — open_url is best-effort; a missing browser
        // surfaces as a console warning rather than a blocking dialog.
        invoke("open_url", { url: classified.url }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("open_url failed:", err);
        });
        return;
      }
      // Internal link: navigate within the workbook. getSheetByName accepts
      // the visible sheet name (not the internal id); the round-trip stores
      // the target with the visible name so this lines up.
      try {
        const target = workbook.getSheetByName(classified.sheet);
        if (!target) return;
        workbook.setActiveSheet(target);
        const range = target.getRange(classified.cell);
        if (range) target.setActiveRange(range);
      } catch (err) {
        // Best-effort: a missing/renamed sheet just no-ops rather than
        // throwing into Univer's command pipeline.
        // eslint-disable-next-line no-console
        console.warn("internal hyperlink jump failed:", err);
      }
    });

    return () => disposable.dispose();
    // #88: re-register the listener whenever the underlying workbook
    // identity changes (open/import/restore replace currentHandle). Without
    // this dep, the listener stays bound to the first workbook for the
    // lifetime of the component and later workbooks' clicks never fire.
  }, [currentHandle]);

  const statusLabel = SAVE_STATUS_LABELS[saveStatus] ?? saveStatus;
  const statusClass = `status-bar__status status-bar__status--${saveStatus}`;
  // #94: memoize the stats parse so unrelated re-renders don't pay the cost
  // of re-parsing the full snapshot.
  const statsLabel = useMemo(
    () => formatSnapshotStats(computeSnapshotStats(currentSnapshotJson)),
    [currentSnapshotJson],
  );

  const fileName = currentHandle?.path
    ? currentHandle.path.split(/[\\/]/).pop()
    : currentHandle?.sourceType === "xlsx"
    ? "xlsx 由来（未保存）"
    : "無題のワークブック";
  const isDirty = saveStatus === "unsaved";
  const fileLabel = isDirty ? `${fileName} •` : fileName;
  const isCocoFile = (currentHandle?.path ?? "").toLowerCase().endsWith(".coco");
  const goHomeAfterConfirm = () => {
    if (!confirmDiscardIfUnsaved()) return;
    goHome();
  };

  if (editorInitError) {
    return (
      <div className="editor-screen editor-screen--error">
        <div className="editor-init-error" role="alert">
          <h2>エディタを表示できません</h2>
          <p>ファイルの内容を読み込めませんでした。</p>
          <pre>{editorInitError}</pre>
          <button type="button" className="toolbar-btn" onClick={goHomeAfterConfirm}>
            ホームへ戻る
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-screen">
      <div className="editor-toolbar">
        <div className="editor-toolbar__left">
          <button type="button" className="toolbar-btn" onClick={goHomeAfterConfirm} title="ホームへ戻る">
            {t("toolbar.home")}
          </button>
          <span
            className="editor-toolbar__filename"
            title={currentHandle?.path ?? undefined}
          >
            {fileLabel}
          </span>
        </div>
      </div>
      {sheetPicker && (
        <SheetPickerModal
          sheets={sheetPicker.map((s) => s.name)}
          onCancel={() => setSheetPicker(null)}
          onConfirm={(idx) => {
            const target = sheetPicker[idx];
            setSheetPicker(null);
            if (target) runCsvExport(target);
          }}
          onExportAll={() => {
            const all = sheetPicker;
            setSheetPicker(null);
            void runBulkCsvExport(all);
          }}
        />
      )}
      {importWarnings.length > 0 && (
        <div className="warning-banner">
          <div className="warning-banner__content">
            {importWarnings.slice(0, 3).map((w: CompatibilityWarning, i: number) => (
              <span key={i} className={`warning-banner__item warning-banner__item--${w.severity}`}>
                {w.message}
              </span>
            ))}
            {importWarnings.length > 3 && (
              <button
                type="button"
                className="warning-banner__more"
                onClick={() => setWarningsDialog("import")}
              >
                + 他 {importWarnings.length - 3} 件
              </button>
            )}
            <button
              type="button"
              className="warning-banner__more"
              onClick={() => setWarningsDialog("import")}
            >
              詳細
            </button>
          </div>
          <button type="button" className="warning-banner__dismiss" onClick={dismissWarnings}>
            ×
          </button>
        </div>
      )}
      {exportWarnings.length > 0 && (
        <div className="warning-banner warning-banner--export">
          <div className="warning-banner__content">
            {exportWarnings.slice(0, 3).map((w: CompatibilityWarning, i: number) => (
              <span key={i} className={`warning-banner__item warning-banner__item--${w.severity}`}>
                {w.message}
              </span>
            ))}
            {exportWarnings.length > 3 && (
              <button
                type="button"
                className="warning-banner__more"
                onClick={() => setWarningsDialog("export")}
              >
                + 他 {exportWarnings.length - 3} 件
              </button>
            )}
            <button
              type="button"
              className="warning-banner__more"
              onClick={() => setWarningsDialog("export")}
            >
              詳細
            </button>
          </div>
          <button type="button" className="warning-banner__dismiss" onClick={dismissExportWarnings}>
            ×
          </button>
        </div>
      )}
      <div
        className={
          "univer-wrap" +
          (formatPainterMode !== "idle" ? " univer-wrap--format-painter" : "")
        }
      >
        <div id="univer-container" ref={containerRef} className="univer-container" />
        <CommentIndicatorsPanel
          indicators={commentIndicators}
          onSelect={jumpToCommentCell}
        />
        <ChartPreviewPanel
          previews={chartPreviews}
          onSelect={jumpToChartRange}
        />
        <ImagePreviewPanel
          images={imagePreviews}
          onSelect={jumpToImageCell}
        />
        {tablesPanelOpen && (
          <TableInfoPanel
            workbookSnapshotJson={currentSnapshotJson ?? ""}
            onJumpTo={jumpToA1OnSheet}
            onRename={renameTableAcrossWorkbook}
            onDelete={deleteTable}
          />
        )}
        {sparklinesPanelOpen && (
          <SparklineListPanel
            workbookSnapshotJson={currentSnapshotJson ?? ""}
            onJumpTo={jumpToA1OnSheet}
            onDelete={deleteSparkline}
          />
        )}
        {errorsPanelOpen && currentSnapshotJson && (
          <ErrorIndicatorsPanel
            workbookSnapshotJson={currentSnapshotJson}
            onJumpTo={jumpToA1OnSheet}
          />
        )}
        {pivotsPanelOpen && currentSnapshotJson && (
          <PivotListPanel
            workbookSnapshotJson={currentSnapshotJson}
            onRefresh={refreshPivotByName}
            onDelete={deletePivot}
            onJumpTo={jumpToA1OnSheet}
          />
        )}
        {chartsCanvasPanelOpen && currentSnapshotJson && (
          <ChartCanvasPanel workbookSnapshotJson={currentSnapshotJson} />
        )}
        {slicersPanelOpen && currentSnapshotJson && (
          <SlicerPanel
            workbookSnapshotJson={currentSnapshotJson}
            onToggleValue={toggleSlicer}
            onDelete={deleteSlicer}
          />
        )}
        {tracePanelOpen && currentSnapshotJson && (
          <FormulaTracePanel
            workbookSnapshotJson={currentSnapshotJson}
            activeSheetId={traceActiveSheetId}
            activeRow={traceActiveRow}
            activeCol={traceActiveCol}
            onJumpTo={jumpToA1OnSheet}
          />
        )}
        {watchWindowOpen && currentSnapshotJson && (
          <WatchWindowPanel
            workbookSnapshotJson={currentSnapshotJson}
            onJumpTo={jumpToA1OnSheet}
          />
        )}
        {BUSY_LABELS[saveStatus] && (
          <BusyOverlay
            label={BUSY_LABELS[saveStatus]!.label}
            blocking={BUSY_LABELS[saveStatus]!.blocking}
          />
        )}
      </div>
      <div className="status-bar">
        {/* React key forces re-mount on status change so the CSS fade animation restarts. */}
        <span key={saveStatus} className={statusClass}>{statusLabel}</span>
        {editorOperationError && (
          <span className="status-bar__operation-error" role="status" aria-live="polite">
            · {editorOperationError}
          </span>
        )}
        {lastSavedAt !== null && (
          isCocoFile ? (
            <button
              type="button"
              className="status-bar__last-saved status-bar__last-saved--clickable"
              title={`最終保存: ${new Date(lastSavedAt).toLocaleString("ja-JP")}（クリックで履歴を開く）`}
              onClick={() => setSnapshotsOpen(true)}
            >
              · 最終保存 {timeAgoJa(lastSavedAt)}
            </button>
          ) : (
            <span
              className="status-bar__last-saved"
              title={`最終保存: ${new Date(lastSavedAt).toLocaleString("ja-JP")}`}
            >
              · 最終保存 {timeAgoJa(lastSavedAt)}
            </span>
          )
        )}
        {statsLabel && (
          <span className="status-bar__stats">· {statsLabel}</span>
        )}
      </div>
      {saveStatus === "save_failed" && (
        <SaveFailureDialog
          path={currentHandle?.path ?? null}
          errorMessage={lastError}
          onRetry={save}
          onSaveAs={promptSaveAs}
          onClose={dismissSaveError}
        />
      )}
      {snapshotsOpen && <SnapshotHistoryDialog onClose={() => setSnapshotsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {namedRanges !== null && (
        <NamedRangesDialog
          initialRanges={namedRanges}
          onSave={applyNamedRanges}
          onClose={() => setNamedRanges(null)}
        />
      )}
      {dvDialog !== null && (
        <DataValidationDialog
          initialRules={dvDialog.rules}
          sheetName={dvDialog.sheetName}
          onSave={applyDataValidations}
          onClose={() => setDvDialog(null)}
        />
      )}
      {cfDialog && (
        <ConditionalFormattingDialog
          sheetName={cfDialog.sheetName}
          initialRules={cfDialog.rules}
          onSave={(next) => applyCfRules(cfDialog.sheetId, next)}
          onClose={() => setCfDialog(null)}
        />
      )}
      {hyperlinkCtx && (
        <InsertHyperlinkDialog
          initialCell={hyperlinkCtx.cell}
          initialDisplay={hyperlinkCtx.display}
          onApply={applyHyperlink}
          onClose={() => setHyperlinkCtx(null)}
        />
      )}
      {commentDialog && (
        <ThreadedCommentDialog
          cellRef={commentDialog.cellRef}
          initialComment={commentDialog.existing}
          defaultAuthor={resolveDefaultAuthor()}
          onSave={(entry) => applyComment(commentDialog.sheetId, entry)}
          onDelete={() => {
            deleteComment(commentDialog.sheetId, commentDialog.cellRef);
            setCommentDialog(null);
          }}
          onClose={() => setCommentDialog(null)}
        />
      )}
      {chartDialog && (
        <InsertChartDialog
          initialRange={chartDialog.range}
          onApply={applyChart}
          onClose={() => setChartDialog(null)}
        />
      )}
      {numFmtDialog && (
        <NumberFormatDialog
          rangeLabel={numFmtDialog.rangeLabel}
          initialCode={numFmtDialog.initialCode}
          onApply={applyNumberFormat}
          onClose={() => setNumFmtDialog(null)}
        />
      )}
      {imageDialog && (
        <InsertImageDialog
          initialCell={imageDialog.cell}
          pickFile={pickImageFile}
          onApply={applyImage}
          onClose={() => setImageDialog(null)}
        />
      )}
      {sortDialog && (
        <SortDialog
          initialRange={sortDialog.range}
          onApply={applySort}
          onClose={() => setSortDialog(null)}
        />
      )}
      {tabColorDialog && (
        <SheetTabColorDialog
          sheetName={tabColorDialog.sheetName}
          initialColor={tabColorDialog.initialColor}
          onApply={(color) => applyTabColor(tabColorDialog.sheetId, color)}
          onClose={() => setTabColorDialog(null)}
        />
      )}
      {outlineDialog && (
        <OutlineGroupDialog
          sheetName={outlineDialog.sheetName}
          sheetId={outlineDialog.sheetId}
          initialRows={outlineDialog.rows}
          initialCols={outlineDialog.cols}
          selection={outlineDialog.selection}
          onApply={(rows, cols) => applyOutline(outlineDialog.sheetId, rows, cols)}
          onClose={() => setOutlineDialog(null)}
        />
      )}
      {tableDialog && (
        <InsertTableDialog
          initialRange={tableDialog.range}
          existingTableNames={(() => {
            if (!currentSnapshotJson) return [];
            try {
              return collectAllTableNames(JSON.parse(currentSnapshotJson));
            } catch {
              return [];
            }
          })()}
          onApply={(entry) => applyTable(tableDialog.sheetId, entry)}
          onClose={() => setTableDialog(null)}
        />
      )}
      {sparklineDialog && (
        <InsertSparklineDialog
          initialSourceRange={sparklineDialog.sourceRange}
          initialAnchorCell={sparklineDialog.anchorCell}
          onApply={(entry) => applySparkline(sparklineDialog.sheetId, entry)}
          onClose={() => setSparklineDialog(null)}
        />
      )}
      {pageSetupDialog && (
        <PageSetupDialog
          sheetName={pageSetupDialog.sheetName}
          initial={pageSetupDialog.initial}
          onApply={applyPageSetup}
          onClose={() => setPageSetupDialog(null)}
        />
      )}
      {cellStylesDialog && (
        <CellStylesDialog
          sheetId={cellStylesDialog.sheetId}
          initialRange={cellStylesDialog.range}
          onApply={applyCellStylePreset}
          onClose={() => setCellStylesDialog(null)}
        />
      )}
      {goalSeekState && (
        <GoalSeekDialog
          initialTargetCell={goalSeekState.targetCell}
          initialChangingCell={goalSeekState.changingCell}
          runAdapter={goalSeekState.adapter}
          onCommit={() => {
            // The adapter already wrote the converged value; close + push
            // a snapshot checkpoint so Ctrl+Alt+Z can undo the change.
            const fUniver = fUniverRef.current;
            const wb = fUniver?.getActiveWorkbook();
            if (wb) {
              applyMutatedSnapshot(JSON.stringify(wb.save()));
            }
            setGoalSeekState(null);
          }}
          onClose={() => setGoalSeekState(null)}
        />
      )}
      {errorCheckingOpen && currentSnapshotJson && (
        <ErrorCheckingDialog
          issues={(() => {
            try {
              return collectAuditIssues(JSON.parse(currentSnapshotJson));
            } catch {
              return [];
            }
          })()}
          onJumpToCell={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setErrorCheckingOpen(false);
          }}
          onClose={() => setErrorCheckingOpen(false)}
        />
      )}
      {subtotalDialog && (
        <SubtotalDialog
          initialRange={subtotalDialog.range}
          sheetId={subtotalDialog.sheetId}
          sheetSnapshot={subtotalDialog.sheetSnapshot}
          onApply={(params) => {
            applySubtotal(subtotalDialog.sheetId, params);
            setSubtotalDialog(null);
          }}
          onRemoveAll={(groupCol) => {
            clearSubtotals(subtotalDialog.sheetId, groupCol);
            setSubtotalDialog(null);
          }}
          onClose={() => setSubtotalDialog(null)}
        />
      )}
      {removeDuplicatesDialog && (
        <RemoveDuplicatesDialog
          initialRange={removeDuplicatesDialog.range}
          sheetId={removeDuplicatesDialog.sheetId}
          sheetSnapshot={removeDuplicatesDialog.sheetSnapshot}
          onApply={(params) => {
            applyRemoveDuplicates(params);
            setRemoveDuplicatesDialog(null);
          }}
          onClose={() => setRemoveDuplicatesDialog(null)}
        />
      )}
      {textToColumnsDialog && (
        <TextToColumnsDialog
          initialRange={textToColumnsDialog.range}
          sampleRows={textToColumnsDialog.sampleRows}
          onApply={(params) => {
            applyTextToColumns(params);
            setTextToColumnsDialog(null);
          }}
          onClose={() => setTextToColumnsDialog(null)}
        />
      )}
      {advancedFilterDialog && (
        <AdvancedFilterDialog
          initialSourceRange={advancedFilterDialog.range}
          onApply={(params) => {
            applyAdvancedFilterAction(params);
            setAdvancedFilterDialog(null);
          }}
          onClose={() => setAdvancedFilterDialog(null)}
        />
      )}
      {flashFillDialog && (
        <FlashFillDialog
          transformDescription={describeTransform(flashFillDialog.transform)}
          preview={flashFillDialog.sourceCol
            .map((src, i) => ({
              source: src,
              filled: flashFillDialog.filled[i] ?? "",
              isExample: flashFillDialog.examplesMask[i],
            }))
            .filter((p) => !p.isExample && p.filled !== "")
            .slice(0, 5)
            .map((p) => ({ source: p.source, filled: p.filled }))}
          onAccept={acceptFlashFill}
          onClose={() => setFlashFillDialog(null)}
        />
      )}
      {pivotDialog && (
        <InsertPivotDialog
          initialSourceRange={pivotDialog.sourceRange}
          initialDestination={pivotDialog.destCell}
          sourceFieldNames={pivotDialog.fieldNames}
          sourceSheetId={pivotDialog.sheetId}
          onApply={(config) => {
            applyPivot(config);
            setPivotDialog(null);
          }}
          onClose={() => setPivotDialog(null)}
        />
      )}
      {slicerDialogOpen && (
        <InsertSlicerDialog
          availableTables={availableSlicerTables}
          onApply={(entry, sheetId) => {
            applySlicer(entry, sheetId);
            setSlicerDialogOpen(false);
          }}
          onClose={() => setSlicerDialogOpen(false)}
        />
      )}
      {unhideDialog && (
        <UnhideSheetDialog
          hiddenSheets={unhideDialog.hiddenSheets}
          onUnhide={(sheetId) => {
            applyUnhide(sheetId);
            setUnhideDialog(null);
          }}
          onClose={() => setUnhideDialog(null)}
        />
      )}
      {moveCopyDialog && (
        <MoveCopySheetDialog
          sheetId={moveCopyDialog.sheetId}
          sheetName={moveCopyDialog.sheetName}
          sheets={moveCopyDialog.sheets}
          onApply={(params) => {
            applyMoveCopy(moveCopyDialog.sheetId, params);
            setMoveCopyDialog(null);
          }}
          onClose={() => setMoveCopyDialog(null)}
        />
      )}
      {insertFunctionCtx && (
        <InsertFunctionDialog
          onInsert={(text) => {
            applyInsertFunction(text);
            setInsertFunctionCtx(null);
          }}
          onClose={() => setInsertFunctionCtx(null)}
        />
      )}
      {customListsCtx && (
        <CustomListsDialog
          initialActiveRange={customListsCtx.initialActiveRange}
          onApplyToRange={(range, items) => {
            applyCustomList(range, items);
            setCustomListsCtx(null);
          }}
          onClose={() => setCustomListsCtx(null)}
        />
      )}
      {calcOptionsOpen && (
        <CalculationOptionsDialog
          currentMode={calcMode}
          onApply={(m) => {
            persistCalcMode(m);
            setCalcModeState(m);
          }}
          onRecalcAll={() => window.dispatchEvent(new CustomEvent("coco:calc-recalc", { detail: { scope: "all" } }))}
          onRecalcSheet={() => window.dispatchEvent(new CustomEvent("coco:calc-recalc", { detail: { scope: "sheet" } }))}
          onClose={() => setCalcOptionsOpen(false)}
        />
      )}
      {scenariosOpen && scenarioAdapter && (() => {
        const wb = fUniverRef.current?.getActiveWorkbook();
        const snap = (wb ? wb.save() : {}) as unknown as WorkbookScenarioSnapshot;
        const scenarios = listScenarios(snap);
        return (
          <ScenarioManagerDialog
            scenarios={scenarios}
            onApply={(s) => {
              applyScenario(scenarioAdapter, s);
              const wb2 = fUniverRef.current?.getActiveWorkbook();
              if (wb2) applyMutatedSnapshot(JSON.stringify(wb2.save()));
            }}
            onAdd={(entry) => {
              const values = captureFromCurrentValues(scenarioAdapter, entry.changingCells);
              const full: ScenarioEntry = { ...entry, values, createdAt: new Date().toISOString() };
              const next = addScenario(snap, full);
              applyMutatedSnapshot(JSON.stringify({ ...((wb?.save() as unknown as object) ?? {}), _scenarios: next._scenarios }));
            }}
            onDelete={(name) => {
              const next = removeScenario(snap, name);
              applyMutatedSnapshot(JSON.stringify({ ...((wb?.save() as unknown as object) ?? {}), _scenarios: next._scenarios }));
            }}
            onSummary={() => {
              // Summary creation deferred — needs result-range UX (TODO)
              setEditorOperationError("シナリオサマリー: 集約セル指定 UI は未実装です。");
            }}
            onClose={() => {
              setScenariosOpen(false);
              setScenarioAdapter(null);
            }}
          />
        );
      })()}
      {forecastDialog && (
        <ForecastSheetDialog
          initialXRange={forecastDialog.xRange}
          initialYRange={forecastDialog.yRange}
          onApply={(p) => {
            applyForecastResult(p);
            setForecastDialog(null);
          }}
          onClose={() => setForecastDialog(null)}
        />
      )}
      {recommendedChartsDialog && (
        <RecommendedChartsDialog
          recommendations={recommendedChartsDialog.recommendations}
          sourceRange={recommendedChartsDialog.range}
          onApply={(type, range) => {
            applyRecommendedChart(type, range);
            setRecommendedChartsDialog(null);
          }}
          onClose={() => setRecommendedChartsDialog(null)}
        />
      )}
      {cfManagerOpen && (
        <CfRuleManagerDialog
          workbookSnapshotJson={currentSnapshotJson ?? ""}
          onReorder={(sheetId, ruleIndex, direction) => {
            try {
              const snap = JSON.parse(currentSnapshotJson || "{}") as WorkbookCfSnapshot;
              const next = reorderCfRule(snap, sheetId, ruleIndex, direction);
              const rules = next.sheets?.[sheetId]?._conditionalFormatting ?? [];
              applyCfRules(sheetId, rules as CfRule[]);
            } catch {
              // best-effort
            }
          }}
          onDelete={(sheetId, ruleIndex) => {
            try {
              const snap = JSON.parse(currentSnapshotJson || "{}") as WorkbookCfSnapshot;
              const next = deleteCfRule(snap, sheetId, ruleIndex);
              const rules = next.sheets?.[sheetId]?._conditionalFormatting ?? [];
              applyCfRules(sheetId, rules as CfRule[]);
            } catch {
              // best-effort
            }
          }}
          onEdit={() => {
            setCfManagerOpen(false);
            openCfDialog();
          }}
          onNew={() => {
            setCfManagerOpen(false);
            openCfDialog();
          }}
          onClose={() => setCfManagerOpen(false)}
        />
      )}
      {snapshotDiffOpen && (
        <SnapshotDiffDialog
          availableSnapshots={snapshotDiffOptions}
          loadSnapshotJson={loadSnapshotJsonById}
          onJumpTo={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setSnapshotDiffOpen(false);
          }}
          onClose={() => setSnapshotDiffOpen(false)}
        />
      )}
      {quickAnalysisDialog && (
        <QuickAnalysisDialog
          rangeLabel={quickAnalysisDialog.rangeLabel}
          cellCount={quickAnalysisDialog.cellCount}
          recommended={quickAnalysisDialog.recommended}
          sheetId={quickAnalysisDialog.sheetId}
          range={quickAnalysisDialog.range}
          onSelect={(opt) => {
            setQuickAnalysisDialog(null);
            // Route to existing flows. Pre-fill not implemented (MVP).
            switch (opt.id) {
              case "format-databar":
              case "format-colorscale":
              case "format-top10":
                openCfDialog();
                break;
              case "chart-line":
              case "chart-bar":
              case "chart-pie":
              case "chart-scatter":
                openChartDialog();
                break;
              case "total-sum":
                applyAutoSum();
                break;
              case "table-format":
                openTableDialog();
                break;
              case "table-pivot":
                openPivotDialog();
                break;
              case "sparkline-line":
              case "sparkline-column":
              case "sparkline-winloss":
                openSparklineDialog();
                break;
            }
          }}
          onClose={() => setQuickAnalysisDialog(null)}
        />
      )}
      {warningsDialog === "import" && (
        <CompatibilityWarningsDialog
          warnings={importWarnings}
          title="インポート時の警告"
          onClose={() => setWarningsDialog(null)}
        />
      )}
      {warningsDialog === "export" && (
        <CompatibilityWarningsDialog
          warnings={exportWarnings}
          title="エクスポート時の警告"
          onClose={() => setWarningsDialog(null)}
        />
      )}
    </div>
  );
}
