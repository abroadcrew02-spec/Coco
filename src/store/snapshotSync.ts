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
 * Workbook-root keys that Coco layers on top of Univer's `IWorkbookData`.
 * Univer 0.5.x doesn't know about these — they're written into the store
 * snapshot by Coco (camera links, scenarios) and round-tripped through xlsx
 * by `xlsx_io.rs` (`COCO_EXTENSION_ROOT_FIELDS`).
 *
 * Because `FWorkbook.save()` reconstructs the snapshot purely from Univer's
 * internal models, it DROPS every key in this list. Any path that overwrites
 * the store with `workbook.save()` output (the MUTATION-driven `syncSnapshot`)
 * must re-graft these keys from the prior snapshot or the user's camera links
 * / scenarios silently vanish on the next cell edit (#184 C-1).
 */
export const COCO_ROOT_EXTENSION_KEYS = [
  "_cameraLinks",
  "_scenarios",
  // #233/Phase 4d: image/textbox inserts mutate `_preservedParts` directly
  // via `applyMutatedSnapshot`. The next Univer mutation triggers a
  // `syncSnapshot` whose `FWorkbook.save()` drops every non-IWorkbookData key
  // — without this graft the inserted drawing parts vanish on the next cell
  // edit, breaking xlsx export round-trip.
  "_preservedParts",
  // #239 Step 5 — Coco-native Data Model (tables + relationships + measures).
  // Distinct from `xl/model/item.data` (Excel's binary Vertipaq store, which
  // we byte-preserve via _preservedParts). The Coco model is JSON and can be
  // edited from the DataModelDialog (planned). Both layers can coexist.
  "_cocoDataModel",
] as const;

/**
 * Carry Coco's workbook-root extension keys forward from `prevJson` into
 * `nextJson`. `nextJson` is fresh `FWorkbook.save()` output that has lost
 * those keys; `prevJson` is the last store snapshot that still holds them.
 *
 * Returns a JSON string. When nothing needs grafting (no prior snapshot, no
 * extension keys present, or `nextJson` already carries the same values) the
 * original `nextJson` is returned unchanged so referential checks stay cheap.
 * Malformed input is passed through untouched — never throws.
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
  for (const key of COCO_ROOT_EXTENSION_KEYS) {
    const prevVal = prev[key];
    // Only graft when the prior snapshot actually had the key and Univer's
    // save() output doesn't (it never does — but stay defensive).
    if (prevVal !== undefined && !(key in next)) {
      next[key] = prevVal;
      changed = true;
    }
  }
  return changed ? JSON.stringify(next) : nextJson;
};
