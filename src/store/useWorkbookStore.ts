import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { friendlyError } from "./errorMessages";
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
  importWarnings: CompatibilityWarning[];
  recentFiles: RecentFile[];
  recoveryCandidates: RecoveryCandidate[];
  currentSnapshotJson: string | null;
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

// Request-token "newer wins" guard for concurrent open / import operations.
// If the user fires off open A then open B before A's invoke resolves, A's
// resolution must NOT clobber B's state. Each open action captures the
// counter at start; if the counter has moved on by the time the invoke
// resolves, the result is discarded. Applies to every action that ends in
// switching `currentHandle` / `currentSnapshotJson` for a new workbook.
let openSeq = 0;

export const useWorkbookStore = create<WorkbookState>((set, get) => ({
  screen: "home",
  currentHandle: null,
  saveStatus: "saved",
  importWarnings: [],
  recentFiles: [],
  recoveryCandidates: [],
  currentSnapshotJson: null,
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

  newWorkbook: async () => {
    const mySeq = ++openSeq;
    try {
      const handle = await invoke<WorkbookHandle>("workbook_new");
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      set({
        screen: "editor",
        currentHandle: handle,
        saveStatus: "unsaved",
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
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_open_coco", { path });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      set({
        screen: "editor",
        currentHandle: result.handle,
        saveStatus: "saved",
        importWarnings: result.warnings,
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
    }
  },

  importXlsx: async (path: string) => {
    const mySeq = ++openSeq;
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
        // companion non-blocking warnings.
        set({
          saveStatus: "saved",
          blockingImport: result.warnings,
          importWarnings: [],
          lastError: null,
        });
        return;
      }
      set({
        screen: "editor",
        currentHandle: result.handle,
        saveStatus: "unsaved",
        importWarnings: result.warnings,
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
    }
  },

  importCsv: async (path: string) => {
    const mySeq = ++openSeq;
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
        saveStatus: "unsaved",
        importWarnings: filteredWarnings,
        exportWarnings: [],
        blockingImport: null,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
    }
  },

  save: async () => {
    const { currentHandle, currentSnapshotJson, saveAs } = get();
    if (!currentHandle) return;

    // New workbook → prompt for save target (xlsx default, .coco optional).
    if (!currentHandle.path) {
      const chosen = await saveDialog({
        title: "名前を付けて保存",
        defaultPath: "Untitled.xlsx",
        filters: [
          { name: "Excel Workbook", extensions: ["xlsx"] },
          { name: "Coco (SQLite)", extensions: ["coco"] },
        ],
      });
      if (!chosen) {
        set({ saveStatus: "unsaved" });
        return;
      }
      await saveAs(chosen);
      return;
    }

    // Overwrite in place — route to xlsx writer or SQLite writer based on extension.
    const lower = currentHandle.path.toLowerCase();
    set({ saveStatus: "saving" });
    try {
      if (lower.endsWith(".xlsx")) {
        const result = await invoke<ExportResult>("workbook_export_xlsx", {
          path: currentHandle.path,
          snapshotJson: currentSnapshotJson ?? "{}",
        });
        set({
          saveStatus: result.success ? "saved" : "save_failed",
          lastError: result.success ? null : friendlyError(result.error) ?? "保存に失敗しました",
          lastSavedAt: result.success ? Date.now() : get().lastSavedAt,
        });
        return;
      }
      // .coco (or unknown extension treated as .coco for backwards compat)
      const result = await invoke<SaveResult>("workbook_save", {
        workbookId: currentHandle.workbookId,
        path: currentHandle.path,
        snapshotJson: currentSnapshotJson ?? "{}",
      });
      if (result.success) {
        set({
          saveStatus: "saved",
          currentHandle: { ...currentHandle, path: result.path },
          lastError: null,
          lastSavedAt: Date.now(),
        });
      } else {
        set({ saveStatus: "save_failed", lastError: friendlyError(result.error) });
      }
    } catch (e) {
      set({ saveStatus: "save_failed", lastError: friendlyError(String(e)) });
    }
  },

  saveAs: async (path: string) => {
    const { currentHandle, currentSnapshotJson } = get();
    if (!currentHandle) return;
    const wasUnsaved = !currentHandle.path;
    const lower = path.toLowerCase();
    set({ saveStatus: "saving" });
    try {
      // Route by chosen extension.
      const isCoco = lower.endsWith(".coco");
      const isXlsx = lower.endsWith(".xlsx");
      // Default unknown extensions to xlsx (since xlsx is now the canonical format).
      const command = isCoco ? "workbook_save_as" : "workbook_export_xlsx";
      const args = isCoco
        ? {
            workbookId: currentHandle.workbookId,
            path,
            snapshotJson: currentSnapshotJson ?? "{}",
          }
        : {
            path: isXlsx ? path : path.replace(/\.[^./\\]*$/, "") + ".xlsx",
            snapshotJson: currentSnapshotJson ?? "{}",
          };

      const result = (await invoke(command, args)) as SaveResult | ExportResult;
      if (result.success) {
        set({
          saveStatus: "saved",
          currentHandle: { ...currentHandle, path: result.path },
          lastError: null,
          lastSavedAt: Date.now(),
        });
        if (wasUnsaved) {
          invoke("workbook_clear_recovery", { candidateId: currentHandle.workbookId }).catch(
            () => undefined
          );
        }
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
    const lower = (currentHandle.path ?? "").toLowerCase();
    const defaultExt = lower.endsWith(".coco") ? "coco" : "xlsx";
    const baseName = currentHandle.path
      ? currentHandle.path.replace(/\.[^./\\]*$/, "") + `.${defaultExt}`
      : `Untitled.${defaultExt}`;
    const fileName = baseName.split(/[\\/]/).pop() ?? `Untitled.${defaultExt}`;
    const chosen = await saveDialog({
      title: "名前を付けて保存",
      defaultPath: fileName,
      filters: [
        { name: "Excel Workbook", extensions: ["xlsx"] },
        { name: "Coco (SQLite)", extensions: ["coco"] },
      ],
    });
    if (!chosen) return;
    await saveAs(chosen);
  },

  dismissSaveError: () => {
    set({ saveStatus: "unsaved", lastError: null });
  },

  autoSave: async () => {
    const { currentHandle, currentSnapshotJson, saveStatus } = get();
    if (!currentHandle) return;
    // Don't race a manual save / export in flight — both would call rotate_backups
    // on the same path. The next tick will pick up any dirt that accumulated.
    if (saveStatus === "saving" || saveStatus === "exporting" || saveStatus === "loading") {
      return;
    }

    const path = currentHandle.path;
    const isCoco = path ? path.toLowerCase().endsWith(".coco") : false;

    try {
      if (isCoco && path) {
        // .coco path → direct atomic autosave to the user's file.
        const result = await invoke<SaveResult>("workbook_autosave_coco", {
          workbookId: currentHandle.workbookId,
          path,
          snapshotJson: currentSnapshotJson ?? "{}",
        });
        if (result.success) set({ saveStatus: "auto_saved", lastError: null, lastSavedAt: Date.now() });
      } else {
        // xlsx path or unsaved → write a hidden temp .coco for crash recovery only.
        // The user's xlsx file is NEVER touched by autosave (xlsx re-zip is slow + risks
        // partial-write corruption). Explicit Ctrl+S overwrites the xlsx.
        const result = await invoke<SaveResult>("workbook_autosave_temp", {
          workbookId: currentHandle.workbookId,
          snapshotJson: currentSnapshotJson ?? "{}",
        });
        if (result.success) set({ saveStatus: "auto_saved", lastError: null, lastSavedAt: Date.now() });
      }
    } catch {
      // Auto-save failures shouldn't disrupt the user; explicit Ctrl+S will surface real errors.
    }
  },

  exportXlsx: async () => {
    const { currentHandle, currentSnapshotJson } = get();
    if (!currentHandle) return;

    const defaultName = currentHandle.path
      ? currentHandle.path.replace(/\.coco$/i, ".xlsx").split(/[\\/]/).pop()
      : "Untitled.xlsx";

    const chosen = await saveDialog({
      title: "xlsx としてエクスポート",
      defaultPath: defaultName,
      filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
    });
    if (!chosen) return;

    set({ isExporting: true, saveStatus: "exporting", exportWarnings: [] });
    try {
      const result = await invoke<ExportResult>("workbook_export_xlsx", {
        path: chosen,
        snapshotJson: currentSnapshotJson ?? "{}",
      });
      // req 5.4.2: export does not change the working .coco path.
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
    const { currentSnapshotJson } = get();
    try {
      return await invoke<{ id: string; name: string }[]>("list_sheet_names", {
        snapshotJson: currentSnapshotJson ?? "{}",
      });
    } catch (e) {
      set({ lastError: friendlyError(String(e)) });
      return [];
    }
  },

  exportCsvToPath: async (path: string, sheetId: string) => {
    const { currentSnapshotJson, csvExportEncoding } = get();
    set({ isExporting: true, saveStatus: "exporting" });
    try {
      const result = await invoke<{
        success: boolean;
        path: string;
        warnings: CompatibilityWarning[];
        error?: string;
      }>("workbook_export_csv", {
        path,
        snapshotJson: currentSnapshotJson ?? "{}",
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
    set({ currentSnapshotJson: snapshotJson, saveStatus: "unsaved" });
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
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_restore_backup", { candidateId });
      if (mySeq !== openSeq) return; // newer open started — discard stale result
      // Restored copy opens with no path - first Ctrl+S will prompt Save As (req 6.5 step 4).
      set({
        screen: "editor",
        currentHandle: { ...result.handle, path: null },
        saveStatus: "unsaved",
        importWarnings: result.warnings,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
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
      importWarnings: [],
      exportWarnings: [],
      blockingImport: null,
      lastError: null,
      lastSavedAt: null,
    }),

  setSaveStatus: (status) => set({ saveStatus: status }),

  loadAutoSaveInterval: async () => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: AUTOSAVE_KEY });
      if (raw === null) return;
      const ms = Number.parseInt(raw, 10);
      if (Number.isFinite(ms) && ms >= 0) {
        set({ autoSaveIntervalMs: ms });
      }
    } catch {
      // non-critical: default stays in effect
    }
  },

  setAutoSaveInterval: async (ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return;
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
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        set({ pinnedPaths: parsed });
      }
    } catch {
      // non-critical: empty pin list stays
    }
  },

  togglePinned: async (path: string) => {
    const cur = get().pinnedPaths;
    const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
    set({ pinnedPaths: next });
    try {
      await invoke("set_setting", { key: PINNED_PATHS_KEY, value: JSON.stringify(next) });
    } catch {
      // best-effort persistence
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
    set({ pinnedOrder: order });
    try {
      await invoke("set_setting", { key: PINNED_ORDER_KEY, value: JSON.stringify(order) });
    } catch {
      // best-effort persistence
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
    set({ suppressCsvPocWarning: v });
    try {
      await invoke("set_setting", { key: SUPPRESS_CSV_POC_KEY, value: v ? "true" : "false" });
    } catch {
      // best-effort persistence
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
        saveStatus: "unsaved",
        importWarnings: result.warnings,
        currentSnapshotJson: result.handle.snapshotJson,
        lastError: null,
      });
    } catch (e) {
      if (mySeq !== openSeq) return;
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
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
