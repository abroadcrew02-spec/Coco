// @vitest-environment happy-dom
//
// End-to-end test for the クラッシュ復元 flow (requirements.md §6.5,
// FR-013-adjacent). Walks the user journey at the store + HomeScreen level:
//
//   1. Previous session terminated abnormally → loadRecoveryCandidates
//      populates the store from `workbook_list_recovery`; HomeScreen renders
//      the 復元候補 section with each candidate.
//   2. User picks 復元 / 破棄 / 後で確認 (close).
//   3. Restoring opens a COPY: store screen flips to "editor" and the new
//      handle's `path` is null — so the user can't overwrite the original by
//      accident.
//   4. First Ctrl+S after restore: store.save() routes through the Save As
//      prompt (saveDialog) because path is null.
//
// We mock @tauri-apps/api/core and @tauri-apps/plugin-dialog the same way as
// App.test.tsx + HomeScreen.test.tsx do (vi.hoisted + vi.mock factories).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { invokeMock, openMock, saveDialogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  saveDialogMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
  save: saveDialogMock,
}));
// Avoid scheduling requestIdleCallback work from the editor preload hook.
vi.mock("./hooks/useEditorPreload", () => ({ useEditorPreload: () => {} }));

import HomeScreen from "./components/HomeScreen";
import { useWorkbookStore } from "./store/useWorkbookStore";

function resetStore() {
  useWorkbookStore.setState({
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
    lastSavedAt: null,
    autoSaveIntervalMs: 30_000,
    csvExportEncoding: "utf8-bom",
    csvImportEncoding: "auto",
    pinnedPaths: [],
    pinnedOrder: [],
    suppressCsvPocWarning: false,
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  openMock.mockReset();
  saveDialogMock.mockReset();
  resetStore();
});

afterEach(() => cleanup());

describe("recovery flow §6.5 (クラッシュ復元) — end to end", () => {
  it("step 1: loadRecoveryCandidates → HomeScreen renders the 復元候補 section", async () => {
    // Startup: app boots, calls workbook_list_recovery. Rust returns two
    // candidates from a prior crashed session.
    invokeMock.mockResolvedValueOnce([
      {
        candidateId: "wb-alpha",
        originalPath: "/work/budget.xlsx",
        savedAt: "2026-05-13T10:00:00Z",
        reason: "auto_save",
      },
      {
        candidateId: "wb-beta",
        originalPath: null,
        savedAt: "2026-05-13T09:30:00Z",
        reason: "manual_save",
      },
    ]);
    await useWorkbookStore.getState().loadRecoveryCandidates();
    expect(invokeMock).toHaveBeenCalledWith("workbook_list_recovery");
    expect(useWorkbookStore.getState().recoveryCandidates).toHaveLength(2);

    render(<HomeScreen />);
    expect(screen.getByText("復元候補")).toBeTruthy();
    expect(screen.getByText("/work/budget.xlsx")).toBeTruthy();
    expect(screen.getByText("無題のワークブック")).toBeTruthy();
    // Both action buttons render for each candidate (2 × 2).
    expect(screen.getAllByText("復元")).toHaveLength(2);
    expect(screen.getAllByText("破棄")).toHaveLength(2);
  });

  it("step 2a (復元): clicking 復元 invokes workbook_restore_backup and opens a copy with null path", async () => {
    const user = userEvent.setup();
    // Seed the store as if step 1 already ran.
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-alpha",
          originalPath: "/work/budget.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
      ],
    });
    // Rust returns the temp .coco path; the store overrides it to null so
    // the user can't accidentally overwrite either the original .xlsx or
    // the temp recovery file.
    invokeMock.mockResolvedValueOnce({
      handle: {
        workbookId: "wb-alpha",
        path: "/data/recovery/wb-alpha.coco",
        sourceType: "coco",
        snapshotJson: "{\"restored\":true}",
      },
      warnings: [],
    });

    render(<HomeScreen />);
    await user.click(screen.getByText("復元"));

    // The right backend command was invoked with the candidate id.
    const restoreCall = invokeMock.mock.calls.find(
      (c) => c[0] === "workbook_restore_backup"
    );
    expect(restoreCall).toBeTruthy();
    expect(restoreCall![1]).toEqual({ candidateId: "wb-alpha" });

    // Store reflects the restored editor session.
    const s = useWorkbookStore.getState();
    expect(s.screen).toBe("editor");
    expect(s.saveStatus).toBe("unsaved");
    // CRITICAL §6.5 invariant: the restored workbook opens as an unnamed
    // copy. path must NOT equal the original (/work/budget.xlsx) and must
    // NOT equal the temp path Rust returned. It's null so Ctrl+S routes
    // through Save As.
    expect(s.currentHandle?.path).toBeNull();
    expect(s.currentHandle?.workbookId).toBe("wb-alpha");
    expect(s.currentSnapshotJson).toBe("{\"restored\":true}");
  });

  it("step 2b (破棄): clicking 破棄 invokes workbook_clear_recovery and removes the candidate from the list", async () => {
    const user = userEvent.setup();
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-alpha",
          originalPath: "/work/budget.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
        {
          candidateId: "wb-beta",
          originalPath: null,
          savedAt: "2026-05-13T09:30:00Z",
          reason: "manual_save",
        },
      ],
    });

    render(<HomeScreen />);
    // Dismiss the SECOND candidate; the first must remain.
    const dismissButtons = screen.getAllByText("破棄");
    await user.click(dismissButtons[1]);

    const clearCall = invokeMock.mock.calls.find(
      (c) => c[0] === "workbook_clear_recovery"
    );
    expect(clearCall).toBeTruthy();
    expect(clearCall![1]).toEqual({ candidateId: "wb-beta" });

    // Store no longer carries the dismissed entry.
    const remaining = useWorkbookStore.getState().recoveryCandidates;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].candidateId).toBe("wb-alpha");
    // The store should NOT have flipped to the editor — dismiss is not open.
    expect(useWorkbookStore.getState().screen).toBe("home");
  });

  it("step 2c (後で確認): doing nothing leaves the candidate intact for next launch", () => {
    // The "後で確認" path is implicit — no action button. Verify the
    // candidate persists in state until either 復元 or 破棄 runs.
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-alpha",
          originalPath: "/work/budget.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
      ],
    });
    render(<HomeScreen />);
    // No clicks. The candidate row is still there.
    expect(screen.getByText("/work/budget.xlsx")).toBeTruthy();
    // No invoke calls were made just by rendering.
    const candidateCalls = invokeMock.mock.calls.filter((c) =>
      ["workbook_restore_backup", "workbook_clear_recovery"].includes(c[0] as string)
    );
    expect(candidateCalls).toHaveLength(0);
    // State still carries the candidate.
    expect(useWorkbookStore.getState().recoveryCandidates).toHaveLength(1);
  });

  it("step 3: restoring does NOT overwrite the original path on disk (no workbook_save invoked)", async () => {
    // The act of restoring must never call workbook_save / workbook_export_xlsx
    // against the original path — that would defeat the "open a copy"
    // protection from §6.5. Only workbook_restore_backup may fire.
    const user = userEvent.setup();
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-alpha",
          originalPath: "/work/budget.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
      ],
    });
    invokeMock.mockResolvedValueOnce({
      handle: {
        workbookId: "wb-alpha",
        path: "/data/recovery/wb-alpha.coco",
        sourceType: "coco",
        snapshotJson: "{}",
      },
      warnings: [],
    });
    render(<HomeScreen />);
    await user.click(screen.getByText("復元"));

    const dangerousCalls = invokeMock.mock.calls.filter((c) =>
      [
        "workbook_save",
        "workbook_save_as",
        "workbook_export_xlsx",
        "workbook_autosave_coco",
      ].includes(c[0] as string)
    );
    expect(dangerousCalls).toHaveLength(0);
  });

  it("step 4: first save() after restore prompts Save As (path is null)", async () => {
    // Compose steps 2a + 4: restore the candidate, then call save(). Because
    // the store forces path=null on restore, save() must hit the saveDialog
    // path rather than auto-overwriting anything.
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-alpha",
          originalPath: "/work/budget.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
      ],
    });

    // First invoke = workbook_restore_backup. Second = the chosen workbook_export_xlsx.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "workbook_restore_backup") {
        return Promise.resolve({
          handle: {
            workbookId: "wb-alpha",
            path: "/data/recovery/wb-alpha.coco",
            sourceType: "coco",
            snapshotJson: "{\"restored\":true}",
          },
          warnings: [],
        });
      }
      if (cmd === "workbook_export_xlsx") {
        return Promise.resolve({
          success: true,
          path: "/work/recovered-copy.xlsx",
          warnings: [],
        });
      }
      if (cmd === "workbook_clear_recovery") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    saveDialogMock.mockResolvedValueOnce("/work/recovered-copy.xlsx");

    // Step 2a + 3.
    await useWorkbookStore.getState().restoreCandidate("wb-alpha");
    expect(useWorkbookStore.getState().currentHandle?.path).toBeNull();

    // Step 4: first save → Save As prompt.
    await useWorkbookStore.getState().save();
    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    // The dialog default points at Untitled.xlsx (xlsx is canonical post-pivot).
    const dialogArg = saveDialogMock.mock.calls[0][0];
    expect(dialogArg.defaultPath).toBe("Untitled.xlsx");

    // Save was actually exercised against the chosen path.
    const exportCall = invokeMock.mock.calls.find(
      (c) => c[0] === "workbook_export_xlsx"
    );
    expect(exportCall).toBeTruthy();
    expect((exportCall![1] as { path: string }).path).toBe("/work/recovered-copy.xlsx");

    // After successful save, the handle path is now the user-chosen target —
    // crucially NOT the original /work/budget.xlsx (no accidental overwrite).
    const s = useWorkbookStore.getState();
    expect(s.currentHandle?.path).toBe("/work/recovered-copy.xlsx");
    expect(s.currentHandle?.path).not.toBe("/work/budget.xlsx");
    expect(s.saveStatus).toBe("saved");
  });

  it("step 4 cancel path: cancelling the Save As dialog leaves saveStatus = unsaved (no overwrite)", async () => {
    // The user picked 復元 but then dismissed the Save As prompt. The
    // workbook stays in memory in an unsaved state; no command writes
    // anywhere on disk.
    useWorkbookStore.setState({
      currentHandle: {
        workbookId: "wb-alpha",
        path: null,
        sourceType: "coco",
        snapshotJson: "{\"restored\":true}",
        requiresSaveAsOnFirstSave: true,
      },
      currentSnapshotJson: "{\"restored\":true}",
      screen: "editor",
      saveStatus: "unsaved",
    });
    saveDialogMock.mockResolvedValueOnce(null);

    await useWorkbookStore.getState().save();

    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    // No export/save command should have fired.
    const writeCalls = invokeMock.mock.calls.filter((c) =>
      ["workbook_export_xlsx", "workbook_save", "workbook_save_as"].includes(
        c[0] as string
      )
    );
    expect(writeCalls).toHaveLength(0);
    // State unchanged: still unsaved, still null path.
    const s = useWorkbookStore.getState();
    expect(s.saveStatus).toBe("unsaved");
    expect(s.currentHandle?.path).toBeNull();
  });

  it("dismiss + restore can be mixed in one session without cross-contamination", async () => {
    // Real-world flow: two candidates, user dismisses one then restores the
    // other. Each call carries its own candidateId.
    const user = userEvent.setup();
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-keep",
          originalPath: "/work/important.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
        {
          candidateId: "wb-trash",
          originalPath: "/work/scratch.xlsx",
          savedAt: "2026-05-13T09:00:00Z",
          reason: "auto_save",
        },
      ],
    });
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "workbook_clear_recovery") return Promise.resolve(undefined);
      if (cmd === "workbook_restore_backup") {
        return Promise.resolve({
          handle: {
            workbookId: args.candidateId as string,
            path: `/data/recovery/${args.candidateId}.coco`,
            sourceType: "coco",
            snapshotJson: "{}",
          },
          warnings: [],
        });
      }
      return Promise.resolve(undefined);
    });

    render(<HomeScreen />);

    // The trash row is rendered SECOND (auto_save with /work/scratch.xlsx).
    const dismissButtons = screen.getAllByText("破棄");
    await user.click(dismissButtons[1]);
    // The keep row should still render; its 復元 button still works.
    expect(useWorkbookStore.getState().recoveryCandidates).toHaveLength(1);
    expect(
      useWorkbookStore.getState().recoveryCandidates[0].candidateId
    ).toBe("wb-keep");

    // Now restore the surviving candidate.
    await user.click(screen.getByText("復元"));

    const clearCall = invokeMock.mock.calls.find(
      (c) => c[0] === "workbook_clear_recovery"
    );
    const restoreCall = invokeMock.mock.calls.find(
      (c) => c[0] === "workbook_restore_backup"
    );
    expect(clearCall![1]).toEqual({ candidateId: "wb-trash" });
    expect(restoreCall![1]).toEqual({ candidateId: "wb-keep" });
    // After restore the screen is the editor; path is null per §6.5.
    const s = useWorkbookStore.getState();
    expect(s.screen).toBe("editor");
    expect(s.currentHandle?.workbookId).toBe("wb-keep");
    expect(s.currentHandle?.path).toBeNull();
  });

  it("restore failure: surfaces lastError and keeps the user on the home screen", async () => {
    // If Rust rejects (recovery file missing, db locked, etc.), the home
    // screen stays put and the user sees a friendly error. The candidate
    // list is NOT cleared — the user can retry or 破棄 manually.
    useWorkbookStore.setState({
      recoveryCandidates: [
        {
          candidateId: "wb-broken",
          originalPath: "/work/budget.xlsx",
          savedAt: "2026-05-13T10:00:00Z",
          reason: "auto_save",
        },
      ],
    });
    invokeMock.mockRejectedValueOnce("Recovery file is missing: /data/recovery/wb-broken.coco");

    await useWorkbookStore.getState().restoreCandidate("wb-broken");

    const s = useWorkbookStore.getState();
    expect(s.lastError).not.toBeNull();
    expect(s.lastError).toContain("/data/recovery/wb-broken.coco");
    // The candidate is still in the list — we didn't silently drop it.
    expect(s.recoveryCandidates).toHaveLength(1);
    // We never flipped to editor.
    expect(s.screen).toBe("home");
    expect(s.currentHandle).toBeNull();
  });
});
