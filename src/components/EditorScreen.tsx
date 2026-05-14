import { useEffect, useRef, useCallback, useState } from "react";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Univer, UniverInstanceType, LocaleType, CommandType, type IWorkbookData } from "@univerjs/core";
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

import { useWorkbookStore } from "../store/useWorkbookStore";
import { useAutoSave } from "../hooks/useAutoSave";
import type { CompatibilityWarning } from "../types/workbook";
import SheetPickerModal from "./SheetPickerModal";
import SaveFailureDialog from "./SaveFailureDialog";
import BusyOverlay from "./BusyOverlay";
import SnapshotHistoryDialog from "./SnapshotHistoryDialog";
import CompatibilityWarningsDialog from "./CompatibilityWarningsDialog";
import { requestSettings, requestHelp } from "../hooks/useGlobalShortcuts";
import { timeAgoJa } from "./timeAgo";
import { computeSnapshotStats, formatSnapshotStats } from "../store/snapshotStats";
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

  useAutoSave();

  // Keyboard shortcuts (req 4.6): Ctrl+S / Cmd+S = save; Ctrl+Shift+S / Cmd+Shift+S = save as.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        promptSaveAs();
      } else if (mod && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        save();
      }
    },
    [save, promptSaveAs]
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

    // Create workbook from snapshot or default empty workbook
    const initialData: Partial<IWorkbookData> = currentSnapshotJson
      ? JSON.parse(currentSnapshotJson)
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

    return () => {
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
      <div className="univer-wrap">
        <div id="univer-container" ref={containerRef} className="univer-container" />
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
