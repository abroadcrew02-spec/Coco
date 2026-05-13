import { useEffect, useState, lazy, Suspense } from "react";
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
    loadRecentFiles,
    loadRecoveryCandidates,
    loadAutoSaveInterval,
    loadCsvExportEncoding,
    loadCsvImportEncoding,
    dismissBlockingImport,
  } = useWorkbookStore();

  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeResolve, setCloseResolve] = useState<
    ((choice: "save" | "discard" | "cancel") => void) | null
  >(null);

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
  }, [
    loadRecentFiles,
    loadRecoveryCandidates,
    loadAutoSaveInterval,
    loadCsvExportEncoding,
    loadCsvImportEncoding,
  ]);

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
      {isDropHovering && <DropOverlay />}
    </div>
  );
}
