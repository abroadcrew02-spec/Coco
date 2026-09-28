// Wires Nicel-specific entries (Insert Comment / Hyperlink / Number Format)
// into Univer's cell context menu. Power users have keyboard shortcuts
// (Shift+F2 / Ctrl+K / Ctrl+1); right-click is the discovery path for the
// rest. We piggy-back on Univer's IMenuManagerService schema so our entries
// sit next to the built-in items rather than floating in a separate menu.
//
// Implementation shape (Univer 0.5.x):
//   1. Register 3 ICommands on ICommandService whose handlers invoke the
//      React-side openX dialog callbacks. We go through the command service
//      rather than wiring `onClick` directly because IMenuItem only carries
//      a command id — Univer's menu renderer dispatches via the registered
//      command, not via a user-supplied callback.
//   2. Merge a MenuSchema under ContextMenuPosition.MAIN_AREA →
//      ContextMenuGroup.OTHERS so the items appear at the bottom of the
//      cell context menu in their own group (Univer auto-separates groups).
//
// All three ids live under a `coco.command.` namespace to avoid clashing
// with Univer's own `sheet.command.*` namespace.

import {
  ICommandService,
  CommandType,
  type IAccessor,
  type ICommand,
  type IDisposable,
  type Univer,
} from "@univerjs/core";
import {
  ContextMenuGroup,
  ContextMenuPosition,
  IMenuManagerService,
  MenuItemType,
  type IMenuButtonItem,
} from "@univerjs/ui";

export const NICEL_INSERT_COMMENT_COMMAND_ID = "nicel.command.insert-comment";
export const NICEL_INSERT_HYPERLINK_COMMAND_ID = "nicel.command.insert-hyperlink";
export const NICEL_OPEN_NUMBER_FORMAT_COMMAND_ID = "nicel.command.open-number-format";
export const NICEL_CAMERA_CAPTURE_COMMAND_ID = "nicel.command.camera-capture";

export interface NicelContextMenuCallbacks {
  openCommentDialog: () => void;
  openHyperlinkDialog: () => void;
  openNumberFormatDialog: () => void;
  /** #184: snapshot the active selection into a live camera image. */
  captureCamera: () => void;
}

// Build an ICommand that, when invoked, calls a React-side opener. We close
// over the latest callback via the refs object so React state changes
// (re-binding of useCallback identities) don't strand the menu wired to
// stale closures.
function makeCommand(
  id: string,
  cbRef: { current: (() => void) | null },
): ICommand {
  return {
    id,
    type: CommandType.OPERATION,
    // The accessor param is unused — Univer requires the signature but our
    // handler just bounces out to the React layer.
    handler: (_accessor: IAccessor) => {
      const fn = cbRef.current;
      if (typeof fn === "function") {
        try {
          fn();
        } catch (err) {
          // Best-effort: log and swallow so a thrown dialog opener doesn't
          // bubble into Univer's command service and surface as a red error
          // toast. Real bugs in the openers will still show up via React.
          // eslint-disable-next-line no-console
          console.error(`nicel context-menu handler ${id} threw`, err);
          return false;
        }
      }
      return true;
    },
  };
}

// Three IMenuButtonItem factories. `title` is a plain JA string (not a
// locale key) because Nicel hasn't introduced i18n yet — the surrounding
// Univer UI runs en-US but our dialogs and labels are all Japanese, so we
// match that convention. label === undefined means Univer renders `title`.
function commentMenuItemFactory(): IMenuButtonItem {
  return {
    id: NICEL_INSERT_COMMENT_COMMAND_ID,
    type: MenuItemType.BUTTON,
    title: "コメントを挿入...",
    tooltip: "選択セルにコメントを挿入 (Shift+F2)",
  };
}

function hyperlinkMenuItemFactory(): IMenuButtonItem {
  return {
    id: NICEL_INSERT_HYPERLINK_COMMAND_ID,
    type: MenuItemType.BUTTON,
    title: "ハイパーリンク...",
    tooltip: "選択セルにハイパーリンクを挿入 (Ctrl+K)",
  };
}

function numberFormatMenuItemFactory(): IMenuButtonItem {
  return {
    id: NICEL_OPEN_NUMBER_FORMAT_COMMAND_ID,
    type: MenuItemType.BUTTON,
    title: "表示形式...",
    tooltip: "選択範囲の表示形式を変更 (Ctrl+1)",
  };
}

function cameraCaptureMenuItemFactory(): IMenuButtonItem {
  return {
    id: NICEL_CAMERA_CAPTURE_COMMAND_ID,
    type: MenuItemType.BUTTON,
    title: "カメラ撮影",
    tooltip: "選択範囲のスナップショット画像を作成 (ソース更新に追従)",
  };
}

// Build the menu schema to merge. We pin all three under
// ContextMenuPosition.MAIN_AREA → ContextMenuGroup.OTHERS so they appear
// at the bottom of the right-click menu, after Univer's stock groups
// (FORMAT / LAYOUT / DATA). Order numbers are large (100/101/102) so
// future Univer additions to OTHERS sort before us.
export function buildNicelContextMenuSchema() {
  return {
    [ContextMenuPosition.MAIN_AREA]: {
      [ContextMenuGroup.OTHERS]: {
        [NICEL_INSERT_COMMENT_COMMAND_ID]: {
          order: 100,
          menuItemFactory: commentMenuItemFactory,
        },
        [NICEL_INSERT_HYPERLINK_COMMAND_ID]: {
          order: 101,
          menuItemFactory: hyperlinkMenuItemFactory,
        },
        [NICEL_OPEN_NUMBER_FORMAT_COMMAND_ID]: {
          order: 102,
          menuItemFactory: numberFormatMenuItemFactory,
        },
        [NICEL_CAMERA_CAPTURE_COMMAND_ID]: {
          order: 103,
          menuItemFactory: cameraCaptureMenuItemFactory,
        },
      },
    },
  };
}

// Disposable bundle returned from registerNicelContextMenu so the caller can
// tear everything down on unmount in the right order.
export interface NicelContextMenuRegistration {
  dispose(): void;
}

// Register both the three commands and the menu schema. Returns a single
// dispose() that cleans up the command service registrations (Univer's
// menu manager doesn't expose an "unmerge" — that's fine in practice since
// the whole Univer instance disposes on EditorScreen unmount, taking the
// schema with it).
export function registerNicelContextMenu(
  univer: Univer,
  callbacks: NicelContextMenuCallbacks,
): NicelContextMenuRegistration {
  const injector = univer.__getInjector();
  const commandService = injector.get(ICommandService);
  const menuManagerService = injector.get(IMenuManagerService);

  // Hold the latest callbacks in refs so re-renders don't require us to
  // re-register commands. The caller (EditorScreen) passes the *current*
  // openX functions on each mount; if they need to swap mid-life,
  // updateCallbacks() lets us mutate the refs in place.
  const commentRef = { current: callbacks.openCommentDialog };
  const hyperlinkRef = { current: callbacks.openHyperlinkDialog };
  const numFmtRef = { current: callbacks.openNumberFormatDialog };
  const cameraRef = { current: callbacks.captureCamera };

  const disposables: IDisposable[] = [
    commandService.registerCommand(
      makeCommand(NICEL_INSERT_COMMENT_COMMAND_ID, commentRef),
    ),
    commandService.registerCommand(
      makeCommand(NICEL_INSERT_HYPERLINK_COMMAND_ID, hyperlinkRef),
    ),
    commandService.registerCommand(
      makeCommand(NICEL_OPEN_NUMBER_FORMAT_COMMAND_ID, numFmtRef),
    ),
    commandService.registerCommand(
      makeCommand(NICEL_CAMERA_CAPTURE_COMMAND_ID, cameraRef),
    ),
  ];

  menuManagerService.mergeMenu(buildNicelContextMenuSchema());

  return {
    dispose(): void {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Best-effort: Univer disposes the command service on its own
          // teardown, which can race with our cleanup on hot-reload.
        }
      }
    },
  };
}
