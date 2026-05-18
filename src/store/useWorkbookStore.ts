import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { friendlyError } from "./errorMessages";
import { flushPendingSnapshot } from "./snapshotSync";
import type {
  AppScreen,
  SaveStatus,
  WorkbookHandle,
  RecentFile,
  RecoveryCandidate,
  CompatibilityWarning,
  OpenWorkbookResult,
  ImportWorkbookResult,
  SaveResult,
  ExportResult,
} from "../types/workbook";

interface WorkbookState {
  screen: AppScreen;
  currentHandle: WorkbookHandle | null;
  saveStatus: SaveStatus;
  /** True when the workbook was dirty (unsaved changes) at the moment export
   *  started. Export does not persist the working book, so the dirty state
   *  must survive an export_done / export_failed transition. Cleared whenever
   *  saveStatus moves to a non-export state (save/load/new/etc.). */
  wasDirtyBeforeExport: boolean;
  importWarnings: CompatibilityWarning[];
  recentFiles: RecentFile[];
  recoveryCandidates: RecoveryCandidate[];
  currentSnapshotJson: string | null;
  editorRevision: number;
  dirtyRevision: number;
  isExporting: boolean;
  exportWarnings: CompatibilityWarning[];
  blockingImport: CompatibilityWarning[] | null;
  lastError: string | null;
  autoSaveIntervalMs: number; // 0 = disabled
  lastSavedAt: number | null; // epoch ms — manual or auto save success
  csvExportEncoding: "utf8-bom" | "utf8" | "shift_jis";
  csvImportEncoding: "auto" | "utf8" | "shift_jis";
  pinnedPaths: string[]; // recent files the user has pinned; sorts to top of home list
  pinnedOrder: string[]; // user-defined ordering for pinned items (drag-to-reorder)
  suppressCsvPocWarning: boolean; // hide the always-fires "CSV PoC" info banner
  /** #97: Coco-managed snapshot history for apply-style operations
   *  (AutoSum, format painter, hyperlink, CF, DV, etc.) that bypass
   *  Univer's commandService. Each entry is a `currentSnapshotJson` that
   *  predated the next mutation. Bounded to keep memory in check. */
  cocoUndoStack: string[];
  cocoRedoStack: string[];

  // Actions
  newWorkbook: () => Promise<void>;
  openCoco: (path: string) => Promise<void>;
  importXlsx: (path: string) => Promise<void>;
  importCsv: (path: string) => Promise<void>;
  save: () => Promise<void>;
  saveAs: (path: string) => Promise<void>;
  promptSaveAs: () => Promise<void>;
  dismissSaveError: () => void;
  autoSave: () => Promise<void>;
  exportXlsx: () => Promise<void>;
  listSheetNames: () => Promise<{ id: string; name: string }[]>;
  exportCsvToPath: (path: string, sheetId: string) => Promise<void>;
  dismissExportWarnings: () => void;
  restoreCandidate: (candidateId: string) => Promise<void>;
  dismissCandidate: (candidateId: string) => Promise<void>;
  updateSnapshot: (snapshotJson: string) => void;
  /** #97: snapshot a pre-mutation state so it can be reverted via cocoUndo.
   *  Apply-style operations (AutoSum, format painter, hyperlink, etc.) call
   *  this with the *previous* `currentSnapshotJson` immediately before
   *  calling `updateSnapshot` with the post-mutation state. Pushes onto
   *  `cocoUndoStack` and clears `cocoRedoStack`. No-op for null inputs. */
  pushCocoCheckpoint: (prevSnapshotJson: string | null) => void;
  /** #97: pop the last checkpoint, swap it in as currentSnapshotJson, push
   *  the current state onto the redo stack. No-op when the stack is empty. */
  cocoUndo: () => void;
  /** #97: pop from redo stack, swap in, push current onto undo. */
  cocoRedo: () => void;
  markDirty: () => void;
  loadRecentFiles: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  clearRecents: () => Promise<void>;
  loadRecoveryCandidates: () => Promise<void>;
  dismissWarnings: () => void;
  dismissBlockingImport: () => void;
  clearError: () => void;
  goHome: () => void;
  setSaveStatus: (status: SaveStatus) => void;
  loadAutoSaveInterval: () => Promise<void>;
  setAutoSaveInterval: (ms: number) => Promise<void>;
  loadCsvExportEncoding: () => Promise<void>;
  setCsvExportEncoding: (enc: "utf8-bom" | "utf8" | "shift_jis") => Promise<void>;
  loadCsvImportEncoding: () => Promise<void>;
  setCsvImportEncoding: (enc: "auto" | "utf8" | "shift_jis") => Promise<void>;
  loadPinnedPaths: () => Promise<void>;
  togglePinned: (path: string) => Promise<void>;
  loadPinnedOrder: () => Promise<void>;
  setPinnedOrder: (order: string[]) => Promise<void>;
  reorderPinned: (dragged: string, target: string) => Promise<void>;
  loadSuppressCsvPocWarning: () => Promise<void>;
  setSuppressCsvPocWarning: (v: boolean) => Promise<void>;
  listSnapshots: () => Promise<SnapshotMeta[]>;
  openSnapshot: (snapshotId: number) => Promise<void>;
  vacuumWorkbook: () => Promise<VacuumResult | null>;
  checkIntegrity: () => Promise<IntegrityCheckResult | null>;
  workbookDiagnosticInfo: () => Promise<DiagnosticInfo | null>;
}

export interface DiagnosticInfo {
  path: string;
  sizeBytes: number;
  snapshotCount: number;
  schemaVersion: number | null;
  lastSavedAt: string | null;
}

export interface SnapshotMeta {
  snapshotId: number;
  createdAt: string;
  reason: string;
}

export interface VacuumResult {
  beforeBytes: number;
  afterBytes: number;
}

export interface IntegrityCheckResult {
  ok: boolean;
  issues: string[];
}

const AUTOSAVE_KEY = "autosave.interval_ms";
const DEFAULT_AUTOSAVE_MS = 30_000;
/** Minimum positive autosave interval. 0 (disabled) is still allowed; any
 *  non-zero value below this would peg the disk + main thread (#89). */
const MIN_AUTOSAVE_MS = 5_000;
const CSV_ENCODING_KEY = "csv.export_encoding";
type CsvEncoding = "utf8-bom" | "utf8" | "shift_jis";
const DEFAULT_CSV_ENCODING: CsvEncoding = "utf8-bom";
const VALID_CSV_ENCODINGS: CsvEncoding[] = ["utf8-bom", "utf8", "shift_jis"];

const CSV_IMPORT_ENCODING_KEY = "csv.import_encoding";
type CsvImportEncoding = "auto" | "utf8" | "shift_jis";
const DEFAULT_CSV_IMPORT_ENCODING: CsvImportEncoding = "auto";
const VALID_CSV_IMPORT_ENCODINGS: CsvImportEncoding[] = ["auto", "utf8", "shift_jis"];

const PINNED_PATHS_KEY = "recents.pinned_paths";
const PINNED_ORDER_KEY = "recents.pinned_order";
const SUPPRESS_CSV_POC_KEY = "csv.suppress_poc_warning";
const SNAPSHOT_REQUIRED_ERROR = "保存できるスナップショットがありません";

const hasSnapshotJson = (snapshotJson: string | null): snapshotJson is string =>
  typeof snapshotJson === "string" && snapshotJson.length > 0;

/** Local copy of dirtyGuard's saveStatus → dirty mapping. Re-implemented here
 *  (rather than imported) because dirtyGuard.ts imports this store, and going
 *  the other direction would cause a circular dependency. Keep in sync with
 *  `isDirtySaveStatus` in dirtyGuard.ts. */
const isDirtySaveStatusValue = (s: SaveStatus): boolean =>
  s === "unsaved" || s === "save_failed";

const defaultSaveAsName = (path: string | null): string =>
  path ? path.replace(/\.[^./\\]*$/, "") + ".xlsx" : "Untitled.xlsx";

// Request-token "newer wins" guard for concurrent open / import operations.
// If the user fires off open A then open B before A's invoke resolves, A's
// resolution must NOT clobber B's state. Each open action captures the
// counter at start; if the counter has moved on by the time the invoke
// resolves, the result is discarded. Applies to every action that ends in
// switching `currentHandle` / `currentSnapshotJson` for a new workbook.
let openSeq = 0;
let autoSaveInFlight: Promise<void> | null = null;
// #69: manual save/saveAs in-flight guard. Without this, Ctrl+S double-presses
// (or shortcut + menu race) launch two `workbook_save` / `workbook_export_xlsx`
// invocations against the same path. Both call `rotate_backups`, shifting the
// backup chain twice for one logical save.
let saveInFlight: Promise<void> | null = null;
// #70: counts edits arriving while a save is in-flight. markDirty bumps it
// instead of stomping `saveStatus`; on save resolution we honor a non-zero
// counter by transitioning to "unsaved" rather than "saved", closing the
// race where a close-during-save bypassed the dirty guard.
let pendingEditsDuringSave = 0;

const waitForAutoSave = async () => {
  const pending = autoSaveInFlight;
  if (pending) await pending;
};

const clearRecoveryBestEffort = (workbookId: string) => {
  void invoke("workbook_clear_recovery", { candidateId: workbookId }).catch(() => undefined);
};

export const useWorkbookStore = create<WorkbookState>((set, get) => ({
  screen: "home",
  currentHandle: null,
  saveStatus: "saved",
  wasDirtyBeforeExport: false,
  importWarnings: [],
  recentFiles: [],
  recoveryCandidates: [],
  currentSnapshotJson: null,
  editorRevision: 0,
  dirtyRevision: 0,
  isExporting: false,
  exportWarnings: [],
  blockingImport: null,
  lastError: null,
  autoSaveIntervalMs: DEFAULT_AUTOSAVE_MS,
  lastSavedAt: null,
  csvExportEncoding: DEFAULT_CSV_ENCODING,
  csvImportEncoding: DEFAULT_CSV_IMPORT_ENCODING,
  pinnedPaths: [],
  pinnedOrder: [],
  suppressCsvPocWarning: false,
  cocoUndoStack: [],
  cocoRedoStack: [],

  newWorkbook: async () => {
    const mySeq = ++openSeq;
    try {
      const handle = await invoke<WorkbookHandle>("workbook_new");
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      set({
        screen: "editor",
        currentHandle: handle,
        editorRevision: get().editorRevision + 1,
        saveStatus: "unsaved",
        wasDirtyBeforeExport: false,
        importWarnings: [],
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({ lastError: friendlyError(String(e)) });
    }
  },

  openCoco: async (path: string) => {
    const mySeq = ++openSeq;
    // Capture the pre-open status so a failed open can restore the dirty
    // state of the previous workbook (#48). `loading` is purely transient.
    const priorStatus = get().saveStatus;
    const priorDirty = get().wasDirtyBeforeExport;
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_open_coco", { path });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      set({
        screen: "editor",
        currentHandle: result.handle,
        editorRevision: get().editorRevision + 1,
        saveStatus: "saved",
        wasDirtyBeforeExport: false,
        importWarnings: result.warnings,
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({
        saveStatus: priorStatus === "loading" ? "saved" : priorStatus,
        wasDirtyBeforeExport: priorDirty,
        lastError: friendlyError(String(e)),
      });
    }
  },

  importXlsx: async (path: string) => {
    const mySeq = ++openSeq;
    const priorStatus = get().saveStatus;
    const priorDirty = get().wasDirtyBeforeExport;
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<ImportWorkbookResult>("workbook_import_xlsx", { path });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      // If the import was blocked by security_scan (now folded into Rust), the result
      // has an empty snapshot + blocking warnings. Surface them on the home screen
      // (we never reached the editor in that case — keep screen at "home").
      const hasBlocking = result.warnings.some((w) => w.severity === "blocking");
      if (hasBlocking) {
        // req 7.3: dedicated modal for malicious-file rejection rather than an
        // inline banner. The dialog displays both blocking issues and the
        // companion non-blocking warnings. The prior workbook (if any) stays
        // intact — restore its saveStatus so dirty state isn't silently lost.
        set({
          saveStatus: priorStatus === "loading" ? "saved" : priorStatus,
          wasDirtyBeforeExport: priorDirty,
          blockingImport: result.warnings,
          importWarnings: [],
          lastError: null,
        });
        return;
      }
      set({
        screen: "editor",
        currentHandle: result.handle,
        editorRevision: get().editorRevision + 1,
        saveStatus: "unsaved",
        wasDirtyBeforeExport: false,
        importWarnings: result.warnings,
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({
        saveStatus: priorStatus === "loading" ? "saved" : priorStatus,
        wasDirtyBeforeExport: priorDirty,
        lastError: friendlyError(String(e)),
      });
    }
  },

  importCsv: async (path: string) => {
    const mySeq = ++openSeq;
    const priorStatus = get().saveStatus;
    const priorDirty = get().wasDirtyBeforeExport;
    try {
      set({ saveStatus: "loading" });
      // "auto" → omit so Rust runs full auto-detect (UTF-8 BOM → UTF-8 → SJIS fallback).
      // Explicit override forces decoder, bypassing detection.
      const enc = get().csvImportEncoding;
      const encoding = enc === "auto" ? undefined : enc;
      const result = await invoke<ImportWorkbookResult>("workbook_import_csv", { path, encoding });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      // Optionally hide the always-fires "CSV PoC" info banner — power users
      // already know our type-detection scope and don't need the reminder.
      const filteredWarnings = get().suppressCsvPocWarning
        ? result.warnings.filter((w) => w.code !== "CSV_POC_IMPORT")
        : result.warnings;
      set({
        screen: "editor",
        currentHandle: result.handle,
        editorRevision: get().editorRevision + 1,
        saveStatus: "unsaved",
        wasDirtyBeforeExport: false,
        importWarnings: filteredWarnings,
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({
        saveStatus: priorStatus === "loading" ? "saved" : priorStatus,
        wasDirtyBeforeExport: priorDirty,
        lastError: friendlyError(String(e)),
      });
    }
  },

  save: async () => {
    // #69: serialize manual saves so double-press / menu+shortcut races
    // can't kick off two concurrent rotate_backups against the same path.
    // Subsequent callers piggyback on the in-flight save and return when it
    // resolves, matching the user expectation of "Ctrl+S = one save".
    if (saveInFlight) {
      await saveInFlight;
      return;
    }
    const run = (async () => {
      // #70: reset the mid-save edit counter at entry; markDirty increments
      // it during the save, and at resolution we honour any non-zero value
      // by transitioning to "unsaved" instead of "saved".
      pendingEditsDuringSave = 0;
      await waitForAutoSave();
      await flushPendingSnapshot();
      const { currentHandle, currentSnapshotJson, saveAs } = get();
      if (!currentHandle) return;

      if (!hasSnapshotJson(currentSnapshotJson)) {
        set({ saveStatus: "save_failed", lastError: SNAPSHOT_REQUIRED_ERROR });
        return;
      }

      const currentPath = currentHandle.path;
      const currentLower = currentPath?.toLowerCase() ?? "";

      if (!currentPath || currentHandle.requiresSaveAsOnFirstSave || currentLower.endsWith(".xlsm")) {
        const defaultPath = defaultSaveAsName(currentPath);
        const chosen = await saveDialog({
          title: "名前を付けて保存",
          defaultPath: defaultPath.split(/[\\/]/).pop() ?? "Untitled.xlsx",
          filters: [
            { name: "Excel Workbook", extensions: ["xlsx"] },
          ],
        });
        if (!chosen) {
          set({ saveStatus: "unsaved" });
          return;
        }
        await saveAs(chosen);
        return;
      }

      set({ saveStatus: "saving" });
      try {
        if (currentLower.endsWith(".xlsx")) {
          const result = await invoke<ExportResult>("workbook_export_xlsx", {
            path: currentPath,
            snapshotJson: currentSnapshotJson,
          });
          // #70: if edits arrived while we were saving, downgrade success to
          // "unsaved" so closeGuard can still warn.
          const dirtyAfter = pendingEditsDuringSave > 0;
          set({
            saveStatus: result.success
              ? dirtyAfter
                ? "unsaved"
                : "saved"
              : "save_failed",
            wasDirtyBeforeExport: result.success ? false : get().wasDirtyBeforeExport,
            currentHandle: result.success
              ? { ...currentHandle, requiresSaveAsOnFirstSave: false }
              : currentHandle,
            lastError: result.success ? null : friendlyError(result.error) ?? "保存に失敗しました",
            lastSavedAt: result.success ? Date.now() : get().lastSavedAt,
          });
          if (result.success) {
            clearRecoveryBestEffort(currentHandle.workbookId);
          }
          return;
        }
        const result = await invoke<SaveResult>("workbook_save", {
          workbookId: currentHandle.workbookId,
          path: currentPath,
          snapshotJson: currentSnapshotJson,
        });
        const dirtyAfter = pendingEditsDuringSave > 0;
        if (result.success) {
          set({
            saveStatus: dirtyAfter ? "unsaved" : "saved",
            wasDirtyBeforeExport: false,
            currentHandle: { ...currentHandle, path: result.path, requiresSaveAsOnFirstSave: false },
            lastError: null,
            lastSavedAt: Date.now(),
          });
        } else {
          set({ saveStatus: "save_failed", lastError: friendlyError(result.error) });
        }
      } catch (e) {
        set({ saveStatus: "save_failed", lastError: friendlyError(String(e)) });
      }
    })();
    saveInFlight = run;
    try {
      await run;
    } finally {
      if (saveInFlight === run) saveInFlight = null;
    }
  },

  saveAs: async (path: string) => {
    // #69: saveAs is not separately locked because the public save() may
    // delegate here from inside its own saveInFlight section — re-locking
    // would deadlock that handoff. Direct concurrent Save As is rare (no
    // double-press shortcut, only the menu) so the residual race is
    // acceptable.
    pendingEditsDuringSave = 0;
    await waitForAutoSave();
    await flushPendingSnapshot();
    const { currentHandle, currentSnapshotJson } = get();
    if (!currentHandle) return;
    if (!hasSnapshotJson(currentSnapshotJson)) {
      set({ saveStatus: "save_failed", lastError: SNAPSHOT_REQUIRED_ERROR });
      return;
    }
    const lower = path.toLowerCase();
    set({ saveStatus: "saving" });
    try {
      const isCoco = lower.endsWith(".coco");
      const isXlsx = lower.endsWith(".xlsx");
      const command = isCoco ? "workbook_save_as" : "workbook_export_xlsx";
      const args = isCoco
        ? {
            workbookId: currentHandle.workbookId,
            path,
            snapshotJson: currentSnapshotJson,
          }
        : {
            path: isXlsx ? path : path.replace(/\.[^./\\]*$/, "") + ".xlsx",
            snapshotJson: currentSnapshotJson,
          };

      const result = (await invoke(command, args)) as SaveResult | ExportResult;
      const dirtyAfter = pendingEditsDuringSave > 0;
      if (result.success) {
        set({
          saveStatus: dirtyAfter ? "unsaved" : "saved",
          wasDirtyBeforeExport: false,
          currentHandle: { ...currentHandle, path: result.path, requiresSaveAsOnFirstSave: false },
          lastError: null,
          lastSavedAt: Date.now(),
        });
        clearRecoveryBestEffort(currentHandle.workbookId);
      } else {
        set({ saveStatus: "save_failed", lastError: friendlyError(result.error) });
      }
    } catch (e) {
      set({ saveStatus: "save_failed", lastError: friendlyError(String(e)) });
    }
  },

  promptSaveAs: async () => {
    const { currentHandle, saveAs } = get();
    if (!currentHandle) return;
    // Save As always defaults to xlsx — .coco is no longer user-pickable (AD-02).
    // Legacy .coco files keep working through `save` / `autoSave` once opened.
    const baseName = defaultSaveAsName(currentHandle.path);
    const fileName = baseName.split(/[\\/]/).pop() ?? "Untitled.xlsx";
    const chosen = await saveDialog({
      title: "名前を付けて保存",
      defaultPath: fileName,
      filters: [
        { name: "Excel Workbook", extensions: ["xlsx"] },
      ],
    });
    if (!chosen) return;
    await saveAs(chosen);
  },

  dismissSaveError: () => {
    set({ saveStatus: "unsaved", lastError: null });
  },

  autoSave: async () => {
    if (autoSaveInFlight) {
      return;
    }

    const run = (async () => {
      const { currentHandle, saveStatus } = get();
      if (!currentHandle) return;
      // Don't race a manual save / export in flight — both would call rotate_backups
      // on the same path. The next tick will pick up any dirt that accumulated.
      if (saveStatus === "saving" || saveStatus === "exporting" || saveStatus === "loading") {
        return;
      }
      await flushPendingSnapshot();
      const { currentSnapshotJson } = get();
      if (!hasSnapshotJson(currentSnapshotJson)) return;

      const path = currentHandle.path;
      const isCoco = path ? path.toLowerCase().endsWith(".coco") : false;
      // #71: snapshot we're committing now. If the user edits during the
      // invoke window, currentSnapshotJson moves past it and we must NOT
      // declare the workbook clean (auto_saved) for a stale snapshot.
      const inflightSnapshot = currentSnapshotJson;

      try {
        if (isCoco && path) {
          // .coco path → direct atomic autosave to the user's file.
          const result = await invoke<SaveResult>("workbook_autosave_coco", {
            workbookId: currentHandle.workbookId,
            path,
            snapshotJson: currentSnapshotJson,
          });
          if (result.success) {
            // #71: only transition to auto_saved when the snapshot we just
            // wrote is still the latest. If newer edits arrived, keep the
            // workbook dirty so the next tick re-runs autosave and the
            // close guard can still warn.
            const stillCurrent = get().currentSnapshotJson === inflightSnapshot;
            set({
              saveStatus: stillCurrent ? "auto_saved" : "unsaved",
              wasDirtyBeforeExport: false,
              lastError: null,
              lastSavedAt: stillCurrent ? Date.now() : get().lastSavedAt,
            });
          } else {
            // #42: surface auto_save_failed so the UI can warn the user that
            // autosave is broken (e.g. disk full, permissions).
            set({
              saveStatus: "save_failed",
              lastError: friendlyError(result.error) ?? "自動保存に失敗しました",
            });
          }
        } else {
          // xlsx path or unsaved → write a hidden temp .coco for crash recovery only.
          // The user's xlsx file is NEVER touched by autosave (xlsx re-zip is slow + risks
          // partial-write corruption). Explicit Ctrl+S overwrites the xlsx.
          const result = await invoke<SaveResult>("workbook_autosave_temp", {
            workbookId: currentHandle.workbookId,
            snapshotJson: currentSnapshotJson,
          });
          if (result.success) {
            // #75: temp autosave writes a hidden recovery .coco — the user's
            // xlsx is NOT saved. Don't bump lastSavedAt or the status bar
            // shows "未保存 · 最終保存 X秒前" (misleading: user thinks xlsx
            // is safe). Only explicit Ctrl+S of the xlsx updates lastSavedAt.
            set({ saveStatus: "unsaved", lastError: null });
          } else {
            // #42: temp autosave failure also flips saveStatus + surfaces error.
            set({
              saveStatus: "save_failed",
              lastError: friendlyError(result.error) ?? "自動保存に失敗しました",
            });
          }
        }
      } catch (e) {
        // #42: previously this swallowed the rejection silently. Surface a
        // failure status so the user can see autosave isn't running.
        set({
          saveStatus: "save_failed",
          lastError: friendlyError(String(e)) ?? "自動保存に失敗しました",
        });
      }
    })();

    autoSaveInFlight = run;
    try {
      await run;
    } finally {
      if (autoSaveInFlight === run) autoSaveInFlight = null;
    }
  },

  exportXlsx: async () => {
    await waitForAutoSave();
    await flushPendingSnapshot();
    const { currentHandle, currentSnapshotJson } = get();
    if (!currentHandle) return;
    if (!hasSnapshotJson(currentSnapshotJson)) {
      set({ saveStatus: "export_failed", lastError: SNAPSHOT_REQUIRED_ERROR });
      return;
    }

    const defaultName = currentHandle.path
      ? defaultSaveAsName(currentHandle.path).split(/[\\/]/).pop()
      : "Untitled.xlsx";

    const chosen = await saveDialog({
      title: "xlsx としてエクスポート",
      defaultPath: defaultName,
      filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
    });
    if (!chosen) return;

    const priorDirty = isDirtySaveStatusValue(get().saveStatus);
    set({
      isExporting: true,
      saveStatus: "exporting",
      exportWarnings: [],
      wasDirtyBeforeExport: priorDirty,
    });
    try {
      const result = await invoke<ExportResult>("workbook_export_xlsx", {
        path: chosen,
        snapshotJson: currentSnapshotJson,
      });
      // req 5.4.2: export does not change the working .coco path. dirty state
      // also survives export — `wasDirtyBeforeExport` keeps the close guard
      // honest until the next real save / discard.
      set({
        isExporting: false,
        saveStatus: result.success ? "export_done" : "export_failed",
        exportWarnings: result.warnings,
        lastError: result.success ? null : friendlyError(result.error) ?? "エクスポートに失敗しました",
      });
    } catch (e) {
      set({
        isExporting: false,
        saveStatus: "export_failed",
        lastError: friendlyError(String(e)),
      });
    }
  },

  dismissExportWarnings: () => set({ exportWarnings: [] }),

  listSheetNames: async () => {
    await flushPendingSnapshot();
    const { currentSnapshotJson } = get();
    if (!hasSnapshotJson(currentSnapshotJson)) {
      set({ lastError: SNAPSHOT_REQUIRED_ERROR });
      return [];
    }
    try {
      return await invoke<{ id: string; name: string }[]>("list_sheet_names", {
        snapshotJson: currentSnapshotJson,
      });
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
      return [];
    }
  },

  exportCsvToPath: async (path: string, sheetId: string) => {
    await waitForAutoSave();
    await flushPendingSnapshot();
    const { currentSnapshotJson, csvExportEncoding } = get();
    if (!hasSnapshotJson(currentSnapshotJson)) {
      set({ isExporting: false, saveStatus: "export_failed", lastError: SNAPSHOT_REQUIRED_ERROR });
      return;
    }
    const priorDirty = isDirtySaveStatusValue(get().saveStatus);
    set({
      isExporting: true,
      saveStatus: "exporting",
      wasDirtyBeforeExport: priorDirty,
    });
    try {
      const result = await invoke<{
        success: boolean;
        path: string;
        warnings: CompatibilityWarning[];
        error?: string;
      }>("workbook_export_csv", {
        path,
        snapshotJson: currentSnapshotJson,
        sheetId,
        encoding: csvExportEncoding,
      });
      set({
        isExporting: false,
        saveStatus: result.success ? "export_done" : "export_failed",
        exportWarnings: result.warnings,
        lastError: result.success ? null : friendlyError(result.error) ?? "CSV エクスポートに失敗しました",
      });
    } catch (e) {
      set({
        isExporting: false,
        saveStatus: "export_failed",
        lastError: friendlyError(String(e)),
      });
    }
  },

  updateSnapshot: (snapshotJson: string) => {
    set((s) => ({
      currentSnapshotJson: snapshotJson,
      saveStatus: "unsaved",
      dirtyRevision: s.dirtyRevision + 1,
    }));
  },

  pushCocoCheckpoint: (prevSnapshotJson: string | null) => {
    if (!prevSnapshotJson) return;
    set((s) => {
      const stack = [...s.cocoUndoStack, prevSnapshotJson];
      // Bound the history so a long editing session doesn't accumulate
      // hundreds of MB of snapshots in memory.
      const MAX = 20;
      if (stack.length > MAX) stack.shift();
      return { cocoUndoStack: stack, cocoRedoStack: [] };
    });
  },

  cocoUndo: () => {
    const { cocoUndoStack, currentSnapshotJson } = get();
    if (cocoUndoStack.length === 0) return;
    const prev = cocoUndoStack[cocoUndoStack.length - 1];
    const nextStack = cocoUndoStack.slice(0, -1);
    set((s) => ({
      cocoUndoStack: nextStack,
      cocoRedoStack: currentSnapshotJson
        ? [...s.cocoRedoStack, currentSnapshotJson]
        : s.cocoRedoStack,
      currentSnapshotJson: prev,
      // editorRevision bump re-mounts Univer with the restored snapshot.
      // View state (scroll, selection) resets, but the data integrity of
      // the undo is preserved — better UX than a stale grid.
      editorRevision: s.editorRevision + 1,
      saveStatus: "unsaved",
      dirtyRevision: s.dirtyRevision + 1,
    }));
  },

  cocoRedo: () => {
    const { cocoRedoStack, currentSnapshotJson } = get();
    if (cocoRedoStack.length === 0) return;
    const next = cocoRedoStack[cocoRedoStack.length - 1];
    const nextRedo = cocoRedoStack.slice(0, -1);
    set((s) => ({
      cocoRedoStack: nextRedo,
      cocoUndoStack: currentSnapshotJson
        ? [...s.cocoUndoStack, currentSnapshotJson]
        : s.cocoUndoStack,
      currentSnapshotJson: next,
      editorRevision: s.editorRevision + 1,
      saveStatus: "unsaved",
      dirtyRevision: s.dirtyRevision + 1,
    }));
  },

  markDirty: () => {
    const { saveStatus } = get();
    if (saveStatus === "saving" || saveStatus === "exporting" || saveStatus === "loading") {
      // #70: still record that an edit arrived so the save resolution can
      // downgrade "saved" → "unsaved" instead of leaving a 300ms window
      // where closeGuard thinks the workbook is clean. Don't touch
      // saveStatus directly — the in-progress save still needs its
      // "saving" indicator until the invoke resolves.
      pendingEditsDuringSave += 1;
      set((s) => ({ dirtyRevision: s.dirtyRevision + 1 }));
      return;
    }
    set((s) => ({ saveStatus: "unsaved", dirtyRevision: s.dirtyRevision + 1 }));
  },

  loadRecentFiles: async () => {
    try {
      const files = await invoke<RecentFile[]>("workbook_list_recent");
      set({ recentFiles: files });
    } catch {
      // non-critical
    }
  },

  removeRecent: async (path: string) => {
    try {
      await invoke("workbook_remove_recent", { path });
      set((s) => ({ recentFiles: s.recentFiles.filter((f) => f.path !== path) }));
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
    }
  },

  clearRecents: async () => {
    try {
      await invoke("workbook_clear_recent");
      set({ recentFiles: [] });
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
    }
  },

  loadRecoveryCandidates: async () => {
    try {
      const candidates = await invoke<RecoveryCandidate[]>("workbook_list_recovery");
      set({ recoveryCandidates: candidates });
    } catch {
      // non-critical
    }
  },

  restoreCandidate: async (candidateId: string) => {
    const mySeq = ++openSeq;
    const priorStatus = get().saveStatus;
    const priorDirty = get().wasDirtyBeforeExport;
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_restore_backup", { candidateId });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      // Restored copy opens with no path - first Ctrl+S will prompt Save As (req 6.5 step 4).
      set({
        screen: "editor",
        currentHandle: { ...result.handle, path: null },
        editorRevision: get().editorRevision + 1,
        saveStatus: "unsaved",
        wasDirtyBeforeExport: false,
        importWarnings: result.warnings,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({
        saveStatus: priorStatus === "loading" ? "saved" : priorStatus,
        wasDirtyBeforeExport: priorDirty,
        lastError: friendlyError(String(e)),
      });
    }
  },

  dismissCandidate: async (candidateId: string) => {
    try {
      await invoke("workbook_clear_recovery", { candidateId });
      set((s) => ({
        recoveryCandidates: s.recoveryCandidates.filter((c) => c.candidateId !== candidateId),
      }));
    } catch {
      // non-critical
    }
  },

  dismissWarnings: () => set({ importWarnings: [] }),

  dismissBlockingImport: () => set({ blockingImport: null }),

  clearError: () => set({ lastError: null }),

  goHome: () =>
    set({
      screen: "home",
      currentHandle: null,
      currentSnapshotJson: null,
      saveStatus: "saved",
      wasDirtyBeforeExport: false,
      importWarnings: [],
      exportWarnings: [],
      blockingImport: null,
      lastError: null,
      lastSavedAt: null,
      // #97: drop undo history when leaving the workbook.
      cocoUndoStack: [],
      cocoRedoStack: [],
    }),

  setSaveStatus: (status) => set({ saveStatus: status }),

  loadAutoSaveInterval: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: AUTOSAVE_KEY });
      if (raw === null) return;
      const ms = Number.parseInt(raw, 10);
      // #43 / #89: isFinite rejects NaN/Infinity/-Infinity. 0 is the special
      // "disabled" value (no autosave). Any positive interval is clamped to
      // [MIN_AUTOSAVE_MS, 24h] so a malformed prior value can't either spam
      // the disk (1ms) or effectively disable autosave (1 month).
      if (Number.isFinite(ms) && ms >= 0 && ms <= 24 * 60 * 60 * 1000) {
        if (ms === 0 || ms >= MIN_AUTOSAVE_MS) {
          set({ autoSaveIntervalMs: ms });
        } else {
          set({ autoSaveIntervalMs: MIN_AUTOSAVE_MS });
        }
      }
    } catch {
      // non-critical: default stays in effect
    }
  },

  setAutoSaveInterval: async (ms: number) => {
    // #43 / #89: reject NaN, Infinity, -Infinity, negatives, absurd upper
    // values, AND positive values below MIN_AUTOSAVE_MS (a 1ms interval would
    // peg the main thread + disk I/O on every tick).
    if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 60 * 60 * 1000) return;
    if (ms > 0 && ms < MIN_AUTOSAVE_MS) return;
    set({ autoSaveIntervalMs: ms });
    try {
      await invoke("set_setting", { key: AUTOSAVE_KEY, value: String(ms) });
    } catch {
      // best-effort persistence; in-memory value stays
    }
  },

  loadCsvExportEncoding: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: CSV_ENCODING_KEY });
      if (raw === null) return;
      if ((VALID_CSV_ENCODINGS as string[]).includes(raw)) {
        set({ csvExportEncoding: raw as CsvEncoding });
      }
    } catch {
      // non-critical: default stays in effect
    }
  },

  setCsvExportEncoding: async (enc) => {
    if (!(VALID_CSV_ENCODINGS as string[]).includes(enc)) return;
    set({ csvExportEncoding: enc });
    try {
      await invoke("set_setting", { key: CSV_ENCODING_KEY, value: enc });
    } catch {
      // best-effort persistence
    }
  },

  loadCsvImportEncoding: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: CSV_IMPORT_ENCODING_KEY });
      if (raw === null) return;
      if ((VALID_CSV_IMPORT_ENCODINGS as string[]).includes(raw)) {
        set({ csvImportEncoding: raw as CsvImportEncoding });
      }
    } catch {
      // non-critical: default stays in effect
    }
  },

  setCsvImportEncoding: async (enc) => {
    if (!(VALID_CSV_IMPORT_ENCODINGS as string[]).includes(enc)) return;
    set({ csvImportEncoding: enc });
    try {
      await invoke("set_setting", { key: CSV_IMPORT_ENCODING_KEY, value: enc });
    } catch {
      // best-effort persistence
    }
  },

  loadPinnedPaths: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: PINNED_PATHS_KEY });
      if (raw === null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // #44: malformed JSON → keep the in-memory default (empty list) and
        // also persist a clean value so the next read doesn't re-trigger this.
        set({ pinnedPaths: [] });
        void invoke("set_setting", { key: PINNED_PATHS_KEY, value: "[]" }).catch(() => undefined);
        return;
      }
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        set({ pinnedPaths: parsed });
      } else {
        // Non-array / non-string-array JSON (null, object, mixed types) →
        // reject and reset to a clean empty list so subsequent writes don't
        // round-trip corrupted state.
        set({ pinnedPaths: [] });
      }
    } catch {
      // get_setting failure → non-critical: empty pin list stays
    }
  },

  togglePinned: async (path: string) => {
    const cur = get().pinnedPaths;
    const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
    set({ pinnedPaths: next });
    try {
      await invoke("set_setting", { key: PINNED_PATHS_KEY, value: JSON.stringify(next) });
    } catch (e) {
      // #84: roll back the in-memory change so the UI state stays in sync
      // with persisted state. Otherwise the pin "stays" until the next
      // app restart, surprising the user.
      set({ pinnedPaths: cur, lastError: friendlyError(String(e)) ?? "ピンの保存に失敗しました" });
    }
  },

  loadPinnedOrder: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: PINNED_ORDER_KEY });
      if (raw === null) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        set({ pinnedOrder: parsed });
      }
    } catch {
      // non-critical: empty order stays (falls back to lastOpened DESC)
    }
  },

  setPinnedOrder: async (order: string[]) => {
    const prev = get().pinnedOrder;
    set({ pinnedOrder: order });
    try {
      await invoke("set_setting", { key: PINNED_ORDER_KEY, value: JSON.stringify(order) });
    } catch (e) {
      // #84: rollback to keep in-memory state aligned with disk.
      set({ pinnedOrder: prev, lastError: friendlyError(String(e)) ?? "並び順の保存に失敗しました" });
    }
  },

  reorderPinned: async (dragged: string, target: string) => {
    if (dragged === target) return;
    const cur = get().pinnedOrder;
    // Start from the existing order, appending any pinned paths not yet
    // tracked so the array can faithfully represent the current visible order.
    const pinned = get().pinnedPaths;
    const base = [...cur];
    for (const p of pinned) {
      if (!base.includes(p)) base.push(p);
    }
    // Remove dragged from its current position; insert it where target sits.
    const without = base.filter((p) => p !== dragged);
    const targetIdx = without.indexOf(target);
    if (targetIdx < 0) {
      // Target isn't in the order array at all — append dragged after it
      // (the seeded order above guarantees it should be there, but guard anyway).
      without.push(dragged);
    } else {
      without.splice(targetIdx, 0, dragged);
    }
    set({ pinnedOrder: without });
    try {
      await invoke("set_setting", { key: PINNED_ORDER_KEY, value: JSON.stringify(without) });
    } catch {
      // best-effort persistence
    }
  },

  loadSuppressCsvPocWarning: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: SUPPRESS_CSV_POC_KEY });
      if (raw === "true" || raw === "1") set({ suppressCsvPocWarning: true });
      // Any other value (null, "false", "0", malformed) leaves the default off.
    } catch {
      // non-critical
    }
  },

  setSuppressCsvPocWarning: async (v: boolean) => {
    const prev = get().suppressCsvPocWarning;
    set({ suppressCsvPocWarning: v });
    try {
      await invoke("set_setting", { key: SUPPRESS_CSV_POC_KEY, value: v ? "true" : "false" });
    } catch (e) {
      // #84: rollback so the toggle reflects the persisted state.
      set({ suppressCsvPocWarning: prev, lastError: friendlyError(String(e)) ?? "設定保存に失敗しました" });
    }
  },

  listSnapshots: async () => {
    const { currentHandle } = get();
    if (!currentHandle?.path) return [];
    try {
      return await invoke<SnapshotMeta[]>("workbook_list_snapshots", {
        path: currentHandle.path,
      });
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
      return [];
    }
  },

  openSnapshot: async (snapshotId: number) => {
    const { currentHandle } = get();
    if (!currentHandle?.path) return;
    const mySeq = ++openSeq;
    const priorStatus = get().saveStatus;
    const priorDirty = get().wasDirtyBeforeExport;
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_open_snapshot", {
        path: currentHandle.path,
        snapshotId,
      });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      // The Rust side returns path=null so the next Ctrl+S goes through
      // Save As (req-style protection: don't let the user overwrite the
      // current file with an older version by accident).
      set({
        screen: "editor",
        currentHandle: { ...result.handle, path: null },
        editorRevision: get().editorRevision + 1,
        saveStatus: "unsaved",
        wasDirtyBeforeExport: false,
        importWarnings: result.warnings,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({
        saveStatus: priorStatus === "loading" ? "saved" : priorStatus,
        wasDirtyBeforeExport: priorDirty,
        lastError: friendlyError(String(e)),
      });
    }
  },

  vacuumWorkbook: async () => {
    const { currentHandle } = get();
    if (!currentHandle?.path) return null;
    try {
      return await invoke<VacuumResult>("workbook_vacuum", { path: currentHandle.path });
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
      return null;
    }
  },

  checkIntegrity: async () => {
    const { currentHandle } = get();
    if (!currentHandle?.path) return null;
    try {
      return await invoke<IntegrityCheckResult>("workbook_check_integrity", {
        path: currentHandle.path,
      });
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
      return null;
    }
  },

  workbookDiagnosticInfo: async () => {
    const { currentHandle } = get();
    if (!currentHandle?.path) return null;
    try {
      return await invoke<DiagnosticInfo>("workbook_diagnostic_info", {
        path: currentHandle.path,
      });
    } catch {
      // non-critical: dialog can render without it
      return null;
    }
  },
}));
