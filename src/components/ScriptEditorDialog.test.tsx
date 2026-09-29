// @vitest-environment happy-dom
//
// #355 — the script editor only runs, dry-runs or fires menu items when the
// execution grant covers the selected script. Viewing and editing still work.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { runScriptMock, collectTriggersMock, fireTriggerMock } = vi.hoisted(() => ({
  runScriptMock: vi.fn(),
  collectTriggersMock: vi.fn(),
  fireTriggerMock: vi.fn(),
}));

vi.mock("../store/scriptRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/scriptRuntime")>();
  return {
    ...actual,
    runScript: runScriptMock,
    collectTriggers: collectTriggersMock,
    fireTrigger: fireTriggerMock,
  };
});

import ScriptEditorDialog from "./ScriptEditorDialog";
import { issueGrant, type ScriptExecutionGrant } from "../store/scriptGrant";
import type { ScriptEntry } from "../store/scriptRuntime";

const entry: ScriptEntry = {
  id: "s1",
  name: "Script 1",
  source: "Nicel.addMenuItem('Go', () => api.log('go'));",
  lastModified: 1,
};

let seq = 0;
function grantFor(...sources: string[]): ScriptExecutionGrant {
  return issueGrant(`dialog-test-${++seq}`, "sha256:dialog", "session", {
    sources,
    connectionSignatures: [],
  });
}

const okResult = {
  ok: true,
  logs: [],
  error: null,
  stack: null,
  errorLine: null,
  elapsedMs: 1,
  timedOut: false,
};

function renderDialog(grant: ScriptExecutionGrant | null, onChange = vi.fn()) {
  return render(
    <ScriptEditorDialog
      scripts={[entry]}
      fUniver={null}
      snapshotJson={null}
      grant={grant}
      onChange={onChange}
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  runScriptMock.mockReset().mockResolvedValue(okResult);
  collectTriggersMock.mockReset().mockResolvedValue({
    scriptId: entry.id,
    scriptName: entry.name,
    triggers: [{ kind: "menu", label: "Go", intervalMs: 0 }],
  });
  fireTriggerMock.mockReset().mockResolvedValue(okResult);
});

afterEach(() => cleanup());

describe("ScriptEditorDialog — trust gate", () => {
  it("without a grant: no dry run, Run disabled, source still editable", async () => {
    const onChange = vi.fn();
    renderDialog(null, onChange);
    const run = screen.getByRole("button", { name: "▶ 実行" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    await Promise.resolve();
    expect(runScriptMock).not.toHaveBeenCalled();
    expect(collectTriggersMock).not.toHaveBeenCalled();

    const textarea = document.querySelector("textarea.script-editor-source") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "api.log('edited');" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("with a covering grant: dry run and Run pass the grant", async () => {
    const grant = grantFor(entry.source);
    renderDialog(grant);
    await waitFor(() => expect(collectTriggersMock).toHaveBeenCalled());
    expect(collectTriggersMock.mock.calls[0][1]).toMatchObject({ grant });

    const run = screen.getByRole("button", { name: "▶ 実行" }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(runScriptMock).toHaveBeenCalledTimes(1));
    expect(runScriptMock.mock.calls[0][0]).toBe(entry.source);
    expect(runScriptMock.mock.calls[0][1]).toMatchObject({ grant });
  });

  it("menu items fire with the grant", async () => {
    const grant = grantFor(entry.source);
    renderDialog(grant);
    const chip = await screen.findByRole("button", { name: /Go/ });
    fireEvent.click(chip);
    await waitFor(() => expect(fireTriggerMock).toHaveBeenCalledTimes(1));
    expect(fireTriggerMock.mock.calls[0][1]).toBe("menu");
    expect(fireTriggerMock.mock.calls[0][2]).toMatchObject({ grant, label: "Go" });
  });

  it("a grant that does not cover the current source disables Run and skips the dry run", async () => {
    renderDialog(grantFor("api.log('some other script');"));
    const run = screen.getByRole("button", { name: "▶ 実行" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await Promise.resolve();
    expect(collectTriggersMock).not.toHaveBeenCalled();
  });
});
