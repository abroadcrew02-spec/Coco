// @vitest-environment happy-dom
//
// Integrity tests for the ribbon model (#198). The ribbon may only fire
// `coco:editor-command` ids that EditorScreen actually dispatches, and the
// model itself must be internally consistent (unique ids, valid actions).

import { describe, it, expect } from "vitest";
import { EDITOR_COMMAND_IDS } from "../../hooks/useMenuActions";
import {
  RIBBON_TABS,
  ribbonEditorCommandIds,
  type RibbonButtonDef,
} from "./ribbonDefs";

function allButtons(): RibbonButtonDef[] {
  return RIBBON_TABS.flatMap((tab) => tab.groups.flatMap((g) => g.buttons));
}

describe("ribbonDefs — command id integrity", () => {
  it("every editorCommand button targets a dispatchable EDITOR_COMMAND_ID", () => {
    const unknown = ribbonEditorCommandIds().filter(
      (id) => !EDITOR_COMMAND_IDS.has(id),
    );
    expect(unknown).toEqual([]);
  });

  it("references at least one editor command", () => {
    expect(ribbonEditorCommandIds().length).toBeGreaterThan(0);
  });
});

describe("ribbonDefs — structural integrity", () => {
  it("button ids are unique across the whole ribbon", () => {
    const ids = allButtons().map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tab ids are unique", () => {
    const ids = RIBBON_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("group ids are unique", () => {
    const ids = RIBBON_TABS.flatMap((t) => t.groups.map((g) => g.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes the six Excel-style tabs in order", () => {
    expect(RIBBON_TABS.map((t) => t.id)).toEqual([
      "home",
      "insert",
      "formulas",
      "data",
      "review",
      "view",
    ]);
  });

  it("every tab has at least one group, every group at least one button", () => {
    for (const tab of RIBBON_TABS) {
      expect(tab.groups.length).toBeGreaterThan(0);
      for (const group of tab.groups) {
        expect(group.buttons.length).toBeGreaterThan(0);
      }
    }
  });

  it("every action is a valid discriminated union member", () => {
    for (const btn of allButtons()) {
      if (btn.action.kind === "editorCommand") {
        expect(typeof btn.action.commandId).toBe("string");
        expect(btn.action.commandId.length).toBeGreaterThan(0);
      } else {
        expect(btn.action.kind).toBe("univer");
        expect(typeof btn.action.op).toBe("string");
      }
    }
  });

  it("home tab covers clipboard / font / alignment groups", () => {
    const home = RIBBON_TABS.find((t) => t.id === "home");
    const groupIds = home?.groups.map((g) => g.id) ?? [];
    expect(groupIds).toEqual(
      expect.arrayContaining(["clipboard", "font", "alignment", "number"]),
    );
  });
});
