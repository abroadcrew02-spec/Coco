import { useEffect } from "react";
import { useWorkbookStore } from "./store/useWorkbookStore";
import HomeScreen from "./components/HomeScreen";
import EditorScreen from "./components/EditorScreen";

export default function App() {
  const { screen, currentHandle, loadRecentFiles, loadRecoveryCandidates } = useWorkbookStore();

  useEffect(() => {
    loadRecentFiles();
    loadRecoveryCandidates();
  }, [loadRecentFiles, loadRecoveryCandidates]);

  return (
    <div className="app">
      {screen === "home" ? (
        <HomeScreen />
      ) : (
        <EditorScreen key={currentHandle?.workbookId ?? "no-workbook"} />
      )}
    </div>
  );
}
