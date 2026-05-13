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
}

const AUTOSAVE_KEY = "autosave.interval_ms";
const DEFAULT_AUTOSAVE_MS = 30_000;

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

  newWorkbook: async () => {
    try {
      const handle = await invoke<WorkbookHandle>("workbook_new");
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
      set({ lastError: friendlyError(String(e)) });
    }
  },

  openCoco: async (path: string) => {
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_open_coco", { path });
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
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
    }
  },

  importXlsx: async (path: string) => {
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<ImportWorkbookResult>("workbook_import_xlsx", { path });
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
      set({ saveStatus: "saved", lastError: friendlyError(String(e)) });
    }
  },

  importCsv: async (path: string) => {
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<ImportWorkbookResult>("workbook_import_csv", { path });
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
    const { currentSnapshotJson } = get();
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
    try {
      set({ saveStatus: "loading" });
      const result = await invoke<OpenWorkbookResult>("workbook_restore_backup", { candidateId });
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
}));
