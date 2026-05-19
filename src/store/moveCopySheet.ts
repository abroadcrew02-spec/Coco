// Pure helpers for the "Move or Copy Sheet" dialog. Operates on the workbook
// snapshot JSON string and returns a new JSON string — never mutates the
// input. Kept side-effect free so it can be unit-tested without Univer.
//
// Snapshot shape (Univer 0.5.x + Coco extension), the relevant slice:
//   {
//     sheetOrder: string[],                    // tab order, by sheetId
//     sheets: {
//       <sheetId>: {
//         id?: string,                         // typically equals the key
//         name?: string,                       // display name in the tab
//         _tabColor?: string,                  // round-tripped Coco extension
//         _protected?: {...},
//         _dataValidations?: [...],
//         cellData?: {...},
//         rowCount?: number,
//         columnCount?: number,
//         ...other Univer sheet fields
//       }
//     },
//     ...other workbook-level fields (styles, namedRanges, etc.)
//   }
//
// Move: reorder sheetOrder.
// Copy: deep-clone the source sheet object, assign a fresh sheetId + auto-
//       generated unique name (e.g. "Sheet1 (2)"), insert into sheetOrder.

export type SnapshotJsonString = string;

interface WorkbookSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetSnapshot | undefined>;
  [k: string]: unknown;
}

interface SheetSnapshot {
  id?: string;
  name?: string;
  [k: string]: unknown;
}

/**
 * Return sheets in tab order (sheetOrder[]) with their display name. Tolerates
 * a malformed snapshot by returning an empty array.
 */
export function listSheetsInOrder(
  snapshotJson: SnapshotJsonString,
): Array<{ sheetId: string; name: string }> {
  let parsed: WorkbookSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as WorkbookSnapshot;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const order = Array.isArray(parsed.sheetOrder) ? parsed.sheetOrder : [];
  const sheets = parsed.sheets ?? {};
  const out: Array<{ sheetId: string; name: string }> = [];
  for (const sheetId of order) {
    if (typeof sheetId !== "string") continue;
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const name = typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    out.push({ sheetId, name });
  }
  return out;
}

/**
 * Generate a fresh sheetId that does not collide with any existing id.
 * Prefers crypto.randomUUID when available; otherwise falls back to a
 * Math.random-based token with a collision retry guard.
 */
export function generateSheetId(existingIds: string[]): string {
  const taken = new Set(existingIds);
  const tryUuid = (): string | null => {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") {
      try {
        return c.randomUUID();
      } catch {
        return null;
      }
    }
    return null;
  };
  for (let i = 0; i < 50; i++) {
    const candidate =
      tryUuid() ??
      // 8-4-4-4-12 hex token; not cryptographic but unique enough for a copy.
      `${randHex(8)}-${randHex(4)}-${randHex(4)}-${randHex(4)}-${randHex(12)}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Last-resort: timestamp suffix.
  return `sheet-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function randHex(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

/**
 * Excel-style copy naming: "Sheet1" → "Sheet1 (2)" → "Sheet1 (3)". If the
 * base already ends with " (N)" we strip it before incrementing so a copy of
 * "Sheet1 (2)" becomes "Sheet1 (3)" rather than "Sheet1 (2) (2)".
 */
export function generateCopyName(existingNames: string[], baseName: string): string {
  const taken = new Set(existingNames);
  // Strip a trailing " (N)" group, if any.
  const m = /^(.*) \((\d+)\)$/.exec(baseName);
  const stem = m ? m[1] : baseName;
  const startAt = m ? parseInt(m[2], 10) + 1 : 2;
  for (let i = startAt; i < startAt + 1000; i++) {
    const candidate = `${stem} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  // Astronomically unlikely; fall back to a timestamp suffix to stay unique.
  return `${stem} (${Date.now()})`;
}

/**
 * Move the sheet identified by `sheetId` to position `targetIndex` in
 * sheetOrder. `targetIndex` is the desired final 0-based index in the array
 * (clamped to [0, length-1]). Returns the new snapshot JSON; if the snapshot
 * is malformed or the sheet isn't in sheetOrder, returns the original input
 * unchanged.
 */
export function moveSheet(
  snapshotJson: SnapshotJsonString,
  sheetId: string,
  targetIndex: number,
): SnapshotJsonString {
  let parsed: WorkbookSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as WorkbookSnapshot;
  } catch {
    return snapshotJson;
  }
  if (!parsed || typeof parsed !== "object") return snapshotJson;
  const order = Array.isArray(parsed.sheetOrder) ? [...parsed.sheetOrder] : [];
  const from = order.indexOf(sheetId);
  if (from < 0) return snapshotJson;
  order.splice(from, 1);
  const dest = Math.max(0, Math.min(order.length, targetIndex));
  order.splice(dest, 0, sheetId);
  parsed.sheetOrder = order;
  return JSON.stringify(parsed);
}

/**
 * Duplicate the sheet identified by `sheetId`, insert the clone at
 * `targetIndex` in sheetOrder, and return the new snapshot JSON alongside the
 * new sheet's id and display name. The clone is a deep copy (JSON round-trip)
 * with its `id` field rewritten to the new sheetId and `name` rewritten to
 * `newName` (auto-generated when not provided).
 *
 * If the snapshot is malformed or the source sheet is missing, returns the
 * original JSON with empty `newSheetId` / `newName` strings so callers can
 * detect and fail safe.
 */
export function copySheet(
  snapshotJson: SnapshotJsonString,
  sheetId: string,
  targetIndex: number,
  newName?: string,
): { json: SnapshotJsonString; newSheetId: string; newName: string } {
  const fail = { json: snapshotJson, newSheetId: "", newName: "" };
  let parsed: WorkbookSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as WorkbookSnapshot;
  } catch {
    return fail;
  }
  if (!parsed || typeof parsed !== "object") return fail;
  const sheets = parsed.sheets ?? {};
  const source = sheets[sheetId];
  if (!source || typeof source !== "object") return fail;
  const order = Array.isArray(parsed.sheetOrder) ? [...parsed.sheetOrder] : [];

  // Deep clone via JSON. The snapshot already round-trips through JSON for
  // persistence, so this is sufficient (no Date / Map / circular refs).
  const clone = JSON.parse(JSON.stringify(source)) as SheetSnapshot;

  const existingIds = Object.keys(sheets);
  const newSheetId = generateSheetId(existingIds);
  clone.id = newSheetId;

  const existingNames = existingIds
    .map((id) => sheets[id]?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const baseName =
    typeof source.name === "string" && source.name ? source.name : sheetId;
  const finalName = (() => {
    if (newName && !existingNames.includes(newName)) return newName;
    return generateCopyName(existingNames, baseName);
  })();
  clone.name = finalName;

  parsed.sheets = { ...sheets, [newSheetId]: clone };
  const dest = Math.max(0, Math.min(order.length, targetIndex));
  order.splice(dest, 0, newSheetId);
  parsed.sheetOrder = order;

  return { json: JSON.stringify(parsed), newSheetId, newName: finalName };
}
