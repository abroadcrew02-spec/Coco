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
});
