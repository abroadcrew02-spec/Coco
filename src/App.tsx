import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { useWorkbookStore } from "./store/useWorkbookStore";
import {
  useGlobalShortcuts,
  onHelpRequested,
  onSettingsRequested,
} from "./hooks/useGlobalShortcuts";
import { useWindowTitle } from "./hooks/useWindowTitle";
import { useFileDrop } from "./hooks/useFileDrop";
import { useCloseGuard, onCloseRequest } from "./hooks/useCloseGuard";
import { useMenuActions } from "./hooks/useMenuActions";
import HomeScreen from "./components/HomeScreen";
import SecurityBlockDialog from "./components/SecurityBlockDialog";
import HelpDialog from "./components/HelpDialog";
import DropOverlay from "./components/DropOverlay";
import SettingsDialog from "./components/SettingsDialog";
import CloseConfirmDialog from "./components/CloseConfirmDialog";
import XlsmMacroLossDialog from "./components/XlsmMacroLossDialog";

// EditorScreen pulls in the ~10MB Univer bundle. Lazy-load it so the Home
// screen renders instantly without waiting for Univer to parse.
const EditorScreen = lazy(() => import("./components/EditorScreen"));

function EditorLoadingFallback() {
  return <div className="editor-loading">エディタを読み込んでいます...</div>;
}

export default function App() {
  const {
    screen,
    currentHandle,
    blockingImport,
    importWarnings,
    loadRecentFiles,
    loadRecoveryCandidates,
    loadAutoSaveInterval,
    loadCsvExportEncoding,
    loadCsvImportEncoding,
    loadPinnedPaths,
    loadPinnedOrder,
    loadSuppressCsvPocWarning,
    dismissBlockingImport,
  } = useWorkbookStore();

  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeResolve, setCloseResolve] = useState<
    ((choice: "save" | "discard" | "cancel") => void) | null
  >(null);
  const [xlsmMacroLossOpen, setXlsmMacroLossOpen] = useState(false);
  // Tracks which workbookIds have already had their macro-loss dialog
  // dismissed. Without this, re-renders that re-evaluate importWarnings
  // would reopen the modal repeatedly for the same import.
  const xlsmMacroLossHandledRef = useRef<Set<string>>(new Set());

  useGlobalShortcuts();
  useWindowTitle();
  useCloseGuard();
  useMenuActions();
  const { isHovering: isDropHovering } = useFileDrop();

  useEffect(() => {
    const u1 = onHelpRequested(() => setHelpOpen(true));
    const u2 = onSettingsRequested(() => setSettingsOpen(true));
    const u3 = onCloseRequest((resolve) => setCloseResolve(() => resolve));
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);

  useEffect(() => {
    loadRecentFiles();
    loadRecoveryCandidates();
    loadAutoSaveInterval();
    loadCsvExportEncoding();
    loadCsvImportEncoding();
    loadPinnedPaths();
    loadPinnedOrder();
    loadSuppressCsvPocWarning();
  }, [
    loadRecentFiles,
    loadRecoveryCandidates,
    loadAutoSaveInterval,
    loadCsvExportEncoding,
    loadCsvImportEncoding,
    loadPinnedPaths,
    loadPinnedOrder,
    loadSuppressCsvPocWarning,
  ]);

  // Auto-show the xlsm macro-loss modal once per workbookId. Skip while a
  // blocking-import dialog is already up (don't stack two alerts).
  useEffect(() => {
    if (blockingImport) return;
    const workbookId = currentHandle?.workbookId;
    if (!workbookId) return;
    const hasMacroLoss = importWarnings.some((w) => w.code === "XLSM_MACROS_DISCARDED");
    if (!hasMacroLoss) return;
    if (xlsmMacroLossHandledRef.current.has(workbookId)) return;
    xlsmMacroLossHandledRef.current.add(workbookId);
    setXlsmMacroLossOpen(true);
  }, [importWarnings, currentHandle, blockingImport]);

  const closeFileName = currentHandle?.path
    ? currentHandle.path.split(/[\\/]/).pop() ?? "Untitled"
    : "無題のワークブック";

  return (
    <div className="app">
      {screen === "home" ? (
        <HomeScreen />
      ) : (
        <Suspense fallback={<EditorLoadingFallback />}>
          <EditorScreen key={currentHandle?.workbookId ?? "no-workbook"} />
        </Suspense>
      )}
      {blockingImport && (
        <SecurityBlockDialog
          warnings={blockingImport}
          onClose={dismissBlockingImport}
        />
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {closeResolve && (
        <CloseConfirmDialog
          fileName={closeFileName}
          onChoice={(choice) => {
            closeResolve(choice);
            setCloseResolve(null);
          }}
        />
      )}
      {xlsmMacroLossOpen && (
        <XlsmMacroLossDialog onClose={() => setXlsmMacroLossOpen(false)} />
      )}
      {isDropHovering && <DropOverlay />}
    </div>
  );
}
