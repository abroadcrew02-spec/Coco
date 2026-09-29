type SnapshotFlush = () => void | Promise<void>;

let snapshotFlush: SnapshotFlush | null = null;

export const registerSnapshotFlush = (fn: SnapshotFlush | null) => {
  snapshotFlush = fn;
  return () => {
    if (snapshotFlush === fn) {
      snapshotFlush = null;
    }
  };
};

export const flushPendingSnapshot = async () => {
  const fn = snapshotFlush;
  if (fn) {
    await fn();
  }
};

/**
 * Workbook-root keys that Nicel layers on top of Univer's `IWorkbookData`.
 * Univer doesn't know about these — they're written into the store snapshot
 * by Nicel (camera links, scenarios, scripts, ...). Some of them are also
 * round-tripped through xlsx by `xlsx_io.rs` (`NICEL_EXTENSION_ROOT_FIELDS`);
 * being listed here does not make xlsx carry a key.
 *
 * Univer never edits these keys, and the store is their only owner. What
 * `FWorkbook.save()` returns for them is whatever the workbook was created
 * with (the unit keeps the createUnit-time root keys in its snapshot object,
 * and `IResourceLoaderService.saveUnit` returns a deep copy of that object),
 * so after an in-app change that copy is STALE, not missing (#356, found on
 * device: a script edit rolled back by the next cell edit).
 * Two measures keep the store's values authoritative:
 *   - `carryForwardRootExtensions`: the store's value always wins over the
 *     save() output in `syncSnapshot`, and a key the store does not have is
 *     removed from it (#184 C-1, #356).
 *   - `mirrorRootExtensionsInto` / `createRootExtensionMirror`: every store
 *     change is copied into Univer's own snapshot, so any other code that
 *     builds a snapshot from save() sees current values, and keys the store
 *     removed are removed there too.
 *
 * Ownership is decided by `isNicelRootKey` (every root key starting with
 * "_"), not by this list, so a new key cannot be forgotten. Univer's
 * `IWorkbookData` has no such key (checked for @univerjs/core 0.24.0: id,
 * rev, name, appVersion, locale, styles, sheetOrder, sheets, defaultStyle,
 * resources, custom). This list names the keys known today, for readers and
 * tests. Sheet-level keys (`sheets[id]._checkboxes`, ...) are not covered.
 *
 * Invariant: the store is the only owner of Nicel's root extension keys.
 * After createUnit (which receives them as part of the initial data), the
 * only place allowed to write them into Univer's workbook snapshot is
 * `mirrorRootExtensionsInto`, and it writes nothing but those keys. Its
 * premise (`getSnapshot()` returns the live object, `saveUnit` /
 * `FWorkbook.save()` a deep copy of it) is pinned by
 * `snapshotSync.univerContract.test.ts`, which runs the real Univer path.
 */
export const NICEL_ROOT_EXTENSION_KEYS = [
  "_cameraLinks",
  "_scenarios",
  // #233/Phase 4d: image/textbox inserts mutate `_preservedParts` directly
  // via `applyMutatedSnapshot`. If the store did not own this key, the next
  // `syncSnapshot` would replace it with Univer's copy and the inserted
  // drawing parts would vanish on the next cell edit, breaking xlsx export.
  "_preservedParts",
  // #146 / #188 — shapes (text box / rect / ellipse / line). The shape
  // handlers build on `workbook.save()`, so if the store did not own (and
  // mirror) this key, a second shape in the same session would replace the
  // first. The xlsx flush
  // (`flushTextBoxesToPreservedParts`) only feeds the export call and is not
  // written back to the store, so the store's list stays authoritative.
  "_textBoxes",
  // Linked data types (LinkedDataTypesPanel). Written on the store snapshot;
  // removed (key deleted) when the last source goes.
  "_cocoDataTypes",
  // #239 Step 5 — Nicel-native Data Model (tables + relationships + measures).
  // Distinct from `xl/model/item.data` (Excel's binary Vertipaq store, which
  // we byte-preserve via _preservedParts). The Nicel model is JSON and can be
  // edited from the DataModelDialog (planned). Both layers can coexist.
  "_cocoDataModel",
  // #238 Step 5 — Nicel-native Get & Transform queries (data source + step
  // pipeline). Saved so the user can refresh a query after a reload. Excel
  // stores connection metadata in xl/queryTables/ (byte-preserved); Nicel's
  // queries are a separate JSON-typed layer.
  "_cocoQueries",
  // #356 — workbook scripts (#136/#189) and data connections (#140/#190) are
  // written into the store snapshot by Nicel. If the store did not own these
  // keys, a script or connection added during the session would be dropped
  // (or rolled back to the opened state) by the next cell edit, which also
  // changes the #355 trust fingerprint unexpectedly. Owning them here does
  // not make xlsx carry them.
  "_scripts",
  "_connections",
] as const;

/**
 * True for a workbook-root key owned by Nicel: any key starting with "_"
 * (Univer's IWorkbookData has none). "__proto__" is excluded so a hostile
 * JSON key cannot touch an object's prototype.
 */
export function isNicelRootKey(key: string): boolean {
  return key.length > 1 && key.startsWith("_") && key !== "__proto__";
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Nicel-owned root keys present in any of `objs`. */
function ownedRootKeys(...objs: Record<string, unknown>[]): string[] {
  const out = new Set<string>();
  for (const o of objs) {
    for (const key of Object.keys(o)) {
      if (isNicelRootKey(key)) out.add(key);
    }
  }
  return [...out];
}

/**
 * Carry Nicel's workbook-root extension keys from `prevJson` (the store
 * snapshot, their only owner) into `nextJson` (fresh `FWorkbook.save()`
 * output): for every owned key, the store's value wins, whether save() left
 * the key out or returned an older copy, and a key the store does not have is
 * removed from the output.
 *
 * When the store snapshot is null, cannot be parsed or is not an object,
 * `nextJson` is passed through as is (there is no owner value to apply). The
 * same happens when `nextJson` cannot be parsed. Returns the original
 * `nextJson` string when nothing differs, so referential checks stay cheap.
 * Never throws.
 */
export const carryForwardRootExtensions = (
  nextJson: string,
  prevJson: string | null,
): string => {
  if (!prevJson) return nextJson;
  let prev: unknown;
  let next: unknown;
  try {
    prev = JSON.parse(prevJson);
  } catch {
    return nextJson;
  }
  if (!isPlainObject(prev)) return nextJson;
  try {
    next = JSON.parse(nextJson);
  } catch {
    return nextJson;
  }
  if (!isPlainObject(next)) return nextJson;
  let changed = false;
  for (const key of ownedRootKeys(prev, next)) {
    if (hasOwn(prev, key)) {
      const prevVal = prev[key];
      if (!hasOwn(next, key) || JSON.stringify(next[key]) !== JSON.stringify(prevVal)) {
        next[key] = prevVal;
        changed = true;
      }
    } else if (hasOwn(next, key)) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(next) : nextJson;
};

/**
 * True when `json` may hold an owned root key (a \u escape could spell one).
 * The test is loose: `"_` also matches cell- and sheet-level keys such as
 * `_fmt` or `_comments`, so for a real workbook it is almost always true and
 * the parse runs. It only saves the parse for empty or plain workbooks.
 */
function mayContainRootExtension(json: string): boolean {
  return json.includes('"_') || json.includes("\\u");
}

/**
 * Copy the store's owned root keys into Univer's own workbook snapshot
 * object (`FWorkbook.getWorkbook().getSnapshot()`, the object `save()`
 * deep-clones), and delete the owned keys the store no longer has. Keys not
 * owned by Nicel are never touched. This is the only function that writes
 * into Univer's snapshot (see the invariant above).
 *
 * Returns true when at least one owned key of `target` was written or
 * removed (a key is rewritten whenever the store has it, even with an equal
 * value). Returns false, touching nothing, when either side is missing, the
 * store JSON cannot be parsed or is not an object, or neither side has any
 * owned key.
 */
export const mirrorRootExtensionsInto = (
  target: Record<string, unknown> | null | undefined,
  storeJson: string | null,
): boolean => {
  if (!isPlainObject(target) || !storeJson) return false;
  if (ownedRootKeys(target).length === 0 && !mayContainRootExtension(storeJson)) return false;
  let store: unknown;
  try {
    store = JSON.parse(storeJson);
  } catch {
    return false;
  }
  if (!isPlainObject(store)) return false;
  let changed = false;
  for (const key of ownedRootKeys(store, target)) {
    if (hasOwn(store, key)) {
      target[key] = store[key];
      changed = true;
    } else if (hasOwn(target, key)) {
      delete target[key];
      changed = true;
    }
  }
  return changed;
};

/** The part of the workbook store the mirror listens to. */
export interface RootMirrorStoreState {
  currentSnapshotJson: string | null;
  editorRevision: number;
}

export interface RootExtensionMirror {
  /** Mirror `json` into the target now (e.g. when the editor mounts). */
  mirror: (json: string | null) => void;
  /**
   * Store listener. Mirrors every snapshot change of the mounted document,
   * except the one update currently being written through `writeOwn`, and
   * nothing while another document is mounting (editor revision changed).
   */
  onStoreChange: (state: RootMirrorStoreState, prevState: RootMirrorStoreState) => void;
  /**
   * Run `write(json)` for a snapshot whose extension keys already are the
   * store's (syncSnapshot's own output). The store notifies listeners
   * synchronously, so exactly that update is skipped; the marker is cleared
   * in `finally`, so a later update with the same string is mirrored again.
   */
  writeOwn: (json: string, write: (json: string) => void) => void;
}

/**
 * Keeps Univer's snapshot object (from `getTarget`) in step with the store's
 * extension keys. `onError` receives failures of `getTarget` or of writing
 * into the target; they never propagate to the store.
 */
export function createRootExtensionMirror(
  getTarget: () => Record<string, unknown> | null | undefined,
  onError: (e: unknown) => void = () => {},
): RootExtensionMirror {
  let ownWrite: string | null = null;
  const mirror = (json: string | null) => {
    try {
      mirrorRootExtensionsInto(getTarget(), json);
    } catch (e) {
      onError(e);
    }
  };
  return {
    mirror,
    onStoreChange: (state, prevState) => {
      if (state.currentSnapshotJson === prevState.currentSnapshotJson) return;
      if (state.editorRevision !== prevState.editorRevision) return;
      if (ownWrite !== null && state.currentSnapshotJson === ownWrite) return;
      mirror(state.currentSnapshotJson);
    },
    writeOwn: (json, write) => {
      ownWrite = json;
      try {
        write(json);
      } finally {
        ownWrite = null;
      }
    },
  };
}
