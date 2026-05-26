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
// Univer #6XXX (0.13+): `defaultTheme` moved out of `@univerjs/design` into a
// dedicated `@univerjs/themes` package alongside `greenTheme` etc.
import { defaultTheme } from "@univerjs/themes";
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
// Phase 4b: in-grid image rendering. The drawing chain is base
// (`@univerjs/drawing` shared data model) + UI (`drawing-ui`) +
// sheets-specific bindings (`sheets-drawing` + `sheets-drawing-ui`). All
// four are Apache-2.0 OSS at 0.24.0. The base `@univerjs/drawing` was
// already pulled in transitively before this PR; we register it explicitly
// so the load order matches Univer's preset.
import { UniverDocsDrawingPlugin } from "@univerjs/docs-drawing";
import { UniverDrawingPlugin } from "@univerjs/drawing";
import { UniverDrawingUIPlugin } from "@univerjs/drawing-ui";
import { UniverSheetsDrawingPlugin } from "@univerjs/sheets-drawing";
import { UniverSheetsDrawingUIPlugin } from "@univerjs/sheets-drawing-ui";
import { FUniver } from "@univerjs/core/facade";
import "@univerjs/sheets/facade";
import "@univerjs/sheets-ui/facade";
import "@univerjs/sheets-formula/facade";
import "@univerjs/engine-formula/facade";
import "@univerjs/docs-ui/facade";
// Phase 4b: surface the drawing facade (newOverGridImage / insertImages /
// getImages / FOverGridImage etc.) on FWorksheet so future Coco code can
// drive in-grid images programmatically.
import "@univerjs/sheets-drawing/facade";
import "@univerjs/sheets-drawing-ui/facade";

import "@univerjs/design/lib/index.css";
import "@univerjs/ui/lib/index.css";
import "@univerjs/docs-ui/lib/index.css";
import "@univerjs/sheets-ui/lib/index.css";
import "@univerjs/sheets-formula-ui/lib/index.css";
import "@univerjs/find-replace/lib/index.css";
// drawing-ui / sheets-drawing-ui ship their own image-popup / sidebar CSS.
import "@univerjs/drawing-ui/lib/index.css";
import "@univerjs/sheets-drawing-ui/lib/index.css";

import { undoRedoOverride } from "./univerUndoRedoOverride";
import { registerCocoContextMenu } from "./univerContextMenu";
import { registerFormulaNormalizer } from "./univerFormulaNormalizer";
import { buildCocoUniverLocales, toUniverLocaleType } from "./cocoUniverLocale";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { useAutoSave } from "../hooks/useAutoSave";
import type { CompatibilityWarning } from "../types/workbook";
import SheetPickerModal from "./SheetPickerModal";
import SaveFailureDialog from "./SaveFailureDialog";
import BusyOverlay from "./BusyOverlay";
import SnapshotHistoryDialog from "./SnapshotHistoryDialog";
import WorkbookInquireDialog from "./WorkbookInquireDialog";
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
import { patchCfRenders, type CfRuleEntry as CfRuleEntryType } from "./conditionalFormatRender";
import { CfSidecar } from "../store/cfSidecar";
import { computeCfApplyPlan } from "../store/cfApplyPlan";
import { batchCfPlan } from "../store/cfRangeBatch";
import type { ChartEntry } from "../store/chartRender";
import { patchCheckboxRenders } from "./checkboxRender";
import {
  addCheckbox,
  hasCheckbox,
  removeCheckbox,
  toggleCheckbox as toggleCheckboxInSnapshot,
  toA1 as checkboxToA1,
} from "../store/checkbox";
import { patchFormControlRenders } from "./formControlRender";
import {
  addFormControl,
  getFormControlAt,
  hasFormControl,
  isCellOccupied,
  removeFormControl,
  selectRadio,
  stepControl,
  toA1 as formControlToA1,
  type FormControlKind,
} from "../store/formControls";
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
import SolverDialog from "./SolverDialog";
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
import InGridChartLayer from "./InGridChartLayer";
import InsertSlicerDialog from "./InsertSlicerDialog";
import SlicerPanel from "./SlicerPanel";
import {
  type SlicerEntry,
  type WorkbookSlicerPivotSnapshot,
  type WorkbookSlicerSnapshot,
  applySlicerFiltersToPivots,
  clearAllSlicers as clearAllSlicersHelper,
  clearSlicerSelection as clearSlicerSelectionHelper,
  generateSlicerName,
  invertSlicerSelection as invertSlicerSelectionHelper,
  removeSlicer as removeSlicerHelper,
  setSlicerSelection as setSlicerSelectionHelper,
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
import CalculationModeIndicator from "./CalculationModeIndicator";
import StatusBarStats from "./StatusBarStats";
import LiveRegion from "./LiveRegion";
import {
  announce,
  announceError,
  buildCellAnnouncement,
  buildRangeAnnouncement,
} from "../store/announce";
import {
  type SelectionStats,
  computeSelectionStats,
} from "../store/selectionStats";
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
import AnalysisToolpakDialog, {
  type AnalysisApplyParams,
} from "./AnalysisToolpakDialog";
import {
  runLinearRegression,
  runOneWayANOVA,
  buildHistogram,
  runTwoWayANOVA,
  runTTest,
  runChiSquareGoodnessOfFit,
  runChiSquareIndependence,
  runCorrelationMatrix,
  generateRandomNumbers,
  runSimpleMovingAverage,
  runExponentialMovingAverage,
  runFourierTransform,
} from "../store/analysisToolpak";
import RecommendedChartsDialog from "./RecommendedChartsDialog";
import { type ChartRecommendation, analyzeRange } from "../store/recommendedCharts";
import CfRuleManagerDialog from "./CfRuleManagerDialog";
import {
  type WorkbookCfSnapshot,
  reorderRule as reorderCfRule,
  deleteRule as deleteCfRule,
} from "../store/cfRuleManager";
import SnapshotDiffDialog from "./SnapshotDiffDialog";
import SpellCheckDialog from "./SpellCheckDialog";
import {
  type SpellIssue,
  collectSpellIssues,
  loadUserDictionary,
  addToUserDictionary,
} from "../store/spellCheck";
import DataFormDialog from "./DataFormDialog";
import {
  type DataFormRow,
  type DataFormRange,
  type SnapshotCellData,
  readRow,
  writeRow,
  appendBlankRow,
  deleteRowAt,
  getColumnHeaders,
  getDataRowCount,
} from "../store/dataForm";
import FindReplaceAllDialog from "./FindReplaceAllDialog";
import CommentsManagerDialog from "./CommentsManagerDialog";
import {
  setCommentResolved as setCmResolved,
  deleteComment as deleteCmInline,
  bulkDeleteResolved as bulkDeleteResolvedComments,
} from "../store/commentsManager";
import SmartDateDialog from "./SmartDateDialog";
import {
  type ConvertToDateParams,
  type SmartDateLocale,
  applyConvertToDate,
  tryParseDate,
  excelSerialToDate,
  DEFAULT_SMART_DATE_FORMAT,
} from "../store/smartDate";
import ConvertToRangeDialog, { type ConvertToRangeTableSummary } from "./ConvertToRangeDialog";
import { applyConvertToRange } from "../store/convertToRange";
import { listAllTables as listAllTablesAcrossSheets, rangeToA1 as rangeToA1Helper, type WorkbookTableSnapshot } from "../store/tables";
import DocumentInspectorDialog from "./DocumentInspectorDialog";
import {
  type InspectionCategory,
  type InspectionResult,
  inspectDocument,
  stripCategory,
} from "../store/documentInspector";
import BulkCleanDialog from "./BulkCleanDialog";
import { applyBulkClean, type BulkCleanParams } from "../store/bulkClean";
import CsvImportWizardDialog from "./CsvImportWizardDialog";
import NavigationBox, { type NavigationTarget } from "./NavigationBox";
import Ribbon from "./ribbon/Ribbon";
import FormulaBar from "./ribbon/FormulaBar";
import { resolveNamedRange as resolveNavNamed } from "../store/navigationBox";
import SheetImportDialog from "./SheetImportDialog";
import { addImportedSheetToSnapshot } from "../store/sheetImport";
import DataConnectionsDialog, {
  type AddConnectionInput,
} from "./DataConnectionsDialog";
import GetTransformDialog from "./GetTransformDialog";
import {
  type DataConnection,
  type EtlStep,
  type SheetFragment as DataConnSheetFragment,
  addConnection as addConnectionToSnapshot,
  applyFragmentToSheet as applyDataConnFragment,
  listConnections as listDataConnections,
  makeConnectionId,
  removeConnection as removeConnectionFromSnapshot,
  transformFragment as transformDataConnFragment,
  updateConnection as updateConnectionInSnapshot,
} from "../store/dataConnections";
import BookmarksPanel from "./BookmarksPanel";
import {
  addBookmark,
  loadBookmarks,
  saveBookmarks,
  generateWorkbookSessionId,
} from "../store/bookmarks";
import NumberFormatManagerDialog from "./NumberFormatManagerDialog";
import {
  type FormatCodeEntry,
  listAllFormatCodes,
  renameFormatCode,
  deleteFormatCode,
} from "../store/numberFormatManager";
import RangeCompareDialog from "./RangeCompareDialog";
import InsertSymbolDialog from "./InsertSymbolDialog";
import SheetNoteDialog from "./SheetNoteDialog";
import {
  type SheetNote,
  type WorkbookNotesSnapshot,
  getSheetNote,
  setSheetNote,
  deleteSheetNote,
} from "../store/sheetNotes";
import ImageManagerDialog from "./ImageManagerDialog";
import {
  listAllImages,
  deleteImage as deleteImageInSnapshot,
  bulkDeleteImagesOnSheet,
  exportImageToFile,
} from "../store/imageManager";
import TemplatesGalleryDialog from "./TemplatesGalleryDialog";
import { buildTemplateSnapshot } from "../store/templates";
import SnapshotControlsDialog from "./SnapshotControlsDialog";
import {
  type SnapshotIntervalSetting,
  getAutoSaveInterval,
  setAutoSaveInterval as persistInterval,
  snapshotIntervalToMs,
} from "../store/snapshotControls";
import SortByColorDialog from "./SortByColorDialog";
import { type SortByColorParams, applySortByColor } from "../store/sortByColor";
import FilterByColorDialog from "./FilterByColorDialog";
import { type FilterByColorParams, applyFilterByColor } from "../store/filterByColor";
import WorkbookStatsDialog from "./WorkbookStatsDialog";
import { type WorkbookStatsBundle, collectWorkbookStats } from "../store/workbookStats";
import { patchShowAllCommentsView } from "./showAllCommentsRender";
import CommentsAllOverlay from "./CommentsAllOverlay";
import QuickPrintDialog from "./QuickPrintDialog";
import HyperlinkManagerDialog from "./HyperlinkManagerDialog";
import UpdateAvailableDialog from "./UpdateAvailableDialog";
import {
  type UpdaterState,
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  isAutoCheckEnabled,
  getSkippedVersion,
  skipVersion as persistSkipVersion,
  isInRolloutBucket,
} from "../store/updater";
import {
  listAllHyperlinks,
  deleteHyperlink as deleteHyperlinkInline,
  bulkDeleteHyperlinksByKind,
  validateUrl,
} from "../store/hyperlinkManager";
import BordersDialog from "./BordersDialog";
import { type BorderParams, applyBorders } from "../store/borders";
import QuickCfDialog from "./QuickCfDialog";
import { applyQuickCfPreset } from "../store/quickCfPresets";
import CellLinkerDialog from "./CellLinkerDialog";
import {
  type CellLinkParams,
  buildLinkFormula,
  resolveSourceValue,
} from "../store/cellLinker";
import FilterSearchDialog from "./FilterSearchDialog";
import { type FilterSearchParams, applyFilterSearch } from "../store/filterSearch";
// Single-thread InsertCommentDialog superseded by ThreadedCommentDialog;
// its CommentEntry type lives in its own module for other consumers.
import InsertChartDialog, { type ChartFormValue } from "./InsertChartDialog";
import NumberFormatDialog, { type NumberFormatValue } from "./NumberFormatDialog";
import InsertImageDialog, {
  type ImageFormValue,
  type ImagePickResult,
} from "./InsertImageDialog";
import InsertShapeDialog, {
  type ShapeFormValue,
} from "./InsertShapeDialog";
import TextBoxesPanel from "./TextBoxesPanel";
import {
  a1ToColRow as tbA1ToColRow,
  addTextBox,
  deleteTextBox,
  updateTextBox,
  listTextBoxesForSheet,
  makeTextBoxId,
  type TextBox,
} from "../store/textBoxes";
import SortDialog, { type SortFormValue } from "./SortDialog";
import SheetTabColorDialog from "./SheetTabColorDialog";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";
import MacroDialog from "./MacroDialog";
import {
  observeCommand as observeMacroCommand,
  playback as playbackMacro,
  summariseDestructive as summariseMacroDestructive,
} from "../store/macroRecord";
import { loadAllSecure as loadMacrosSecure } from "../store/secureMacroStore";
import CommentIndicatorsPanel from "./CommentIndicatorsPanel";
import SmartChipPopover, {
  type SmartChipPopoverAnchor,
} from "./SmartChipPopover";
import {
  type SmartChip,
  chipsForCell as smartChipsForCell,
  chipActionUrl as smartChipActionUrl,
} from "../store/smartChips";
import ChartPreviewPanel from "./ChartPreviewPanel";
import { computeChartPreviews, type ChartPreview } from "./chartPreviewData";
import ImagePreviewPanel from "./ImagePreviewPanel";
import {
  requestSettings,
  requestHelp,
  onMacroPlayRequested,
} from "../hooks/useGlobalShortcuts";
import { confirmDiscardIfUnsaved } from "../store/dirtyGuard";
import { routeOpenPath } from "../store/pathRouter";
import { registerSnapshotFlush, carryForwardRootExtensions } from "../store/snapshotSync";
import { timeAgoJa } from "./timeAgo";
import {
  computeSnapshotStats,
  formatSnapshotStats,
  shouldSkipBackgroundSnapshotSync,
} from "../store/snapshotStats";
import { isSheetProtectedInSnapshot } from "../store/sheetProtection";
import { extractCellStyle, applyCellStyle } from "../store/formatPainter";
import {
  computeSplitEntry,
  hasSplitPane,
  writeSplitPaneInto,
  type SplitMode,
  type SplitSnapshotShape,
} from "../store/splitPane";
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
import CameraLinksPanel from "./CameraLinksPanel";
import {
  listCameraLinks,
  addCameraLink,
  removeCameraLink,
  updateCameraLinkRender,
  isSourceResolvable,
  generateCameraLinkId,
  CAMERA_LINKS_MAX,
  type CameraLink,
} from "../store/cameraLinks";
import { renderRangeToDataUrl } from "../store/cameraCanvas";
import { rectToA1 } from "../store/cameraRender";
import { validateMutation, extractCellWrites } from "../store/dataValidation";
import { getLocale, subscribeLocale, t } from "../i18n/locale";
import { swapUniverLocale } from "./univerLocaleSwap";
import {
  getEffectiveTheme,
  onThemeChanged,
  subscribeSystemTheme,
} from "../store/theme";
import { setUniverDarkMode } from "./univerDarkMode";
import ScriptEditorDialog from "./ScriptEditorDialog";
import {
  type ScriptEntry,
  type EditEvent,
  type CollectedTriggers,
  readScripts,
  writeScripts,
  collectTriggers,
  fireTrigger,
  recordRun,
} from "../store/scriptRuntime";
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

// #198: derive the next number-format code for the ribbon's comma / decimal
// buttons. `prev` is the cell's current `_fmt`; the result is written back to
// `_fmt`. Kept module-level + pure so it's trivially unit-testable.
//   commaStyle      — toggle a thousands-separator integer format.
//   increaseDecimal — append one fractional digit.
//   decreaseDecimal — remove one fractional digit (floors at zero).
function nextNumberFormatCode(
  op: "commaStyle" | "increaseDecimal" | "decreaseDecimal",
  prev: string,
): string {
  // Count trailing decimal digits in the existing pattern (the `0`s after a
  // literal dot). Defaults to 0 when there's no recognizable pattern.
  const decimalMatch = /\.(0+)/.exec(prev);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;
  const hasComma = prev.includes(",");
  if (op === "commaStyle") {
    // Toggle: if it's already a comma format, fall back to General.
    if (hasComma) return "";
    return decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0";
  }
  const nextDecimals =
    op === "increaseDecimal" ? decimals + 1 : Math.max(0, decimals - 1);
  const intPart = hasComma ? "#,##0" : "0";
  return nextDecimals > 0 ? `${intPart}.${"0".repeat(nextDecimals)}` : intPart;
}

export default function EditorScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Univer | null>(null);
  const fUniverRef = useRef<FUniver | null>(null);
  // StrictMode-safe stash for the Univer instance bundle. React 18 StrictMode
  // double-invokes effects in dev (mount → cleanup → mount). Disposing Univer
  // synchronously in the cleanup tears down its `redi` DI injector while a
  // late async dispatch (in Univer 0.5.x specifically: `_initWorkbookListener`)
  // is still pending, producing "[redi]: Injector cannot be accessed after it
  // was disposed" and a blank grid. We instead defer disposal onto a
  // setTimeout(0); a StrictMode remount runs synchronously and cancels that
  // timer, reusing the live instance.
  //
  // NOTE (post-Univer-0.24): the original 0.5.x async race (the symbol
  // `_initWorkbookListener` no longer exists in 0.24's core bundle) appears
  // to have been resolved upstream. This guard may now be dead code. Removing
  // it is tracked in issue #232 — needs a runtime spike under StrictMode
  // before we delete ~50 lines of machinery.
  const univerStashRef = useRef<{
    univer: Univer;
    fUniver: FUniver;
    contextMenuReg: ReturnType<typeof registerCocoContextMenu> | null;
    formulaNormalizerReg: ReturnType<typeof registerFormulaNormalizer> | null;
    disposeTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  // Stable refs for the openX dialog handlers so the Univer context-menu
  // commands (registered once at mount with empty-deps useEffect) always
  // see the *latest* React-side openX function, not the one captured at
  // first render. Each render syncs the current openX values below.
  const openCommentDialogRef = useRef<() => void>(() => {});
  const openHyperlinkDialogRef = useRef<() => void>(() => {});
  const openNumberFormatDialogRef = useRef<() => void>(() => {});

  // CF live re-paint sidecar: one instance per editor session. Tracks the
  // user-authored base style for every cell touched by a CF rule, so facade
  // writes never pollute the canonical BASE (the PR #211 revert bug).
  // Reset in clearEditor / on workbook close so stale state doesn't carry
  // across file-open operations.
  const cfSidecarRef = useRef<CfSidecar>(new CfSidecar());

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
  // #245 — Workbook Inquire (read-only diagnostic of cell/formula counts,
  // top functions, errors, external links, embedded-object tallies).
  const [inquireOpen, setInquireOpen] = useState(false);
  const [editorInitError, setEditorInitError] = useState<string | null>(null);
  const [editorOperationError, setEditorOperationError] = useState<string | null>(null);
  // Auto-update state machine (Phase 1, Windows-only). Drives a status-bar
  // indicator + UpdateAvailableDialog. See src/store/updater.ts for the
  // UpdaterState union and lazy-loaded plugin wrappers.
  const [updaterState, setUpdaterState] = useState<UpdaterState>({ kind: "idle" });
  // #192: live aggregates for the current selection, shown on the status bar.
  // null = single-cell / empty selection (nothing worth summarizing).
  const [selectionStats, setSelectionStats] = useState<SelectionStats | null>(null);
  // Command palette (Ctrl+Shift+P / Cmd+Shift+P). Boolean state — the command
  // list is rebuilt on every render so the palette always sees the latest
  // handler closures and store actions.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // #131 — macro record/playback dialog. Boolean; the dialog reads the
  // recorder state from the module-scope singleton in `store/macroRecord`,
  // so we don't mirror it here.
  const [macroDialogOpen, setMacroDialogOpen] = useState(false);
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
  // Insert-shape dialog (#146 / #188): null while closed. Captures the active
  // sheet + the top-left of the active range so the shape anchors where the
  // user clicked. Same shape as imageDialog.
  const [shapeDialog, setShapeDialog] = useState<{
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
  // Solver (#239 MVP, single-variable) — reuses the GoalSeekAdapter.
  const [solverState, setSolverState] = useState<{
    objectiveCell: string;
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
  // #184: camera-image (live range snapshot) panel visibility.
  const [cameraPanelOpen, setCameraPanelOpen] = useState(false);
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
  // #136 / #189: スクリプトエディタ。
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [calcOptionsOpen, setCalcOptionsOpen] = useState(false);
  const [calcMode, setCalcModeState] = useState<CalcMode>(() => getCalcMode());
  const [watchWindowOpen, setWatchWindowOpen] = useState(false);
  // Wave 6
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [scenarioAdapter, setScenarioAdapter] = useState<ScenarioAdapter | null>(null);
  const [forecastDialog, setForecastDialog] = useState<{ xRange: string; yRange: string } | null>(null);
  const [analysisToolpakDialog, setAnalysisToolpakDialog] = useState<{ initialRange: string } | null>(null);
  const [recommendedChartsDialog, setRecommendedChartsDialog] = useState<{
    sheetId: string;
    range: string;
    recommendations: ChartRecommendation[];
  } | null>(null);
  const [cfManagerOpen, setCfManagerOpen] = useState(false);
  const [snapshotDiffOpen, setSnapshotDiffOpen] = useState(false);
  const [snapshotDiffOptions, setSnapshotDiffOptions] = useState<Array<{ id: string; label: string }>>([]);
  // Wave 7
  const [spellCheckOpen, setSpellCheckOpen] = useState(false);
  const [spellCheckIssues, setSpellCheckIssues] = useState<SpellIssue[]>([]);
  const [dataFormDialog, setDataFormDialog] = useState<{
    sheetId: string;
    range: DataFormRange;
    rangeLabel: string;
    hasHeader: boolean;
    headers: string[];
    rows: DataFormRow[];
  } | null>(null);
  const [findReplaceAllDialog, setFindReplaceAllDialog] = useState<{
    activeSheetId: string | null;
  } | null>(null);
  const [commentsManagerOpen, setCommentsManagerOpen] = useState(false);
  // Wave 8
  const [smartDateDialog, setSmartDateDialog] = useState<{
    sheetId: string;
    range: string;
    rangeRect: { r1: number; c1: number; r2: number; c2: number };
  } | null>(null);
  const [smartDatePreview, setSmartDatePreview] = useState<
    Array<{ original: string; converted: string }>
  >([]);
  const [convertToRangeDialog, setConvertToRangeDialog] = useState<{
    tables: ConvertToRangeTableSummary[];
  } | null>(null);
  const [documentInspectorOpen, setDocumentInspectorOpen] = useState(false);
  const [documentInspections, setDocumentInspections] = useState<InspectionResult[]>([]);
  const [bulkCleanDialog, setBulkCleanDialog] = useState<{
    sheetId: string;
    range: string;
    preview: Array<{ original: string }>;
  } | null>(null);
  const [csvWizard, setCsvWizard] = useState<{ filePath: string; previewBytes: Uint8Array } | null>(null);
  // Wave 9
  const [goToOpen, setGoToOpen] = useState(false);
  // #116-followup: toolbar-embedded NavigationBox needs reactive active-cell
  // tracking. Same 300ms poll pattern used by FormulaTracePanel since
  // Univer 0.5.x's selection observable API isn't stable.
  const [navActiveSheetName, setNavActiveSheetName] = useState("Sheet1");
  const [navActiveCellRef, setNavActiveCellRef] = useState("A1");
  // #198: text shown in the ribbon's formula bar — the active cell's formula
  // (preferred) or its literal value. Refreshed by the same 300ms poll.
  const [formulaBarText, setFormulaBarText] = useState("");
  // #146 / #188: track the active sheet id so the TextBoxesPanel can filter to
  // the current sheet. Same 300ms-poll cadence as navActiveSheetName above.
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [sheetImportOpen, setSheetImportOpen] = useState(false);
  // #238 Step 2: Get & Transform dialog.
  const [getTransformOpen, setGetTransformOpen] = useState(false);
  // #140 / #190: external data connections (Power Query) — modal dialog.
  const [dataConnectionsOpen, setDataConnectionsOpen] = useState(false);
  const [bookmarksPanelOpen, setBookmarksPanelOpen] = useState(false);
  // #109: per-workbook session id so bookmarks for unsaved workbooks don't
  // bleed across "default". Regenerated whenever the workbook handle changes
  // (new file opened / new workbook created / save-as to new path).
  const [workbookSessionId, setWorkbookSessionId] = useState<string>(() =>
    generateWorkbookSessionId(),
  );
  useEffect(() => {
    setWorkbookSessionId(generateWorkbookSessionId());
  }, [currentHandle?.path]);
  // Reset CF sidecar on file-open so stale base-style state doesn't carry
  // across workbook switches (promised in the cfSidecarRef comment above).
  useEffect(() => {
    cfSidecarRef.current.clearAll();
  }, [currentHandle?.path]);
  const bookmarkWorkbookId = currentHandle?.path ?? workbookSessionId;
  const [numberFormatManagerOpen, setNumberFormatManagerOpen] = useState(false);
  const [rangeCompareState, setRangeCompareState] = useState<{
    initialA: string;
    initialB: string;
    snapshotJson: string;
  } | null>(null);
  // Wave 10
  const [insertSymbolCtx, setInsertSymbolCtx] = useState<{ sheetId: string; cellRef: string } | null>(null);
  const [sheetNoteDialog, setSheetNoteDialog] = useState<{
    sheetId: string;
    sheetName: string;
    initial: SheetNote | null;
  } | null>(null);
  const [imageManagerOpen, setImageManagerOpen] = useState(false);
  const [templatesGalleryOpen, setTemplatesGalleryOpen] = useState(false);
  const [snapshotControlsState, setSnapshotControlsState] = useState<{
    open: boolean;
    lastSnapshotAt: string | null;
    snapshotCount: number;
  }>({ open: false, lastSnapshotAt: null, snapshotCount: 0 });
  const [snapInterval, setSnapInterval] = useState<SnapshotIntervalSetting>(() => getAutoSaveInterval());
  // Wave 11
  const [sortByColorDialog, setSortByColorDialog] = useState<{ sheetId: string; range: string } | null>(null);
  const [filterByColorDialog, setFilterByColorDialog] = useState<{
    sheetId: string;
    range: string;
    snapshot: { cellData?: Record<string, Record<string, unknown>> };
  } | null>(null);
  const [workbookStatsOpen, setWorkbookStatsOpen] = useState(false);
  const [workbookStats, setWorkbookStats] = useState<WorkbookStatsBundle | null>(null);
  const [showAllCommentsMode, setShowAllCommentsMode] = useState(false);
  const [quickPrintDialog, setQuickPrintDialog] = useState<{
    snapshot: object;
    activeSheetId: string | null;
  } | null>(null);
  // Wave 12
  const [hyperlinkManagerOpen, setHyperlinkManagerOpen] = useState(false);
  const [hyperlinkValidation, setHyperlinkValidation] = useState<Record<string, boolean> | undefined>(undefined);
  const [bordersDialog, setBordersDialog] = useState<{ sheetId: string; range: string } | null>(null);
  const [quickCfDialog, setQuickCfDialog] = useState<{ sheetId: string; range: string } | null>(null);
  const [cellLinkerCtx, setCellLinkerCtx] = useState<{
    activeSheetId: string;
    initialTargetCell: string;
    availableSheets: Array<{ id: string; name: string }>;
  } | null>(null);
  const [filterSearchDialog, setFilterSearchDialog] = useState<{
    sheetId: string;
    range: string;
    snapshot: { cellData?: Record<string, Record<string, unknown>> };
  } | null>(null);
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

  // --- Window split (issue #156) -------------------------------------------
  //
  // "Split" is the Excel "View → Split" feature: divide the active sheet into
  // 2 or 4 viewports at the active cell, each scrolling independently. Unlike
  // freeze panes (the top/left region is locked), split panes have NO locked
  // region — all panes scroll.
  //
  // Univer 0.5.x does not expose a dedicated split-pane API; only freeze. The
  // closest visual approximation is `FWorksheet.setFreeze` which renders 4
  // viewports with independent scroll. We use that for the in-session view and
  // persist `state="split"` in `_freezePane` so xlsx round-trip preserves
  // Excel's distinction.
  const applySplitToFacade = useCallback(
    (
      workbook: ReturnType<FUniver["getActiveWorkbook"]>,
      sheetId: string,
      row: number,
      col: number,
    ) => {
      try {
        if (!workbook) return;
        const sheets = workbook.getSheets();
        const target = sheets.find((s) => s.getSheetId() === sheetId);
        if (!target) return;
        if (row === 0 && col === 0) {
          target.cancelFreeze();
          return;
        }
        target.setFreeze({
          xSplit: col,
          ySplit: row,
          startRow: row,
          startColumn: col,
        });
      } catch {
        // Best-effort.
      }
    },
    [],
  );

  const toggleSplitPane = useCallback(
    (mode: SplitMode = "both") => {
      const ready = getReadyWorkbook("ウィンドウ分割");
      if (!ready) return;
      const { workbook } = ready;
      const activeSheet = workbook.getActiveSheet();
      if (!activeSheet) return;
      const sheetId = activeSheet.getSheetId();

      const fresh = workbook.save() as unknown as SplitSnapshotShape;
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;

      const freshJson = JSON.stringify(fresh);
      if (hasSplitPane(freshJson, sheetId)) {
        writeSplitPaneInto(fresh, sheetId, null);
        applyMutatedSnapshot(JSON.stringify(fresh));
        applySplitToFacade(workbook, sheetId, 0, 0);
        return;
      }

      let activeRow = 0;
      let activeCol = 0;
      try {
        const sel = activeSheet.getSelection();
        const range = sel?.getActiveRange();
        if (range) {
          activeRow = range.getRow();
          activeCol = range.getColumn();
        }
      } catch {
        // Best-effort.
      }
      const entry = computeSplitEntry(activeRow, activeCol, mode);
      if (!entry) {
        setEditorOperationError(
          "ウィンドウ分割: アクティブセルが A1 のため分割位置を決められません。別のセルを選択してから再度お試しください。",
        );
        return;
      }
      writeSplitPaneInto(fresh, sheetId, entry);
      applyMutatedSnapshot(JSON.stringify(fresh));
      applySplitToFacade(workbook, sheetId, entry.row, entry.col);
    },
    [getReadyWorkbook, applyMutatedSnapshot, applySplitToFacade],
  );

  const clearSplitPane = useCallback(() => {
    const ready = getReadyWorkbook("ウィンドウ分割を解除");
    if (!ready) return;
    const { workbook } = ready;
    const activeSheet = workbook.getActiveSheet();
    if (!activeSheet) return;
    const sheetId = activeSheet.getSheetId();
    const fresh = workbook.save() as unknown as SplitSnapshotShape;
    if (!fresh.sheets || !fresh.sheets[sheetId]) return;
    if (!hasSplitPane(JSON.stringify(fresh), sheetId)) return;
    writeSplitPaneInto(fresh, sheetId, null);
    applyMutatedSnapshot(JSON.stringify(fresh));
    applySplitToFacade(workbook, sheetId, 0, 0);
  }, [getReadyWorkbook, applyMutatedSnapshot, applySplitToFacade]);

  const activeSheetHasSplit = (() => {
    if (!currentSnapshotJson) return false;
    const fUniver = fUniverRef.current;
    let sid: string | undefined;
    try {
      sid = fUniver?.getActiveWorkbook()?.getActiveSheet()?.getSheetId();
    } catch {
      sid = undefined;
    }
    if (!sid) {
      try {
        const snap = JSON.parse(currentSnapshotJson) as { sheetOrder?: string[] };
        sid = snap.sheetOrder?.[0];
      } catch {
        return false;
      }
    }
    return hasSplitPane(currentSnapshotJson, sid ?? null);
  })();

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

  // Conditional formatting: rules are authored into the snapshot
  // (xlsx_io.rs preserves _conditionalFormatting per sheet) and `patchCfRenders`
  // evaluates them at createUnit time. In-session live re-paint after
  // `applyCfRules` was attempted in PR #211 and reverted in v0.4.4 — see the
  // note inside applyCfRules for the runtime bugs that drove the revert and
  // `high-cf-live-render` in docs/TODOS.md for the redo plan.
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
      // Capture the OUTGOING rules so the live-repaint pass below can revert
      // cells dropped from a shrunk / removed rule. `fresh` still carries the
      // old set at this point because we haven't written `next` into it yet.
      const prevRules = Array.isArray(sheetObj._conditionalFormatting)
        ? ([...(sheetObj._conditionalFormatting as CfRule[])] as CfRule[])
        : [];
      if (next.length === 0) {
        // Mirror the Rust "omit when empty" convention on the export side so
        // a sheet that loses all its rules doesn't keep a stray empty array.
        delete sheetObj._conditionalFormatting;
      } else {
        sheetObj._conditionalFormatting = next;
      }
      const nextJson = JSON.stringify(fresh);
      applyMutatedSnapshot(nextJson);

      // #241 CF live re-paint (sidecar approach, replaces the reverted PR #211).
      //
      // The plan computes per-cell style deltas using a sidecar that tracks the
      // user-authored BASE style per cell. The sidecar ensures BASE never drifts
      // even after repeated facade writes — defeating the two runtime bugs from
      // the original PR #211 revert:
      //   1. iconSet glyph: the plan records `iconValue` in the sidecar cfStyle
      //      but the facade loop below skips `setValue` for cells that carry
      //      `iconValue` (the glyph is already rendered by `patchCfRenders` in
      //      the snapshot patch applied above via `applyMutatedSnapshot`). The
      //      canonical snapshot's `v` field is never written with a glyph string,
      //      so numeric cells stay numeric and formulas keep evaluating correctly.
      //   2. BASE drift: the sidecar's `recordBase` is idempotent — once a BASE
      //      is recorded it is never overwritten by a subsequent CF facade write,
      //      so `clear` actions always restore the true user-authored style.
      const fUniver = fUniverRef.current;
      const sidecar = cfSidecarRef.current;
      if (fUniver) {
        try {
          const snapshotForPlan = JSON.parse(nextJson) as {
            sheets?: Record<string, { cellData?: Record<string, Record<string, unknown> | undefined> } | undefined>;
          };
          const plan = computeCfApplyPlan(
            sidecar,
            snapshotForPlan,
            sheetId,
            prevRules as CfRuleEntryType[],
            next as CfRuleEntryType[],
          );
          const batches = batchCfPlan(plan);
          const fWorkbook = fUniver.getActiveWorkbook();
          if (fWorkbook) {
            const fSheet = fWorkbook.getSheetBySheetId(sheetId);
            if (fSheet) {
              for (const batch of batches) {
                if (batch.action === "noop") continue;
                const { r1, c1, r2, c2 } = batch.rect;
                const fRange = fSheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
                if (!fRange) continue;
                const style = batch.style;
                try {
                  if (batch.action === "paint") {
                    if (style.bg !== undefined) fRange.setBackground(style.bg);
                    if (style.cl !== undefined) fRange.setFontColor(style.cl);
                    if (style.bl !== undefined) fRange.setFontWeight(style.bl === 1 ? "bold" : "normal");
                    // iconValue: glyph is applied by patchCfRenders on snapshot —
                    // deliberately NOT calling setValue here to prevent numeric
                    // cell corruption (the original show-stopper bug from PR #211).
                  } else {
                    // clear: restore base style
                    fRange.setBackground(style.bg ?? "#FFFFFF");
                    if (style.cl !== undefined) fRange.setFontColor(style.cl);
                    if (style.bl !== undefined) fRange.setFontWeight(style.bl === 1 ? "bold" : "normal");
                  }
                } catch {
                  // Best-effort: swallow per-range errors (same policy as applyHyperlink).
                }
              }
            }
          }
        } catch {
          // Live repaint failure is non-fatal — patchCfRenders on next createUnit
          // will correct any visual drift.
        }
      }
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

  // #150: "Insert → Checkbox" command. Walks the active selection and toggles
  // checkbox decoration on every cell. Single-cell on a pre-decorated cell
  // removes the checkbox (Google Sheets parity: the menu acts as toggle).
  // Snapshot is pushed through applyMutatedSnapshot so the Coco undo stack
  // captures the change.
  const insertCheckboxAtSelection = useCallback(() => {
    const ready = getReadyWorkbook("チェックボックス");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const liveSnapshot = useWorkbookStore.getState().currentSnapshotJson;
    if (isSheetProtectedInSnapshot(liveSnapshot, sheetId)) {
      setEditorOperationError(
        "チェックボックス: このシートは保護されているため挿入できません。",
      );
      return;
    }
    // Resolve selection rect (fall back to A1 on no live selection).
    let r1 = 0;
    let c1 = 0;
    let r2 = 0;
    let c2 = 0;
    try {
      const sel = sheet.getSelection();
      const range = sel?.getActiveRange();
      if (range) {
        r1 = range.getRow();
        c1 = range.getColumn();
        const rowCount =
          (range as unknown as { getRowCount?: () => number }).getRowCount?.() ??
          1;
        const colCount =
          (range as unknown as { getColumnCount?: () => number }).getColumnCount?.() ??
          1;
        r2 = r1 + Math.max(rowCount, 1) - 1;
        c2 = c1 + Math.max(colCount, 1) - 1;
      }
    } catch {
      // Fall through to defaults.
    }

    // Single-cell on a pre-decorated cell → remove (toggle off).
    if (r1 === r2 && c1 === c2 && hasCheckbox(liveSnapshot, sheetId, r1, c1)) {
      const next = removeCheckbox(liveSnapshot, sheetId, checkboxToA1(r1, c1));
      applyMutatedSnapshot(JSON.stringify(next));
      return;
    }

    // Cell-occupancy guard: refuse when any target cell already carries a
    // sparkline or form-control glyph (they overwrite the cell's `p` paragraph
    // and would visually collide). A pre-existing checkbox is fine — addCheckbox
    // is idempotent on the host cell.
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (
          isCellOccupied(liveSnapshot, sheetId, r, c) &&
          !hasCheckbox(liveSnapshot, sheetId, r, c)
        ) {
          setEditorOperationError(
            "チェックボックス: 対象範囲にスパークライン・フォームコントロールがあるセルが含まれるため挿入できません。",
          );
          return;
        }
      }
    }

    // Apply addCheckbox across the rectangle.
    let snap: unknown = liveSnapshot
      ? JSON.parse(liveSnapshot)
      : { sheets: {} };
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        snap = addCheckbox(
          snap as Parameters<typeof addCheckbox>[0],
          sheetId,
          checkboxToA1(r, c),
        );
      }
    }
    applyMutatedSnapshot(JSON.stringify(snap));
  }, [getReadyWorkbook, applyMutatedSnapshot]);

  // #183: "Insert → Form control" commands (radio / spin / scroll). Each
  // anchors the control to the active cell with its linked cell defaulting to
  // the next column over so the control glyph and its numeric value don't
  // collide. A single-cell selection on a pre-decorated cell removes the
  // control (toggle parity with the checkbox command). Radios placed in the
  // same column are auto-bundled into one group so they behave mutually
  // exclusively out of the box.
  const insertFormControlAtSelection = useCallback(
    (kind: FormControlKind) => {
      const labelJa =
        kind === "radio"
          ? "ラジオボタン"
          : kind === "spin"
            ? "スピンボタン"
            : "スクロールバー";
      const ready = getReadyWorkbook(labelJa);
      if (!ready) return;
      const { workbook } = ready;
      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      const sheetId = sheet.getSheetId();
      const liveSnapshot = useWorkbookStore.getState().currentSnapshotJson;
      if (isSheetProtectedInSnapshot(liveSnapshot, sheetId)) {
        setEditorOperationError(
          `${labelJa}: このシートは保護されているため挿入できません。`,
        );
        return;
      }
      // Anchor cell = top-left of the active selection (fallback A1).
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
        // Fall through to defaults.
      }

      // Toggle-off when the anchor already hosts a control.
      if (hasFormControl(liveSnapshot, sheetId, row, col)) {
        const next = removeFormControl(
          liveSnapshot,
          sheetId,
          formControlToA1(row, col),
        );
        applyMutatedSnapshot(JSON.stringify(next));
        return;
      }

      // Cell-occupancy guard: refuse to stack a control glyph onto a cell that
      // already carries a sparkline / checkbox glyph (they all overwrite the
      // cell's `p` paragraph and would visually collide).
      if (isCellOccupied(liveSnapshot, sheetId, row, col)) {
        setEditorOperationError(
          `${labelJa}: このセルには既にスパークライン・チェックボックス・フォームコントロールのいずれかがあるため挿入できません。`,
        );
        return;
      }

      const hostRef = formControlToA1(row, col);
      // Linked cell defaults to the cell one column to the right so the
      // control glyph and its value are visually distinct.
      const linkedRef = formControlToA1(row, col + 1);
      let spec: Parameters<typeof addFormControl>[3];
      if (kind === "radio") {
        // Auto-group radios that share a column on this sheet.
        const groupId = `radio-col${col}`;
        // Count existing radios in this group to label the new option.
        const existing = liveSnapshot
          ? (() => {
              try {
                const parsed = JSON.parse(liveSnapshot);
                const arr = parsed?.sheets?.[sheetId]?._formControls;
                return Array.isArray(arr)
                  ? arr.filter(
                      (e: { kind?: string; group?: string }) =>
                        e?.kind === "radio" && e?.group === groupId,
                    ).length
                  : 0;
              } catch {
                return 0;
              }
            })()
          : 0;
        const optionIndex = existing + 1;
        spec = {
          kind: "radio",
          group: groupId,
          // All radios in a group share one linked cell (Excel parity).
          linkedCell: formControlToA1(row, col + 1),
          optionValue: optionIndex,
          label: `オプション ${optionIndex}`,
        };
      } else if (kind === "spin") {
        spec = {
          kind: "spin",
          linkedCell: linkedRef,
          min: 0,
          max: 100,
          step: 1,
        };
      } else {
        spec = {
          kind: "scroll",
          linkedCell: linkedRef,
          min: 0,
          max: 100,
          step: 1,
          page: 10,
        };
      }
      const next = addFormControl(liveSnapshot, sheetId, hostRef, spec);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [getReadyWorkbook, applyMutatedSnapshot],
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
        sheets?: Record<string, { _tables?: TableEntry[]; _slicers?: SlicerEntry[] }>;
      };
      if (!fresh.sheets || !fresh.sheets[sheetId]) return;
      const sheet = fresh.sheets[sheetId];
      sheet._tables = removeTable(sheet as { _tables?: TableEntry[] }, name);
      // #115: cascade-delete every slicer (workbook-wide) that referenced the
      // dropped table; otherwise SlicerPanel keeps a broken row that toggles inert.
      for (const sid of Object.keys(fresh.sheets)) {
        const otherSheet = fresh.sheets[sid];
        if (!otherSheet || !Array.isArray(otherSheet._slicers)) continue;
        otherSheet._slicers = otherSheet._slicers.filter((s) => s?.targetTable !== name);
      }
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
      const next = renameWorkbookTable(fresh as { sheets?: Record<string, { _tables?: TableEntry[] }> }, oldName, newName);
      if (next === null) return;
      applyMutatedSnapshot(JSON.stringify(next));
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

  // --- Solver (#239 MVP, single-variable) -----------------------------------
  const openSolverDialog = useCallback(() => {
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
    setSolverState({ objectiveCell: activeRef, changingCell: "A1", adapter });
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

  // Pivot-targeting slicer support (PR #253 follow-up). Pivot's filter
  // surface is the SOURCE header set (since slicer changes which rows feed
  // the aggregation), so columns = inferFieldNames(sourceCellData, range).
  const availableSlicerPivots = useMemo(() => {
    if (!currentSnapshotJson) return [];
    let parsed: {
      sheetOrder?: string[];
      sheets?: Record<
        string,
        | {
            name?: string;
            _pivots?: PivotEntry[];
            cellData?: Record<string, Record<string, { v?: unknown } | undefined> | undefined>;
          }
        | undefined
      >;
    };
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
      if (!Array.isArray(sh?._pivots)) continue;
      for (const p of sh!._pivots!) {
        if (!p?.name || !p.source) continue;
        const srcSheet = sheets[p.source.sheetId];
        const columns = inferFieldNames(srcSheet?.cellData, p.source.range, p.hasHeader);
        out.push({ name: p.name, sheetId: sid, columns });
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
      const next = toggleSlicerValueHelper(fresh, name, value);
      if (!next) return;
      // PR #253 follow-up: also re-render any pivots whose filter set is
      // driven by this (or any) slicer. No-op when nothing pivot-targets.
      // The helper mutates the snapshot in place, including writing the
      // updated pivot output cells.
      applySlicerFiltersToPivots(next as unknown as WorkbookSlicerPivotSnapshot);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [applyMutatedSnapshot],
  );

  // Bulk-op handlers (Slicer panel toolbar). Same shape as toggleSlicer:
  // mutate the cloned snapshot via the pure helper, re-render pivots if any,
  // commit via applyMutatedSnapshot (Coco-undo aware).
  const clearSlicer = useCallback(
    (name: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookSlicerSnapshot;
      const next = clearSlicerSelectionHelper(fresh, name);
      if (!next) return;
      applySlicerFiltersToPivots(next as unknown as WorkbookSlicerPivotSnapshot);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [applyMutatedSnapshot],
  );

  const selectAllSlicer = useCallback(
    (name: string, values: string[]) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookSlicerSnapshot;
      const next = setSlicerSelectionHelper(fresh, name, values);
      if (!next) return;
      applySlicerFiltersToPivots(next as unknown as WorkbookSlicerPivotSnapshot);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [applyMutatedSnapshot],
  );

  const invertSlicer = useCallback(
    (name: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as WorkbookSlicerPivotSnapshot;
      const next = invertSlicerSelectionHelper(fresh, name);
      if (!next) return;
      applySlicerFiltersToPivots(next);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [applyMutatedSnapshot],
  );

  const clearAllSlicersHandler = useCallback(() => {
    const fUniver = fUniverRef.current;
    const workbook = fUniver?.getActiveWorkbook();
    if (!workbook) return;
    const fresh = workbook.save() as unknown as WorkbookSlicerSnapshot;
    const result = clearAllSlicersHelper(fresh);
    if (!result || result.clearedCount === 0) return;
    applySlicerFiltersToPivots(result.snapshotMutated as unknown as WorkbookSlicerPivotSnapshot);
    applyMutatedSnapshot(JSON.stringify(result.snapshotMutated));
  }, [applyMutatedSnapshot]);

  // Excel-parity: Ctrl+; inserts today's date, Ctrl+Shift+; inserts current
  // time. We write a VALUE (not a formula) so the cell freezes at insertion
  // — Excel's =TODAY() / =NOW() variants are NOT what this shortcut does in
  // Excel either. Uses the user's locale for display via toLocale*String.
  const insertDateTimeNow = useCallback((mode: "date" | "time") => {
    const fUniver = fUniverRef.current;
    const workbook = fUniver?.getActiveWorkbook();
    const sheet = workbook?.getActiveSheet();
    if (!sheet) return;
    const sel = sheet.getSelection?.();
    const range = sel?.getActiveRange();
    if (!range) return;
    const now = new Date();
    let payload: string;
    if (mode === "date") {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      payload = `${y}-${m}-${d}`;
    } else {
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      payload = `${hh}:${mm}:${ss}`;
    }
    try {
      range.setValue(payload);
    } catch (err) {
      console.warn("[Coco] insertDateTimeNow failed:", err);
    }
  }, []);

  // --- Camera (#184) ---------------------------------------------------------
  // Snapshot the active selection into a "live" camera image: the source
  // range is baked into a PNG data URL that re-renders when the source cells
  // change. Univer 0.5.x has no in-grid overlay API so the images surface in
  // CameraLinksPanel (sidebar) — see store/cameraLinks.ts.
  const captureCamera = useCallback(() => {
    const ready = getReadyWorkbook("カメラ撮影");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const r = sheet.getSelection()?.getActiveRange();
    if (!r) {
      setEditorOperationError("カメラ撮影: セル範囲を選択してください");
      return;
    }
    const startRow = r.getRow();
    const startCol = r.getColumn();
    const height = (r as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
    const width = (r as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
    const sourceRange = {
      r1: startRow,
      c1: startCol,
      r2: startRow + Math.max(0, height - 1),
      c2: startCol + Math.max(0, width - 1),
    };
    const snapJson = workbook.save() as unknown as Record<string, unknown>;
    const snapStr = JSON.stringify(snapJson);

    const links = listCameraLinks(snapJson);
    if (links.length >= CAMERA_LINKS_MAX) {
      setEditorOperationError(
        `カメラ撮影: 1ブックあたり ${CAMERA_LINKS_MAX} 件までです`,
      );
      return;
    }

    const dataUrl = renderRangeToDataUrl(snapStr, sheetId, sourceRange);
    if (dataUrl === null) {
      setEditorOperationError("カメラ撮影: スナップショット画像の生成に失敗しました");
      return;
    }
    // Default destination anchor: two columns to the right of the source so
    // the snapshot doesn't overlap the range it mirrors.
    const link: CameraLink = {
      id: generateCameraLinkId(links),
      sourceSheetId: sheetId,
      sourceRange,
      dstSheetId: sheetId,
      dstAnchor: { row: sourceRange.r1, col: sourceRange.c2 + 2 },
      dataUrl,
      broken: false,
      generatedAt: new Date().toISOString(),
    };
    const { snapshot: nextSnap, added } = addCameraLink(snapJson, link);
    if (!added) {
      setEditorOperationError(
        `カメラ撮影: 1ブックあたり ${CAMERA_LINKS_MAX} 件までです`,
      );
      return;
    }
    setEditorOperationError(null);
    applyMutatedSnapshot(JSON.stringify(nextSnap));
    setCameraPanelOpen(true);
  }, [getReadyWorkbook, applyMutatedSnapshot]);

  const captureCameraRef = useRef<() => void>(() => {});
  captureCameraRef.current = captureCamera;

  // Delete a camera link by id.
  const deleteCameraLink = useCallback(
    (id: string) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as Record<string, unknown>;
      applyMutatedSnapshot(JSON.stringify(removeCameraLink(fresh, id)));
    },
    [applyMutatedSnapshot],
  );

  // Live re-render: when the snapshot changes, re-bake every camera image
  // whose source range may have moved/changed. Debounced 300ms so a burst of
  // edits collapses into one re-render pass (issue perf budget). Broken links
  // (source sheet deleted) get flagged for the #REF! placeholder. The render
  // pass writes back via updateSnapshot directly (not applyMutatedSnapshot)
  // so it doesn't pollute the Coco undo stack — it's a derived refresh, not a
  // user action.
  useEffect(() => {
    if (!currentSnapshotJson) return;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = JSON.parse(currentSnapshotJson) as Record<string, unknown>;
    } catch {
      return;
    }
    const links = listCameraLinks(snapshot);
    if (links.length === 0) return;

    const timer = window.setTimeout(() => {
      // Re-read the latest snapshot at fire time so we don't clobber edits
      // made during the debounce window.
      const latest = useWorkbookStore.getState().currentSnapshotJson;
      if (!latest) return;
      let live: Record<string, unknown>;
      try {
        live = JSON.parse(latest) as Record<string, unknown>;
      } catch {
        return;
      }
      let mutated = false;
      let working = live;
      for (const link of listCameraLinks(live)) {
        const resolvable = isSourceResolvable(
          live as { sheets?: Record<string, unknown> },
          link,
        );
        if (!resolvable) {
          if (!link.broken || link.dataUrl !== "") {
            working = updateCameraLinkRender(working, link.id, {
              dataUrl: "",
              broken: true,
            });
            mutated = true;
          }
          continue;
        }
        const fresh = renderRangeToDataUrl(latest, link.sourceSheetId, link.sourceRange);
        if (fresh !== null && (fresh !== link.dataUrl || link.broken)) {
          working = updateCameraLinkRender(working, link.id, {
            dataUrl: fresh,
            broken: false,
          });
          mutated = true;
        }
      }
      if (mutated) {
        updateSnapshot(JSON.stringify(working));
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [currentSnapshotJson, updateSnapshot]);

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

  // #192: keep the status-bar selection summary (合計 / 平均 / 個数 ...) in
  // sync with the live selection. We poll the active range every 250ms —
  // mirroring the Trace panel above — because Univer 0.5.x's selection
  // observable isn't stable across patches, and `onSelectionChange` doesn't
  // carry cell values (we'd still have to re-read the range). A single-cell
  // selection (or no selection) yields null so the summary stays hidden.
  const lastSelectionRangeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Cap the per-poll read: a whole-column selection is ~1M cells and
    // re-serializing it every 250ms would stutter the UI.
    const MAX_SELECTION_CELLS = 100_000;
    const tick = () => {
      const workbook = fUniverRef.current?.getActiveWorkbook();
      if (!workbook) {
        lastSelectionRangeKeyRef.current = null;
        setSelectionStats(null);
        return;
      }
      try {
        const sheet = workbook.getActiveSheet();
        const r = sheet?.getSelection()?.getActiveRange();
        if (!r) {
          lastSelectionRangeKeyRef.current = null;
          setSelectionStats(null);
          return;
        }
        const range = r as unknown as {
          getHeight?: () => number;
          getWidth?: () => number;
          getRow?: () => number;
          getColumn?: () => number;
          getValues?: () => unknown[][];
        };
        const height = range.getHeight?.() ?? 1;
        const width = range.getWidth?.() ?? 1;
        if (height <= 1 && width <= 1) {
          lastSelectionRangeKeyRef.current = null;
          setSelectionStats(null);
          return;
        }
        // Skip the (potentially large) getValues() read when the selection
        // hasn't moved since the last poll — recompute only on change.
        const sheetId =
          (sheet as unknown as { getSheetId?: () => string }).getSheetId?.() ??
          "";
        const rangeKey = `${sheetId}:${range.getRow?.() ?? 0},${
          range.getColumn?.() ?? 0
        },${height},${width}`;
        if (rangeKey === lastSelectionRangeKeyRef.current) return;
        lastSelectionRangeKeyRef.current = rangeKey;
        if (height * width > MAX_SELECTION_CELLS) {
          setSelectionStats(null);
          return;
        }
        const values = range.getValues?.();
        const stats = computeSelectionStats(values);
        // Excel hides the summary when the selection has no countable data.
        setSelectionStats(stats.count > 0 ? stats : null);
      } catch {
        lastSelectionRangeKeyRef.current = null;
        setSelectionStats(null);
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, []);

  // #177: announce the active cell / range to screen readers (NVDA / JAWS /
  // Narrator) whenever the selection moves. Polls the active range — same
  // mechanism as the #192 status-bar summary above — because Univer 0.5.x's
  // selection observable isn't stable across patches. Announcing only on a
  // *change* of range key avoids spamming the live region every tick.
  const lastAnnouncedRangeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const workbook = fUniverRef.current?.getActiveWorkbook();
      if (!workbook) return;
      try {
        const sheet = workbook.getActiveSheet();
        const r = sheet?.getSelection()?.getActiveRange();
        if (!r) return;
        const range = r as unknown as {
          getHeight?: () => number;
          getWidth?: () => number;
          getRow?: () => number;
          getColumn?: () => number;
          getValue?: () => unknown;
        };
        const row = range.getRow?.() ?? 0;
        const col = range.getColumn?.() ?? 0;
        const height = range.getHeight?.() ?? 1;
        const width = range.getWidth?.() ?? 1;
        const sheetId =
          (sheet as unknown as { getSheetId?: () => string }).getSheetId?.() ??
          "";
        const rangeKey = `${sheetId}:${row},${col},${height},${width}`;
        if (rangeKey === lastAnnouncedRangeKeyRef.current) return;
        // Skip the very first poll: announcing the cell the editor simply
        // opened on would be noise. Establish the baseline silently.
        const isFirst = lastAnnouncedRangeKeyRef.current === null;
        lastAnnouncedRangeKeyRef.current = rangeKey;
        if (isFirst) return;
        if (height <= 1 && width <= 1) {
          announce(buildCellAnnouncement(row, col, range.getValue?.()));
        } else {
          announce(
            buildRangeAnnouncement(
              row,
              col,
              row + height - 1,
              col + width - 1,
            ),
          );
        }
      } catch {
        // Univer's selection API can throw mid-teardown — ignore.
      }
    };
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, []);

  // #177: announce save-status changes (saving / saved / failed) to screen
  // readers. The sighted status bar already shows these; this mirrors them
  // into the live region so assistive-tech users get the same feedback.
  const lastAnnouncedSaveStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastAnnouncedSaveStatusRef.current;
    lastAnnouncedSaveStatusRef.current = saveStatus;
    // Skip the initial render — only announce genuine transitions.
    if (prev === null || prev === saveStatus) return;
    if (saveStatus === "saved") {
      announce(t("a11y.status.saved"));
    } else if (saveStatus === "saving") {
      announce(t("a11y.status.saving"));
    } else if (saveStatus === "save_failed") {
      announceError(t("a11y.status.saveFailed"));
    }
  }, [saveStatus]);

  // #177: route editor operation errors / status messages through the
  // assertive live region so screen readers speak them immediately.
  useEffect(() => {
    if (editorOperationError) {
      announceError(editorOperationError);
    }
  }, [editorOperationError]);

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

  // --- Analysis ToolPak ------------------------------------------------------
  const openAnalysisToolpakDialog = useCallback(() => {
    const ready = getReadyWorkbook("分析ツールパック");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
    if (!sheet) return;
    let initialRange = "A2:A10";
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) initialRange = r.getA1Notation();
    } catch {
      // best-effort
    }
    setAnalysisToolpakDialog({ initialRange });
  }, [getReadyWorkbook]);

  const applyAnalysisToolpak = useCallback(
    (p: AnalysisApplyParams) => {
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      const snap = JSON.parse(JSON.stringify(wb.save())) as {
        sheets?: Record<string, {
          id?: string;
          name?: string;
          cellData?: Record<string, Record<string, unknown>>;
        }>;
        sheetOrder?: string[];
      };
      const sheetId = wb.getActiveSheet()?.getSheetId();
      const sourceSheet = sheetId ? snap.sheets?.[sheetId] : undefined;
      if (!snap.sheets || !sourceSheet) {
        setEditorOperationError("分析ツールパック: アクティブシートが取得できません。");
        return;
      }

      // Local A1 parser — single cell or rectangle, optional sheet qualifier
      // (the qualifier is ignored; we always read from the active sheet).
      const parseRange = (a1: string): { r1: number; c1: number; r2: number; c2: number } | null => {
        const trimmed = a1.replace(/^[^!]+!/, "").trim();
        const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(trimmed);
        if (!m) return null;
        const colToIdx = (s: string) => {
          let n = 0;
          for (const c of s.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
          return n - 1;
        };
        const c1 = colToIdx(m[1]);
        const r1 = parseInt(m[2], 10) - 1;
        const c2 = m[3] ? colToIdx(m[3]) : c1;
        const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
        return {
          r1: Math.min(r1, r2),
          r2: Math.max(r1, r2),
          c1: Math.min(c1, c2),
          c2: Math.max(c1, c2),
        };
      };

      const readNums = (a1: string): number[] => {
        const pr = parseRange(a1);
        if (!pr) return [];
        const out: number[] = [];
        for (let r = pr.r1; r <= pr.r2; r++) {
          for (let c = pr.c1; c <= pr.c2; c++) {
            const cell = (sourceSheet.cellData?.[String(r)] as
              | Record<string, { v?: unknown }>
              | undefined)?.[String(c)];
            const v = cell?.v;
            if (typeof v === "number" && Number.isFinite(v)) {
              out.push(v);
            } else if (typeof v === "string" && v.trim() !== "") {
              const n = Number(v);
              if (Number.isFinite(n)) out.push(n);
            }
            // blanks / non-numeric are skipped (analysis helpers tolerate
            // gaps; for regression they're filtered pair-wise downstream).
          }
        }
        return out;
      };

      // Read a range as a single flat column, preserving position: blank /
      // non-numeric cells become NaN instead of being skipped. Used by the
      // correlation matrix so every variable column has the same length and
      // listwise deletion can drop incomplete rows consistently.
      const readColumn = (a1: string): number[] => {
        const pr = parseRange(a1);
        if (!pr) return [];
        const out: number[] = [];
        for (let r = pr.r1; r <= pr.r2; r++) {
          for (let c = pr.c1; c <= pr.c2; c++) {
            const cell = (sourceSheet.cellData?.[String(r)] as
              | Record<string, { v?: unknown }>
              | undefined)?.[String(c)];
            const v = cell?.v;
            if (typeof v === "number" && Number.isFinite(v)) {
              out.push(v);
            } else if (typeof v === "string" && v.trim() !== "") {
              const num = Number(v);
              out.push(Number.isFinite(num) ? num : Number.NaN);
            } else {
              out.push(Number.NaN);
            }
          }
        }
        return out;
      };

      // Read a rectangular block as a row-major 2D number grid. Blank /
      // non-numeric cells become NaN so the analysis helpers can decide how
      // to treat them (most reject NaN in grid inputs).
      const readGrid = (a1: string): number[][] => {
        const pr = parseRange(a1);
        if (!pr) return [];
        const grid: number[][] = [];
        for (let r = pr.r1; r <= pr.r2; r++) {
          const row: number[] = [];
          for (let c = pr.c1; c <= pr.c2; c++) {
            const cell = (sourceSheet.cellData?.[String(r)] as
              | Record<string, { v?: unknown }>
              | undefined)?.[String(c)];
            const v = cell?.v;
            if (typeof v === "number" && Number.isFinite(v)) {
              row.push(v);
            } else if (typeof v === "string" && v.trim() !== "") {
              const num = Number(v);
              row.push(Number.isFinite(num) ? num : Number.NaN);
            } else {
              row.push(Number.NaN);
            }
          }
          grid.push(row);
        }
        return grid;
      };

      // Allocate a fresh sheet id + name without collisions.
      const sheets = snap.sheets;
      const order = Array.isArray(snap.sheetOrder) ? snap.sheetOrder : [];
      snap.sheetOrder = order;
      const existingIds = new Set(Object.keys(sheets));
      for (const id of order) existingIds.add(id);
      let n = 1;
      let newSheetId = `sheet-analysis-${n}`;
      while (existingIds.has(newSheetId)) {
        n += 1;
        newSheetId = `sheet-analysis-${n}`;
      }
      const existingNames = new Set<string>();
      for (const s of Object.values(sheets)) {
        if (s && typeof s.name === "string") existingNames.add(s.name);
      }
      const baseNameByKind: Record<AnalysisApplyParams["kind"], string> = {
        regression: "分析-回帰",
        anova: "分析-ANOVA",
        histogram: "分析-ヒストグラム",
        anova2: "分析-二元ANOVA",
        ttest: "分析-t検定",
        chisquare: "分析-カイ二乗",
        correlation: "分析-相関",
        random: "分析-乱数",
        movingAverage: "分析-移動平均",
        fourier: "分析-フーリエ",
      };
      const baseName = baseNameByKind[p.kind] ?? "分析";
      let finalName = baseName;
      let nameN = 2;
      while (existingNames.has(finalName)) {
        finalName = `${baseName} (${nameN})`;
        nameN += 1;
      }

      // Build the result table as a row-major 2D array of cell values.
      const rows: Array<Array<string | number>> = [];
      const fmt = (n: number) => (Number.isFinite(n) ? n : "—");

      if (p.kind === "regression") {
        const xs = readNums(p.primaryRange);
        const ys = p.secondaryRange ? readNums(p.secondaryRange) : [];
        const res = runLinearRegression(xs, ys);
        rows.push(["線形回帰分析"]);
        rows.push(["X 範囲", p.primaryRange]);
        rows.push(["Y 範囲", p.secondaryRange ?? ""]);
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["観測数 n", res.n]);
          rows.push(["切片 (b)", fmt(res.intercept)]);
          rows.push(["傾き (a)", fmt(res.slope)]);
          rows.push(["R²", fmt(res.r2)]);
          rows.push(["自由度調整 R²", fmt(res.adjustedR2)]);
          rows.push(["残差標準誤差", fmt(res.residualSE)]);
          rows.push(["傾きの標準誤差", fmt(res.seSlope)]);
          rows.push(["切片の標準誤差", fmt(res.seIntercept)]);
          rows.push(["F 統計", fmt(res.f)]);
          rows.push(["p 値", fmt(res.pValue)]);
          rows.push([]);
          rows.push(["分散分析表"]);
          rows.push(["要因", "df", "SS", "MS"]);
          rows.push(["回帰", 1, fmt(res.ssr), fmt(res.ssr / 1)]);
          rows.push([
            "残差",
            res.n - 2,
            fmt(res.sse),
            fmt(res.sse / Math.max(1, res.n - 2)),
          ]);
          rows.push(["合計", res.n - 1, fmt(res.sst), ""]);
          rows.push([]);
          rows.push(["残差テーブル"]);
          rows.push(["i", "ŷ", "残差"]);
          for (let i = 0; i < res.fitted.length; i++) {
            rows.push([i + 1, fmt(res.fitted[i]), fmt(res.residuals[i])]);
          }
        }
      } else if (p.kind === "anova") {
        const groups = (p.groupRanges ?? []).map((r) => readNums(r));
        const res = runOneWayANOVA(groups);
        rows.push(["一元配置 分散分析 (ANOVA)"]);
        (p.groupRanges ?? []).forEach((r, i) => {
          rows.push([`群 ${i + 1} の範囲`, r]);
        });
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["群ごとの要約"]);
          rows.push(["群", "n", "平均", "分散"]);
          res.groups.forEach((g, i) => {
            rows.push([`群 ${i + 1}`, g.n, fmt(g.mean), fmt(g.variance)]);
          });
          rows.push([]);
          rows.push(["分散分析表"]);
          rows.push(["要因", "df", "SS", "MS", "F", "p 値"]);
          rows.push([
            "群間",
            res.dfBetween,
            fmt(res.ssBetween),
            fmt(res.msBetween),
            fmt(res.f),
            fmt(res.pValue),
          ]);
          rows.push([
            "群内",
            res.dfWithin,
            fmt(res.ssWithin),
            fmt(res.msWithin),
            "",
            "",
          ]);
          rows.push(["合計", res.dfTotal, fmt(res.ssTotal), "", "", ""]);
        }
      } else if (p.kind === "histogram") {
        const data = readNums(p.primaryRange);
        const res = buildHistogram(data, p.binEdges ?? []);
        rows.push(["ヒストグラム"]);
        rows.push(["データ範囲", p.primaryRange]);
        rows.push([
          "ビン境界",
          (p.binEdges ?? []).length > 0 ? (p.binEdges ?? []).join(", ") : "自動 (Sturges)",
        ]);
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["範囲", "下限", "上限", "頻度"]);
          res.bins.forEach((b) => {
            rows.push([b.label, fmt(b.binStart), fmt(b.binEnd), b.frequency]);
          });
          if (res.underflow > 0) rows.push(["下方外れ", "", "", res.underflow]);
          if (res.overflow > 0) rows.push(["上方外れ", "", "", res.overflow]);
        }
      } else if (p.kind === "anova2") {
        // Two-way ANOVA. The block range is a (levelsA·replicates) × levelsB
        // grid laid out row-major: factor-A levels stacked, replicates within.
        const grid = readGrid(p.primaryRange);
        const a = Math.max(0, Math.floor(p.levelsA ?? 0));
        const b = Math.max(0, Math.floor(p.levelsB ?? 0));
        const r = Math.max(0, Math.floor(p.replicates ?? 0));
        rows.push(["二元配置 分散分析 (ANOVA)"]);
        rows.push(["データ範囲", p.primaryRange]);
        rows.push(["因子 A 水準数", a]);
        rows.push(["因子 B 水準数", b]);
        rows.push(["セルあたり繰り返し数", r]);
        rows.push([]);
        const expectedRows = a * r;
        if (
          a < 2 ||
          b < 2 ||
          r < 1 ||
          grid.length !== expectedRows ||
          grid.some((row) => row.length !== b)
        ) {
          rows.push([
            "エラー",
            `データブロックは ${expectedRows} 行 × ${b} 列である必要があります (現在 ${grid.length} 行)`,
          ]);
        } else {
          // Re-shape the flat grid into cells[a][b][r].
          const cells: number[][][] = [];
          for (let i = 0; i < a; i++) {
            const rowCells: number[][] = [];
            for (let j = 0; j < b; j++) {
              const reps: number[] = [];
              for (let k = 0; k < r; k++) {
                reps.push(grid[i * r + k][j]);
              }
              rowCells.push(reps);
            }
            cells.push(rowCells);
          }
          const res = runTwoWayANOVA(cells);
          if (res.error) {
            rows.push(["エラー", res.error]);
          } else {
            rows.push(["総平均", fmt(res.grandMean)]);
            rows.push(["総観測数", res.totalN]);
            rows.push([]);
            rows.push(["分散分析表"]);
            rows.push(["要因", "df", "SS", "MS", "F", "p 値"]);
            const labelOf = (s: string) =>
              s === "factorA"
                ? "因子 A"
                : s === "factorB"
                  ? "因子 B"
                  : s === "interaction"
                    ? "交互作用 (A×B)"
                    : s === "error"
                      ? "誤差"
                      : "合計";
            res.terms.forEach((t) => {
              rows.push([
                labelOf(t.source),
                t.df,
                fmt(t.ss),
                Number.isFinite(t.ms) ? fmt(t.ms) : "",
                t.f !== undefined ? fmt(t.f) : "",
                t.pValue !== undefined ? fmt(t.pValue) : "",
              ]);
            });
          }
        }
      } else if (p.kind === "ttest") {
        const variant = p.tTestVariant ?? "twoSamplePooled";
        const s1 = readNums(p.primaryRange);
        const s2 = p.secondaryRange ? readNums(p.secondaryRange) : [];
        const res = runTTest(s1, s2, variant, p.hypothesizedMean ?? 0);
        const variantLabel =
          variant === "oneSample"
            ? "1 標本"
            : variant === "twoSamplePooled"
              ? "2 標本 (等分散プール)"
              : variant === "welch"
                ? "2 標本 (Welch)"
                : "対応あり";
        rows.push(["t 検定"]);
        rows.push(["検定タイプ", variantLabel]);
        rows.push(["標本 1 の範囲", p.primaryRange]);
        if (variant !== "oneSample") {
          rows.push(["標本 2 の範囲", p.secondaryRange ?? ""]);
        }
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["", "標本 1", variant === "oneSample" ? "" : "標本 2"]);
          rows.push([
            "平均",
            fmt(res.mean1),
            variant === "oneSample" ? "" : fmt(res.mean2),
          ]);
          rows.push([
            "観測数 n",
            res.n1,
            variant === "oneSample" ? "" : res.n2,
          ]);
          rows.push([]);
          rows.push([
            variant === "oneSample" ? "仮説平均 (μ₀)" : "仮説平均差",
            fmt(res.hypothesizedMean),
          ]);
          rows.push(["平均差", fmt(res.meanDiff)]);
          rows.push(["標準誤差", fmt(res.standardError)]);
          rows.push(["t 統計", fmt(res.t)]);
          rows.push(["自由度", fmt(res.df)]);
          rows.push(["p 値 (両側)", fmt(res.pValueTwoSided)]);
          rows.push(["p 値 (片側)", fmt(res.pValueOneSided)]);
        }
      } else if (p.kind === "chisquare") {
        const variant = p.chiSquareVariant ?? "goodnessOfFit";
        if (variant === "goodnessOfFit") {
          const observed = readNums(p.primaryRange);
          const expected = p.expectedRange
            ? readNums(p.expectedRange)
            : undefined;
          const res = runChiSquareGoodnessOfFit(observed, expected);
          rows.push(["カイ二乗 適合度検定"]);
          rows.push(["観測度数の範囲", p.primaryRange]);
          rows.push([
            "期待度数の範囲",
            p.expectedRange ?? "一様分布 (自動)",
          ]);
          rows.push([]);
          if (res.error) {
            rows.push(["エラー", res.error]);
          } else {
            rows.push(["χ² 統計", fmt(res.chiSquare)]);
            rows.push(["自由度", res.df]);
            rows.push(["p 値", fmt(res.pValue)]);
            rows.push([]);
            rows.push(["カテゴリ", "観測度数", "期待度数"]);
            res.colTotals.forEach((obs, i) => {
              rows.push([
                `カテゴリ ${i + 1}`,
                fmt(obs),
                fmt(res.expected[0]?.[i] ?? Number.NaN),
              ]);
            });
          }
        } else {
          const table = readGrid(p.primaryRange);
          const res = runChiSquareIndependence(table);
          rows.push(["カイ二乗 独立性検定"]);
          rows.push(["分割表の範囲", p.primaryRange]);
          rows.push([]);
          if (res.error) {
            rows.push(["エラー", res.error]);
          } else {
            rows.push(["χ² 統計", fmt(res.chiSquare)]);
            rows.push(["自由度", res.df]);
            rows.push(["p 値", fmt(res.pValue)]);
            rows.push(["総度数", res.total]);
            rows.push([]);
            rows.push(["期待度数表"]);
            const header: Array<string | number> = [""];
            for (let j = 0; j < res.colTotals.length; j++) {
              header.push(`列 ${j + 1}`);
            }
            rows.push(header);
            res.expected.forEach((expRow, i) => {
              rows.push([`行 ${i + 1}`, ...expRow.map((e) => fmt(e))]);
            });
          }
        }
      } else if (p.kind === "correlation") {
        const ranges = p.variableRanges ?? [];
        // Keep blank/non-numeric cells as NaN (not skipped) so each variable
        // column stays the same length; runCorrelationMatrix then drops
        // incomplete rows via listwise deletion.
        const columns = ranges.map((rng) => readColumn(rng));
        const labels = ranges.map((rng, i) => `変数 ${i + 1} (${rng})`);
        const res = runCorrelationMatrix(columns, labels);
        rows.push(["相関行列"]);
        ranges.forEach((rng, i) => {
          rows.push([`変数 ${i + 1} の範囲`, rng]);
        });
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["完全ケース数 n", res.n]);
          rows.push([]);
          rows.push(["相関係数行列 (Pearson)"]);
          rows.push(["", ...res.labels]);
          res.correlation.forEach((corrRow, i) => {
            rows.push([res.labels[i], ...corrRow.map((v) => fmt(v))]);
          });
          rows.push([]);
          rows.push(["共分散行列 (標本, n-1)"]);
          rows.push(["", ...res.labels]);
          res.covariance.forEach((covRow, i) => {
            rows.push([res.labels[i], ...covRow.map((v) => fmt(v))]);
          });
        }
      } else if (p.kind === "random") {
        const res = generateRandomNumbers({
          distribution: p.randomDistribution ?? "normal",
          count: p.randomCount ?? 0,
          seed: p.randomSeed,
          min: p.randomMin,
          max: p.randomMax,
          mean: p.randomMean,
          stdDev: p.randomStdDev,
          probability: p.randomProbability,
          lambda: p.randomLambda,
        });
        const distLabel =
          res.distribution === "uniform"
            ? "一様分布"
            : res.distribution === "normal"
              ? "正規分布"
              : res.distribution === "bernoulli"
                ? "ベルヌーイ分布"
                : "ポアソン分布";
        rows.push(["乱数生成"]);
        rows.push(["分布", distLabel]);
        rows.push([
          "シード",
          p.randomSeed !== undefined ? p.randomSeed : "ランダム",
        ]);
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["i", "値"]);
          res.values.forEach((v, i) => {
            rows.push([i + 1, fmt(v)]);
          });
        }
      } else if (p.kind === "movingAverage") {
        const variant = p.movingAverageVariant ?? "simple";
        const data = readNums(p.primaryRange);
        const res =
          variant === "simple"
            ? runSimpleMovingAverage(data, p.movingWindow ?? 0)
            : runExponentialMovingAverage(data, p.movingAlpha ?? 0);
        rows.push([
          variant === "simple" ? "単純移動平均" : "指数移動平均",
        ]);
        rows.push(["データ範囲", p.primaryRange]);
        if (variant === "simple") {
          rows.push(["窓幅", p.movingWindow ?? ""]);
        } else {
          rows.push(["平滑化係数 α", p.movingAlpha ?? ""]);
        }
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push(["i", "元データ", "移動平均"]);
          res.values.forEach((v, i) => {
            rows.push([
              i + 1,
              fmt(data[i]),
              Number.isFinite(v) ? fmt(v) : "—",
            ]);
          });
        }
      } else {
        // fourier
        const signal = readNums(p.primaryRange);
        const res = runFourierTransform(signal);
        rows.push(["フーリエ変換 (FFT)"]);
        rows.push(["信号データ範囲", p.primaryRange]);
        rows.push([]);
        if (res.error) {
          rows.push(["エラー", res.error]);
        } else {
          rows.push([
            "アルゴリズム",
            res.method === "radix2"
              ? "Cooley-Tukey (基数2)"
              : "Bluestein (任意長)",
          ]);
          rows.push(["サンプル数 n", res.n]);
          rows.push([]);
          rows.push(["k", "実部", "虚部", "振幅", "位相 (rad)"]);
          for (let k = 0; k < res.n; k++) {
            rows.push([
              k,
              fmt(res.real[k]),
              fmt(res.imag[k]),
              fmt(res.amplitude[k]),
              fmt(res.phase[k]),
            ]);
          }
        }
      }

      // Materialise the rows into a fresh sheet fragment. We mirror the
      // shape Univer expects (cellData[row][col] = { v }) and include
      // rowCount/columnCount for a snug viewport.
      const cellData: Record<string, Record<string, { v: unknown }>> = {};
      let maxCols = 0;
      rows.forEach((row, r) => {
        if (row.length === 0) return;
        if (row.length > maxCols) maxCols = row.length;
        const rowObj: Record<string, { v: unknown }> = {};
        row.forEach((cell, c) => {
          rowObj[String(c)] = { v: cell };
        });
        cellData[String(r)] = rowObj;
      });
      sheets[newSheetId] = {
        id: newSheetId,
        name: finalName,
        cellData,
      };
      order.push(newSheetId);
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
      // #106: deep-clone the live snapshot so we don't mutate the
      // Univer-internal save() reference (could race with React renders).
      const snap = JSON.parse(JSON.stringify(wb.save())) as Record<string, unknown>;
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

  // --- Spell Check -----------------------------------------------------------
  const openSpellCheckDialog = useCallback(() => {
    if (!currentSnapshotJson) return;
    try {
      const snap = JSON.parse(currentSnapshotJson);
      const userDict = loadUserDictionary();
      setSpellCheckIssues(collectSpellIssues(snap, userDict));
      setSpellCheckOpen(true);
    } catch {
      setSpellCheckIssues([]);
      setSpellCheckOpen(true);
    }
  }, [currentSnapshotJson]);

  const applySpellCheckReplacement = useCallback(
    (issue: SpellIssue, replacement: string) => {
      if (!currentSnapshotJson) return;
      try {
        const snap = JSON.parse(currentSnapshotJson);
        // Resolve cellRef to row/col indices
        const m = /^([A-Z]+)(\d+)$/.exec(issue.cellRef);
        if (!m) return;
        let col = 0;
        for (const c of m[1]) col = col * 26 + (c.charCodeAt(0) - 64);
        col -= 1;
        const row = parseInt(m[2], 10) - 1;
        const sheet = snap?.sheets?.[issue.sheetId];
        const cell = sheet?.cellData?.[String(row)]?.[String(col)];
        if (cell && typeof cell.v === "string") {
          cell.v =
            cell.v.slice(0, issue.offset) +
            replacement +
            cell.v.slice(issue.offset + issue.word.length);
          applyMutatedSnapshot(JSON.stringify(snap));
          setSpellCheckIssues(collectSpellIssues(snap, loadUserDictionary()));
        }
      } catch {
        // best-effort
      }
    },
    [currentSnapshotJson, applyMutatedSnapshot],
  );

  // --- Data Form -------------------------------------------------------------
  const openDataFormDialog = useCallback(() => {
    const ready = getReadyWorkbook("データフォーム");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let rangeA1 = "A1:A1";
    let rect: DataFormRange = { r1: 0, c1: 0, r2: 0, c2: 0 };
    try {
      const sel = sheet.getSelection();
      const r = sel?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        rangeA1 = a1.includes(":") ? a1 : `${a1}:${a1}`;
        const height = (r as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
        const width = (r as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
        rect = {
          r1: r.getRow(),
          c1: r.getColumn(),
          r2: r.getRow() + height - 1,
          c2: r.getColumn() + width - 1,
        };
      }
    } catch {
      // best-effort
    }
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: SnapshotCellData }>;
    };
    const cellData = snap.sheets?.[sheetId]?.cellData;
    const headers = getColumnHeaders(cellData, rect, true);
    const rows: DataFormRow[] = [];
    for (let i = 0; i < getDataRowCount(rect, true); i++) {
      rows.push(readRow(cellData, rect, i, true));
    }
    setDataFormDialog({ sheetId, range: rect, rangeLabel: rangeA1, hasHeader: true, headers, rows });
  }, [getReadyWorkbook]);

  // --- Find & Replace All ----------------------------------------------------
  // #106: do NOT capture the snapshot at open time — the dialog stays open
  // arbitrarily and the user can keep editing. We only pin the activeSheetId.
  // The snapshot is passed as a prop on every render so the dialog always
  // searches/replaces against fresh state.
  const openFindReplaceAllDialog = useCallback(() => {
    const ready = getReadyWorkbook("検索と置換");
    if (!ready) return;
    const activeSheetId = ready.workbook.getActiveSheet()?.getSheetId() ?? null;
    setFindReplaceAllDialog({ activeSheetId });
  }, [getReadyWorkbook]);

  // --- Comments Manager ------------------------------------------------------
  const resolveCommentInline = useCallback(
    (sheetId: string, cellRef: string, resolved: boolean) => {
      if (!currentSnapshotJson) return;
      try {
        const next = setCmResolved(currentSnapshotJson, sheetId, cellRef, resolved);
        applyMutatedSnapshot(JSON.stringify(next));
      } catch {
        // best-effort
      }
    },
    [currentSnapshotJson, applyMutatedSnapshot],
  );

  const deleteCommentInline = useCallback(
    (sheetId: string, cellRef: string) => {
      if (!currentSnapshotJson) return;
      try {
        const next = deleteCmInline(currentSnapshotJson, sheetId, cellRef);
        applyMutatedSnapshot(JSON.stringify(next));
      } catch {
        // best-effort
      }
    },
    [currentSnapshotJson, applyMutatedSnapshot],
  );

  const bulkDeleteResolvedAction = useCallback(() => {
    if (!currentSnapshotJson) return;
    try {
      const { snapshotMutated } = bulkDeleteResolvedComments(currentSnapshotJson);
      applyMutatedSnapshot(JSON.stringify(snapshotMutated));
    } catch {
      // best-effort
    }
  }, [currentSnapshotJson, applyMutatedSnapshot]);

  // --- Smart Date ------------------------------------------------------------
  // Helper: parse "A1:B5" to a rect (returns null on bad input). Local-only.
  const parseRectFromA1 = (a1: string): { r1: number; c1: number; r2: number; c2: number } | null => {
    const m = /^(?:[^!]+!)?\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(a1.trim());
    if (!m) return null;
    const colToIdx = (s: string): number => {
      let n = 0;
      for (const c of s.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
      return n - 1;
    };
    const c1 = colToIdx(m[1]);
    const r1 = parseInt(m[2], 10) - 1;
    if (m[3] === undefined) return { r1, c1, r2: r1, c2: c1 };
    const c2 = colToIdx(m[3]);
    const r2 = parseInt(m[4], 10) - 1;
    return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  };

  const buildSmartDatePreview = useCallback(
    (sheetId: string, rect: { r1: number; c1: number; r2: number; c2: number }, locale: SmartDateLocale, _outputFormat: string) => {
      const out: Array<{ original: string; converted: string }> = [];
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return out;
      const snap = wb.save() as unknown as {
        sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: unknown }>> }>;
      };
      const cellData = snap.sheets?.[sheetId]?.cellData ?? {};
      for (let r = rect.r1; r <= rect.r2 && out.length < 5; r++) {
        for (let c = rect.c1; c <= rect.c2 && out.length < 5; c++) {
          const cell = cellData[String(r)]?.[String(c)];
          if (!cell || cell.f) continue;
          if (typeof cell.v !== "string") continue;
          const parsed = tryParseDate(cell.v, locale);
          if (!parsed) {
            out.push({ original: cell.v, converted: "(変換不可)" });
          } else {
            out.push({ original: cell.v, converted: parsed.toISOString().slice(0, 10) });
          }
        }
      }
      return out;
    },
    [],
  );

  const openSmartDateDialog = useCallback(() => {
    const ready = getReadyWorkbook("日付に変換");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1:A1";
    let rangeRect = { r1: 0, c1: 0, r2: 0, c2: 0 };
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        range = a1.includes(":") ? a1 : `${a1}:${a1}`;
        const parsed = parseRectFromA1(range);
        if (parsed) rangeRect = parsed;
      }
    } catch {
      // best-effort
    }
    setSmartDatePreview(buildSmartDatePreview(sheetId, rangeRect, "ja", DEFAULT_SMART_DATE_FORMAT));
    setSmartDateDialog({ sheetId, range, rangeRect });
  }, [getReadyWorkbook, buildSmartDatePreview]);

  const applySmartDate = useCallback(
    (params: ConvertToDateParams) => {
      if (!smartDateDialog) return;
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      const snap = wb.save();
      const { snapshotMutated, convertedCount } = applyConvertToDate(snap, smartDateDialog.sheetId, params);
      if (convertedCount === 0) {
        setEditorOperationError("日付に変換: 対象の日付文字列が見つかりませんでした。");
        return;
      }
      applyMutatedSnapshot(JSON.stringify(snapshotMutated));
    },
    [smartDateDialog, applyMutatedSnapshot],
  );
  // Suppress unused-warning for helper re-export.
  void excelSerialToDate;

  // --- Convert Table to Range ------------------------------------------------
  const openConvertToRangeDialog = useCallback(() => {
    if (!currentSnapshotJson) return;
    try {
      const parsed = JSON.parse(currentSnapshotJson) as WorkbookTableSnapshot;
      const listings = listAllTablesAcrossSheets(parsed);
      const tables: ConvertToRangeTableSummary[] = listings.map((l) => ({
        name: l.table.name,
        sheetId: l.sheetId,
        sheetName: l.sheetName,
        rangeLabel: rangeToA1Helper(l.table.range),
        columnCount: l.table.columns.length,
      }));
      setConvertToRangeDialog({ tables });
    } catch {
      setConvertToRangeDialog({ tables: [] });
    }
  }, [currentSnapshotJson]);

  // --- Document Inspector ----------------------------------------------------
  const openDocumentInspector = useCallback(() => {
    if (!currentSnapshotJson) return;
    setDocumentInspections(inspectDocument(currentSnapshotJson));
    setDocumentInspectorOpen(true);
  }, [currentSnapshotJson]);

  // --- Bulk Data Clean -------------------------------------------------------
  const openBulkCleanDialog = useCallback(() => {
    const ready = getReadyWorkbook("データクリーニング");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    const snap = workbook.save() as unknown as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: unknown }>> }>;
    };
    let range = "A1";
    const preview: Array<{ original: string }> = [];
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        range = a1.includes(":") ? a1 : `${a1}:${a1}`;
      }
      const parsed = parseRectFromA1(range);
      if (parsed) {
        const cellData = snap.sheets?.[sheetId]?.cellData ?? {};
        outer: for (let rr = parsed.r1; rr <= parsed.r2; rr++) {
          for (let cc = parsed.c1; cc <= parsed.c2; cc++) {
            const cell = cellData[String(rr)]?.[String(cc)];
            if (cell && typeof cell.v === "string" && (cell.f === undefined || cell.f === null || cell.f === "")) {
              preview.push({ original: cell.v });
              if (preview.length >= 3) break outer;
            }
          }
        }
      }
    } catch {
      // best-effort
    }
    setBulkCleanDialog({ sheetId, range, preview });
  }, [getReadyWorkbook]);

  const applyBulkCleanAction = useCallback(
    (params: BulkCleanParams) => {
      if (!bulkCleanDialog) return;
      const wb = fUniverRef.current?.getActiveWorkbook();
      if (!wb) return;
      const fresh = JSON.stringify(wb.save());
      const { snapshotMutated, cellsTouched } = applyBulkClean(fresh, bulkCleanDialog.sheetId, params);
      applyMutatedSnapshot(JSON.stringify(snapshotMutated));
      setEditorOperationError(`データクリーニング: ${cellsTouched} セルを更新しました。`);
    },
    [bulkCleanDialog, applyMutatedSnapshot],
  );

  // --- CSV Import Wizard -----------------------------------------------------
  const openCsvImportWizard = useCallback(() => {
    void (async () => {
      try {
        const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
        const selected = await openFileDialog({
          multiple: false,
          filters: [{ name: "CSV / TSV", extensions: ["csv", "tsv"] }],
        });
        if (!selected) return;
        const path = typeof selected === "string" ? selected : selected[0];
        // Read first 5KB via existing read_file_bytes_base64 backend command
        // (limited to ~32 MiB; CSV preview is well under that).
        const b64 = await invoke<string>("read_file_bytes_base64", { path });
        const raw = atob(b64);
        const bytes = new Uint8Array(Math.min(raw.length, 5 * 1024));
        for (let i = 0; i < bytes.length; i++) bytes[i] = raw.charCodeAt(i);
        setCsvWizard({ filePath: path, previewBytes: bytes });
      } catch (e) {
        setEditorOperationError(`CSV インポートウィザード: ${(e as Error).message}`);
      }
    })();
  }, []);

  // --- Wave 9: Sheet Import / Bookmarks / NumberFormatManager / RangeCompare / Go To ---
  const applySheetImport = useCallback(
    async (filePath: string, sheetNames: string[]) => {
      try {
        // #106: extract all fragments first (async work). Don't bind to a
        // snapshot until the final write, so concurrent user edits during the
        // multi-second extract pass survive instead of being silently erased.
        const fragments: unknown[] = [];
        for (const name of sheetNames) {
          const fragJson = await invoke<string>("workbook_extract_sheet_as_snapshot", {
            path: filePath,
            sheetName: name,
          });
          fragments.push(JSON.parse(fragJson));
        }
        // Re-read the live snapshot now — captures any edits made during the
        // extract awaits.
        const liveSnap = useWorkbookStore.getState().currentSnapshotJson;
        if (!liveSnap) return;
        const merged = JSON.parse(liveSnap);
        for (const frag of fragments) {
          // `frag` is the parsed JSON the Rust extractor produced — its shape
          // matches SheetFragment by construction; cast to satisfy strict TS.
          addImportedSheetToSnapshot(merged, frag as Parameters<typeof addImportedSheetToSnapshot>[1]);
        }
        applyMutatedSnapshot(JSON.stringify(merged));
      } catch (e) {
        setEditorOperationError(`シート取り込みに失敗しました: ${(e as Error).message}`);
      }
    },
    [applyMutatedSnapshot],
  );

  // --- #140 / #190: External data connections (Power Query) ---
  // Loads a source (CSV/JSON file, Web/REST endpoint or local SQLite DB) via
  // the backend, runs the connection's ETL step pipeline, and merges the
  // result into the snapshot under a sheet owned by the connection record.
  const loadDataConnectionFragment = useCallback(
    async (
      conn: Pick<DataConnection, "type" | "sourcePath" | "web" | "sqlite" | "targetSheetName">,
    ): Promise<DataConnSheetFragment> => {
      type RawResult = {
        sheetName: string;
        rowCount: number;
        columnCount: number;
        headers: string[];
        cellData: Record<string, Record<string, unknown>>;
        encoding: string;
      };
      let result: RawResult;
      if (conn.type === "web") {
        if (!conn.web) throw new Error("Web 接続の設定がありません");
        result = await invoke<RawResult>("data_connection_load_web", {
          url: conn.web.url,
          format: conn.web.format,
          headers:
            conn.web.headers && Object.keys(conn.web.headers).length > 0
              ? conn.web.headers
              : null,
          sheetName: conn.targetSheetName,
        });
      } else if (conn.type === "sqlite") {
        if (!conn.sqlite) throw new Error("SQLite 接続の設定がありません");
        result = await invoke<RawResult>("data_connection_load_sqlite", {
          dbPath: conn.sqlite.dbPath,
          query: conn.sqlite.query,
          sheetName: conn.targetSheetName,
        });
      } else {
        result = await invoke<RawResult>("data_connection_load", {
          sourcePath: conn.sourcePath,
          sourceType: conn.type,
        });
      }
      return {
        cellData: result.cellData,
        rowCount: result.rowCount,
        columnCount: result.columnCount,
        headers: result.headers,
      };
    },
    [],
  );

  const handleDataConnectionAdd = useCallback(
    async (input: AddConnectionInput) => {
      const connection: DataConnection = {
        id: makeConnectionId(),
        name: input.name,
        type: input.type,
        sourcePath: input.sourcePath,
        targetSheetId: null,
        targetSheetName: input.targetSheetName,
        lastRefreshedAt: null,
        steps: [],
      };
      if (input.type === "web") {
        connection.web = {
          url: input.webUrl ?? "",
          format: input.webFormat ?? "auto",
          headers: input.webHeaders ?? {},
        };
      } else if (input.type === "sqlite") {
        connection.sqlite = {
          dbPath: input.sourcePath,
          query: input.sqliteQuery ?? "",
        };
      }
      const rawFragment = await loadDataConnectionFragment(connection);
      const fragment = transformDataConnFragment(rawFragment, connection.steps);
      // Re-read the live snapshot AFTER the async load so concurrent edits
      // aren't lost.
      const liveSnap = useWorkbookStore.getState().currentSnapshotJson;
      if (!liveSnap) throw new Error("ワークブックがありません");
      const snapshot = JSON.parse(liveSnap) as Record<string, unknown>;
      const { sheetId } = applyDataConnFragment(snapshot, connection, fragment);
      connection.targetSheetId = sheetId;
      connection.lastRefreshedAt = Date.now();
      addConnectionToSnapshot(snapshot, connection);
      applyMutatedSnapshot(JSON.stringify(snapshot));
    },
    [applyMutatedSnapshot, loadDataConnectionFragment],
  );

  // #196 item 1: serialize data-connection refreshes. Concurrent refreshes
  // (two `onOpen` connections, or an interval tick overlapping a manual
  // refresh) each re-read the SAME live `currentSnapshotJson` before either's
  // `applyMutatedSnapshot` lands, so last-write-wins silently drops one
  // connection's update. Chain every refresh through this promise queue so the
  // read→apply→write critical section runs strictly one refresh at a time.
  const refreshQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const handleDataConnectionRefresh = useCallback(
    (connectionId: string) => {
      const doRefresh = async () => {
        const liveBefore = useWorkbookStore.getState().currentSnapshotJson;
        if (!liveBefore) throw new Error("ワークブックがありません");
        const snapBefore = JSON.parse(liveBefore) as Record<string, unknown>;
        const conn = listDataConnections(snapBefore).find((c) => c.id === connectionId);
        if (!conn) throw new Error("接続が見つかりません");
        const rawFragment = await loadDataConnectionFragment(conn);
        // Re-parse the live snapshot AFTER the async load.
        const liveAfter = useWorkbookStore.getState().currentSnapshotJson;
        if (!liveAfter) throw new Error("ワークブックがありません");
        const snapAfter = JSON.parse(liveAfter) as Record<string, unknown>;
        const liveConn = listDataConnections(snapAfter).find((c) => c.id === connectionId);
        if (!liveConn) throw new Error("接続が削除されています");
        const fragment = transformDataConnFragment(rawFragment, liveConn.steps);
        const { sheetId } = applyDataConnFragment(snapAfter, liveConn, fragment);
        updateConnectionInSnapshot(snapAfter, connectionId, {
          targetSheetId: sheetId,
          lastRefreshedAt: Date.now(),
        });
        applyMutatedSnapshot(JSON.stringify(snapAfter));
      };
      const run = refreshQueueRef.current.then(() => doRefresh());
      // Keep the chain alive on error so one failed refresh doesn't deadlock
      // the queue; callers still observe the real rejection via `run`.
      refreshQueueRef.current = run.catch(() => {});
      return run;
    },
    [applyMutatedSnapshot, loadDataConnectionFragment],
  );

  const handleDataConnectionEdit = useCallback(
    async (
      connectionId: string,
      patch: {
        name: string;
        targetSheetName: string;
        steps: EtlStep[];
        scheduleOnOpen: boolean;
        scheduleIntervalMinutes: number;
      },
    ) => {
      const live = useWorkbookStore.getState().currentSnapshotJson;
      if (!live) throw new Error("ワークブックがありません");
      const snap = JSON.parse(live) as Record<string, unknown>;
      // Rename the underlying sheet too so the new name is visible.
      const conn = listDataConnections(snap).find((c) => c.id === connectionId);
      if (conn && conn.targetSheetId) {
        const sheets = (snap.sheets ?? {}) as Record<string, { name?: string } | undefined>;
        const sheet = sheets[conn.targetSheetId];
        if (sheet && typeof sheet === "object") {
          sheet.name = patch.targetSheetName;
        }
      }
      updateConnectionInSnapshot(snap, connectionId, {
        name: patch.name,
        targetSheetName: patch.targetSheetName,
        steps: patch.steps,
        schedule: {
          onOpen: patch.scheduleOnOpen,
          intervalMinutes: patch.scheduleIntervalMinutes,
        },
      });
      applyMutatedSnapshot(JSON.stringify(snap));
    },
    [applyMutatedSnapshot],
  );

  const handleDataConnectionRemove = useCallback(
    async (connectionId: string) => {
      const live = useWorkbookStore.getState().currentSnapshotJson;
      if (!live) throw new Error("ワークブックがありません");
      const snap = JSON.parse(live) as Record<string, unknown>;
      removeConnectionFromSnapshot(snap, connectionId);
      applyMutatedSnapshot(JSON.stringify(snap));
    },
    [applyMutatedSnapshot],
  );

  // #190 Phase 5: scheduled refresh. Fires connections marked `onOpen` once
  // when the workbook handle changes, and sets up per-connection interval
  // timers for connections with `intervalMinutes > 0`. The timers re-read the
  // live snapshot each tick, so edits to a connection's schedule take effect
  // on the next dialog save (which replaces the handle? no — we re-scan).
  const dataConnOnOpenFiredRef = useRef<string | null>(null);
  useEffect(() => {
    const handle = currentHandle;
    if (!handle) return;
    const handleKey = JSON.stringify(handle);
    const snapJson = useWorkbookStore.getState().currentSnapshotJson;
    if (!snapJson) return;
    let conns: DataConnection[];
    try {
      conns = listDataConnections(JSON.parse(snapJson) as Record<string, unknown>);
    } catch {
      return;
    }
    // Fire on-open refreshes exactly once per workbook handle.
    if (dataConnOnOpenFiredRef.current !== handleKey) {
      dataConnOnOpenFiredRef.current = handleKey;
      for (const c of conns) {
        if (c.schedule?.onOpen) {
          void handleDataConnectionRefresh(c.id).catch(() => {
            // Background refresh failures are non-fatal — surfaced in the
            // dialog when the user next opens it.
          });
        }
      }
    }
    // Interval timers: one per connection with intervalMinutes > 0.
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const c of conns) {
      const minutes = c.schedule?.intervalMinutes ?? 0;
      if (minutes > 0) {
        const id = c.id;
        timers.push(
          setInterval(
            () => {
              void handleDataConnectionRefresh(id).catch(() => {});
            },
            minutes * 60_000,
          ),
        );
      }
    }
    return () => {
      for (const t of timers) clearInterval(t);
    };
  }, [currentHandle, handleDataConnectionRefresh]);

  const addCurrentCellAsBookmark = useCallback(() => {
    const fUniver = fUniverRef.current;
    const workbook = fUniver?.getActiveWorkbook();
    const sheet = workbook?.getActiveSheet();
    const r = sheet?.getSelection()?.getActiveRange();
    if (!sheet || !r) return;
    const wbId = bookmarkWorkbookId;
    const current = loadBookmarks(wbId);
    const label = `Bookmark ${current.length + 1}`;
    const next = addBookmark(current, {
      label,
      sheetId: sheet.getSheetId(),
      cellRef: toA1Ref(r.getRow(), r.getColumn()),
    });
    saveBookmarks(wbId, next);
    setBookmarksPanelOpen(true);
  }, [currentHandle]);

  // Derive sheetNamesById for the Bookmarks panel
  const sheetNamesById = useMemo(() => {
    const m: Record<string, string> = {};
    if (!currentSnapshotJson) return m;
    try {
      const snap = JSON.parse(currentSnapshotJson) as { sheets?: Record<string, { name?: string }> };
      for (const [id, s] of Object.entries(snap.sheets ?? {})) {
        if (s?.name) m[id] = s.name;
      }
    } catch {
      // best-effort
    }
    return m;
  }, [currentSnapshotJson]);

  // NumberFormatManager
  const numberFormatEntries = useMemo<FormatCodeEntry[]>(
    () => listAllFormatCodes(currentSnapshotJson ?? ""),
    [currentSnapshotJson],
  );

  const activeSelectionA1 = useMemo(() => {
    try {
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      const sheet = wb?.getActiveSheet();
      const r = sheet?.getSelection()?.getActiveRange();
      return r ? r.getA1Notation() : "";
    } catch {
      return "";
    }
  }, []);

  const replaceWorkbookSnapshot = useCallback(
    (json: string) => {
      applyMutatedSnapshot(json);
    },
    [applyMutatedSnapshot],
  );

  // RangeCompare opener
  const openRangeCompareDialog = useCallback(() => {
    const ready = getReadyWorkbook("範囲の比較");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet || !currentSnapshotJson) return;
    const sheetName = sheet.getSheetName?.() ?? "Sheet1";
    let initialA = `${sheetName}!A1:A1`;
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) {
        const a1 = r.getA1Notation();
        initialA = `${sheetName}!${a1.includes(":") ? a1 : `${a1}:${a1}`}`;
      }
    } catch {
      // best-effort
    }
    setRangeCompareState({ initialA, initialB: initialA, snapshotJson: currentSnapshotJson });
  }, [getReadyWorkbook, currentSnapshotJson]);

  // Go To / Name Box opener
  const openGoToDialog = useCallback(() => {
    if (!getReadyWorkbook("ジャンプ")) return;
    setGoToOpen(true);
  }, [getReadyWorkbook]);

  // Inline jump that doesn't depend on the later-declared jumpToA1OnSheet —
  // avoids TS's temporal-dead-zone warning in the deps array.
  const goToJump = useCallback((sheetId: string, a1: string) => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    try {
      const sheet = workbook.getSheetBySheetId ? workbook.getSheetBySheetId(sheetId) : null;
      if (sheet) {
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

  const handleGoToNavigate = useCallback(
    (target: NavigationTarget) => {
      const fUniver = fUniverRef.current;
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      const activeSheet = wb.getActiveSheet();
      const activeSid = activeSheet?.getSheetId() ?? "";
      const sheetIdByName = (name: string): string | null => {
        if (!currentSnapshotJson) return null;
        try {
          const snap = JSON.parse(currentSnapshotJson) as { sheets?: Record<string, { name?: string }> };
          for (const [id, s] of Object.entries(snap.sheets ?? {})) {
            if ((s?.name ?? id) === name) return id;
          }
        } catch {
          // ignore
        }
        return null;
      };
      if (target.kind === "named" && target.name) {
        try {
          const snapObj = currentSnapshotJson ? JSON.parse(currentSnapshotJson) : null;
          const named = readNamedRanges().map((r) => ({ name: r.name, target: r.formula }));
          const resolved = resolveNavNamed(snapObj, target.name, named);
          if (resolved) goToJump(resolved.sheetId, resolved.a1);
        } catch {
          // ignore
        }
      } else if (target.a1) {
        const sid = target.sheetName ? sheetIdByName(target.sheetName) ?? activeSid : activeSid;
        goToJump(sid, target.a1);
      }
      setGoToOpen(false);
    },
    [currentSnapshotJson, readNamedRanges, goToJump],
  );

  // #198: commit a value/formula typed into the ribbon's formula bar to the
  // active cell. Routes through FRange.setValue so Univer's formula engine
  // and undo stack handle it (matches insert-symbol / insert-function paths).
  const handleFormulaBarCommit = useCallback(
    (value: string) => {
      const ready = getReadyWorkbook("数式バー");
      if (!ready) return;
      const sheet = ready.workbook.getActiveSheet();
      if (!sheet) return;
      try {
        const range = sheet.getSelection()?.getActiveRange();
        if (!range) return;
        const a1 = range.getA1Notation();
        const topLeft = a1.includes(":") ? a1.split(":")[0] : a1;
        sheet.getRange(topLeft)?.setValue(value);
      } catch {
        // best-effort
      }
    },
    [getReadyWorkbook],
  );

  // #198: dispatch a Univer-native ribbon operation. Font / alignment / merge
  // ops call the FRange facade directly on the live workbook (Univer routes
  // these through its command stack, so undo/redo and re-render Just Work).
  // Toggle buttons read the current cell style first so a second click clears.
  // Number-format ops (comma / decimal) take the snapshot `_fmt` path because
  // Coco doesn't register the optional @univerjs/sheets-numfmt facade.
  const handleUniverAction = useCallback(
    (
      op: import("./ribbon/ribbonDefs").UniverActionId,
      // #202 Phase 3: color-palette dropdowns pass the chosen color here, so
      // fontColor / fillColor no longer need a window.prompt.
      color?: string,
    ) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;

      // Workbook-level ops first — no range needed.
      if (op === "undo") {
        try {
          workbook.undo();
        } catch {
          /* best-effort */
        }
        return;
      }
      if (op === "redo") {
        try {
          workbook.redo();
        } catch {
          /* best-effort */
        }
        return;
      }
      if (op === "copy") {
        // Univer owns the clipboard; re-dispatch the browser copy command so
        // the active selection is copied through Univer's clipboard service.
        try {
          document.execCommand("copy");
        } catch {
          /* best-effort */
        }
        return;
      }
      if (op === "paste") {
        try {
          document.execCommand("paste");
        } catch {
          /* best-effort */
        }
        return;
      }

      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      let range;
      try {
        range = sheet.getSelection()?.getActiveRange();
      } catch {
        range = null;
      }
      if (!range) return;

      try {
        switch (op) {
          case "bold": {
            const cur = range.getCellStyle();
            const isBold = !!cur && (cur as { bl?: number }).bl === 1;
            range.setFontWeight(isBold ? "normal" : "bold");
            break;
          }
          case "italic": {
            const cur = range.getCellStyle();
            const isItalic = !!cur && (cur as { it?: number }).it === 1;
            range.setFontStyle(isItalic ? "normal" : "italic");
            break;
          }
          case "underline": {
            const cur = range.getCellStyle() as { ul?: { s?: number } } | null;
            const isUnderlined = !!cur && cur.ul?.s === 1;
            range.setFontLine(isUnderlined ? "none" : "underline");
            break;
          }
          case "fontColor": {
            // #202 Phase 3: the ribbon's color-palette dropdown supplies the
            // color; a bare click with no color is a no-op (the palette is the
            // only way to pick one — the old window.prompt is gone).
            if (color && color.trim()) range.setFontColor(color.trim());
            break;
          }
          case "fillColor": {
            if (color && color.trim()) range.setBackground(color.trim());
            break;
          }
          case "alignLeft":
            range.setHorizontalAlignment("left");
            break;
          case "alignCenter":
            range.setHorizontalAlignment("center");
            break;
          case "alignRight":
            // Univer 0.5.x's facade types FHorizontalAlignment as
            // 'left' | 'center' | 'normal' and omits 'right', but the
            // underlying SetHorizontalTextAlignCommand accepts it (the core
            // HorizontalAlign enum has RIGHT=3). Cast through the parameter
            // type so the legitimate value compiles.
            (
              range.setHorizontalAlignment as (a: string) => unknown
            )("right");
            break;
          case "alignTop":
            range.setVerticalAlignment("top");
            break;
          case "alignMiddle":
            range.setVerticalAlignment("middle");
            break;
          case "alignBottom":
            range.setVerticalAlignment("bottom");
            break;
          case "wrapText": {
            const wrapped = range.getWrap();
            range.setWrap(!wrapped);
            break;
          }
          case "mergeCells":
            range.merge();
            break;
          case "unmergeCells":
            range.breakApart();
            break;
          case "commaStyle":
          case "increaseDecimal":
          case "decreaseDecimal": {
            // Number-format ops walk the snapshot `_fmt` field directly —
            // Coco doesn't register @univerjs/sheets-numfmt, and xlsx_io.rs
            // keys the round-trip off per-cell `_fmt` (see applyNumberFormat).
            const sheetId = sheet.getSheetId();
            const sr = range.getRow();
            const sc = range.getColumn();
            const h =
              (range as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
            const w =
              (range as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
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
            const sheetObj = snapshot.sheets?.[sheetId];
            if (!sheetObj) break;
            if (!sheetObj.cellData) sheetObj.cellData = {};
            const cellData = sheetObj.cellData;
            for (let r = sr; r < sr + h; r++) {
              const rowKey = String(r);
              if (!cellData[rowKey]) cellData[rowKey] = {};
              const row = cellData[rowKey];
              for (let c = sc; c < sc + w; c++) {
                const colKey = String(c);
                const cell = row[colKey] ?? {};
                const prev = typeof cell._fmt === "string" ? cell._fmt : "";
                cell._fmt = nextNumberFormatCode(op, prev);
                row[colKey] = cell;
              }
            }
            applyMutatedSnapshot(JSON.stringify(snapshot));
            break;
          }
        }
      } catch {
        // best-effort — Univer throws on a few edge selections (e.g. merged
        // overlap); swallow so a bad click never crashes the editor.
      }
    },
    [applyMutatedSnapshot],
  );

  // --- Wave 10: Insert Symbol / Sheet Notes / Image Manager / Templates / Snapshot Controls ---
  const openInsertSymbolDialog = useCallback(() => {
    const ready = getReadyWorkbook("記号の挿入");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
    if (!sheet) return;
    let cellRef = "A1";
    try {
      const a1 = sheet.getSelection()?.getActiveRange()?.getA1Notation() ?? "A1";
      cellRef = a1.includes(":") ? a1.split(":")[0] : a1;
    } catch {
      // best-effort
    }
    setInsertSymbolCtx({ sheetId: sheet.getSheetId(), cellRef });
  }, [getReadyWorkbook]);

  const applyInsertSymbol = useCallback(
    (char: string) => {
      if (!insertSymbolCtx) return;
      const ready = getReadyWorkbook("記号の挿入");
      if (!ready) return;
      const sheet = ready.workbook.getActiveSheet();
      const range = sheet?.getRange(insertSymbolCtx.cellRef);
      if (!range) return;
      const current = range.getValue();
      const base = current === null || current === undefined ? "" : String(current);
      range.setValue(base + char);
    },
    [getReadyWorkbook, insertSymbolCtx],
  );

  const openSheetNoteDialog = useCallback(() => {
    const ready = getReadyWorkbook("シートのメモ");
    if (!ready) return;
    const ws = ready.workbook.getActiveSheet();
    if (!ws) return;
    const sheetId = ws.getSheetId();
    const sheetName = ws.getSheetName();
    let initial: SheetNote | null = null;
    if (currentSnapshotJson) {
      try {
        initial = getSheetNote(JSON.parse(currentSnapshotJson) as WorkbookNotesSnapshot, sheetId);
      } catch {
        initial = null;
      }
    }
    setSheetNoteDialog({ sheetId, sheetName, initial });
  }, [currentSnapshotJson, getReadyWorkbook]);

  const openTemplatesGallery = useCallback(() => {
    setTemplatesGalleryOpen(true);
  }, []);

  const handleUseTemplate = useCallback(
    async (id: string) => {
      setTemplatesGalleryOpen(false);
      if (!confirmDiscardIfUnsaved()) return;
      await newWorkbook();
      const snapshotJson = buildTemplateSnapshot(id);
      if (snapshotJson) applyMutatedSnapshot(snapshotJson);
    },
    [newWorkbook, applyMutatedSnapshot],
  );

  const openSnapshotControlsDialog = useCallback(() => {
    void (async () => {
      try {
        const rows = await useWorkbookStore.getState().listSnapshots();
        setSnapshotControlsState({
          open: true,
          lastSnapshotAt: rows[0]?.createdAt ?? null,
          snapshotCount: rows.length,
        });
      } catch {
        setSnapshotControlsState({ open: true, lastSnapshotAt: null, snapshotCount: 0 });
      }
    })();
  }, []);

  // #116: autoSave() already creates a snapshot row as a side effect; the
  // window dispatch had no listener and is removed as dead code.
  const triggerSnapshotNow = useCallback(() => {
    void useWorkbookStore.getState().autoSave();
  }, []);

  // --- Wave 11: Sort by Color / Filter by Color / Workbook Stats / Show All Comments / Quick Print ---
  const openSortByColorDialog = useCallback(() => {
    const ready = getReadyWorkbook("色で並べ替え");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
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
    setSortByColorDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  const applySortByColorAction = useCallback(
    (params: SortByColorParams) => {
      if (!sortByColorDialog) return;
      const ready = getReadyWorkbook("色で並べ替え");
      if (!ready) return;
      const snap = ready.workbook.save();
      const { snapshotMutated, reorderedCount } = applySortByColor(snap, sortByColorDialog.sheetId, params);
      if (reorderedCount === 0) return;
      applyMutatedSnapshot(JSON.stringify(snapshotMutated));
    },
    [sortByColorDialog, getReadyWorkbook, applyMutatedSnapshot],
  );

  const openFilterByColorDialog = useCallback(() => {
    const ready = getReadyWorkbook("色でフィルター");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
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
    const fresh = ready.workbook.save() as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
    };
    const snap = fresh.sheets?.[sheetId] ?? {};
    setFilterByColorDialog({ sheetId, range, snapshot: snap });
  }, [getReadyWorkbook]);

  const applyFilterByColorAction = useCallback(
    (params: FilterByColorParams) => {
      if (!filterByColorDialog) return;
      const wb = fUniverRef.current?.getActiveWorkbook();
      if (!wb) return;
      const fresh = wb.save() as object;
      const { snapshotMutated, matchedRows, hiddenRows } = applyFilterByColor(fresh, filterByColorDialog.sheetId, params);
      applyMutatedSnapshot(JSON.stringify(snapshotMutated));
      setEditorOperationError(`色でフィルター: ${matchedRows} 行表示 / ${hiddenRows} 行非表示`);
    },
    [filterByColorDialog, applyMutatedSnapshot],
  );

  const openWorkbookStatsDialog = useCallback(() => {
    setWorkbookStats(collectWorkbookStats(currentSnapshotJson ?? ""));
    setWorkbookStatsOpen(true);
  }, [currentSnapshotJson]);

  const refreshWorkbookStats = useCallback(() => {
    setWorkbookStats(collectWorkbookStats(currentSnapshotJson ?? ""));
  }, [currentSnapshotJson]);

  const openQuickPrintDialog = useCallback(() => {
    if (!currentSnapshotJson) return;
    let snap: object;
    try {
      snap = JSON.parse(currentSnapshotJson) as object;
    } catch {
      return;
    }
    const activeId = fUniverRef.current?.getActiveWorkbook()?.getActiveSheet()?.getSheetId() ?? null;
    setQuickPrintDialog({ snapshot: snap, activeSheetId: activeId });
  }, [currentSnapshotJson]);

  // --- Wave 12: HyperlinkManager / Borders / QuickCF / CellLinker / FilterSearch ---
  const openBordersDialog = useCallback(() => {
    const ready = getReadyWorkbook("罫線");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
    if (!sheet) return;
    const sheetId = sheet.getSheetId();
    let range = "A1";
    try {
      const r = sheet.getSelection()?.getActiveRange();
      if (r) range = r.getA1Notation();
    } catch {
      // best-effort
    }
    setBordersDialog({ sheetId, range });
  }, [getReadyWorkbook]);

  const applyBordersFromDialog = useCallback(
    (params: BorderParams) => {
      if (!bordersDialog) return;
      const wb = fUniverRef.current?.getActiveWorkbook();
      if (!wb) return;
      try {
        const fresh = wb.save();
        const { snapshotMutated } = applyBorders(fresh as object, bordersDialog.sheetId, params);
        applyMutatedSnapshot(JSON.stringify(snapshotMutated));
      } catch (e) {
        setEditorOperationError(`罫線: ${(e as Error).message}`);
      }
    },
    [bordersDialog, applyMutatedSnapshot],
  );

  const openQuickCfDialog = useCallback(() => {
    const ready = getReadyWorkbook("クイック条件付き書式");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
    if (!sheet) return;
    const r = sheet.getSelection()?.getActiveRange();
    const range = r?.getA1Notation() ?? "A1";
    setQuickCfDialog({ sheetId: sheet.getSheetId(), range });
  }, [getReadyWorkbook]);

  const openCellLinkerDialog = useCallback(() => {
    const ready = getReadyWorkbook("セルリンク");
    if (!ready) return;
    const { workbook } = ready;
    const sheet = workbook.getActiveSheet();
    if (!sheet) return;
    const activeSheetId = sheet.getSheetId();
    let initialTargetCell = "A1";
    try {
      const a1 = sheet.getSelection()?.getActiveRange()?.getA1Notation();
      if (a1) initialTargetCell = a1.includes(":") ? a1.split(":")[0] : a1;
    } catch {
      // best-effort
    }
    const snap = workbook.save() as unknown as {
      sheetOrder?: string[];
      sheets?: Record<string, { name?: string } | undefined>;
    };
    const sheets = snap.sheets ?? {};
    const order = snap.sheetOrder ?? Object.keys(sheets);
    const availableSheets = order
      .map((id) => ({ id, name: sheets[id]?.name ?? id }))
      .filter((s) => typeof s.name === "string");
    setCellLinkerCtx({ activeSheetId, initialTargetCell, availableSheets });
  }, [getReadyWorkbook]);

  const applyCellLink = useCallback(
    (params: CellLinkParams) => {
      const fUniver = fUniverRef.current;
      const workbook = fUniver?.getActiveWorkbook();
      if (!workbook) return;
      try {
        const sheet = workbook.getSheetBySheetId
          ? workbook.getSheetBySheetId(params.targetSheetId)
          : null;
        if (!sheet) return;
        const range = (sheet as unknown as { getRange?: (a1: string) => unknown }).getRange?.(params.targetCellRef);
        if (!range) return;
        const r = range as { setValue?: (v: unknown) => void };
        if (params.liveLink) {
          r.setValue?.(buildLinkFormula(params.sourceSheetName, params.sourceCellRef));
        } else {
          const snap = workbook.save() as unknown;
          const v = resolveSourceValue(snap, params.sourceSheetName, params.sourceCellRef);
          r.setValue?.(v ?? "");
        }
      } catch {
        // best-effort
      }
    },
    [],
  );

  const openFilterSearchDialog = useCallback(() => {
    const ready = getReadyWorkbook("値で検索フィルター");
    if (!ready) return;
    const sheet = ready.workbook.getActiveSheet();
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
    const fresh = ready.workbook.save() as {
      sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>> }>;
    };
    const snap = fresh.sheets?.[sheetId] ?? {};
    setFilterSearchDialog({ sheetId, range, snapshot: snap });
  }, [getReadyWorkbook]);

  const applyFilterSearchAction = useCallback(
    (params: FilterSearchParams) => {
      if (!filterSearchDialog) return;
      const wb = fUniverRef.current?.getActiveWorkbook();
      if (!wb) return;
      const fresh = wb.save() as object;
      const { snapshotMutated, matchedRows, hiddenRows } = applyFilterSearch(
        fresh,
        filterSearchDialog.sheetId,
        params,
      );
      applyMutatedSnapshot(JSON.stringify(snapshotMutated));
      setEditorOperationError(`値で検索フィルター: ${matchedRows} 行表示 / ${hiddenRows} 行非表示`);
    },
    [filterSearchDialog, applyMutatedSnapshot],
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

  // #146 / #188: derive the shape (text box / rect / ellipse / line) list for
  // the active sheet from the live snapshot. Filtered client-side so the panel
  // auto-refreshes on sheet switch / insert / delete without manual invalidation.
  const activeSheetTextBoxes: TextBox[] = activeSheetId
    ? listTextBoxesForSheet(currentSnapshotJson ?? null, activeSheetId)
    : [];

  // Jump the Univer selection to a shape's anchor cell when the user clicks a
  // panel row. Switches sheets first if the shape lives on a different sheet —
  // mirrors jumpToImageCell.
  const jumpToTextBoxCell = useCallback((tb: TextBox) => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
    try {
      const target = workbook.getSheetBySheetId(tb.sheetId);
      if (!target) return;
      const active = workbook.getActiveSheet();
      if (!active || active.getSheetId() !== tb.sheetId) {
        workbook.setActiveSheet(target);
      }
      const a1 = colRowToA1(tb.x, tb.y);
      const range = target.getRange(a1);
      if (range) range.activate();
    } catch {
      // best-effort
    }
  }, []);

  // #184: jump the Univer selection to a camera link's source range / dst
  // anchor when the user clicks an entry in CameraLinksPanel.
  const jumpToCameraSource = useCallback(
    (link: CameraLink) => {
      jumpToA1OnSheet(link.sourceSheetId, rectToA1(link.sourceRange));
    },
    [jumpToA1OnSheet],
  );
  const jumpToCameraDest = useCallback(
    (link: CameraLink) => {
      jumpToA1OnSheet(
        link.dstSheetId,
        rectToA1({
          r1: link.dstAnchor.row,
          c1: link.dstAnchor.col,
          r2: link.dstAnchor.row,
          c2: link.dstAnchor.col,
        }),
      );
    },
    [jumpToA1OnSheet],
  );

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

  // Persist drag/resize result back to the workbook snapshot (#236 Step 5).
  // Called by InGridChartLayer on every pointerup that moved/resized a chart.
  // Uses the cached currentSnapshotJson (drag completes synchronously, so no
  // dialog-open race). Pushed through applyMutatedSnapshot so Ctrl+Alt+Z
  // (Coco undo) can roll it back.
  const handleChartAnchorChange = useCallback(
    (sheetId: string, chartIndex: number, updated: ChartEntry) => {
      const snapshot = getSnapshotForTool("グラフ移動");
      if (!snapshot) return;
      const sheets = (snapshot.sheets as Record<string, Record<string, unknown>> | undefined) ?? {};
      const sheetObj = sheets[sheetId];
      if (!sheetObj) return;
      const existing = Array.isArray(sheetObj._charts)
        ? (sheetObj._charts as Array<Record<string, unknown>>)
        : [];
      if (chartIndex < 0 || chartIndex >= existing.length) return;
      const next = existing.map((c, i) => (i === chartIndex ? { ...c, ...updated } : c));
      sheetObj._charts = next;
      applyMutatedSnapshot(JSON.stringify(snapshot));
    },
    [getSnapshotForTool, applyMutatedSnapshot],
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
        t("confirm.cell.overwrite", trimmed, formula),
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

      // Phase 4d (#high-image-live): the snapshot mutation alone doesn't
      // re-mount Univer, so the image wouldn't appear in-grid until the user
      // saves and reopens (when the xlsx import bridge re-emits
      // `resources[SHEET_DRAWING_PLUGIN]` from `_preservedParts`). Fire a
      // facade `insertImage` so the image renders immediately in-session.
      // Fire-and-forget: if the facade rejects, the export round-trip still
      // works via `_preservedParts` and the image will appear on next reopen.
      const ext = value.ext.toLowerCase();
      const mime =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        ext === "png" ? "image/png" :
        ext === "gif" ? "image/gif" :
        ext === "bmp" ? "image/bmp" :
        ext === "webp" ? "image/webp" :
        `image/${ext}`;
      const dataUrl = `data:${mime};base64,${value.base64}`;
      try {
        const fSheet = workbook.getActiveSheet();
        const fSheetWithImage = fSheet as unknown as {
          insertImage?: (url: string, col: number, row: number) => Promise<boolean>;
        } | null;
        if (fSheetWithImage?.insertImage) {
          void fSheetWithImage
            .insertImage(dataUrl, pos.col, pos.row)
            .catch((err: unknown) => {
              console.warn("[Coco] in-grid image render failed:", err);
            });
        }
      } catch (err) {
        console.warn("[Coco] facade insertImage threw synchronously:", err);
      }
      return null;
    },
    [imageDialog, applyMutatedSnapshot],
  );

  // #146 / #188 — Insert-shape dialog plumbing. Snapshots the active sheet +
  // the top-left of the active range so the shape anchors at the user's actual
  // cursor cell (same pattern as openImageDialog).
  const openShapeDialog = useCallback(() => {
    const ready = getReadyWorkbook("図形の挿入");
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
    setShapeDialog({ sheetId, cell });
  }, [getReadyWorkbook]);

  // Apply a new shape (text box / rect / ellipse / line) by mutating the
  // snapshot's `_textBoxes` array. The shape stays in-memory only until the
  // user saves to xlsx; on save the round-trip serialises every shape into
  // the matching drawing XML via `_textBoxes` → `<xdr:sp>` / `<xdr:grpSp>`
  // injection. Returns null on success, or a localized error string on
  // rejection (matching applyImage's contract).
  const applyShape = useCallback(
    (value: ShapeFormValue): string | null => {
      if (!shapeDialog) return "ダイアログの状態が無効です";
      const fUniver = fUniverRef.current;
      if (!fUniver) return "ワークブックがまだ準備できていません";
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return "アクティブなワークブックがありません";
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const sheetOrder = (snapshot.sheetOrder as string[] | undefined) ?? [];
      if (!sheetOrder.includes(shapeDialog.sheetId)) {
        return "対象シートが見つかりません";
      }
      const pos = tbA1ToColRow(value.cell);
      if (!pos) return "アンカーセルの解析に失敗しました";
      const tb: TextBox = {
        id: makeTextBoxId(),
        type: value.type,
        sheetId: shapeDialog.sheetId,
        x: pos.col,
        y: pos.row,
        w: value.w,
        h: value.h,
        text: value.text,
        fontFamily: value.fontFamily,
        fontSize: value.fontSize,
        color: value.color,
        backgroundColor: value.backgroundColor,
        borderColor: value.borderColor,
      };
      const next = addTextBox(snapshot, tb);
      applyMutatedSnapshot(JSON.stringify(next));
      return null;
    },
    [shapeDialog, applyMutatedSnapshot],
  );

  // Remove a shape by id. Used by the side panel's per-row delete button.
  const removeTextBox = useCallback(
    (id: string) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const next = deleteTextBox(snapshot, id);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [applyMutatedSnapshot],
  );

  // Patch a shape's geometry / style fields from the side-panel numeric
  // editor. Univer 0.5.x exposes no stable pixel-overlay API, so position and
  // size are edited as cell-unit numbers in the panel (issue #188 note).
  const patchTextBox = useCallback(
    (id: string, patch: Partial<Omit<TextBox, "id">>) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const next = updateTextBox(snapshot, id, patch);
      applyMutatedSnapshot(JSON.stringify(next));
    },
    [applyMutatedSnapshot],
  );

  // Group / ungroup the supplied shapes (#188). Grouping stamps a shared
  // `groupId` on every member so the xlsx export wraps them in one
  // `<xdr:grpSp>`. Passing an empty `groupId` clears the grouping.
  const groupTextBoxes = useCallback(
    (ids: string[], groupId: string | undefined) => {
      if (ids.length === 0) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      let snapshot = workbook.save() as unknown as Record<string, unknown>;
      for (const id of ids) {
        snapshot = updateTextBox(snapshot, id, { groupId }) as Record<
          string,
          unknown
        >;
      }
      applyMutatedSnapshot(JSON.stringify(snapshot));
    },
    [applyMutatedSnapshot],
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
  // the sheets-ui SelectionChanged event once the workbook is mounted; the
  // listener pulls the pending style + active sheet + new selection ranges
  // and writes through updateSnapshot. Single mode deactivates after the
  // first apply; sticky mode keeps going until ESC.
  useEffect(() => {
    if (formatPainterMode === "idle") return;
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;

    // Univer 0.24 (#13): migrated from `FWorkbook.onSelectionChange(...)` to
    // `addEvent(Event.SelectionChanged, ...)`. The typed payload exposes
    // `{ workbook, worksheet, selections }` where `selections: IRange[]` —
    // same `startRow / endRow / startColumn / endColumn` shape the legacy
    // callback delivered, so the rest of the handler is unchanged.
    const disposable = fUniver.addEvent(fUniver.Event.SelectionChanged, (params) => {
      // Ignore the synchronous initial fire that some Univer versions emit
      // when a listener is attached — debounce ~50ms against arm time.
      if (Date.now() - formatPainterArmedAtRef.current < 50) return;
      const style = pendingFormatRef.current;
      if (!style) return;
      const ranges = params.selections;
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
      id: "insert.shape",
      label: "図形を挿入",
      category: "挿入",
      keywords: "shape textbox rect ellipse line 図形 テキストボックス 矩形 円 矢印",
      run: openShapeDialog,
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
      id: "view.split.toggle",
      // Label flips between "分割" (open) and "分割を解除" (close) so the
      // single command-palette entry behaves like Excel's View → Split toggle.
      label: activeSheetHasSplit ? "ウィンドウ分割を解除" : "ウィンドウを分割",
      category: "表示",
      keywords: "split window pane 分割 4分割",
      run: () => toggleSplitPane("both"),
    },
    {
      id: "view.split.horizontal",
      label: "ウィンドウを横に分割",
      category: "表示",
      keywords: "split horizontal pane 横分割 2分割",
      run: () => toggleSplitPane("horizontal"),
    },
    {
      id: "view.split.vertical",
      label: "ウィンドウを縦に分割",
      category: "表示",
      keywords: "split vertical pane 縦分割 2分割",
      run: () => toggleSplitPane("vertical"),
    },
    {
      id: "view.split.clear",
      label: "ウィンドウ分割を解除",
      category: "表示",
      keywords: "split clear remove unsplit 解除",
      run: clearSplitPane,
    },
    {
      id: "insert.camera",
      label: "カメラ撮影 (範囲のスナップショット画像)",
      category: "挿入",
      keywords: "camera snapshot picture range live image",
      run: captureCamera,
    },
    {
      id: "view.camera",
      label: "カメラ画像パネル",
      category: "表示",
      keywords: "camera snapshot panel",
      run: () => setCameraPanelOpen((v) => !v),
    },
    {
      id: "tools.macro",
      label: "マクロの記録 / 再生",
      category: "ツール",
      keywords: "macro record playback automation",
      run: () => setMacroDialogOpen(true),
    },
    {
      id: "tools.scriptEditor",
      label: "スクリプトエディタ",
      category: "ツール",
      keywords: "script editor javascript apps script macro trigger sandbox",
      run: () => setScriptEditorOpen(true),
    },
    {
      id: "tools.inquire",
      label: "ブック診断 (Inquire)",
      category: "ツール",
      keywords: "inquire statistics workbook diagnostic functions errors external links 診断 統計",
      run: () => setInquireOpen(true),
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
      } else if (mod && !e.shiftKey && (e.key === "p" || e.key === "P")) {
        // Ctrl+P / Cmd+P — print preview. Previously bound only via the native
        // menu accelerator (#202 removed the native menu); handled here so the
        // shortcut keeps opening Coco's in-app preview instead of the WebView's
        // default browser print.
        e.preventDefault();
        openQuickPrintDialog();
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
      } else if (mod && !e.altKey && (e.key === ";" || e.key === ":")) {
        // Ctrl+; — insert today's date (YYYY-MM-DD) into the active cell.
        // Ctrl+Shift+; (a.k.a. Ctrl+:) — insert current time (HH:MM:SS).
        // Excel parity shortcuts that write a VALUE (not a formula) so the
        // cell freezes at the instant of insertion, the way Excel does it.
        // Key detection: many JIS / 60% layouts send ":" for Ctrl+Shift+;,
        // others send ";" with shiftKey set — accept both.
        const wantsTime = e.shiftKey || e.key === ":";
        e.preventDefault();
        insertDateTimeNow(wantsTime ? "time" : "date");
      }
    },
    [
      save,
      promptSaveAs,
      openQuickPrintDialog,
      openNamedRangesDialog,
      openCfDialog,
      openHyperlinkDialog,
      openCommentDialog,
      openNumberFormatDialog,
      formatPainterMode,
      deactivateFormatPainter,
      applyAutoSum,
      insertDateTimeNow,
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
      case "insert-shape":
        openShapeDialog();
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
      case "tools-solver":
        openSolverDialog();
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
      case "insert-camera":
        captureCamera();
        break;
      case "view-camera-panel":
        setCameraPanelOpen((v) => !v);
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
      case "tools-macro":
        setMacroDialogOpen(true);
        break;
      case "tools-script-editor":
        setScriptEditorOpen(true);
        break;
      case "data-forecast-sheet":
        openForecastSheetDialog();
        break;
      case "tools-analysis-toolpak":
        openAnalysisToolpakDialog();
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
      case "tools-spell-check":
        openSpellCheckDialog();
        break;
      case "data-form":
        openDataFormDialog();
        break;
      case "edit-find-replace-all":
        openFindReplaceAllDialog();
        break;
      case "view-comments-manager":
        setCommentsManagerOpen((v) => !v);
        break;
      case "data-smart-date":
        openSmartDateDialog();
        break;
      case "data-convert-to-range":
        openConvertToRangeDialog();
        break;
      case "tools-document-inspector":
        openDocumentInspector();
        break;
      case "data-bulk-clean":
        openBulkCleanDialog();
        break;
      case "file-csv-import-wizard":
        openCsvImportWizard();
        break;
      case "edit-go-to":
        openGoToDialog();
        break;
      case "file-import-sheet":
        setSheetImportOpen(true);
        break;
      case "data-get-transform":
        setGetTransformOpen(true);
        break;
      case "data-data-connections":
        setDataConnectionsOpen(true);
        break;
      case "view-bookmarks-panel":
        setBookmarksPanelOpen((v) => !v);
        break;
      case "bookmark-add-current":
        addCurrentCellAsBookmark();
        break;
      case "format-manage-codes":
        setNumberFormatManagerOpen(true);
        break;
      case "data-range-compare":
        openRangeCompareDialog();
        break;
      case "insert-symbol":
        openInsertSymbolDialog();
        break;
      case "view-sheet-note":
        openSheetNoteDialog();
        break;
      case "view-image-manager":
        setImageManagerOpen((v) => !v);
        break;
      case "file-templates":
        openTemplatesGallery();
        break;
      case "view-snapshot-controls":
        openSnapshotControlsDialog();
        break;
      case "snapshot-now":
        triggerSnapshotNow();
        break;
      case "data-sort-by-color":
        openSortByColorDialog();
        break;
      case "data-filter-by-color":
        openFilterByColorDialog();
        break;
      case "view-workbook-stats":
        openWorkbookStatsDialog();
        break;
      case "view-show-all-comments":
        setShowAllCommentsMode((v) => !v);
        break;
      case "file-quick-print":
        openQuickPrintDialog();
        break;
      case "view-hyperlink-manager":
        setHyperlinkManagerOpen((v) => !v);
        break;
      case "format-borders":
        openBordersDialog();
        break;
      case "format-quick-cf":
        openQuickCfDialog();
        break;
      case "insert-cell-link":
        openCellLinkerDialog();
        break;
      case "insert-checkbox":
        insertCheckboxAtSelection();
        break;
      case "insert-radio-button":
        insertFormControlAtSelection("radio");
        break;
      case "insert-spin-button":
        insertFormControlAtSelection("spin");
        break;
      case "insert-scroll-bar":
        insertFormControlAtSelection("scroll");
        break;
      case "data-filter-search":
        openFilterSearchDialog();
        break;
      case "help-check-update":
        // Manual check: ignore skip-version flag so user can re-see a dialog
        // they previously dismissed.
        void (async () => {
          setUpdaterState({ kind: "checking" });
          try {
            const r = await checkForUpdate();
            if (!r.available) {
              setUpdaterState({ kind: "idle" });
              setEditorOperationError("最新バージョンを使用しています。");
              return;
            }
            // Manual check: always show the dialog (ignore both skip-version
            // and staged-rollout gate). User explicitly asked.
            setUpdaterState({
              kind: "available",
              version: r.version,
              currentVersion: r.currentVersion,
              notes: r.notes,
              pubDate: r.pubDate,
              minRequiredVersion: r.minRequiredVersion,
              isForced: r.isForced,
              rollout: r.rollout,
              channel: r.channel,
            });
          } catch (e) {
            setUpdaterState({ kind: "error", message: (e as Error).message });
            setEditorOperationError(`更新の確認に失敗しました: ${(e as Error).message}`);
          }
        })();
        break;
    }
  }, [
    openHyperlinkDialog,
    openCommentDialog,
    openChartDialog,
    openImageDialog,
    openShapeDialog,
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
    openSolverDialog,
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
    openAnalysisToolpakDialog,
    openRecommendedChartsDialog,
    openSnapshotDiffDialog,
    openSpellCheckDialog,
    openDataFormDialog,
    openFindReplaceAllDialog,
    openSmartDateDialog,
    openConvertToRangeDialog,
    openDocumentInspector,
    openBulkCleanDialog,
    openCsvImportWizard,
    openGoToDialog,
    addCurrentCellAsBookmark,
    openRangeCompareDialog,
    openInsertSymbolDialog,
    openSheetNoteDialog,
    openTemplatesGallery,
    openSnapshotControlsDialog,
    triggerSnapshotNow,
    openSortByColorDialog,
    openFilterByColorDialog,
    openWorkbookStatsDialog,
    openQuickPrintDialog,
    openBordersDialog,
    openQuickCfDialog,
    openCellLinkerDialog,
    openFilterSearchDialog,
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
          t("confirm.csvExport.overwrite", existing.length)
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

  // Poll Univer's active selection for the toolbar NavigationBox display.
  useEffect(() => {
    const tick = () => {
      try {
        const wb = fUniverRef.current?.getActiveWorkbook();
        const sheet = wb?.getActiveSheet();
        const r = sheet?.getSelection()?.getActiveRange();
        if (!sheet || !r) return;
        setNavActiveSheetName(sheet.getSheetName());
        // #146 / #188: feed the shape panel filter. Cheap getter, safe to call
        // unconditionally — null when there's no active sheet.
        try {
          setActiveSheetId(sheet.getSheetId());
        } catch {
          // best-effort
        }
        const startCol = r.getColumn();
        const startRow = r.getRow();
        const width = (r as unknown as { getWidth?: () => number }).getWidth?.() ?? 1;
        const height = (r as unknown as { getHeight?: () => number }).getHeight?.() ?? 1;
        const cellA1 = (() => {
          let n = startCol + 1;
          let out = "";
          while (n > 0) {
            const rem = (n - 1) % 26;
            out = String.fromCharCode(65 + rem) + out;
            n = Math.floor((n - 1) / 26);
          }
          return `${out}${startRow + 1}`;
        })();
        if (width === 1 && height === 1) {
          setNavActiveCellRef(cellA1);
        } else {
          const endCol = startCol + width - 1;
          const endRow = startRow + height - 1;
          let n = endCol + 1;
          let endCellLetters = "";
          while (n > 0) {
            const rem = (n - 1) % 26;
            endCellLetters = String.fromCharCode(65 + rem) + endCellLetters;
            n = Math.floor((n - 1) / 26);
          }
          setNavActiveCellRef(`${cellA1}:${endCellLetters}${endRow + 1}`);
        }
        // #198: feed the formula bar — show the formula if the active cell
        // has one, otherwise its literal value. Read from the top-left cell.
        try {
          const cell = sheet.getRange(startRow, startCol);
          const formulas = cell.getFormulas();
          const f = formulas?.[0]?.[0];
          if (typeof f === "string" && f.length > 0) {
            setFormulaBarText(f);
          } else {
            const v = cell.getValue();
            setFormulaBarText(v === null || v === undefined ? "" : String(v));
          }
        } catch {
          // best-effort
        }
      } catch {
        // best-effort
      }
    };
    tick();
    const id = window.setInterval(tick, 300);
    return () => window.clearInterval(id);
  }, []);

  // #107: bind F9 / Shift+F9 to the recalc events so the keyboard shortcut
  // documented in the menu actually fires. Tab/textarea-focus is ignored
  // since recalc is workbook-scope.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F9") return;
      e.preventDefault();
      const scope = e.shiftKey ? "sheet" : "all";
      window.dispatchEvent(new CustomEvent("coco:calc-recalc", { detail: { scope } }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // #183: keyboard activation for checkboxes and form controls. When the
  // active cell hosts a control:
  //   - checkbox:  Space toggles the boolean.
  //   - radio:     Space / Enter selects this option.
  //   - spin:      ArrowUp/Down step by ±step.
  //   - scroll:    ArrowUp/Down step by ±step, PageUp/Down by ±page.
  // We ignore the keystroke while a cell editor / dialog input is focused so
  // typing into a cell still works. Mutations route through
  // applyMutatedSnapshot for undo capture and respect sheet protection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter" &&
          e.key !== "ArrowUp" && e.key !== "ArrowDown" &&
          e.key !== "PageUp" && e.key !== "PageDown") {
        return;
      }
      // Skip when focus is in an editable field (cell editor, dialog input).
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const sheet = workbook.getActiveSheet();
      if (!sheet) return;
      const subUnitId = sheet.getSheetId();
      let row = -1;
      let col = -1;
      try {
        const range = sheet.getSelection()?.getActiveRange();
        if (range) {
          row = range.getRow();
          col = range.getColumn();
        }
      } catch {
        return;
      }
      if (row < 0 || col < 0) return;
      const snapshot = snapshotRef.current;

      // Checkbox: Space toggles.
      if (hasCheckbox(snapshot, subUnitId, row, col)) {
        if (e.key !== " ") return;
        if (isSheetProtectedInSnapshot(snapshot, subUnitId)) return;
        e.preventDefault();
        const result = toggleCheckboxInSnapshot(snapshot, subUnitId, row, col);
        if (result.changed) {
          applyMutatedSnapshot(JSON.stringify(result.snapshot));
        }
        return;
      }

      // Form controls.
      const fc = getFormControlAt(snapshot, subUnitId, row, col);
      if (!fc) return;
      if (isSheetProtectedInSnapshot(snapshot, subUnitId)) return;
      let result: ReturnType<typeof selectRadio> | null = null;
      if (fc.kind === "radio") {
        if (e.key !== " " && e.key !== "Enter") return;
        result = selectRadio(snapshot, subUnitId, row, col);
      } else {
        // spin / scroll
        if (e.key === "ArrowUp") {
          result = stepControl(snapshot, subUnitId, row, col, 1, false);
        } else if (e.key === "ArrowDown") {
          result = stepControl(snapshot, subUnitId, row, col, -1, false);
        } else if (e.key === "PageUp" && fc.kind === "scroll") {
          result = stepControl(snapshot, subUnitId, row, col, 1, true);
        } else if (e.key === "PageDown" && fc.kind === "scroll") {
          result = stepControl(snapshot, subUnitId, row, col, -1, true);
        } else {
          return;
        }
      }
      e.preventDefault();
      if (result && result.changed) {
        applyMutatedSnapshot(JSON.stringify(result.snapshot));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyMutatedSnapshot]);

  // #107: consume the coco:calc-recalc events. Calls Univer's facade calc()
  // when available (the public surface in 0.5.x exposes a workbook-level
  // calculate via formula plugin); best-effort otherwise.
  useEffect(() => {
    const onRecalc = (e: Event) => {
      try {
        const detail = (e as CustomEvent<{ scope?: string }>).detail;
        const wb = fUniverRef.current?.getActiveWorkbook();
        if (!wb) return;
        const target =
          detail?.scope === "sheet"
            ? (wb.getActiveSheet() as unknown as { calculate?: () => void } | null)
            : (wb as unknown as { calculate?: () => void });
        target?.calculate?.();
        // If the facade doesn't expose calculate, fall back: round-trip the
        // snapshot — this forces Univer to re-derive computed cells.
        if (!target?.calculate) {
          const fresh = wb.save();
          updateSnapshot(JSON.stringify(fresh));
        }
      } catch {
        // best-effort
      }
    };
    window.addEventListener("coco:calc-recalc", onRecalc);
    return () => window.removeEventListener("coco:calc-recalc", onRecalc);
  }, [updateSnapshot]);

  // #111: consume the import-workspace-bundle event dispatched from
  // useMenuActions (the menu sends an event because the dialog flow needs
  // editor-level state). Opens a .zip picker and invokes the backend.
  useEffect(() => {
    const onImportBundle = () => {
      void (async () => {
        try {
          const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
          const selected = await openFileDialog({
            multiple: false,
            filters: [{ name: "Workspace Bundle", extensions: ["zip"] }],
          });
          if (!selected) return;
          const path = typeof selected === "string" ? selected : selected[0];
          // Restore into a temp dir derived from the workspace; the backend
          // returns a manifest with the restored .coco path which we then open.
          const result = await invoke<{
            restoredWorkbookPath: string;
            restoredSettingsCount: number;
            sheetCount: number;
          }>("workbook_import_workspace_bundle", {
            bundlePath: path,
            targetDir: "",
          });
          if (result?.restoredWorkbookPath) {
            if (!confirmDiscardIfUnsaved()) return;
            await openCoco(result.restoredWorkbookPath);
            setEditorOperationError(
              `バンドルを復元しました (シート ${result.sheetCount} / 設定 ${result.restoredSettingsCount} 件)。`,
            );
          }
        } catch (e) {
          setEditorOperationError(`バンドル取り込みに失敗しました: ${(e as Error).message}`);
        }
      })();
    };
    window.addEventListener("coco:menu-import-workspace-bundle", onImportBundle);
    return () => window.removeEventListener("coco:menu-import-workspace-bundle", onImportBundle);
  }, [openCoco]);

  // Auto-update: startup check. Fires once on mount (empty deps) unless the
  // user has disabled it in Settings (localStorage `coco.updater.checkOnLaunch
  // === "false"`). The skip-version flag suppresses the modal for a version
  // the user explicitly dismissed; manual check (help-check-update) ignores
  // skip so users can opt back in.
  useEffect(() => {
    if (!isAutoCheckEnabled()) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await checkForUpdate();
        if (cancelled) return;
        if (!r.available) {
          setUpdaterState({ kind: "idle" });
          return;
        }
        // Race fix (#A10): if the user toggled auto-check OFF while this
        // check was in flight, swallow the result. Forced upgrades still
        // win — security/CVE fixes shouldn't be silenced by a preference.
        if (!isAutoCheckEnabled() && !r.isForced) {
          setUpdaterState({ kind: "idle" });
          return;
        }
        // Forced upgrades (min_required_version) override both the skip-version
        // flag and the staged-rollout gate — security/CVE fixes must reach everyone.
        if (!r.isForced) {
          if (getSkippedVersion() === r.version) {
            setUpdaterState({ kind: "idle" });
            return;
          }
          if (!isInRolloutBucket(r.rollout)) {
            // User isn't in this rollout bucket yet — silently skip and wait
            // for either a higher percent or a manual check from Settings.
            setUpdaterState({ kind: "idle" });
            return;
          }
        }
        setUpdaterState({
          kind: "available",
          version: r.version,
          currentVersion: r.currentVersion,
          notes: r.notes,
          pubDate: r.pubDate,
          minRequiredVersion: r.minRequiredVersion,
          isForced: r.isForced,
          rollout: r.rollout,
          channel: r.channel,
        });
      } catch (e) {
        // Silent fail on first launch — log to console only. Don't show a
        // toast since this is the *automatic* check and the user didn't ask
        // for it. Manual check (help-check-update) surfaces errors.
        // eslint-disable-next-line no-console
        console.warn("[updater] startup check failed:", (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

    // StrictMode remount fast path: if a previous run stashed a live instance
    // and scheduled (but not yet fired) its disposal, this effect re-run is the
    // StrictMode remount. Cancel the pending disposal and reuse the existing
    // Univer instead of creating a second one — building a new Univer here
    // would, on Univer 0.5.x, race the disposed instance's late async dispatch
    // (the `_initWorkbookListener` of that era) and surface
    // "[redi]: Injector ... disposed". See `univerStashRef` and issue #232 for
    // the post-0.24 status of this guard.
    {
      const stashed = univerStashRef.current;
      if (stashed && stashed.disposeTimer !== null) {
        clearTimeout(stashed.disposeTimer);
        stashed.disposeTimer = null;
        univerRef.current = stashed.univer;
        fUniverRef.current = stashed.fUniver;
        return () => {
          const s = univerStashRef.current;
          if (!s) return;
          s.disposeTimer = setTimeout(() => {
            s.formulaNormalizerReg?.dispose();
            s.contextMenuReg?.dispose();
            s.univer.dispose();
            univerRef.current = null;
            fUniverRef.current = null;
            univerStashRef.current = null;
          }, 0);
        };
      }
    }

    setEditorOperationError(null);

    let univer: Univer | null = null;
    let contextMenuReg: ReturnType<typeof registerCocoContextMenu> | null = null;
    let formulaNormalizerReg: ReturnType<typeof registerFormulaNormalizer> | null = null;

    try {
      // Univer 0.12 ships a native `LocaleType.JA_JP`, so we wire both EN_US
      // and JA_JP slots from the stock per-package locale bundles (plus a
      // small Coco override for ~200 formula `abstract` strings) and pick the
      // initial slot via Coco's app-side `getLocale()`. The 0.5.x EN_US-slot-
      // with-JA-override workaround that lived in cocoUniverLocale.ts was
      // removed as part of the 0.12.4 bump (docs/UNIVER_0_6_MIGRATION.md
      // change #9).
      univer = new Univer({
        theme: defaultTheme,
        // #193 (Univer 0.8 dark mode): seed the initial dark-mode flag from
        // Coco's effective theme so the grid renders correctly on first paint.
        // The live-update effect below handles subsequent theme flips.
        darkMode: getEffectiveTheme() === "dark",
        locale: toUniverLocaleType(getLocale()),
        locales: buildCocoUniverLocales(),
        // FR-011: bump the per-unit undo stack from Univer's default 20 to 100.
        override: undoRedoOverride,
      });

      univer.registerPlugin(UniverRenderEnginePlugin);
      univer.registerPlugin(UniverFormulaEnginePlugin);
      univer.registerPlugin(UniverUIPlugin, {
        container: "univer-container",
        // Coco's own custom ribbon covers the toolbar / header-menu surface.
        // Hide Univer's native header-bar AND ribbon-toolbar to avoid
        // duplicate UI directly above the column-header row. The formula
        // bar lives outside `data-u-comp="headerbar"` so disabling header
        // here does not hide it.
        header: false,
        toolbar: false,
        headerMenu: false,
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
      // Phase 4b (UNIVER_0_6_MIGRATION.md §4 / high-image-live): in-grid
      // image rendering. Order mirrors Univer's own preset — the shared
      // drawing model first, then the generic drawing UI, then the
      // sheets-specific bindings. The base `@univerjs/drawing` plugin
      // is required: `UniverSheetsDrawingPlugin` injects `IDrawingManagerService`
      // which lives in that package. Registering only the sheets-level
      // pair throws "service not registered" at boot.
      //
      // Snapshot integration: `UniverSheetsDrawingPlugin` registers a
      // `IResourceManagerService` resource keyed by `SHEET_DRAWING_PLUGIN`,
      // so its data round-trips inside `IWorkbookData.resources` — NOT
      // inside Coco's `_preservedParts` (which the Rust xlsx_io.rs writer
      // owns for byte-for-byte image part preservation). The two paths are
      // independent: existing-xlsx images keep round-tripping via
      // `_preservedParts`, but in-grid rendering requires a bridge that
      // emits a `resources[SHEET_DRAWING_PLUGIN]` entry from the parsed
      // drawing XML. That bridge is deferred to a follow-up (see
      // docs/TODOS.md `high-image-live`). Registering the plugins here is
      // the prerequisite — without them the resource slot is ignored even
      // if we populate it.
      univer.registerPlugin(UniverDrawingPlugin);
      univer.registerPlugin(UniverDrawingUIPlugin);
      // #233: UniverSheetsDrawingUIPlugin's `@DependentOn` graph pulls
      // UniverDocsDrawingPlugin in automatically, but Univer's PluginService
      // logs a noisy debug line for each unregistered dependent on every
      // boot. Register explicitly to silence it. The plugin is inert for
      // sheet-only Coco workbooks (no DOC unit).
      univer.registerPlugin(UniverDocsDrawingPlugin);
      univer.registerPlugin(UniverSheetsDrawingPlugin);
      univer.registerPlugin(UniverSheetsDrawingUIPlugin);

      // Create workbook from snapshot or default empty workbook. We pipe the
      // snapshot through `patchHyperlinkRenders` first so every cell listed in
      // `_hyperlinks` arrives at Univer pre-styled (blue + underline) with the
      // link label as its value. The patch is pure / idempotent — the round
      // -trip writer ignores the inline style we add since the `_hyperlinks`
      // array is its source of truth for re-emitting the actual <hyperlink>
      // elements on xlsx export.
      const initialData: Partial<IWorkbookData> = currentSnapshotJson
        ? patchShowFormulasView(
            patchShowAllCommentsView(
              patchErrorIndicators(
                patchCfRenders(
                  patchSparklineRenders(
                    patchTableRenders(
                      patchSlicerFilters(
                        patchFormControlRenders(
                          patchCheckboxRenders(
                            patchOutlineRenders(
                              patchHyperlinkRenders(JSON.parse(currentSnapshotJson)),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              showAllCommentsMode,
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
        captureCamera: () => captureCameraRef.current(),
      });

      // #179 (area C): rewrite Japanese function-name aliases (=合計(...) →
      // =SUM(...)) before the formula engine sees the cell edit.
      formulaNormalizerReg = registerFormulaNormalizer(univer);

      // Stash the live instance bundle so a StrictMode remount can reuse it
      // (see univerStashRef) instead of constructing a second Univer.
      univerStashRef.current = {
        univer,
        fUniver: fUniverRef.current,
        contextMenuReg,
        formulaNormalizerReg,
        disposeTimer: null,
      };
    } catch (e) {
      // Genuine creation failure — no stash exists yet, so dispose
      // synchronously here and leave univerStashRef null.
      formulaNormalizerReg?.dispose();
      contextMenuReg?.dispose();
      univer?.dispose();
      univerRef.current = null;
      fUniverRef.current = null;
      univerStashRef.current = null;
      setEditorInitError(String(e));
      return;
    }

    // Defer disposal onto a timer instead of disposing synchronously. A
    // StrictMode remount runs within the same commit and cancels this timer
    // (see the remount fast path above), reusing the instance; a real unmount
    // lets the timer fire and disposes for real. On Univer 0.5.x, disposing
    // synchronously here would tear down the `redi` injector while
    // `_initWorkbookListener` was still pending → "[redi]: Injector disposed".
    // Univer 0.24 no longer exposes that symbol; this guard's continued value
    // is tracked in issue #232.
    return () => {
      const s = univerStashRef.current;
      if (!s) return;
      s.disposeTimer = setTimeout(() => {
        s.formulaNormalizerReg?.dispose();
        s.contextMenuReg?.dispose();
        s.univer.dispose();
        univerRef.current = null;
        fUniverRef.current = null;
        univerStashRef.current = null;
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #179 (area E): hot-swap Univer's locale when the app language changes,
  // so the editor chrome (ribbon, menus, formula helper) updates without a
  // page reload. The Coco-side UI re-renders via App's useLocale().
  useEffect(() => {
    return subscribeLocale((locale) => {
      const univer = univerRef.current;
      if (univer) swapUniverLocale(univer, locale);
    });
  }, []);

  // #193 (Univer 0.8 dark mode): keep Univer's native dark-mode flag in sync
  // with Coco's effective theme. Initial value is seeded in the Univer ctor
  // above; this effect handles live flips (Settings dialog, OS color-scheme
  // change). Modeled on the locale hot-swap above so the editor never has to
  // be re-mounted on a theme change. ThemeService recolors the grid canvas
  // (row/col headers, gridlines, empty cells) and the surrounding chrome.
  useEffect(() => {
    const reapply = () => {
      const univer = univerRef.current;
      if (univer) setUniverDarkMode(univer, getEffectiveTheme());
    };
    // Re-apply on an explicit mode change (Settings dialog), and also follow
    // the OS color-scheme as it flips. `getEffectiveTheme()` resolves the
    // persisted mode against `prefers-color-scheme` on each call, so the
    // system subscription is a harmless no-op re-apply while the mode is an
    // explicit light / dark.
    const unsubChanged = onThemeChanged(reapply);
    const unsubSystem = subscribeSystemTheme(reapply);
    // Belt-and-suspenders: also reapply once right after subscribing. The
    // `new Univer({ darkMode })` constructor seed should already match
    // getEffectiveTheme(), but if a future Univer version changes the
    // semantics of that flag (e.g. ignores it, or defaults to `true`),
    // this self-heals on first paint instead of waiting for the user to
    // flip the theme. No-cost: setUniverDarkMode is idempotent.
    reapply();
    return () => {
      unsubChanged();
      unsubSystem();
    };
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
      // #184 C-1: `FWorkbook.save()` reconstructs the snapshot from Univer's
      // internal models, so it drops Coco's workbook-root extension keys
      // (`_cameraLinks`, `_scenarios`) that were written straight into the
      // store via `applyMutatedSnapshot` without a Univer re-mount. Re-graft
      // them from the prior store snapshot so a cell edit doesn't silently
      // wipe the user's camera links / scenarios.
      const fresh = JSON.stringify(workbook.save());
      const prev = useWorkbookStore.getState().currentSnapshotJson;
      updateSnapshot(carryForwardRootExtensions(fresh, prev));
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

    // Univer 0.24 (#13): migrated from `fUniver.onCommandExecuted(...)` to
    // `addEvent(Event.CommandExecuted, ...)`. The typed `ICommandEvent`
    // payload carries `{ id, type, params, options }` — same fields the
    // legacy callback's `info` argument exposed.
    const disposable = fUniver.addEvent(fUniver.Event.CommandExecuted, (info) => {
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

  // #131 — macro recorder hook. Subscribes to Univer's high-level COMMAND
  // stream (not MUTATION; replaying a COMMAND re-generates the right MUTATIONs
  // so undo + snapshot sync keep working). The observer is a no-op when the
  // recorder is idle, so the cost is one Set.has() per command.
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;
    // Univer 0.24 (#13): migrated from `fUniver.onCommandExecuted(...)` to
    // `addEvent(Event.CommandExecuted, ...)`. The legacy callback received
    // `(info, options)` as separate args; the typed `ICommandEvent` payload
    // folds `options` onto the same event object, so we read it from `info`.
    const disposable = fUniver.addEvent(fUniver.Event.CommandExecuted, (info) => {
      if (info.type !== CommandType.COMMAND) return;
      observeMacroCommand(info.id, info.params, {
        fromCollab: info.options?.fromCollab === true,
      });
    });
    return () => disposable.dispose();
  }, []);

  // #189 — script triggers. Books can embed JS snippets (snapshot._scripts)
  // that register onOpen / onEdit / timer triggers via the `Coco.*` API.
  // This effect:
  //   - onOpen : fires every registered onOpen handler once the workbook is
  //              ready (after a short settle delay so Facade is populated).
  //   - onEdit : hooks the MUTATION command stream and fires onEdit handlers
  //              with an EditEvent for each cell write. Protected sheets are
  //              still write-blocked inside ScriptApi.
  //   - timer  : schedules setInterval per registered timer trigger.
  // Triggers run through `fireTrigger` — #189 C2: in the browser this routes
  // through the sandboxed-iframe executor (handlers are kept inside the
  // iframe; the parent only sends fire-trigger messages). Each run is
  // appended to the execution log.
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;
    let disposed = false;
    const timerIds: ReturnType<typeof setInterval>[] = [];
    // Per-script collected triggers, refreshed when scripts change.
    let collected: CollectedTriggers[] = [];
    // C1 — re-entry guard. `fireAll("onEdit")` handlers may write cells,
    // which re-enters the MUTATION listener below. Without this flag every
    // onEdit-driven write would re-fire onEdit → infinite loop. Set for the
    // whole duration of an onEdit dispatch (which is serialized).
    let firingEdit = false;
    // M1 — per-timer "already running" guard so a slow handler doesn't pile
    // up overlapping runs when the interval is shorter than the run time.
    const timerRunning = new Set<string>();

    /** Resolve a sheet's display name from its id via the Facade. */
    const sheetNameById = (subUnitId: string): string => {
      try {
        const wb = fUniverRef.current?.getActiveWorkbook();
        const sheets =
          (wb as { getSheets?: () => unknown[] } | undefined)?.getSheets?.() ?? [];
        for (const s of sheets) {
          const sh = s as {
            getSheetId?: () => string;
            getSheetName?: () => string;
          };
          if (sh.getSheetId?.() === subUnitId) return sh.getSheetName?.() ?? "";
        }
      } catch {
        /* fall through */
      }
      return "";
    };

    /**
     * Fire `kind` triggers for every script that registered one. Runs are
     * serialized (awaited one after another) so onEdit dispatches finish
     * before the re-entry guard is lowered. After an unmount we skip
     * `recordRun` / logging so triggers don't leave side effects (M1).
     */
    const fireAll = async (
      kind: "onOpen" | "onEdit" | "timer",
      extra: { editEvent?: EditEvent } = {},
    ): Promise<void> => {
      const snapshot = snapshotRef.current;
      const scripts = readScripts(snapshot);
      for (const c of collected) {
        if (disposed) return;
        if (!c.triggers.some((t) => t.kind === kind)) continue;
        const entry = scripts.find((s) => s.id === c.scriptId);
        if (!entry) continue;
        const result = await fireTrigger(entry, kind, {
          fUniver: fUniverRef.current,
          snapshotJson: snapshotRef.current,
          editEvent: extra.editEvent,
        });
        // M1 — after unmount, don't record runs or write logs.
        if (disposed) return;
        recordRun(entry, kind, result);
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[script:${kind}] ${entry.name}: ${result.error}`);
        }
      }
    };

    /** (Re)collect triggers from the current snapshot, then arm timers. */
    const refresh = async () => {
      const scripts = readScripts(snapshotRef.current);
      const next: CollectedTriggers[] = [];
      for (const s of scripts) {
        try {
          next.push(
            await collectTriggers(s, {
              fUniver: fUniverRef.current,
              snapshotJson: snapshotRef.current,
            }),
          );
        } catch {
          /* skip scripts whose dry-run throws */
        }
      }
      if (disposed) return;
      collected = next;
      // Re-arm timers from scratch.
      for (const id of timerIds.splice(0)) clearInterval(id);
      timerRunning.clear();
      for (const c of collected) {
        for (const t of c.triggers) {
          if (t.kind !== "timer" || t.intervalMs <= 0) continue;
          // M1 — skip this tick if the previous run for this timer key is
          // still in flight; serialize via the timerRunning set.
          const key = `${c.scriptId}#${t.intervalMs}`;
          const id = setInterval(() => {
            if (disposed || timerRunning.has(key)) return;
            timerRunning.add(key);
            void fireAll("timer").finally(() => timerRunning.delete(key));
          }, t.intervalMs);
          timerIds.push(id);
        }
      }
    };

    // Initial collection + onOpen fire after the workbook settles.
    const openTimer = setTimeout(() => {
      void refresh().then(() => {
        if (!disposed) void fireAll("onOpen");
      });
    }, 400);

    // onEdit: hook MUTATION writes.
    // Univer 0.24 (#13): migrated from `fUniver.onCommandExecuted(...)` to
    // `addEvent(Event.CommandExecuted, ...)`. Payload fields match the
    // legacy `info` arg (`id`, `type`, `params`).
    const editDisposable = fUniver.addEvent(fUniver.Event.CommandExecuted, (info) => {
      // C1 — re-entry guard. onEdit handlers that write cells produce
      // MUTATIONs; without this early return they would re-trigger onEdit
      // forever. Skip MUTATIONs that occur while an onEdit dispatch runs.
      if (firingEdit) return;
      if (info.type !== CommandType.MUTATION) return;
      const { subUnitId, writes } = extractCellWrites(info.params);
      if (!subUnitId || writes.length === 0) return;
      if (!collected.some((c) => c.triggers.some((t) => t.kind === "onEdit"))) return;
      const sheetName = sheetNameById(subUnitId);
      // Serialize all writes' onEdit dispatches, then lower the guard.
      firingEdit = true;
      void (async () => {
        try {
          for (const w of writes) {
            if (disposed) break;
            await fireAll("onEdit", {
              editEvent: {
                sheetName,
                a1: toA1(w.row, w.col),
                row: w.row,
                col: w.col,
                value: w.value,
              },
            });
          }
        } finally {
          firingEdit = false;
        }
      })();
    });

    return () => {
      disposed = true;
      clearTimeout(openTimer);
      for (const id of timerIds) clearInterval(id);
      timerRunning.clear();
      editDisposable.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSnapshotJson]);

  // #186 — global-shortcut macro playback. `useGlobalShortcuts` (App level)
  // detects Ctrl/Cmd+Shift+1..9 and emits the bound macro id; we own the
  // Univer executor so we resolve the macro from the (encrypted) store and
  // replay it here. Destructive macros still prompt before running.
  useEffect(() => {
    const unsub = onMacroPlayRequested((macroId) => {
      void (async () => {
        const fUniver = fUniverRef.current;
        if (!fUniver) return;
        const { macros } = await loadMacrosSecure();
        const macro = macros.find((m) => m.id === macroId);
        if (!macro) return;
        if (summariseMacroDestructive(macro.events).length > 0) {
          const ok = window.confirm(
            `「${macro.name}」には破壊的な操作が含まれます。実行しますか？`,
          );
          if (!ok) return;
        }
        await playbackMacro(macro.events, {
          executeCommand: (id, params) =>
            fUniver.executeCommand(id, (params ?? undefined) as object | undefined),
        });
      })();
    });
    return () => unsub();
  }, []);

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

    // Univer 0.24 (#13): migrated from `fUniver.onBeforeCommandExecute(...)`
    // to `addEvent(Event.BeforeCommandExecute, ...)`. The typed
    // `ICommandEvent` payload exposes the same `{ id, type, params, options }`
    // fields the legacy `info` argument carried, and throwing
    // `CustomCommandExecutionError` from the handler still politely cancels
    // the mutation via Univer's CommandService.
    const disposable = fUniver.addEvent(fUniver.Event.BeforeCommandExecute, (info) => {
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

    // Univer 0.24 (#13): migrated from `fUniver.onBeforeCommandExecute(...)`
    // to `addEvent(Event.BeforeCommandExecute, ...)`. Same `ICommandEvent`
    // payload as the sheet-protection hook above.
    const disposable = fUniver.addEvent(fUniver.Event.BeforeCommandExecute, (info) => {
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
  // behavior. Univer 0.6+ deprecated `FWorkbook.onCellClick` in favor of
  // `univerAPI.addEvent(univerAPI.Event.CellClicked, …)` (FEventRegistry
  // refactor, #4616 — finalized in 0.24); we subscribe through that path so
  // we keep working when the deprecated mixin is eventually removed. The
  // event params carry `{ workbook, worksheet, row, column, location }` —
  // we read subUnitId off `location` to keep the rest of the handler
  // unchanged. External links go through the Rust `open_url` command
  // (cmd /c start | open | xdg-open, scheme-allowlisted to http(s) / mailto
  // / file in shell.rs). Internal `#Sheet!A1` targets route through the
  // facade itself (setActiveSheet + setActiveRange) so the jump stays in-app.
  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;

    // Univer #4616: `addEvent` is the canonical subscription API; the
    // typed Event registry guarantees CellClicked params shape — but the
    // typed surface is only `{ workbook, worksheet, row, column }`, so we
    // derive subUnitId from the worksheet rather than digging into the
    // spread `location` field that's present at runtime but not typed.
    const disposable = fUniver.addEvent(fUniver.Event.CellClicked, (params) => {
      const subUnitId = params.worksheet?.getSheetId();
      const row = params.row;
      const col = params.column;
      if (typeof subUnitId !== "string" || typeof row !== "number" || typeof col !== "number") {
        return;
      }
      // #150: checkbox toggle takes priority over hyperlink follow. A cell
      // can't sensibly be both. Honour sheet protection — the
      // beforeCommandExecute guard would block the mutation anyway, but
      // bailing here avoids a stale snapshot push.
      if (hasCheckbox(snapshotRef.current, subUnitId, row, col)) {
        if (isSheetProtectedInSnapshot(snapshotRef.current, subUnitId)) return;
        const result = toggleCheckboxInSnapshot(
          snapshotRef.current,
          subUnitId,
          row,
          col,
        );
        if (!result.changed) return;
        applyMutatedSnapshot(JSON.stringify(result.snapshot));
        return;
      }
      // #183: form-control activation. Radio → select; spin → step +1;
      // scroll → step +1 page. Click is the coarse interaction; the keyboard
      // handler offers finer control (arrows / Space). Sheet protection blocks
      // the mutation just like the checkbox path.
      const fc = getFormControlAt(snapshotRef.current, subUnitId, row, col);
      if (fc) {
        if (isSheetProtectedInSnapshot(snapshotRef.current, subUnitId)) return;
        let result;
        if (fc.kind === "radio") {
          result = selectRadio(snapshotRef.current, subUnitId, row, col);
        } else {
          // Spin steps by one; scroll bar steps by one page on a plain click.
          result = stepControl(
            snapshotRef.current,
            subUnitId,
            row,
            col,
            1,
            fc.kind === "scroll",
          );
        }
        if (result.changed) {
          applyMutatedSnapshot(JSON.stringify(result.snapshot));
        }
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
      // the target with the visible name so this lines up. We prefer the
      // event's `workbook` over the captured `getActiveWorkbook()` so a
      // workbook swap mid-effect still routes to the live instance.
      try {
        const target = params.workbook.getSheetByName(classified.sheet);
        if (!target) return;
        params.workbook.setActiveSheet(target);
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
    // The post-0.24 `addEvent` registers on the FUniver (not a specific
    // workbook), and `params.workbook` inside the handler resolves to the
    // event-bound live workbook, so the listener is workbook-swap-safe
    // without re-binding on currentHandle. The pre-0.24 `onCellClick`
    // mixin closed over `getActiveWorkbook()` at register-time, which IS
    // why this dep array used to read `[currentHandle]`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Smart chips (#158 MVP + #185 user-extensible rules). Lazy hover-driven
  // detection: we wire the sheets-ui `onCellHover` facade event, look up
  // chips for the hovered (sheetId, row, col), and surface them in
  // SmartChipPopover. The detector reads the snapshot ref so we always see
  // the freshest cell values without re-binding on every snapshot mutation.
  //
  // Detection runs only on hover — no eager walk of the grid — so a 1M-row
  // workbook pays nothing until the user points at a cell. The detector is
  // O(cell-text-length) with a hard 8 KB bail-out, and the custom-rule pass
  // (#185) is bounded by MAX_MATCHES_PER_CELL + a ReDoS-shape rejection in
  // customSmartChipRules.ts, so even pathological rules stay cheap.
  const [smartChipState, setSmartChipState] = useState<{
    chips: SmartChip[];
    anchor: SmartChipPopoverAnchor | null;
    sheetId: string;
    row: number;
    col: number;
  } | null>(null);

  useEffect(() => {
    if (!fUniverRef.current) return;
    const fUniver = fUniverRef.current;

    // Univer #4616 / #13 (0.24): use `addEvent(Event.CellHover)` instead of
    // the deprecated `FWorkbook.onCellHover` mixin. Univer 0.24's
    // `currentRichText$` source strips `event` before dispatch (only
    // `currentCellPosWithEvent$` for `CellPointerMove` carries it), so the
    // runtime payload here exposes `{ workbook, worksheet, row, column,
    // rect, ... }` — no cursor position. We anchor to the cell's bounding
    // rect (`rect.endX` / `rect.endY` in viewport pixels) so the popover
    // sits at the cell's bottom-right, which is also a more stable UX than
    // a cursor-tracking popover that jumps with every pixel of mouse
    // movement.
    const disposable = fUniver.addEvent(fUniver.Event.CellHover, (params) => {
      const subUnitId = params.worksheet?.getSheetId();
      const row = typeof params.row === "number" ? params.row : null;
      const col = typeof params.column === "number" ? params.column : null;
      if (typeof subUnitId !== "string" || row === null || col === null) {
        setSmartChipState(null);
        return;
      }
      // Skip re-detect when hovering the same cell: avoids re-running the
      // detector + re-rendering the popover on every mousemove pixel.
      setSmartChipState((prev) => {
        if (
          prev &&
          prev.sheetId === subUnitId &&
          prev.row === row &&
          prev.col === col
        ) {
          return prev;
        }
        const chips = smartChipsForCell(
          snapshotRef.current,
          subUnitId,
          row,
          col,
        );
        if (chips.length === 0) return null;
        // Anchor to the cell's bounding rect carried in params (typed as
        // `IHoverRichTextPosition.rect: { startX, startY, endX, endY }` in
        // viewport pixels). Sit the popover at the cell's bottom-right
        // corner with a small gap so it doesn't overlap the cell content
        // and stays stable as the cursor moves within the cell. Falls
        // back to (24, 24) only if Univer doesn't surface a rect.
        const rect = (params as unknown as {
          rect?: { endX?: number; endY?: number };
        }).rect;
        const x = typeof rect?.endX === "number" ? rect.endX + 4 : 24;
        const y = typeof rect?.endY === "number" ? rect.endY + 4 : 24;
        return {
          chips,
          anchor: { x, y },
          sheetId: subUnitId,
          row,
          col,
        };
      });
    });

    return () => disposable.dispose();
    // Same workbook-swap-safety rationale as the CellClicked effect above:
    // addEvent is on FUniver and the handler reads `params.workbook`
    // implicitly via `snapshotRef.current`, so re-binding on currentHandle
    // is just churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Action handler for a chip pick. URLs / emails / custom-rule URLs go
  // through the existing `open_url` Tauri command (which enforces a scheme
  // allowlist of http(s)/mailto in shell.rs — custom rule templates are
  // validated to http(s) up-front, so they pass). Dates pop a tiny
  // prompt-based picker for the MVP — the user sees the chip's ISO value
  // and can confirm/edit it; we then write it back via the Univer facade.
  const handleSmartChipActivate = useCallback(
    (chip: SmartChip) => {
      const url = smartChipActionUrl(chip);
      if (url) {
        invoke("open_url", { url }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("smart-chip open_url failed:", err);
        });
        setSmartChipState(null);
        return;
      }
      if (chip.kind === "date" && smartChipState) {
        const current = chip.iso ?? "";
        // window.prompt is the MVP-minimal "calendar picker". It accepts
        // YYYY-MM-DD; we re-detect via Date.parse so the user can also
        // type "May 20, 2026" and get a normalized date written back.
        const input = window.prompt(
          "日付を編集 (YYYY-MM-DD)",
          current,
        );
        if (input === null) {
          setSmartChipState(null);
          return;
        }
        const trimmed = input.trim();
        if (!trimmed) {
          setSmartChipState(null);
          return;
        }
        const parsed = Date.parse(trimmed);
        if (!Number.isFinite(parsed)) {
          // eslint-disable-next-line no-console
          console.warn("smart-chip date parse failed:", trimmed);
          setSmartChipState(null);
          return;
        }
        const d = new Date(parsed);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        try {
          const fUniver = fUniverRef.current;
          const workbook = fUniver?.getActiveWorkbook();
          const sheet = workbook?.getActiveSheet();
          const range = sheet?.getRange(smartChipState.row, smartChipState.col);
          if (range) range.setValue(iso);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("smart-chip date write failed:", err);
        }
        setSmartChipState(null);
      }
    },
    [smartChipState],
  );

  const statusLabel = SAVE_STATUS_LABELS[saveStatus] ?? saveStatus;
  const statusClass = `status-bar__status status-bar__status--${saveStatus}`;
  // #94: memoize the stats parse so unrelated re-renders don't pay the cost
  // of re-parsing the full snapshot.
  const statsLabel = useMemo(
    () => formatSnapshotStats(computeSnapshotStats(currentSnapshotJson)),
    [currentSnapshotJson],
  );

  const fileName = currentHandle?.path
    ? currentHandle.path.split(/[\\/]/).pop() ?? "無題のワークブック"
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
      {/* #177: ARIA live regions for screen-reader announcements. */}
      <LiveRegion />
      {/* #198 / #202: Excel-like ribbon — replaces the flat toolbar's
          per-feature buttons and the removed native menu bar. The "← Home"
          navigation and file name are folded into the ribbon's tab strip
          (one row saved). The Name Box lives in the formula bar below. */}
      <Ribbon
        onUniverAction={handleUniverAction}
        onGoHome={goHomeAfterConfirm}
        fileLabel={fileLabel}
        filePath={currentHandle?.path ?? undefined}
      />
      <FormulaBar
        activeSheetName={navActiveSheetName}
        activeCellRef={navActiveCellRef}
        availableNamedRanges={readNamedRanges().map((r) => ({
          name: r.name,
          target: r.formula,
        }))}
        onNavigate={handleGoToNavigate}
        cellText={formulaBarText}
        onCommit={handleFormulaBarCommit}
      />
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
        <InGridChartLayer
          workbookSnapshotJson={currentSnapshotJson}
          activeSheetId={activeSheetId}
          onChartChange={handleChartAnchorChange}
        />
        <CommentIndicatorsPanel
          indicators={commentIndicators}
          onSelect={jumpToCommentCell}
        />
        <SmartChipPopover
          chips={smartChipState?.chips ?? []}
          anchor={smartChipState?.anchor ?? null}
          onActivate={handleSmartChipActivate}
          onDismiss={() => setSmartChipState(null)}
        />
        <ChartPreviewPanel
          previews={chartPreviews}
          onSelect={jumpToChartRange}
        />
        <ImagePreviewPanel
          images={imagePreviews}
          onSelect={jumpToImageCell}
        />
        <TextBoxesPanel
          textBoxes={activeSheetTextBoxes}
          sheetName={navActiveSheetName}
          onSelect={jumpToTextBoxCell}
          onDelete={(tb) => removeTextBox(tb.id)}
          onPatch={patchTextBox}
          onGroup={groupTextBoxes}
        />
        {cameraPanelOpen && currentSnapshotJson && (
          <CameraLinksPanel
            workbookSnapshotJson={currentSnapshotJson}
            sheetNamesById={sheetNamesById}
            onJumpToSource={jumpToCameraSource}
            onJumpToDest={jumpToCameraDest}
            onDelete={deleteCameraLink}
          />
        )}
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
            onClearSelection={clearSlicer}
            onSelectAll={selectAllSlicer}
            onInvertSelection={invertSlicer}
            onClearAllSlicers={clearAllSlicersHandler}
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
        {bookmarksPanelOpen && (
          <BookmarksPanel
            workbookId={bookmarkWorkbookId}
            sheetNamesById={sheetNamesById}
            onJumpTo={jumpToA1OnSheet}
            onRequestAddCurrent={addCurrentCellAsBookmark}
          />
        )}
        {showAllCommentsMode && currentSnapshotJson && (
          <CommentsAllOverlay
            workbookSnapshotJson={currentSnapshotJson}
            onJumpTo={jumpToA1OnSheet}
            onClose={() => setShowAllCommentsMode(false)}
          />
        )}
        {BUSY_LABELS[saveStatus] && (
          <BusyOverlay
            label={BUSY_LABELS[saveStatus]!.label}
            blocking={BUSY_LABELS[saveStatus]!.blocking}
          />
        )}
      </div>
      <div
        className="status-bar"
        role="status"
        aria-label={t("a11y.label.statusBar")}
      >
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
        {/* #192: live aggregates for the current multi-cell selection. */}
        <StatusBarStats stats={selectionStats} />
        {/* #116: surface the calc-mode setting in the status bar so users can
            see Manual mode at a glance + click to open the options dialog. */}
        <CalculationModeIndicator
          mode={calcMode}
          onClick={() => setCalcOptionsOpen(true)}
        />
        {/* Auto-update status (non-blocking). Hidden while idle. */}
        {updaterState.kind === "checking" && (
          <span className="status-bar__update" role="status" aria-live="polite">
            · {t("status.update.checking")}
          </span>
        )}
        {updaterState.kind === "downloading" && (
          <span className="status-bar__update" role="status" aria-live="polite">
            · {t("status.update.downloading")} {Math.round(updaterState.progress * 100)}%
          </span>
        )}
        {updaterState.kind === "ready" && (
          <button
            type="button"
            className="status-bar__update status-bar__update--ready"
            onClick={() => { void relaunchApp(); }}
            title={t("status.update.ready")}
          >
            · {t("status.update.ready")}
          </button>
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
      {inquireOpen && (
        <WorkbookInquireDialog
          snapshotJson={currentSnapshotJson ?? ""}
          onClose={() => setInquireOpen(false)}
        />
      )}
      {macroDialogOpen && (
        <MacroDialog
          executor={
            fUniverRef.current
              ? {
                  // Adapter — FUniver.executeCommand is generic over `P extends
                  // object` but our recorded params are `unknown` JSON blobs.
                  // We cast through `object` because Univer's commands accept
                  // plain JSON-shaped objects for the whitelisted ids.
                  executeCommand: (id, params) =>
                    fUniverRef.current!.executeCommand(
                      id,
                      (params ?? undefined) as object | undefined,
                    ),
                }
              : null
          }
          onClose={() => setMacroDialogOpen(false)}
        />
      )}
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
      {shapeDialog && (
        <InsertShapeDialog
          initialCell={shapeDialog.cell}
          onApply={applyShape}
          onClose={() => setShapeDialog(null)}
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
      {solverState && (
        <SolverDialog
          initialObjectiveCell={solverState.objectiveCell}
          initialChangingCell={solverState.changingCell}
          runAdapter={solverState.adapter}
          onCommit={() => {
            const fUniver = fUniverRef.current;
            const wb = fUniver?.getActiveWorkbook();
            if (wb) {
              applyMutatedSnapshot(JSON.stringify(wb.save()));
            }
            setSolverState(null);
          }}
          onClose={() => setSolverState(null)}
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
          availablePivots={availableSlicerPivots}
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
      {scriptEditorOpen && (
        <ScriptEditorDialog
          scripts={readScripts(currentSnapshotJson)}
          fUniver={fUniverRef.current}
          snapshotJson={currentSnapshotJson}
          onChange={(next: ScriptEntry[]) => {
            // _scripts はワークブックメタ (シートと独立) なので、現在の
            // snapshot に書き戻して updateSnapshot で永続化する。
            const nextJson = writeScripts(currentSnapshotJson, next);
            updateSnapshot(nextJson);
          }}
          onClose={() => setScriptEditorOpen(false)}
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
        // #106: derive scenarios LIST from the live snapshot at render time
        // (not closure-captured at open time). Mutating handlers re-read
        // the live snapshot inside their bodies so rapid add/delete sequences
        // don't drop entries to a stale base.
        const liveWb = fUniverRef.current?.getActiveWorkbook();
        const liveSnap = (liveWb ? liveWb.save() : {}) as unknown as WorkbookScenarioSnapshot;
        const scenarios = listScenarios(liveSnap);
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
              const wb2 = fUniverRef.current?.getActiveWorkbook();
              if (!wb2) return;
              const freshSnap = wb2.save() as unknown as WorkbookScenarioSnapshot;
              const next = addScenario(freshSnap, full);
              applyMutatedSnapshot(JSON.stringify({ ...(freshSnap as unknown as object), _scenarios: next._scenarios }));
            }}
            onDelete={(name) => {
              const wb2 = fUniverRef.current?.getActiveWorkbook();
              if (!wb2) return;
              const freshSnap = wb2.save() as unknown as WorkbookScenarioSnapshot;
              const next = removeScenario(freshSnap, name);
              applyMutatedSnapshot(JSON.stringify({ ...(freshSnap as unknown as object), _scenarios: next._scenarios }));
            }}
            onSummary={() => {
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
      {analysisToolpakDialog && (
        <AnalysisToolpakDialog
          initialRange={analysisToolpakDialog.initialRange}
          onApply={(p) => {
            applyAnalysisToolpak(p);
            setAnalysisToolpakDialog(null);
          }}
          onClose={() => setAnalysisToolpakDialog(null)}
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
      {spellCheckOpen && (
        <SpellCheckDialog
          issues={spellCheckIssues}
          onChange={applySpellCheckReplacement}
          onIgnore={() => {}}
          onIgnoreAll={() => {}}
          onAddToDictionary={(w) => addToUserDictionary(w)}
          onJumpToCell={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setSpellCheckOpen(false);
          }}
          onClose={() => setSpellCheckOpen(false)}
        />
      )}
      {dataFormDialog && (
        <DataFormDialog
          range={dataFormDialog.rangeLabel}
          columnHeaders={dataFormDialog.headers}
          initialRows={dataFormDialog.rows}
          onCommitRow={(rowIdx, row) => {
            const fUniver = fUniverRef.current;
            const wb = fUniver?.getActiveWorkbook();
            if (!wb) return;
            const snap = wb.save() as unknown as { sheets?: Record<string, { cellData?: SnapshotCellData }> };
            const sheetObj = snap.sheets?.[dataFormDialog.sheetId];
            if (!sheetObj) return;
            const { newCellData } = writeRow(sheetObj.cellData, dataFormDialog.range, rowIdx, row, dataFormDialog.hasHeader);
            sheetObj.cellData = newCellData;
            applyMutatedSnapshot(JSON.stringify(snap));
            setDataFormDialog((d) =>
              d ? { ...d, rows: d.rows.map((r, i) => (i === rowIdx ? { ...row } : r)) } : d,
            );
          }}
          onAddRow={() => {
            const fUniver = fUniverRef.current;
            const wb = fUniver?.getActiveWorkbook();
            if (!wb) return;
            const snap = wb.save() as unknown as { sheets?: Record<string, { cellData?: SnapshotCellData }> };
            const sheetObj = snap.sheets?.[dataFormDialog.sheetId];
            if (!sheetObj) return;
            const { newCellData } = appendBlankRow(sheetObj.cellData, dataFormDialog.range, dataFormDialog.hasHeader);
            sheetObj.cellData = newCellData;
            applyMutatedSnapshot(JSON.stringify(snap));
            setDataFormDialog((d) =>
              d
                ? {
                    ...d,
                    range: { ...d.range, r2: d.range.r2 + 1 },
                    rows: [...d.rows, {}],
                  }
                : d,
            );
          }}
          onDeleteRow={(rowIdx) => {
            const fUniver = fUniverRef.current;
            const wb = fUniver?.getActiveWorkbook();
            if (!wb) return;
            const snap = wb.save() as unknown as { sheets?: Record<string, { cellData?: SnapshotCellData }> };
            const sheetObj = snap.sheets?.[dataFormDialog.sheetId];
            if (!sheetObj) return;
            sheetObj.cellData = deleteRowAt(sheetObj.cellData, dataFormDialog.range, rowIdx, dataFormDialog.hasHeader);
            applyMutatedSnapshot(JSON.stringify(snap));
            setDataFormDialog((d) =>
              d
                ? {
                    ...d,
                    range: { ...d.range, r2: Math.max(d.range.r1, d.range.r2 - 1) },
                    rows: d.rows.filter((_, i) => i !== rowIdx),
                  }
                : d,
            );
          }}
          onClose={() => setDataFormDialog(null)}
        />
      )}
      {findReplaceAllDialog && (
        <FindReplaceAllDialog
          activeSheetId={findReplaceAllDialog.activeSheetId}
          workbookSnapshotJson={currentSnapshotJson ?? "{}"}
          onReplaceCommit={(json) => applyMutatedSnapshot(json)}
          onJumpToCell={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setFindReplaceAllDialog(null);
          }}
          onClose={() => setFindReplaceAllDialog(null)}
        />
      )}
      {smartDateDialog && (
        <SmartDateDialog
          initialRange={smartDateDialog.range}
          samplePreview={smartDatePreview}
          onConfigChange={(config) => {
            const rect = parseRectFromA1(config.range) ?? smartDateDialog.rangeRect;
            setSmartDatePreview(buildSmartDatePreview(smartDateDialog.sheetId, rect, config.locale, config.outputFormat));
          }}
          onApply={(params) => {
            applySmartDate(params);
            setSmartDateDialog(null);
          }}
          onClose={() => setSmartDateDialog(null)}
        />
      )}
      {convertToRangeDialog && (
        <ConvertToRangeDialog
          tables={convertToRangeDialog.tables}
          onApply={({ sheetId, tableName, preserveStyles }) => {
            if (!currentSnapshotJson) return;
            try {
              const snap = JSON.parse(currentSnapshotJson);
              const { snapshotMutated } = applyConvertToRange(snap, sheetId, { tableName, preserveStyles });
              applyMutatedSnapshot(JSON.stringify(snapshotMutated));
            } catch {
              // best-effort
            }
            setConvertToRangeDialog(null);
          }}
          onClose={() => setConvertToRangeDialog(null)}
        />
      )}
      {documentInspectorOpen && currentSnapshotJson && (
        <DocumentInspectorDialog
          inspections={documentInspections}
          onStrip={(cat: InspectionCategory) => {
            const { snapshotMutated, strippedCount } = stripCategory(currentSnapshotJson, cat);
            if (strippedCount > 0) {
              const json = JSON.stringify(snapshotMutated);
              applyMutatedSnapshot(json);
              setDocumentInspections(inspectDocument(json));
            }
          }}
          onJumpTo={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setDocumentInspectorOpen(false);
          }}
          onReinspect={() => setDocumentInspections(inspectDocument(currentSnapshotJson))}
          onClose={() => setDocumentInspectorOpen(false)}
        />
      )}
      {bulkCleanDialog && (
        <BulkCleanDialog
          initialRange={bulkCleanDialog.range}
          preview={bulkCleanDialog.preview}
          onApply={(params) => {
            applyBulkCleanAction(params);
            setBulkCleanDialog(null);
          }}
          onClose={() => setBulkCleanDialog(null)}
        />
      )}
      {csvWizard && (
        <CsvImportWizardDialog
          filePath={csvWizard.filePath}
          previewBytes={csvWizard.previewBytes}
          onImport={async () => {
            await importCsv(csvWizard.filePath);
            setCsvWizard(null);
          }}
          onClose={() => setCsvWizard(null)}
        />
      )}
      {goToOpen && (
        <div
          className="sd-backdrop"
          onClick={() => setGoToOpen(false)}
          style={{ alignItems: "flex-start", paddingTop: 80 }}
        >
          <div
            className="sd-modal"
            role="dialog"
            aria-modal="true"
            style={{ maxWidth: 480 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="sd-header">
              <h2 className="sd-title">ジャンプ / 名前ボックス</h2>
              <button type="button" className="sd-close" onClick={() => setGoToOpen(false)} aria-label="閉じる">
                ×
              </button>
            </header>
            <div className="sd-body">
              <NavigationBox
                activeSheetName={(() => {
                  try {
                    return fUniverRef.current?.getActiveWorkbook()?.getActiveSheet()?.getSheetName() ?? "Sheet1";
                  } catch {
                    return "Sheet1";
                  }
                })()}
                activeCellRef={activeSelectionA1 || "A1"}
                availableNamedRanges={readNamedRanges().map((r) => ({ name: r.name, target: r.formula }))}
                onNavigate={handleGoToNavigate}
              />
              <p className="sd-hint" style={{ marginTop: 12 }}>
                セル参照 (例: B5)、シート修飾 (Sheet2!A1)、範囲 (A1:C10)、名前付き範囲が使えます。
              </p>
            </div>
          </div>
        </div>
      )}
      {sheetImportOpen && (
        <SheetImportDialog
          onApply={(filePath, sheetNames) => {
            void applySheetImport(filePath, sheetNames);
            setSheetImportOpen(false);
          }}
          onClose={() => setSheetImportOpen(false)}
        />
      )}
      {getTransformOpen && (
        <GetTransformDialog
          snapshotJson={currentSnapshotJson}
          onApply={(newSnapshotJson) => {
            applyMutatedSnapshot(newSnapshotJson);
            setGetTransformOpen(false);
          }}
          onClose={() => setGetTransformOpen(false)}
        />
      )}
      {dataConnectionsOpen && (
        <DataConnectionsDialog
          snapshotJson={currentSnapshotJson}
          onAdd={handleDataConnectionAdd}
          onRefresh={handleDataConnectionRefresh}
          onEdit={handleDataConnectionEdit}
          onRemove={handleDataConnectionRemove}
          onClose={() => setDataConnectionsOpen(false)}
        />
      )}
      {numberFormatManagerOpen && (
        <NumberFormatManagerDialog
          entries={numberFormatEntries}
          activeSelectionRange={activeSelectionA1}
          onRename={(oldCode, newCode) => {
            const { snapshotMutated, changedCount } = renameFormatCode(currentSnapshotJson ?? "", oldCode, newCode);
            if (changedCount > 0) replaceWorkbookSnapshot(JSON.stringify(snapshotMutated));
          }}
          onApplyToRange={(code, range) => {
            // Apply via existing applyMutatedSnapshot pattern — set _fmt on each cell in the range.
            // Simplified: just call applyMutatedSnapshot with a quick range-walk.
            try {
              const fUniver = fUniverRef.current;
              const wb = fUniver?.getActiveWorkbook();
              const sheet = wb?.getActiveSheet();
              if (!wb || !sheet) return;
              const sheetId = sheet.getSheetId();
              const fresh = wb.save() as unknown as {
                sheets?: Record<string, { cellData?: Record<string, Record<string, unknown>>; _fmt?: Record<string, Record<string, string>> }>;
              };
              const sheetObj = fresh.sheets?.[sheetId];
              if (!sheetObj) return;
              if (!sheetObj._fmt) sheetObj._fmt = {};
              const cleaned = range.includes("!") ? range.split("!").slice(1).join("!") : range;
              const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(cleaned.trim());
              if (!m) return;
              const colToIdx = (s: string) => {
                let n = 0;
                for (const c of s.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
                return n - 1;
              };
              const c1 = colToIdx(m[1]);
              const r1 = parseInt(m[2], 10) - 1;
              const c2 = m[3] ? colToIdx(m[3]) : c1;
              const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
              for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
                if (!sheetObj._fmt[String(r)]) sheetObj._fmt[String(r)] = {};
                for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
                  sheetObj._fmt[String(r)][String(c)] = code;
                }
              }
              applyMutatedSnapshot(JSON.stringify(fresh));
            } catch {
              // best-effort
            }
          }}
          onDelete={(code) => {
            const { snapshotMutated, clearedCount } = deleteFormatCode(currentSnapshotJson ?? "", code);
            if (clearedCount > 0) replaceWorkbookSnapshot(JSON.stringify(snapshotMutated));
          }}
          onClose={() => setNumberFormatManagerOpen(false)}
        />
      )}
      {rangeCompareState && (
        <RangeCompareDialog
          initialRangeA={rangeCompareState.initialA}
          initialRangeB={rangeCompareState.initialB}
          workbookSnapshotJson={rangeCompareState.snapshotJson}
          onJumpTo={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setRangeCompareState(null);
          }}
          onClose={() => setRangeCompareState(null)}
        />
      )}
      {insertSymbolCtx && (
        <InsertSymbolDialog
          onInsert={(char) => {
            applyInsertSymbol(char);
            setInsertSymbolCtx(null);
          }}
          onClose={() => setInsertSymbolCtx(null)}
        />
      )}
      {sheetNoteDialog && (
        <SheetNoteDialog
          sheetName={sheetNoteDialog.sheetName}
          initial={sheetNoteDialog.initial}
          defaultAuthor={resolveDefaultAuthor()}
          onSave={(text, author) => {
            if (!currentSnapshotJson) return;
            try {
              const snap = JSON.parse(currentSnapshotJson) as WorkbookNotesSnapshot;
              const next = text.trim()
                ? setSheetNote(snap, sheetNoteDialog.sheetId, text, author)
                : deleteSheetNote(snap, sheetNoteDialog.sheetId);
              applyMutatedSnapshot(JSON.stringify(next));
            } catch {
              // best-effort
            }
            setSheetNoteDialog(null);
          }}
          onDelete={() => {
            if (!currentSnapshotJson) return;
            try {
              const snap = JSON.parse(currentSnapshotJson) as WorkbookNotesSnapshot;
              applyMutatedSnapshot(JSON.stringify(deleteSheetNote(snap, sheetNoteDialog.sheetId)));
            } catch {
              // best-effort
            }
            setSheetNoteDialog(null);
          }}
          onClose={() => setSheetNoteDialog(null)}
        />
      )}
      {imageManagerOpen && currentSnapshotJson && (
        <ImageManagerDialog
          images={listAllImages(currentSnapshotJson)}
          onJumpTo={(sheetId, anchor) => {
            jumpToA1OnSheet(sheetId, anchor);
            setImageManagerOpen(false);
          }}
          onDelete={(sheetId, anchor) => {
            if (!currentSnapshotJson) return;
            try {
              const next = deleteImageInSnapshot(currentSnapshotJson, sheetId, anchor);
              applyMutatedSnapshot(JSON.stringify(next));
            } catch {
              // best-effort
            }
          }}
          onBulkDeleteOnSheet={(sheetId) => {
            if (!currentSnapshotJson) return;
            try {
              const { snapshotMutated } = bulkDeleteImagesOnSheet(currentSnapshotJson, sheetId);
              applyMutatedSnapshot(JSON.stringify(snapshotMutated));
            } catch {
              // best-effort
            }
          }}
          onExport={(image) => {
            void (async () => {
              try {
                const { save: saveDlg } = await import("@tauri-apps/plugin-dialog");
                const ext = (image.name.split(".").pop() ?? "png").toLowerCase();
                const chosen = await saveDlg({
                  title: "画像を書き出し",
                  defaultPath: image.name,
                  filters: [{ name: "Image", extensions: [ext] }],
                });
                if (!chosen) return;
                await exportImageToFile(image.name, image.bytesBase64, chosen);
                setEditorOperationError(`画像を書き出しました: ${chosen}`);
              } catch (e) {
                setEditorOperationError(`画像書き出しに失敗しました: ${(e as Error).message}`);
              }
            })();
          }}
          onClose={() => setImageManagerOpen(false)}
        />
      )}
      {templatesGalleryOpen && (
        <TemplatesGalleryDialog
          onUseTemplate={(id) => {
            void handleUseTemplate(id);
          }}
          onClose={() => setTemplatesGalleryOpen(false)}
        />
      )}
      {sortByColorDialog && (
        <SortByColorDialog
          initialRange={sortByColorDialog.range}
          sheetId={sortByColorDialog.sheetId}
          onApply={(params) => {
            applySortByColorAction(params);
            setSortByColorDialog(null);
          }}
          onClose={() => setSortByColorDialog(null)}
        />
      )}
      {filterByColorDialog && (
        <FilterByColorDialog
          initialRange={filterByColorDialog.range}
          sheetId={filterByColorDialog.sheetId}
          sheetSnapshot={filterByColorDialog.snapshot}
          onApply={(params) => {
            applyFilterByColorAction(params);
            setFilterByColorDialog(null);
          }}
          onClose={() => setFilterByColorDialog(null)}
        />
      )}
      {workbookStatsOpen && workbookStats && (
        <WorkbookStatsDialog
          stats={workbookStats}
          onRefresh={refreshWorkbookStats}
          onClose={() => setWorkbookStatsOpen(false)}
        />
      )}
      {quickPrintDialog && (
        <QuickPrintDialog
          snapshot={quickPrintDialog.snapshot}
          activeSheetId={quickPrintDialog.activeSheetId}
          onClose={() => setQuickPrintDialog(null)}
        />
      )}
      {hyperlinkManagerOpen && currentSnapshotJson && (
        <HyperlinkManagerDialog
          links={listAllHyperlinks(currentSnapshotJson)}
          onJumpTo={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setHyperlinkManagerOpen(false);
          }}
          onEdit={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setHyperlinkManagerOpen(false);
            openHyperlinkDialog();
          }}
          onDelete={(sheetId, cellRef) => {
            if (!currentSnapshotJson) return;
            try {
              const next = deleteHyperlinkInline(currentSnapshotJson, sheetId, cellRef);
              applyMutatedSnapshot(JSON.stringify(next));
            } catch {
              // best-effort
            }
          }}
          onBulkDelete={(kind) => {
            if (!currentSnapshotJson) return;
            try {
              const { snapshotMutated, deletedCount } = bulkDeleteHyperlinksByKind(currentSnapshotJson, kind);
              if (deletedCount > 0) applyMutatedSnapshot(JSON.stringify(snapshotMutated));
            } catch {
              // best-effort
            }
          }}
          onValidate={() => {
            const out: Record<string, boolean> = {};
            for (const l of listAllHyperlinks(currentSnapshotJson)) {
              out[`${l.sheetId}!${l.cellRef}`] = validateUrl(l.target).ok;
            }
            setHyperlinkValidation(out);
          }}
          validationResults={hyperlinkValidation}
          onClose={() => setHyperlinkManagerOpen(false)}
        />
      )}
      {bordersDialog && (
        <BordersDialog
          initialRange={bordersDialog.range}
          sheetId={bordersDialog.sheetId}
          onApply={(params) => {
            applyBordersFromDialog(params);
            setBordersDialog(null);
          }}
          onClose={() => setBordersDialog(null)}
        />
      )}
      {quickCfDialog && (
        <QuickCfDialog
          initialRange={quickCfDialog.range}
          sheetId={quickCfDialog.sheetId}
          onApply={(range, presetId) => {
            const ready = getReadyWorkbook("クイック条件付き書式");
            if (!ready) {
              setQuickCfDialog(null);
              return;
            }
            const fresh = ready.workbook.save() as unknown as object;
            const { snapshotMutated, ruleAdded } = applyQuickCfPreset(fresh, quickCfDialog.sheetId, range, presetId);
            if (ruleAdded) applyMutatedSnapshot(JSON.stringify(snapshotMutated));
            setQuickCfDialog(null);
          }}
          onClose={() => setQuickCfDialog(null)}
        />
      )}
      {cellLinkerCtx && (
        <CellLinkerDialog
          initialTargetCell={cellLinkerCtx.initialTargetCell}
          availableSheets={cellLinkerCtx.availableSheets}
          activeSheetId={cellLinkerCtx.activeSheetId}
          onApply={(params) => {
            applyCellLink(params);
            setCellLinkerCtx(null);
          }}
          onClose={() => setCellLinkerCtx(null)}
        />
      )}
      {filterSearchDialog && (
        <FilterSearchDialog
          initialRange={filterSearchDialog.range}
          sheetId={filterSearchDialog.sheetId}
          sheetSnapshot={filterSearchDialog.snapshot}
          onApply={(params) => {
            applyFilterSearchAction(params);
            setFilterSearchDialog(null);
          }}
          onClose={() => setFilterSearchDialog(null)}
        />
      )}
      {updaterState.kind === "available" && (
        <UpdateAvailableDialog
          currentVersion={updaterState.currentVersion}
          newVersion={updaterState.version}
          pubDate={updaterState.pubDate}
          notes={updaterState.notes}
          isForced={updaterState.isForced}
          onUpdate={() => {
            // Capture the target version so progress events can label it.
            const targetVersion = updaterState.kind === "available"
              ? updaterState.version
              : "";
            setUpdaterState({
              kind: "downloading",
              version: targetVersion,
              progress: 0,
              downloaded: 0,
              total: null,
            });
            void (async () => {
              try {
                // gateOverride=true: the user explicitly clicked Update, so
                // bypass the staged-rollout bucket check (auditor finding #A7).
                // Forced upgrades already bypass internally.
                await downloadAndInstall(({ downloaded, total }) => {
                  const progress = total && total > 0 ? downloaded / total : 0;
                  setUpdaterState({
                    kind: "downloading",
                    version: targetVersion,
                    progress,
                    downloaded,
                    total,
                  });
                }, true);
                setUpdaterState({ kind: "ready", version: targetVersion });
                // Offer immediate relaunch; user can decline (status bar
                // button stays visible until they restart manually).
                if (window.confirm(t("confirm.update.relaunch"))) {
                  await relaunchApp();
                }
              } catch (e) {
                setUpdaterState({ kind: "error", message: (e as Error).message });
                setEditorOperationError(`更新のダウンロードに失敗しました: ${(e as Error).message}`);
              }
            })();
          }}
          onSkip={() => {
            if (updaterState.kind === "available") {
              persistSkipVersion(updaterState.version);
            }
            setUpdaterState({ kind: "idle" });
          }}
          onLater={() => setUpdaterState({ kind: "idle" })}
          onClose={() => setUpdaterState({ kind: "idle" })}
        />
      )}
      {snapshotControlsState.open && (
        <SnapshotControlsDialog
          currentInterval={snapInterval}
          lastSnapshotAt={snapshotControlsState.lastSnapshotAt}
          snapshotCount={snapshotControlsState.snapshotCount}
          onIntervalChange={(next) => {
            setSnapInterval(next);
            persistInterval(next);
            void useWorkbookStore.getState().setAutoSaveInterval(snapshotIntervalToMs(next));
          }}
          onSnapshotNow={triggerSnapshotNow}
          onClose={() => setSnapshotControlsState((s) => ({ ...s, open: false }))}
        />
      )}
      {commentsManagerOpen && currentSnapshotJson && (
        <CommentsManagerDialog
          workbookSnapshotJson={currentSnapshotJson}
          onResolveToggle={resolveCommentInline}
          onDelete={deleteCommentInline}
          onBulkDeleteResolved={bulkDeleteResolvedAction}
          onJumpToCell={(sheetId, cellRef) => {
            jumpToA1OnSheet(sheetId, cellRef);
            setCommentsManagerOpen(false);
          }}
          onExportMarkdown={(text) => {
            void saveDialog({
              title: "コメントを Markdown にエクスポート",
              defaultPath: "comments.md",
              filters: [{ name: "Markdown", extensions: ["md"] }],
            }).then(async (path) => {
              if (!path) return;
              try {
                await invoke("plugin:fs|write_text_file", { path, contents: text });
              } catch {
                setEditorOperationError("コメント Markdown 出力に失敗しました。");
              }
            });
          }}
          onExportCsv={(text) => {
            void saveDialog({
              title: "コメントを CSV にエクスポート",
              defaultPath: "comments.csv",
              filters: [{ name: "CSV", extensions: ["csv"] }],
            }).then(async (path) => {
              if (!path) return;
              try {
                await invoke("plugin:fs|write_text_file", { path, contents: text });
              } catch {
                setEditorOperationError("コメント CSV 出力に失敗しました。");
              }
            });
          }}
          onClose={() => setCommentsManagerOpen(false)}
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
