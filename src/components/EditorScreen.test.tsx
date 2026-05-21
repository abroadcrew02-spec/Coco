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
const toolbarSource =
  editorSource.match(/<div className="editor-toolbar">[\s\S]*?\n      \{sheetPicker && \(/)?.[0] ?? "";

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

  it("uses Coco's Univer locale bundle so standard UI labels can be overridden", () => {
    expect(editorSource).toMatch(/import \{ buildCocoUniverLocale \} from "\.\/cocoUniverLocale"/);
    expect(editorSource).toMatch(/import \{ getLocale, subscribeLocale, t \} from "\.\.\/i18n\/locale"/);
    expect(editorSource).toMatch(/\[LocaleType\.EN_US\]: buildCocoUniverLocale\(getLocale\(\)\)/);
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

  it("initializes Univer and surfaces init errors", () => {
    // editorReady state was removed when the right-side toolbar buttons were
    // pulled into the native menu — readiness is now checked per-action via
    // getReadyWorkbook (see test below). Init failures still take over the
    // screen with editorInitError.
    expect(editorSource).not.toMatch(/setEditorReady\(/);
    expect(editorSource).toMatch(/fUniverRef\.current = FUniver\.newAPI\(univer\)/);
    expect(editorSource).toMatch(/if \(!fUniverRef\.current\.getActiveWorkbook\(\)\) \{\s*throw new Error\("Active workbook is not available"\);\s*\}/);
    expect(editorSource).toMatch(/setEditorInitError\(String\(e\)\)/);
  });

  it("guards editor tools per action via getReadyWorkbook", () => {
    expect(editorSource).toMatch(/EDITOR_NOT_READY_MESSAGE/);
    expect(getReadyWorkbookSource).toMatch(/const getReadyWorkbook = useCallback/);
    expect(getReadyWorkbookSource).toMatch(/setEditorOperationError\(`\$\{label\}: \$\{EDITOR_NOT_READY_MESSAGE\}`\)/);
    expect(getReadyWorkbookSource).toMatch(/setEditorOperationError\(null\)/);
    expect(editorSource).toMatch(/className="status-bar__operation-error"/);
    expect(editorSource).toMatch(/aria-live="polite"/);
  });

  it("keeps the Coco custom toolbar minimal (back-to-home + filename only)", () => {
    // The 6 quick-action buttons (表示形式 / Σ / 通貨 / % / 書式コピー / 並べ替え)
    // were moved into the native menu (書式 / データ submenus) to declutter the
    // top bar. They are still reachable via menu + keyboard shortcuts; the
    // toolbar-side disabling has nothing to gate now, so the dedicated state
    // and the "クイック操作" group are gone. `getReadyWorkbook` still guards
    // each underlying action against premature execution.
    expect(toolbarSource).not.toMatch(/aria-label="クイック操作"/);
    expect(toolbarSource).not.toMatch(/editorToolDisabled/);
    expect(toolbarSource).not.toMatch(/data-testid="autosum"/);
    expect(toolbarSource).not.toMatch(/data-testid="quick-fmt-currency"/);
    expect(toolbarSource).not.toMatch(/data-testid="format-painter"/);
    expect(toolbarSource).not.toMatch(/t\("toolbar\.save"\)/);
    expect(toolbarSource).not.toMatch(/t\("toolbar\.exportXlsx"\)/);
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
    expect(editorSource).toMatch(/shouldSkipBackgroundSnapshotSync/);
    expect(mutationSnapshotSyncSource).toMatch(/window\.requestIdleCallback/);
    expect(mutationSnapshotSyncSource).toMatch(/window\.cancelIdleCallback\(idleCallback\)/);
    expect(mutationSnapshotSyncSource).toMatch(/idleFallbackTimer = setTimeout\(\(\) => \{/);
    expect(mutationSnapshotSyncSource).toMatch(
      /markDirty\(\);\s*cancelPendingSnapshotSync\(\);\s*debounceTimer = setTimeout\(\(\) => \{\s*debounceTimer = null;\s*scheduleSnapshotSync\(\);\s*\}, 300\);/,
    );
    expect(mutationSnapshotSyncSource.match(/cancelPendingSnapshotSync\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // #184 C-1: syncSnapshot re-grafts Coco's workbook-root extension keys
    // (`_cameraLinks`, `_scenarios`) that `workbook.save()` drops, so a cell
    // edit can't silently wipe the user's camera links / scenarios.
    expect(mutationSnapshotSyncSource).toMatch(/updateSnapshot\(carryForwardRootExtensions\(fresh, prev\)\)/);
    // #87: when the workbook is too large for the fast path, we still
    // schedule a longer-leash sync (instead of returning indefinitely) so
    // protection / data-validation guards eventually see fresh state.
    expect(mutationSnapshotSyncSource).toMatch(/shouldSkipBackgroundSnapshotSync\(snapshotRef\.current\)/);
    expect(mutationSnapshotSyncSource).toMatch(/LARGE_WORKBOOK_SYNC_LEASH_MS/);
  });

  it("registers a synchronous snapshot flush for immediate save/close flows", () => {
    expect(editorSource).toMatch(/import \{ registerSnapshotFlush, carryForwardRootExtensions \} from "\.\.\/store\/snapshotSync"/);
    expect(mutationSnapshotSyncSource).toMatch(/const unregisterSnapshotFlush = registerSnapshotFlush\(\(\) => \{/);
    expect(mutationSnapshotSyncSource).toMatch(
      /registerSnapshotFlush\(\(\) => \{\s*cancelPendingSnapshotSync\(\);\s*syncSnapshot\(\);\s*\}\)/,
    );
    expect(mutationSnapshotSyncSource).toMatch(/unregisterSnapshotFlush\(\);/);
  });

  it("routes native editor menu commands to existing editor handlers", () => {
    expect(editorSource).toMatch(/const runEditorCommand = useCallback\(\(id: string\) => \{/);
    expect(editorSource).toMatch(/window\.addEventListener\("coco:editor-command", onEditorCommand\)/);
    expect(editorSource).toMatch(/case "format-number":\s*openNumberFormatDialog\(\);/);
    expect(editorSource).toMatch(/case "format-currency":\s*applyQuickFormat\(QUICK_FMT_CURRENCY\);/);
    expect(editorSource).toMatch(/case "data-autosum":\s*applyAutoSum\(\);/);
    expect(editorSource).toMatch(/case "tools-sheet-protection":\s*toggleSheetProtection\(\);/);
    expect(toolbarSource).not.toMatch(/data-testid="sheet-protection-toggle"/);
    // #97: apply-style mutations now go through applyMutatedSnapshot so the
    // pre-mutation state is checkpointed for Coco undo (Ctrl+Alt+Z).
    expect(editorSource).toMatch(/applyMutatedSnapshot\(JSON\.stringify\(fresh\)\)/);
    expect(editorSource).toMatch(/_protected/);
  });
});
