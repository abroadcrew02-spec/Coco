// @vitest-environment node
// Univer mounts a canvas-backed renderer that doesn't run cleanly in jsdom /
// happy-dom, so a full <EditorScreen /> render isn't feasible here. Instead
// this test asserts that the Find/Replace plugin registration is present in
// the source by reading the file directly. The check is mechanical but
// guards against silent regressions (e.g. someone removes the import).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const editorSource = readFileSync(resolve(here, "EditorScreen.tsx"), "utf8");
const getReadyWorkbookSource =
  editorSource.match(/const getReadyWorkbook = useCallback\(\(label: string\) => \{[\s\S]*?\n  \}, \[\]\);/)?.[0] ?? "";
const mutationSnapshotSyncSource =
  editorSource.match(/\/\/ Sync snapshot to store on data mutations[\s\S]*?\n  \}, \[markDirty, updateSnapshot\]\);/)?.[0] ?? "";

describe("EditorScreen Univer plugin wiring", () => {
  it("imports and registers the Find/Replace plugins (Ctrl+F / Ctrl+H)", () => {
    expect(editorSource).toMatch(
      /from "@univerjs\/find-replace"/,
    );
    expect(editorSource).toMatch(
      /from "@univerjs\/sheets-find-replace"/,
    );
    expect(editorSource).toMatch(
      /univer\.registerPlugin\(UniverFindReplacePlugin\)/,
    );
    expect(editorSource).toMatch(
      /univer\.registerPlugin\(UniverSheetsFindReplacePlugin\)/,
    );
  });

  it("includes the find-replace stylesheet so the dialog has its CSS", () => {
    expect(editorSource).toMatch(
      /"@univerjs\/find-replace\/lib\/index\.css"/,
    );
  });

  it("imports and registers the sheets-filter plugin (FR-009)", () => {
    expect(editorSource).toMatch(
      /from "@univerjs\/sheets-filter"/,
    );
    expect(editorSource).toMatch(
      /univer\.registerPlugin\(UniverSheetsFilterPlugin\)/,
    );
  });

  it("catches editor init errors and renders a recovery panel", () => {
    expect(editorSource).toMatch(/setEditorInitError\(String\(e\)\)/);
    expect(editorSource).toMatch(/role="alert"/);
    expect(editorSource).toMatch(/エディタを表示できません/);
    expect(editorSource).toMatch(/ホームへ戻る/);
  });

  it("routes the init-error home action through the unsaved discard guard", () => {
    expect(editorSource).toMatch(/goHomeAfterConfirm = \(\) => \{/);
    expect(editorSource).toMatch(/if \(!confirmDiscardIfUnsaved\(\)\) return;\s*goHome\(\);/);
    expect(editorSource).toMatch(/onClick=\{goHomeAfterConfirm\}/);
    expect(editorSource).not.toMatch(/onClick=\{goHome\} title="ホームへ戻る"/);
  });

  it("tracks editor readiness and clears it on init failure or cleanup", () => {
    expect(editorSource).toMatch(/const \[editorReady, setEditorReady\] = useState\(false\)/);
    expect(editorSource).toMatch(/setEditorReady\(false\);\s*setEditorOperationError\(null\);/);
    expect(editorSource).toMatch(/fUniverRef\.current = FUniver\.newAPI\(univer\)/);
    expect(editorSource).toMatch(
      /if \(!fUniverRef\.current\.getActiveWorkbook\(\)\) \{\s*throw new Error\("Active workbook is not available"\);\s*\}\s*setEditorReady\(true\)/,
    );
    expect(editorSource).toMatch(/setEditorReady\(false\);\s*setEditorInitError\(String\(e\)\)/);
  });

  it("guards editor tools per action without latching the toolbar disabled", () => {
    expect(editorSource).toMatch(/EDITOR_NOT_READY_MESSAGE/);
    expect(getReadyWorkbookSource).toMatch(/const getReadyWorkbook = useCallback/);
    expect(getReadyWorkbookSource).toMatch(/setEditorOperationError\(`\$\{label\}: \$\{EDITOR_NOT_READY_MESSAGE\}`\)/);
    expect(getReadyWorkbookSource).not.toMatch(/setEditorReady\(false\)/);
    expect(getReadyWorkbookSource).toMatch(/setEditorReady\(true\);\s*setEditorOperationError\(null\)/);
    expect(editorSource).toMatch(/className="status-bar__operation-error"/);
    expect(editorSource).toMatch(/aria-live="polite"/);
  });

  it("disables workbook-dependent toolbar actions until the editor is ready", () => {
    expect(editorSource).toMatch(/const editorToolDisabled = !editorReady/);
    expect(editorSource).toMatch(/disabled=\{isExporting \|\| editorToolDisabled\}/);
    expect(editorSource.match(/disabled=\{editorToolDisabled\}/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
  });

  it("surfaces an error when CSV export has no sheet names", () => {
    expect(editorSource).toMatch(/const sheets = await listSheetNames\(\)/);
    expect(editorSource).toMatch(/CSV エクスポート: エクスポートできるシートがまだありません。/);
    expect(editorSource).not.toMatch(/if \(sheets\.length === 0\) return;/);
  });

  it("preflights bulk CSV export for duplicate names and existing files", () => {
    expect(editorSource).toMatch(/const outputs = sheets\.map/);
    expect(editorSource).toMatch(/シート名の変換後に同じファイル名になるため中止しました/);
    expect(editorSource).toMatch(/existing_csv_export_paths/);
    expect(editorSource).toMatch(/window\.confirm\(/);
  });

  it("defers mutation snapshot sync to idle work and cancels stale scheduled syncs", () => {
    expect(mutationSnapshotSyncSource).toMatch(/window\.requestIdleCallback/);
    expect(mutationSnapshotSyncSource).toMatch(/window\.cancelIdleCallback\(idleCallback\)/);
    expect(mutationSnapshotSyncSource).toMatch(/idleFallbackTimer = setTimeout\(\(\) => \{/);
    expect(mutationSnapshotSyncSource).toMatch(
      /markDirty\(\);\s*cancelPendingSnapshotSync\(\);\s*debounceTimer = setTimeout\(\(\) => \{\s*debounceTimer = null;\s*scheduleSnapshotSync\(\);\s*\}, 300\);/,
    );
    expect(mutationSnapshotSyncSource.match(/cancelPendingSnapshotSync\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(mutationSnapshotSyncSource).toMatch(/updateSnapshot\(JSON\.stringify\(workbook\.save\(\)\)\)/);
  });

  it("registers a synchronous snapshot flush for immediate save/close flows", () => {
    expect(editorSource).toMatch(/import \{ registerSnapshotFlush \} from "\.\.\/store\/snapshotSync"/);
    expect(mutationSnapshotSyncSource).toMatch(/const unregisterSnapshotFlush = registerSnapshotFlush\(\(\) => \{/);
    expect(mutationSnapshotSyncSource).toMatch(
      /registerSnapshotFlush\(\(\) => \{\s*cancelPendingSnapshotSync\(\);\s*syncSnapshot\(\);\s*\}\)/,
    );
    expect(mutationSnapshotSyncSource).toMatch(/unregisterSnapshotFlush\(\);/);
  });

  it("renders the sheet-protection toggle button and wires its handler", () => {
    // The toolbar button must be present with the testid and onClick handler
    // so toggling sheet protection routes through `toggleSheetProtection`.
    expect(editorSource).toMatch(/toggleSheetProtection/);
    expect(editorSource).toMatch(/data-testid="sheet-protection-toggle"/);
    // Locked / unlocked labels — emoji + Japanese verb. Guards against
    // accidental label drift.
    expect(editorSource).toMatch(/🔒 保護/);
    expect(editorSource).toMatch(/🔓 解除/);
    // The handler must write back via updateSnapshot so the save button
    // enables and the round-trip catches the change.
    expect(editorSource).toMatch(/updateSnapshot\(JSON\.stringify\(fresh\)\)/);
    // Snapshot field name — must match the Rust side `_protected`.
    expect(editorSource).toMatch(/_protected/);
  });
});
