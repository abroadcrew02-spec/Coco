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
