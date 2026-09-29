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
 * Univer 0.5.x doesn't know about these — they're written into the store
 * snapshot by Nicel (camera links, scenarios) and round-tripped through xlsx
 * by `xlsx_io.rs` (`NICEL_EXTENSION_ROOT_FIELDS`).
 *
 * Univer never edits these keys, and the store is their only owner. What
 * `FWorkbook.save()` returns for them is whatever the workbook was created
 * with (`Workbook` keeps the createUnit-time root keys and deep-clones them on
 * every save), so after an in-app change that copy is STALE, not missing
 * (#356, found on device: a script edit rolled back by the next cell edit).
 * Two measures keep the store's values authoritative:
 *   - `carryForwardRootExtensions`: the store's value always wins over the
 *     save() output in `syncSnapshot` (#184 C-1, #356).
 *   - `mirrorRootExtensionsInto`: every store change is copied into Univer's
 *     own snapshot, so any other code that builds a snapshot from save() sees
 *     current values, and keys the store removed are removed there too.
 */
export const NICEL_ROOT_EXTENSION_KEYS = [
  "_cameraLinks",
  "_scenarios",
  // #233/Phase 4d: image/textbox inserts mutate `_preservedParts` directly
  // via `applyMutatedSnapshot`. The next Univer mutation triggers a
  // `syncSnapshot` whose `FWorkbook.save()` drops every non-IWorkbookData key
  // — without this graft the inserted drawing parts vanish on the next cell
  // edit, breaking xlsx export round-trip.
  "_preservedParts",
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
  // written into the store snapshot by Nicel. Without the graft a script or
  // connection added during the session is dropped (or rolled back to the
  // opened state) by the next cell edit, which also changes the #355 trust
  // fingerprint unexpectedly. Grafting here does not make xlsx carry them.
  "_scripts",
  "_connections",
] as const;

/**
 * Carry Nicel's workbook-root extension keys from `prevJson` (the store
 * snapshot, their owner) into `nextJson` (fresh `FWorkbook.save()` output).
 *
 * For every key the store has, the store's value wins, whether save() left
 * the key out or returned an older copy of it. A key the store does not have
 * is left as save() returned it (with `mirrorRootExtensionsInto` in place,
 * save() no longer carries keys the store removed).
 *
 * Returns a JSON string. When nothing differs the original `nextJson` is
 * returned unchanged so referential checks stay cheap. Malformed input is
 * passed through untouched — never throws.
 */
export const carryForwardRootExtensions = (
  nextJson: string,
  prevJson: string | null,
): string => {
  if (!prevJson) return nextJson;
  let prev: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    prev = JSON.parse(prevJson) as Record<string, unknown>;
    next = JSON.parse(nextJson) as Record<string, unknown>;
  } catch {
    return nextJson;
  }
  if (!prev || typeof prev !== "object" || !next || typeof next !== "object") {
    return nextJson;
  }
  let changed = false;
  for (const key of NICEL_ROOT_EXTENSION_KEYS) {
    const prevVal = prev[key];
    if (prevVal === undefined) continue;
    if (!(key in next) || JSON.stringify(next[key]) !== JSON.stringify(prevVal)) {
      next[key] = prevVal;
      changed = true;
    }
  }
  return changed ? JSON.stringify(next) : nextJson;
};

/** True when `json` may hold any extension key (a \u escape could spell one). */
function mayContainRootExtension(json: string): boolean {
  if (json.includes("\\u")) return true;
  return NICEL_ROOT_EXTENSION_KEYS.some((key) => json.includes(`"${key}"`));
}

/**
 * Copy the store's extension keys into Univer's own workbook snapshot object
 * (`FWorkbook.getWorkbook().getSnapshot()`, the object `save()` deep-clones),
 * and delete the ones the store no longer has. Other keys are not touched.
 *
 * Returns true when `target` was changed. Does nothing (false) when either
 * side is missing, the store JSON cannot be parsed, or neither side has any
 * extension key. Never throws.
 */
export const mirrorRootExtensionsInto = (
  target: Record<string, unknown> | null | undefined,
  storeJson: string | null,
): boolean => {
  if (!target || typeof target !== "object" || !storeJson) return false;
  const targetHasAny = NICEL_ROOT_EXTENSION_KEYS.some((key) => key in target);
  if (!targetHasAny && !mayContainRootExtension(storeJson)) return false;
  let store: Record<string, unknown>;
  try {
    store = JSON.parse(storeJson) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!store || typeof store !== "object" || Array.isArray(store)) return false;
  let changed = false;
  for (const key of NICEL_ROOT_EXTENSION_KEYS) {
    const value = store[key];
    if (value !== undefined) {
      target[key] = value;
      changed = true;
    } else if (key in target) {
      delete target[key];
      changed = true;
    }
  }
  return changed;
};
