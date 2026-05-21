// Unit test for the Coco context-menu helper. We don't try to drive the
// real Univer renderer (right-click → menu) — that's an e2e concern. We
// just assert:
//   - `buildCocoContextMenuSchema` slots our 3 commands under
//     ContextMenuPosition.MAIN_AREA / ContextMenuGroup.OTHERS with stable
//     order numbers and correct JA titles.
//   - `registerCocoContextMenu` resolves IMenuManagerService +
//     ICommandService from the injector, registers 3 commands, merges the
//     schema once, and disposes cleanly.
//   - The registered command handlers route to the latest callback ref
//     value (so React state updates aren't stranded against stale closures).
//
// Univer's ICommandService and IMenuManagerService are redi `IdentifierDecorator`s
// — calling them as keys on a Map works in tests because redi's identifier
// is just a unique symbol-like object that round-trips through `get`.

import { describe, it, expect, vi } from "vitest";
import { ICommandService, type ICommand, type IDisposable } from "@univerjs/core";
import {
  ContextMenuGroup,
  ContextMenuPosition,
  IMenuManagerService,
  MenuItemType,
} from "@univerjs/ui";
import {
  buildCocoContextMenuSchema,
  registerCocoContextMenu,
  COCO_INSERT_COMMENT_COMMAND_ID,
  COCO_INSERT_HYPERLINK_COMMAND_ID,
  COCO_OPEN_NUMBER_FORMAT_COMMAND_ID,
  COCO_CAMERA_CAPTURE_COMMAND_ID,
} from "./univerContextMenu";

interface MergedSchemaCall {
  source: ReturnType<typeof buildCocoContextMenuSchema>;
}

// Minimal fake Univer that returns a fake injector whose .get() routes to
// our stub command service + menu manager. Keeps the test fully unit-level —
// no Univer plugins loaded, no DOM, no Univer DI bootstrap.
function makeFakeUniver() {
  const commands: ICommand[] = [];
  const merged: MergedSchemaCall[] = [];
  const disposed: string[] = [];

  const commandService = {
    registerCommand(cmd: ICommand): IDisposable {
      commands.push(cmd);
      return {
        dispose: () => {
          disposed.push(cmd.id);
        },
      };
    },
  };

  const menuManagerService = {
    mergeMenu(source: ReturnType<typeof buildCocoContextMenuSchema>) {
      merged.push({ source });
    },
  };

  const injector = {
    get(identifier: unknown) {
      if (identifier === ICommandService) return commandService;
      if (identifier === IMenuManagerService) return menuManagerService;
      throw new Error(`unexpected injector.get(${String(identifier)})`);
    },
  };

  return {
    univer: {
      __getInjector: () => injector,
    } as unknown as Parameters<typeof registerCocoContextMenu>[0],
    commands,
    merged,
    disposed,
  };
}

describe("buildCocoContextMenuSchema", () => {
  const schema = buildCocoContextMenuSchema();
  const others =
    schema[ContextMenuPosition.MAIN_AREA][ContextMenuGroup.OTHERS];

  it("places four entries under MAIN_AREA → OTHERS", () => {
    const ids = Object.keys(others);
    expect(ids).toEqual([
      COCO_INSERT_COMMENT_COMMAND_ID,
      COCO_INSERT_HYPERLINK_COMMAND_ID,
      COCO_OPEN_NUMBER_FORMAT_COMMAND_ID,
      COCO_CAMERA_CAPTURE_COMMAND_ID,
    ]);
  });

  it("uses ascending order numbers so the items keep a stable order", () => {
    expect(others[COCO_INSERT_COMMENT_COMMAND_ID].order).toBe(100);
    expect(others[COCO_INSERT_HYPERLINK_COMMAND_ID].order).toBe(101);
    expect(others[COCO_OPEN_NUMBER_FORMAT_COMMAND_ID].order).toBe(102);
    expect(others[COCO_CAMERA_CAPTURE_COMMAND_ID].order).toBe(103);
  });

  it("produces BUTTON menu items with JA titles", () => {
    const comment = others[COCO_INSERT_COMMENT_COMMAND_ID].menuItemFactory();
    expect(comment.type).toBe(MenuItemType.BUTTON);
    expect(comment.title).toBe("コメントを挿入...");

    const hyper = others[COCO_INSERT_HYPERLINK_COMMAND_ID].menuItemFactory();
    expect(hyper.type).toBe(MenuItemType.BUTTON);
    expect(hyper.title).toBe("ハイパーリンク...");

    const numFmt =
      others[COCO_OPEN_NUMBER_FORMAT_COMMAND_ID].menuItemFactory();
    expect(numFmt.type).toBe(MenuItemType.BUTTON);
    expect(numFmt.title).toBe("表示形式...");

    const camera = others[COCO_CAMERA_CAPTURE_COMMAND_ID].menuItemFactory();
    expect(camera.type).toBe(MenuItemType.BUTTON);
    expect(camera.title).toBe("カメラ撮影");
  });

  it("aligns menu item ids with command ids so dispatch resolves", () => {
    // The menu renderer dispatches by IMenuItem.id (or commandId fallback)
    // — verify our items don't drift from the registered command ids.
    expect(others[COCO_INSERT_COMMENT_COMMAND_ID].menuItemFactory().id).toBe(
      COCO_INSERT_COMMENT_COMMAND_ID,
    );
    expect(others[COCO_INSERT_HYPERLINK_COMMAND_ID].menuItemFactory().id).toBe(
      COCO_INSERT_HYPERLINK_COMMAND_ID,
    );
    expect(
      others[COCO_OPEN_NUMBER_FORMAT_COMMAND_ID].menuItemFactory().id,
    ).toBe(COCO_OPEN_NUMBER_FORMAT_COMMAND_ID);
    expect(
      others[COCO_CAMERA_CAPTURE_COMMAND_ID].menuItemFactory().id,
    ).toBe(COCO_CAMERA_CAPTURE_COMMAND_ID);
  });
});

describe("registerCocoContextMenu", () => {
  it("registers four OPERATION commands and merges the schema once", () => {
    const { univer, commands, merged } = makeFakeUniver();
    const cb = {
      openCommentDialog: vi.fn(),
      openHyperlinkDialog: vi.fn(),
      openNumberFormatDialog: vi.fn(),
      captureCamera: vi.fn(),
    };

    registerCocoContextMenu(univer, cb);

    expect(commands.map((c) => c.id)).toEqual([
      COCO_INSERT_COMMENT_COMMAND_ID,
      COCO_INSERT_HYPERLINK_COMMAND_ID,
      COCO_OPEN_NUMBER_FORMAT_COMMAND_ID,
      COCO_CAMERA_CAPTURE_COMMAND_ID,
    ]);
    expect(merged).toHaveLength(1);
  });

  it("dispatches the correct callback when each command handler runs", () => {
    const { univer, commands } = makeFakeUniver();
    const cb = {
      openCommentDialog: vi.fn(),
      openHyperlinkDialog: vi.fn(),
      openNumberFormatDialog: vi.fn(),
      captureCamera: vi.fn(),
    };
    registerCocoContextMenu(univer, cb);

    // Univer's command handler signature is `(accessor, params?) → R`.
    // For our OPERATION commands we just bounce to the JS callback —
    // we pass a stub accessor (unused).
    const stubAccessor = {} as Parameters<ICommand["handler"]>[0];

    const byId = new Map(commands.map((c) => [c.id, c]));
    byId.get(COCO_INSERT_COMMENT_COMMAND_ID)!.handler(stubAccessor);
    byId.get(COCO_INSERT_HYPERLINK_COMMAND_ID)!.handler(stubAccessor);
    byId.get(COCO_OPEN_NUMBER_FORMAT_COMMAND_ID)!.handler(stubAccessor);
    byId.get(COCO_CAMERA_CAPTURE_COMMAND_ID)!.handler(stubAccessor);

    expect(cb.openCommentDialog).toHaveBeenCalledTimes(1);
    expect(cb.openHyperlinkDialog).toHaveBeenCalledTimes(1);
    expect(cb.openNumberFormatDialog).toHaveBeenCalledTimes(1);
    expect(cb.captureCamera).toHaveBeenCalledTimes(1);
  });

  it("swallows handler errors so a thrown opener doesn't poison Univer's command service", () => {
    const { univer, commands } = makeFakeUniver();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const cb = {
      openCommentDialog: () => {
        throw new Error("boom");
      },
      openHyperlinkDialog: vi.fn(),
      openNumberFormatDialog: vi.fn(),
      captureCamera: vi.fn(),
    };
    registerCocoContextMenu(univer, cb);

    const stubAccessor = {} as Parameters<ICommand["handler"]>[0];
    const target = commands.find((c) => c.id === COCO_INSERT_COMMENT_COMMAND_ID)!;
    const result = target.handler(stubAccessor);

    expect(result).toBe(false);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("disposes the four command registrations on teardown", () => {
    const { univer, disposed } = makeFakeUniver();
    const cb = {
      openCommentDialog: vi.fn(),
      openHyperlinkDialog: vi.fn(),
      openNumberFormatDialog: vi.fn(),
      captureCamera: vi.fn(),
    };
    const reg = registerCocoContextMenu(univer, cb);
    expect(disposed).toEqual([]);

    reg.dispose();

    expect(disposed).toEqual([
      COCO_INSERT_COMMENT_COMMAND_ID,
      COCO_INSERT_HYPERLINK_COMMAND_ID,
      COCO_OPEN_NUMBER_FORMAT_COMMAND_ID,
      COCO_CAMERA_CAPTURE_COMMAND_ID,
    ]);
  });
});
