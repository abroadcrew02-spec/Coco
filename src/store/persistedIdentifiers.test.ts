// Guards the identifiers that are persisted on users' machines or referenced
// by already-shipped builds. They kept the pre-v0.8.0 "coco" spelling on
// purpose when the product was renamed to Nicel: changing any of them would
// orphan saved data (localStorage keys, keyring entries, snapshot keys) or
// break the auto-update path (identifier, endpoint, public key). A future
// bulk rename must not touch them — this test turns such a change into a
// CI failure instead of a silent data loss.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KEY_SEED_STORAGE_KEY } from "./macroCrypto";
import { LOCAL_STORAGE_KEY as MACROS_STORAGE_KEY } from "./macroRecord";
import { LOCAL_STORAGE_KEY as MACRO_SHORTCUTS_STORAGE_KEY } from "./macroShortcuts";
import { MACRO_BLOCK_END, MACRO_BLOCK_FOR, MACRO_BLOCK_IF } from "./macroDsl";
import { LOCALE_STORAGE_KEY } from "../i18n/locale";
import { UPDATE_MANIFEST_URL } from "./updater";
import { routeOpenPath } from "./pathRouter";

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("persisted identifiers keep the pre-rename spelling", () => {
  it("localStorage keys and macro DSL markers", () => {
    expect(KEY_SEED_STORAGE_KEY).toBe("coco.macroKeySeed");
    expect(MACROS_STORAGE_KEY).toBe("coco.macros");
    expect(MACRO_SHORTCUTS_STORAGE_KEY).toBe("coco.macroShortcuts");
    expect(LOCALE_STORAGE_KEY).toBe("coco.locale");
    expect(MACRO_BLOCK_FOR).toBe("coco.macro.block.for");
    expect(MACRO_BLOCK_IF).toBe("coco.macro.block.if");
    expect(MACRO_BLOCK_END).toBe("coco.macro.block.end");
  });

  it(".coco workbook extension and its route kind", () => {
    expect(routeOpenPath("C:/tmp/book.coco")).toEqual({ kind: "coco", path: "C:/tmp/book.coco" });
  });

  it("updater endpoint stays on the original GitHub repository", () => {
    expect(UPDATE_MANIFEST_URL).toBe(
      "https://github.com/abroadcrew02-spec/Coco/releases/latest/download/latest.json",
    );
  });

  it("tauri.conf.json identifier, updater endpoint and public key", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.identifier).toBe("com.coco.app");
    expect(conf.plugins.updater.endpoints).toEqual([
      "https://github.com/abroadcrew02-spec/Coco/releases/latest/download/latest.json",
    ]);
    expect(conf.plugins.updater.pubkey).toBe(
      "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM5QjlBMTM4QkRCRTIxOApSV1FZNHR1TEU1cWJBOSt1MHpXVjRSdk5RV2ZxZjl2OTMrMGU4VHJwVzhobmV1d043SFlUVnErcQo=",
    );
    // MSI upgrade code the Coco MSIs were built with (UUIDv5 of "Coco.exe.app.x64").
    expect(conf.bundle.windows.wix.upgradeCode).toBe("2f0d29e5-0f27-5c52-b1c4-aee05c0224af");
  });

  it("Rust-side keyring service, SQLite source_type and xlsx extension part path", () => {
    expect(read("src-tauri/src/commands/url_fetch_credentials.rs")).toContain(
      'KEYRING_SERVICE: &str = "coco-urlfetch"',
    );
    expect(read("src-tauri/src/db/schema.rs")).toContain("IN ('new', 'coco', 'xlsx', 'csv')");
    expect(read("src-tauri/src/commands/xlsx_io.rs")).toContain('"xl/cocoExtensions/"');
    expect(read("src-tauri/src/commands/xlsx_io.rs")).toContain('"coco-new"');
  });
});
