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
// #202: the standalone Coco toolbar row was removed — "← Home" and the file
// name now live inside the ribbon's tab strip. The region from the ribbon
// mount to the sheet-picker stands in for the former toolbar source slice.
const toolbarSource =
  editorSource.match(/<Ribbon[\s\S]*?\n      \{sheetPicker && \(/)?.[0] ?? "";
// #189 — the script-trigger useEffect (onOpen / onEdit / timer wiring).
const triggerEffectSource =
  editorSource.match(/\/\/ #189 — script triggers\.[\s\S]*?\n  \}, \[currentSnapshotJson\]\);/)?.[0] ?? "";

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

  it("folds back-to-home + filename into the ribbon, no standalone toolbar (#202)", () => {
    // #202: the standalone Coco toolbar row is gone — the ribbon owns the
    // "← Home" navigation and file name (passed as props). No quick-action
    // buttons or per-feature toolbar state remain in this region.
    expect(editorSource).not.toMatch(/className="editor-toolbar"/);
    expect(editorSource).toMatch(/onGoHome=\{goHomeAfterConfirm\}/);
    expect(editorSource).toMatch(/fileLabel=\{fileLabel\}/);
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

  it("guards onEdit triggers against the MUTATION re-entry loop (#189 C1)", () => {
    // The MUTATION listener fires onEdit handlers; those handlers can write
    // cells, producing more MUTATIONs. Without a re-entry guard this loops
    // forever. The fix: a `firingEdit` flag set for the whole dispatch, and
    // an early return at the top of the listener while it is set.
    expect(triggerEffectSource).toMatch(/let firingEdit = false;/);
    expect(triggerEffectSource).toMatch(/if \(firingEdit\) return;/);
    expect(triggerEffectSource).toMatch(/firingEdit = true;/);
    expect(triggerEffectSource).toMatch(/firingEdit = false;/);
    // The fire-and-forget `void fireTrigger(...).then(...)` is gone — runs
    // are awaited (serialized) so the guard covers async handler execution.
    expect(triggerEffectSource).not.toMatch(/void fireTrigger\(/);
    expect(triggerEffectSource).toMatch(/await fireTrigger\(entry, kind/);
  });

  it("skips overlapping timer ticks and no-ops after unmount (#189 M1)", () => {
    // M1: a slow timer handler must not pile up. Each timer key tracks an
    // in-flight run in `timerRunning`; a tick is skipped while its key is set.
    expect(triggerEffectSource).toMatch(/const timerRunning = new Set<string>\(\)/);
    expect(triggerEffectSource).toMatch(/if \(disposed \|\| timerRunning\.has\(key\)\) return;/);
    expect(triggerEffectSource).toMatch(/timerRunning\.add\(key\)/);
    expect(triggerEffectSource).toMatch(/\.finally\(\(\) => timerRunning\.delete\(key\)\)/);
    // M1: after unmount, fireAll re-checks `disposed` before recordRun/log.
    expect(triggerEffectSource).toMatch(
      /if \(disposed\) return;\s*\n\s*recordRun\(entry, kind, result\);/,
    );
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
