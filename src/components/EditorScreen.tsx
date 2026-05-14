import { useEffect, useRef, useCallback, useState } from "react";
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

import SheetsEnUS from "@univerjs/sheets/locale/en-US";
import SheetsUIEnUS from "@univerjs/sheets-ui/locale/en-US";
import UIEnUS from "@univerjs/ui/locale/en-US";
import DocsUIEnUS from "@univerjs/docs-ui/locale/en-US";
import SheetsFormulaUIEnUS from "@univerjs/sheets-formula-ui/locale/en-US";
import FindReplaceEnUS from "@univerjs/find-replace/locale/en-US";
import SheetsFindReplaceEnUS from "@univerjs/sheets-find-replace/locale/en-US";

import "@univerjs/design/lib/index.css";
import "@univerjs/ui/lib/index.css";
import "@univerjs/docs-ui/lib/index.css";
import "@univerjs/sheets-ui/lib/index.css";
import "@univerjs/sheets-formula-ui/lib/index.css";
import "@univerjs/find-replace/lib/index.css";

import { undoRedoOverride } from "./univerUndoRedoOverride";
import { registerCocoContextMenu } from "./univerContextMenu";
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
} from "./hyperlinkRender";
import { patchCfRenders } from "./conditionalFormatRender";
import InsertCommentDialog, { type CommentEntry } from "./InsertCommentDialog";
import InsertChartDialog, { type ChartFormValue } from "./InsertChartDialog";
import NumberFormatDialog, { type NumberFormatValue } from "./NumberFormatDialog";
import InsertImageDialog, {
  type ImageFormValue,
  type ImagePickResult,
} from "./InsertImageDialog";
import SortDialog, { type SortFormValue } from "./SortDialog";
import SheetTabColorDialog from "./SheetTabColorDialog";
import CommentIndicatorsPanel from "./CommentIndicatorsPanel";
import { requestSettings, requestHelp } from "../hooks/useGlobalShortcuts";
import { timeAgoJa } from "./timeAgo";
import { computeSnapshotStats, formatSnapshotStats } from "../store/snapshotStats";
import { isSheetProtectedInSnapshot } from "../store/sheetProtection";
import { extractCellStyle, applyCellStyle } from "../store/formatPainter";
import {
  computeCommentIndicators,
  type CommentIndicator,
} from "../store/commentIndicators";
import { validateMutation, extractCellWrites } from "../store/dataValidation";
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
    isExporting,
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
  } = useWorkbookStore();

  const [sheetPicker, setSheetPicker] = useState<{ id: string; name: string }[] | null>(null);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
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
    existing: CommentEntry | null;
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
    setNamedRanges(readNamedRanges());
  }, [readNamedRanges]);

  // Data-validation dialog plumbing. We work directly on the snapshot JSON
  // rather than going through Univer because the @univerjs/sheets-data
  // -validation plugin isn't registered in this build and the round-trip
  // already drives off the snapshot's `_dataValidations[]` field. MVP scope:
  // target sheetOrder[0] (the typical single-sheet xlsx); a future cut can
  // surface a sheet picker.
  const openDataValidationDialog = useCallback(() => {
    if (!currentSnapshotJson) return;
    try {
      const snap = JSON.parse(currentSnapshotJson) as {
        sheetOrder?: string[];
        sheets?: Record<string, { name?: string; _dataValidations?: DataValidationEntry[] }>;
      };
      const sheetId = snap.sheetOrder?.[0];
      if (!sheetId || !snap.sheets || !snap.sheets[sheetId]) return;
      const sheet = snap.sheets[sheetId];
      const rules = Array.isArray(sheet._dataValidations)
        ? sheet._dataValidations.map((r) => ({ ...r }))
        : [];
      setDvDialog({ sheetId, sheetName: sheet.name ?? sheetId, rules });
    } catch {
      // Malformed snapshot — nothing we can edit; silently no-op.
    }
  }, [currentSnapshotJson]);

  const applyDataValidations = useCallback(
    (next: DataValidationEntry[]) => {
      if (!dvDialog || !currentSnapshotJson) return;
      try {
        const snap = JSON.parse(currentSnapshotJson) as {
          sheets?: Record<string, { _dataValidations?: DataValidationEntry[] }>;
        };
        if (!snap.sheets || !snap.sheets[dvDialog.sheetId]) return;
        const sheet = snap.sheets[dvDialog.sheetId];
        // Opt-in field: drop the key entirely when the list is empty so a
        // sheet that never had DV doesn't gain an empty array on round-trip
        // (mirrors the Rust side's emission policy in xlsx_io.rs).
        if (next.length === 0) {
          delete sheet._dataValidations;
        } else {
          sheet._dataValidations = next;
        }
        updateSnapshot(JSON.stringify(snap));
      } catch {
        // Snapshot got malformed between open and apply — discard the edit.
      }
    },
    [dvDialog, currentSnapshotJson, updateSnapshot],
  );

  // Conditional formatting is currently round-tripped at the snapshot level
  // (xlsx_io.rs preserves _conditionalFormatting per sheet). The Univer CF
  // plugin uses a different rule model (IRange + dxf-style IStyleBase), so for
  // this PoC we author into the snapshot directly: read → edit → write back via
  // updateSnapshot. Live highlighting is therefore deferred until save+reopen.
  const openCfDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, [currentSnapshotJson]);

  // Persist authored CF rules back into the workbook snapshot. We re-derive
  // the snapshot from the live Univer workbook (not the cached
  // currentSnapshotJson) so we don't clobber edits the user made while the
  // dialog was open, then splice in `_conditionalFormatting` for the target
  // sheet and push the result through updateSnapshot.
  const applyCfRules = useCallback(
    (sheetId: string, next: CfRule[]) => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const fresh = workbook.save() as unknown as {
        sheets: Record<string, Record<string, unknown>>;
      };
      const sheetObj = fresh.sheets?.[sheetId];
      if (!sheetObj) return;
      if (next.length === 0) {
        // Mirror the Rust "omit when empty" convention on the export side so
        // a sheet that loses all its rules doesn't keep a stray empty array.
        delete sheetObj._conditionalFormatting;
      } else {
        sheetObj._conditionalFormatting = next;
      }
      updateSnapshot(JSON.stringify(fresh));
    },
    [updateSnapshot],
  );

  // Snapshot the active sheet + cell when the user invokes Insert Hyperlink.
  // We pin both so the apply step targets the cell the user saw at open time,
  // even if focus moves while the dialog is up. Falls back to Sheet1!A1 when
  // there's no live selection.
  const openHyperlinkDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, []);

  // Append the new hyperlink to `sheets.<id>._hyperlinks` in the snapshot and
  // reload Univer from it. We go snapshot-level because Univer 0.5.x's facade
  // doesn't expose a stable hyperlink API; the round-trip path in xlsx_io.rs
  // (parse_xlsx_hyperlinks / build_hyperlink_from_snapshot) is the source of
  // truth for the shape: { cell, target, display?, tooltip? }.
  const applyHyperlink = useCallback(
    (value: HyperlinkFormValue) => {
      if (!hyperlinkCtx) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const sheets = (snapshot.sheets as Record<string, Record<string, unknown>> | undefined) ?? {};
      const sheetObj = sheets[hyperlinkCtx.sheetId];
      if (!sheetObj) return;
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
      updateSnapshot(JSON.stringify(snapshot));
    },
    [hyperlinkCtx, updateSnapshot],
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
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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

    let existing: CommentEntry | null = null;
    if (currentSnapshotJson) {
      try {
        const snap = JSON.parse(currentSnapshotJson) as {
          sheets?: Record<string, { _comments?: CommentEntry[] }>;
        };
        const arr = snap.sheets?.[sheetId]?._comments ?? [];
        existing = arr.find((c) => c.cell === cellRef) ?? null;
      } catch {
        // Bad snapshot JSON: treat as no existing comment; the apply path
        // also re-parses defensively so we don't poison the snapshot.
      }
    }
    setCommentDialog({ sheetId, cellRef, existing });
  }, [currentSnapshotJson]);

  // Apply (insert or update) a comment in the snapshot's `sheets.<id>._comments`
  // array. Matches by cell ref — if one exists for this cell, replace it;
  // otherwise append. Always re-stringifies and pushes back via updateSnapshot
  // so the save button enables and the auto-save path picks up the change.
  const applyComment = useCallback(
    (sheetId: string, entry: CommentEntry) => {
      if (!currentSnapshotJson) return;
      let snap: {
        sheets?: Record<string, { _comments?: CommentEntry[] }>;
      };
      try {
        snap = JSON.parse(currentSnapshotJson);
      } catch {
        return;
      }
      if (!snap.sheets) snap.sheets = {};
      if (!snap.sheets[sheetId]) snap.sheets[sheetId] = {};
      const list = snap.sheets[sheetId]._comments ?? [];
      const idx = list.findIndex((c) => c.cell === entry.cell);
      if (idx >= 0) {
        list[idx] = entry;
      } else {
        list.push(entry);
      }
      snap.sheets[sheetId]._comments = list;
      updateSnapshot(JSON.stringify(snap));
      // Persist the chosen author so the next new-comment dialog pre-fills it.
      if (entry.author && entry.author.trim()) {
        try {
          window.localStorage.setItem("coco.commentAuthor", entry.author.trim());
        } catch {
          // Best-effort: ignore quota / private-mode errors.
        }
      }
    },
    [currentSnapshotJson, updateSnapshot],
  );

  // Toggle sheet protection (read-only marker) on the active sheet. Writes
  // into `sheets.<id>._protected = { protected: true }` (or removes the key
  // entirely when turning protection off, mirroring the Rust "omit when
  // empty" convention). Round-trips through xlsx via `<sheetProtection
  // sheet="1"/>`. Password isn't surfaced in the toolbar — the snapshot
  // schema supports `password?: string` for future expansion.
  const toggleSheetProtection = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
    updateSnapshot(JSON.stringify(fresh));
  }, [updateSnapshot]);

  // Open the tab-color dialog targeting the active sheet. We re-derive the
  // snapshot from Univer so the dialog sees the current `_tabColor` even if
  // it was just changed in another flow. Display name comes from the facade.
  const openTabColorDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, []);

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
      updateSnapshot(JSON.stringify(fresh));
    },
    [updateSnapshot],
  );

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
        sheets?: Record<string, { _comments?: CommentEntry[] }>;
      };
      try {
        snap = JSON.parse(currentSnapshotJson);
      } catch {
        return;
      }
      const list = snap.sheets?.[sheetId]?._comments;
      if (!list) return;
      const next = list.filter((c) => c.cell !== cellRef);
      if (next.length === list.length) return;
      if (next.length === 0) {
        // Drop the key entirely so the round-trip stays clean (Rust side
        // omits `_comments` when empty).
        delete snap.sheets![sheetId]._comments;
      } else {
        snap.sheets![sheetId]._comments = next;
      }
      updateSnapshot(JSON.stringify(snap));
    },
    [currentSnapshotJson, updateSnapshot],
  );

  // Derive the comment indicator list from the live snapshot so the panel
  // updates whenever a comment is added, edited, or deleted. Re-derived on
  // every render keyed off currentSnapshotJson — the helper is pure JSON
  // parsing + a flatten and the snapshot churn rate is human-paced, so the
  // cost is negligible vs. the simplicity gain over memoization.
  const commentIndicators: CommentIndicator[] = computeCommentIndicators(
    currentSnapshotJson,
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

  // Open the chart dialog targeting the active sheet's current selection.
  // The Univer @univerjs/sheets-chart plugin isn't in this build, so the
  // dialog persists into `sheets.<id>._charts` (snapshot-level). The xlsx
  // round-trip preserves existing chart blobs byte-for-byte (xlsx_io.rs),
  // but newly authored entries are data-only — re-emitting chart OOXML is
  // out of scope here. Falls back to A1 if there's no live selection.
  const openChartDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, []);

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
      updateSnapshot(JSON.stringify(snapshot));
    },
    [chartDialog, updateSnapshot],
  );

  // Number-format dialog plumbing. Captures the active selection's bounding
  // rows/cols + the anchor cell's existing `_fmt` (so the dialog can pre-select
  // a preset) and stashes them in state. We pin coords at open time so the
  // user can confirm later even if focus moves.
  const openNumberFormatDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, [currentSnapshotJson]);

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
      updateSnapshot(JSON.stringify(snapshot));
    },
    [numFmtDialog, updateSnapshot],
  );

  // Insert-image dialog plumbing. Snapshots the active sheet + the top-left of
  // the active range so the image anchors at the user's actual cursor cell.
  const openImageDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, []);

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
  const applyImage = useCallback(
    (value: ImageFormValue) => {
      if (!imageDialog) return;
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
      const snapshot = workbook.save() as unknown as Record<string, unknown>;
      const sheetOrder = (snapshot.sheetOrder as string[] | undefined) ?? [];
      const sheetIdx = sheetOrder.indexOf(imageDialog.sheetId);
      if (sheetIdx < 0) return;
      const pos = a1ToColRow(value.cell);
      if (!pos) return;

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
        console.warn("InsertImage: sheet already has a drawing; skipping");
        return;
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

      updateSnapshot(JSON.stringify(snapshot));
    },
    [imageDialog, updateSnapshot],
  );

  // Open the sort dialog with the active sheet + a default range derived from
  // the current selection. Falls back to A1:A1 when there's no live selection.
  const openSortDialog = useCallback(() => {
    const fUniver = fUniverRef.current;
    if (!fUniver) return;
    const workbook = fUniver.getActiveWorkbook();
    if (!workbook) return;
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
  }, []);

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
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
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
      if (!sheetObj) return;
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

      updateSnapshot(JSON.stringify(snapshot));
    },
    [sortDialog, updateSnapshot],
  );

  // Format Painter: capture the anchor cell's style from the live workbook
  // snapshot and arm the tool. `mode` distinguishes single-shot vs sticky;
  // a fresh activation while already armed cycles through (single → sticky → idle).
  const activateFormatPainter = useCallback(
    (mode: "single" | "sticky") => {
      const fUniver = fUniverRef.current;
      if (!fUniver) return;
      const workbook = fUniver.getActiveWorkbook();
      if (!workbook) return;
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
    [],
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

  const handleFormatPainterDoubleClick = useCallback(() => {
    // Cancel any pending single-click activation; the double click wins.
    if (formatPainterClickTimerRef.current) {
      clearTimeout(formatPainterClickTimerRef.current);
      formatPainterClickTimerRef.current = null;
    }
    activateFormatPainter("sticky");
  }, [activateFormatPainter]);

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
        updateSnapshot(next);
      }
      if (formatPainterMode === "single") {
        deactivateFormatPainter();
      }
    });

    return () => disposable.dispose();
  }, [formatPainterMode, updateSnapshot, deactivateFormatPainter]);

  useAutoSave();

  // Keyboard shortcuts (req 4.6): Ctrl+S / Cmd+S = save; Ctrl+Shift+S / Cmd+Shift+S = save as.
  // Ctrl+F3 opens the named-ranges dialog — Excel's convention for "Name Manager".
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "s" || e.key === "S")) {
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
    const sheets = await listSheetNames();
    if (sheets.length === 0) return;
    if (sheets.length === 1) {
      await runCsvExport(sheets[0]);
      return;
    }
    setSheetPicker(sheets);
  }, [listSheetNames, runCsvExport]);

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
      for (const sheet of sheets) {
        const fileName = `${sanitize(sheet.name)}.csv`;
        // Cross-platform path join: use forward slash; both Windows and Unix
        // accept it in Tauri command paths.
        const path = `${dir}/${fileName}`;
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

    const univer = new Univer({
      theme: defaultTheme,
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: {
          ...SheetsEnUS,
          ...SheetsUIEnUS,
          ...UIEnUS,
          ...DocsUIEnUS,
          ...SheetsFormulaUIEnUS,
          ...FindReplaceEnUS,
          ...SheetsFindReplaceEnUS,
        },
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
      ? patchCfRenders(patchHyperlinkRenders(JSON.parse(currentSnapshotJson)))
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

    // Wire Coco-specific entries (Insert Comment / Hyperlink / Number Format)
    // into the cell context menu. We forward to the ref-held callbacks so
    // the menu always invokes the latest React-side dialog opener.
    const contextMenuReg = registerCocoContextMenu(univer, {
      openCommentDialog: () => openCommentDialogRef.current(),
      openHyperlinkDialog: () => openHyperlinkDialogRef.current(),
      openNumberFormatDialog: () => openNumberFormatDialogRef.current(),
    });

    return () => {
      contextMenuReg.dispose();
      univer.dispose();
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
    let timer: ReturnType<typeof setTimeout> | null = null;

    const disposable = fUniver.onCommandExecuted((info) => {
      if (info.type !== CommandType.MUTATION) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const workbook = fUniver.getActiveWorkbook();
        if (!workbook) return;
        updateSnapshot(JSON.stringify(workbook.save()));
      }, 300);
    });

    return () => {
      if (timer) clearTimeout(timer);
      disposable.dispose();
    };
  }, [updateSnapshot]);

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
  }, []);

  const statusLabel = SAVE_STATUS_LABELS[saveStatus] ?? saveStatus;
  const statusClass = `status-bar__status status-bar__status--${saveStatus}`;
  const statsLabel = formatSnapshotStats(computeSnapshotStats(currentSnapshotJson));

  const fileName = currentHandle?.path
    ? currentHandle.path.split(/[\\/]/).pop()
    : currentHandle?.sourceType === "xlsx"
    ? "xlsx 由来（未保存）"
    : "無題のワークブック";
  const isDirty = saveStatus === "unsaved";
  const fileLabel = isDirty ? `${fileName} •` : fileName;
  const isCocoFile = (currentHandle?.path ?? "").toLowerCase().endsWith(".coco");

  return (
    <div className="editor-screen">
      <div className="editor-toolbar">
        <div className="editor-toolbar__left">
          <button type="button" className="toolbar-btn" onClick={goHome} title="ホームへ戻る">
            ← ホーム
          </button>
          <span
            className="editor-toolbar__filename"
            title={currentHandle?.path ?? undefined}
          >
            {fileLabel}
          </span>
        </div>
        <div className="editor-toolbar__right">
          <button
            type="button"
            className="toolbar-btn toolbar-btn--primary"
            onClick={save}
            disabled={saveStatus === "saving"}
            title="同じパスに上書き保存 (Ctrl+S)"
          >
            保存
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={promptSaveAs}
            disabled={saveStatus === "saving"}
            title="保存先と形式（xlsx / .coco）を選んで保存 (Ctrl+Shift+S)"
          >
            別名保存
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={exportXlsx}
            disabled={isExporting}
            title="現在のブックを別名の xlsx として書き出す"
          >
            xlsx エクスポート
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={handleCsvExport}
            disabled={isExporting}
            title="シートを選んで CSV (UTF-8 BOM) として書き出す"
          >
            {isExporting ? "出力中..." : "CSV エクスポート"}
          </button>
          {isCocoFile && (
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setSnapshotsOpen(true)}
              title="保存履歴（.coco の過去 5 世代）"
              aria-label="スナップショット履歴"
            >
              履歴
            </button>
          )}
          <span className="toolbar-divider" aria-hidden="true" />
          {/* 編集系: 入力規則 / 条件付き書式 / 表示形式 / シート保護 */}
          <div className="toolbar-group" role="group" aria-label="編集">
            <button
              type="button"
              className="toolbar-btn"
              onClick={openDataValidationDialog}
              title="データの入力規則を追加・編集"
              aria-label="データの入力規則"
            >
              入力規則
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={openCfDialog}
              title="条件付き書式を編集 (Ctrl+F8)"
              aria-label="条件付き書式"
            >
              条件付き書式...
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={openNumberFormatDialog}
              title="選択範囲の表示形式を変更 (Ctrl+1)"
              aria-label="表示形式"
            >
              🔢 表示形式
            </button>
            <button
              type="button"
              className={
                "toolbar-btn" +
                (formatPainterMode !== "idle" ? " toolbar-btn--active" : "")
              }
              onClick={handleFormatPainterClick}
              onDoubleClick={handleFormatPainterDoubleClick}
              title={
                formatPainterMode === "sticky"
                  ? "書式コピー（連続適用中・ESCで終了）"
                  : formatPainterMode === "single"
                  ? "書式コピー（次の選択に1回適用・ESCで取消）"
                  : "書式のコピー/貼り付け（ダブルクリックで連続適用）"
              }
              aria-label="書式コピー"
              aria-pressed={formatPainterMode !== "idle"}
              data-testid="format-painter"
            >
              🖌 書式コピー
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={toggleSheetProtection}
              title={
                activeSheetProtected
                  ? "シート保護を解除（書き込み可に戻す）"
                  : "シートを保護（読み取り専用にする）"
              }
              aria-label="シート保護"
              aria-pressed={activeSheetProtected}
              data-testid="sheet-protection-toggle"
            >
              {activeSheetProtected ? "🔓 解除" : "🔒 保護"}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={openTabColorDialog}
              title="シートタブの色を変更"
              aria-label="シートタブの色"
              data-testid="sheet-tab-color"
            >
              🎨 タブ色
            </button>
          </div>
          <span className="toolbar-divider" aria-hidden="true" />
          {/* 挿入系: 名前付き範囲 / グラフ / 画像挿入 */}
          <div className="toolbar-group" role="group" aria-label="挿入">
            <button
              type="button"
              className="toolbar-btn"
              onClick={openNamedRangesDialog}
              title="名前付き範囲を編集 (Ctrl+F3)"
              aria-label="名前付き範囲"
            >
              名前付き範囲
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={openChartDialog}
              title="選択範囲からグラフを挿入"
              aria-label="グラフを挿入"
            >
              📊 グラフ
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={openImageDialog}
              title="画像をワークブックに挿入"
              aria-label="画像挿入"
            >
              🖼 画像挿入
            </button>
          </div>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-btn"
            onClick={openSortDialog}
            title="選択範囲を並べ替え"
            aria-label="並べ替え"
          >
            ↕ 並べ替え
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={requestSettings}
            title="設定（自動保存間隔など）"
            aria-label="設定"
          >
            ⚙
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={requestHelp}
            title="ヘルプとキーボードショートカット (F1)"
            aria-label="ヘルプ"
          >
            ?
          </button>
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
        <InsertCommentDialog
          cellRef={commentDialog.cellRef}
          initialEntry={commentDialog.existing}
          defaultAuthor={resolveDefaultAuthor()}
          onApply={(entry) => applyComment(commentDialog.sheetId, entry)}
          onDelete={() => deleteComment(commentDialog.sheetId, commentDialog.cellRef)}
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
