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
  ribbonMenuActionIds,
  type RibbonButtonDef,
} from "./ribbonDefs";

// #202: the menu-only ids `useMenuActions` dispatches via its own switch
// (everything not in EDITOR_COMMAND_IDS). The File tab's `menuAction` buttons
// must target one of these so file/store operations still work.
const MENU_ACTION_IDS = new Set([
  "new",
  "open",
  "save",
  "save-as",
  "export-xlsx",
  "export-csv",
  "export-html",
  "export-pdf",
  "export-workspace-bundle",
  "import-workspace-bundle",
  "settings",
  "help",
  "close",
]);

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

  it("every menuAction button targets an id useMenuActions dispatches (#202)", () => {
    const unknown = ribbonMenuActionIds().filter(
      (id) => !MENU_ACTION_IDS.has(id),
    );
    expect(unknown).toEqual([]);
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

  it("exposes the Excel-style tabs in order, File first (#202)", () => {
    expect(RIBBON_TABS.map((t) => t.id)).toEqual([
      "file",
      "home",
      "insert",
      "formulas",
      "data",
      "review",
      "view",
      "tools",
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
      } else if (btn.action.kind === "menuAction") {
        expect(typeof btn.action.menuId).toBe("string");
        expect(btn.action.menuId.length).toBeGreaterThan(0);
      } else if (btn.action.kind === "goHome") {
        // #204: a bare in-app navigation action — carries no payload.
        expect(btn.action.kind).toBe("goHome");
      } else {
        expect(btn.action.kind).toBe("univer");
        expect(typeof btn.action.op).toBe("string");
      }
    }
  });

  it("the File tab exposes a `goHome` (Back to Home) button — #204", () => {
    const file = RIBBON_TABS.find((t) => t.id === "file");
    const goHomeBtn = file?.groups
      .flatMap((g) => g.buttons)
      .find((b) => b.action.kind === "goHome");
    expect(goHomeBtn).toBeDefined();
    expect(goHomeBtn?.id).toBe("file-go-home");
    // The goHome action lives only on the File tab — no other tab fires it.
    const goHomeElsewhere = RIBBON_TABS.filter((t) => t.id !== "file")
      .flatMap((t) => t.groups.flatMap((g) => g.buttons))
      .filter((b) => b.action.kind === "goHome");
    expect(goHomeElsewhere).toEqual([]);
  });

  it("home tab covers clipboard / font / alignment groups", () => {
    const home = RIBBON_TABS.find((t) => t.id === "home");
    const groupIds = home?.groups.map((g) => g.id) ?? [];
    expect(groupIds).toEqual(
      expect.arrayContaining(["clipboard", "font", "alignment", "number"]),
    );
  });

  it("the File tab exposes a `close` (Exit) button — #202 reachability fix", () => {
    expect(ribbonMenuActionIds()).toContain("close");
  });
});

describe("ribbonDefs — dropdowns (#202 Phase 3)", () => {
  it("font-color and fill-color buttons own a color palette dropdown", () => {
    for (const id of ["font-color", "fill-color"]) {
      const btn = allButtons().find((b) => b.id === id);
      expect(btn?.dropdown?.kind).toBe("palette");
      if (btn?.dropdown?.kind === "palette") {
        // The palette swatches must fire the button's own univer op.
        expect(btn.action.kind).toBe("univer");
        if (btn.action.kind === "univer") {
          expect(btn.dropdown.op).toBe(btn.action.op);
        }
      }
    }
  });

  it("the number-format button owns a menu dropdown of format presets", () => {
    const btn = allButtons().find((b) => b.id === "number-format");
    expect(btn?.dropdown?.kind).toBe("menu");
    if (btn?.dropdown?.kind === "menu") {
      expect(btn.dropdown.items.length).toBeGreaterThan(0);
    }
  });

  it("every dropdown menu item has a unique id and a valid action", () => {
    for (const btn of allButtons()) {
      if (btn.dropdown?.kind !== "menu") continue;
      const ids = btn.dropdown.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of btn.dropdown.items) {
        expect(item.action.kind).toMatch(/^(editorCommand|univer|menuAction)$/);
      }
    }
  });

  it("dropdown menu items only reference dispatchable command ids", () => {
    // ribbonEditorCommandIds()/ribbonMenuActionIds() already fold in dropdown
    // menu items — the integrity tests above therefore cover them too. This
    // just asserts the dropdown ids actually reach those flatteners.
    const itemCmdIds = allButtons()
      .flatMap((b) => (b.dropdown?.kind === "menu" ? b.dropdown.items : []))
      .filter((i) => i.action.kind === "editorCommand")
      .map((i) => (i.action as { commandId: string }).commandId);
    for (const id of itemCmdIds) {
      expect(EDITOR_COMMAND_IDS.has(id)).toBe(true);
    }
  });
});
