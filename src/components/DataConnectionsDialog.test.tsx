// @vitest-environment happy-dom
//
// #355 — the connections dialog must show and save the schedule exactly as
// the scheduler and the trust fingerprint read it. A stored schedule value the
// scheduler ignores (e.g. the string "5") must not be shown as active and must
// not become active when the user only edits other fields and saves.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import DataConnectionsDialog from "./DataConnectionsDialog";
import {
  listConnections,
  updateConnection,
  type DataConnection,
} from "../store/dataConnections";
import {
  computeActiveContent,
  createMemoryTrustPersistence,
  createScriptTrustStore,
} from "../store/scriptTrust";
import { normalizeIntervalMinutesInput } from "../store/dataConnectionSchedule";

type EditPatch = {
  name: string;
  targetSheetName: string;
  steps: unknown[];
  scheduleOnOpen: boolean;
  scheduleIntervalMinutes: number;
};

function snapshotWith(schedule: unknown): string {
  const c = {
    id: "c1",
    name: "Sales feed",
    type: "web",
    sourcePath: "",
    targetSheetId: null,
    targetSheetName: "Sales",
    lastRefreshedAt: null,
    steps: [],
    web: { url: "https://example.test/sales.json", format: "json", headers: {} },
    schedule,
  };
  return JSON.stringify({ sheets: {}, _connections: [c] });
}

/** Apply the dialog's patch the way EditorScreen.handleDataConnectionEdit does. */
function applyEdit(snapshotJson: string, id: string, patch: EditPatch): string {
  const snap = JSON.parse(snapshotJson) as Parameters<typeof listConnections>[0];
  updateConnection(snap, id, {
    name: patch.name,
    targetSheetName: patch.targetSheetName,
    steps: patch.steps as DataConnection["steps"],
    schedule: {
      onOpen: patch.scheduleOnOpen === true,
      intervalMinutes: normalizeIntervalMinutesInput(patch.scheduleIntervalMinutes),
    },
  });
  return JSON.stringify(snap);
}

function renderDialog(snapshotJson: string, onEdit = vi.fn(async (_id: string, _p: EditPatch) => {})) {
  render(
    <DataConnectionsDialog
      snapshotJson={snapshotJson}
      onRefresh={vi.fn(async () => {})}
      onAdd={vi.fn(async () => {})}
      onEdit={onEdit as never}
      onRemove={vi.fn(async () => {})}
      onClose={() => {}}
    />,
  );
  return onEdit;
}

afterEach(() => cleanup());

const ignoredSchedules: { name: string; schedule: unknown }[] = [
  { name: 'interval "5" (string)', schedule: { onOpen: false, intervalMinutes: "5" } },
  { name: "interval true", schedule: { onOpen: false, intervalMinutes: true } },
  { name: "interval [5]", schedule: { onOpen: false, intervalMinutes: [5] } },
  { name: 'onOpen "yes"', schedule: { onOpen: "yes", intervalMinutes: 0 } },
  { name: "interval 0.001 (below range)", schedule: { onOpen: false, intervalMinutes: 0.001 } },
];

describe("DataConnectionsDialog — schedule shown and saved as the scheduler reads it", () => {
  it.each(ignoredSchedules)(
    "$name: no badge, form starts inactive, renaming keeps the workbook at none",
    async ({ schedule }) => {
      const prev = snapshotWith(schedule);
      const onEdit = renderDialog(prev);

      // The list does not claim a schedule the scheduler ignores.
      expect(screen.queryByText(/分毎/)).toBeNull();
      expect(screen.queryByText(/起動時/)).toBeNull();

      fireEvent.click(screen.getByTestId("dcd-edit-c1"));
      expect((screen.getByTestId("dcd-sched-onopen") as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId("dcd-sched-interval") as HTMLInputElement).value).toBe("0");

      // Only the name changes.
      fireEvent.change(screen.getByTestId("dcd-edit-name"), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByTestId("dcd-edit-submit"));
      await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
      const [id, patch] = onEdit.mock.calls[0] as [string, EditPatch];
      expect(patch.name).toBe("Renamed");
      expect(patch.scheduleOnOpen).toBe(false);
      expect(patch.scheduleIntervalMinutes).toBe(0);

      // The fingerprint does not change: still nothing that runs by itself.
      const next = applyEdit(prev, id, patch);
      const before = await computeActiveContent(prev);
      const after = await computeActiveContent(next);
      expect(before.isEmpty).toBe(true);
      expect(after.isEmpty).toBe(true);
      expect(after.fingerprint).toBe(before.fingerprint);

      // And the in-app edit is not promoted to a trusted "self" run.
      const store = createScriptTrustStore(createMemoryTrustPersistence());
      const subject = { sessionKey: `dcd-${Math.random()}`, path: "C:\\b.coco", lookupPath: null };
      await store.adoptLocalEdit(subject, prev, next);
      const r = await store.evaluate(subject, next);
      expect(r.state).toEqual({ kind: "none" });
      expect(r.grant).toBeNull();
    },
  );

  it("shows and keeps a valid schedule", async () => {
    const prev = snapshotWith({ onOpen: true, intervalMinutes: 15 });
    const onEdit = renderDialog(prev);
    expect(screen.getByText("起動時 / 15分毎")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dcd-edit-c1"));
    expect((screen.getByTestId("dcd-sched-onopen") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("dcd-sched-interval") as HTMLInputElement).value).toBe("15");
    fireEvent.click(screen.getByTestId("dcd-edit-submit"));
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    const patch = onEdit.mock.calls[0][1] as EditPatch;
    expect(patch.scheduleOnOpen).toBe(true);
    expect(patch.scheduleIntervalMinutes).toBe(15);
  });

  it("caps a typed interval at the longest the timer supports", async () => {
    const onEdit = renderDialog(snapshotWith({ onOpen: false, intervalMinutes: 0 }));
    fireEvent.click(screen.getByTestId("dcd-edit-c1"));
    fireEvent.change(screen.getByTestId("dcd-sched-interval"), { target: { value: "99999" } });
    fireEvent.click(screen.getByTestId("dcd-edit-submit"));
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect((onEdit.mock.calls[0][1] as EditPatch).scheduleIntervalMinutes).toBe(35791);
  });
});
