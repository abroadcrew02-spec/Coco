// Pure helpers for the workbook-wide Hyperlink Manager dialog. Aggregates
// every hyperlink across every sheet into a flat listing for table render,
// per-row jump/edit/delete, bulk-delete-by-kind, and lightweight URL syntax
// validation.
//
// Reads the same Coco-extended snapshot shape used by hyperlinkRender.ts:
//
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         _hyperlinks?: Array<{
//           cell: string;        // A1 ref, e.g. "B12"
//           target: string;      // "https://...", "mailto:...", "#Sheet2!A1", "file:///..."
//           display?: string;    // visible label; falls back to target
//           tooltip?: string;    // hover hint
//         }>
//       }
//     }
//   }
//
// All mutators return a fresh snapshot object (never mutate the input) so the
// caller can JSON.stringify the result back into the workbook store while
// retaining the previous snapshot for undo. Kept side-effect free so it can
// be unit-tested without Univer.
//
// Classification rules mirror Excel's hyperlink semantics:
//   - `#…` (workbook-internal anchor)             → "internal"
//   - `mailto:…`                                   → "mailto"
//   - `file:…`, drive-letter / UNC                  → "file"
//   - `http(s)://…`, anything with a scheme        → "external"
//   - empty / malformed                            → "unknown"
//
// `validateUrl` is intentionally syntax-only (no network probe). It catches
// the everyday hand-typed mistakes — empty, missing scheme, stray whitespace,
// dangling protocol — without pretending to verify reachability.

/** Row shape consumed by the Hyperlink Manager table. */
export interface HyperlinkListing {
  sheetId: string;
  sheetName: string;
  cellRef: string;
  display: string;
  target: string;
  kind: "external" | "internal" | "mailto" | "file" | "unknown";
}

interface RawHyperlinkRow {
  cell?: string;
  target?: string;
  display?: string;
  tooltip?: string;
}

interface HyperlinkSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        _hyperlinks?: RawHyperlinkRow[];
      }
    | undefined
  >;
}

function parseSnapshot(input: unknown): HyperlinkSnapshot | null {
  if (input && typeof input === "object") return input as HyperlinkSnapshot;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as HyperlinkSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Classify a hyperlink target by leading scheme / shape. Returns "unknown"
 * for empty input rather than throwing so the dialog can still surface the
 * row (the user can then edit or delete it).
 *
 * Note: this is the *listing* classification — coarser than
 * hyperlinkRender.classifyHyperlink() which only distinguishes
 * internal vs external for the click handler. We split mailto/file out
 * here so the bulk-delete filter can target them precisely.
 */
export function classifyHyperlinkKind(
  target: string,
): HyperlinkListing["kind"] {
  if (typeof target !== "string") return "unknown";
  const trimmed = target.trim();
  if (!trimmed) return "unknown";
  if (trimmed.startsWith("#")) return "internal";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("mailto:")) return "mailto";
  if (lower.startsWith("file:")) return "file";
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return "external";
  }
  // Windows drive-letter paths ("C:\…") and UNC ("\\server\…") are common
  // in xlsx hyperlinks authored from desktop apps — treat them as file.
  if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith("\\\\")) {
    return "file";
  }
  // Anything else with a scheme (ftp://, sftp://, custom://) is external —
  // it will resolve via the OS shell on click.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "external";
  return "unknown";
}

/**
 * Walks every sheet's `_hyperlinks` array and emits a flat list of
 * `HyperlinkListing` rows in (sheetOrder, original-array-order) order.
 *
 * Accepts either a snapshot JSON string or a pre-parsed snapshot object so
 * callers that already have the parsed shape don't pay a re-parse cost.
 *
 * Tolerates malformed snapshots, missing sheets, missing `_hyperlinks`, and
 * bad rows (silently skipped — a row needs at least `cell` and `target`).
 * Returns [] for null/undefined input so the dialog can render unconditionally.
 */
export function listAllHyperlinks(
  snapshot: string | HyperlinkSnapshot | null | undefined,
): HyperlinkListing[] {
  if (snapshot === null || snapshot === undefined) return [];
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return [];
  const sheets = parsed.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const order =
    Array.isArray(parsed.sheetOrder) && parsed.sheetOrder.length > 0
      ? parsed.sheetOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(sheets);

  const out: HyperlinkListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const arr = sheet._hyperlinks;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const cell = typeof raw.cell === "string" ? raw.cell.trim() : "";
      const target = typeof raw.target === "string" ? raw.target : "";
      if (!cell || !target) continue;
      const display =
        typeof raw.display === "string" && raw.display.length > 0
          ? raw.display
          : target;
      out.push({
        sheetId,
        sheetName,
        cellRef: cell,
        display,
        target,
        kind: classifyHyperlinkKind(target),
      });
    }
  }
  return out;
}

/**
 * Returns the parsed snapshot object as-is when given an object, or after
 * a JSON.parse when given a string. Returns an empty snapshot stub when the
 * input can't be parsed so mutators fail-safe to a no-op.
 *
 * Shallow-clones `sheets` so we can re-assign `_hyperlinks` without mutating
 * the caller's reference; per-row clones happen at the mutation site.
 */
function ensureSnapshot(
  snapshot: string | HyperlinkSnapshot | null | undefined,
): HyperlinkSnapshot {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return { sheets: {} };
  return { ...parsed, sheets: { ...(parsed.sheets ?? {}) } };
}

function findHyperlinkIndex(rows: RawHyperlinkRow[], cellRef: string): number {
  const needle = cellRef.trim();
  return rows.findIndex((r) => {
    if (!r || typeof r !== "object") return false;
    return typeof r.cell === "string" && r.cell.trim() === needle;
  });
}

/**
 * Removes the hyperlink anchored at (sheetId, cellRef). Returns a fresh
 * snapshot; missing target → structurally-equivalent no-op snapshot so the
 * caller can diff without special-casing the miss.
 *
 * Note: this only strips the `_hyperlinks` row. The cell's visible value and
 * any inline blue+underline style left by hyperlinkRender.patchHyperlinkRenders
 * are *not* reset — matching Excel's "Remove Hyperlink" which similarly leaves
 * the cell's text in place. Restyling is the integrator's responsibility.
 */
export function deleteHyperlink(
  snapshot: string | HyperlinkSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
): HyperlinkSnapshot {
  const out = ensureSnapshot(snapshot);
  const sheet = out.sheets?.[sheetId];
  if (!sheet || !Array.isArray(sheet._hyperlinks)) return out;
  const idx = findHyperlinkIndex(sheet._hyperlinks, cellRef);
  if (idx < 0) return out;
  const next = sheet._hyperlinks.slice();
  next.splice(idx, 1);
  out.sheets![sheetId] = { ...sheet, _hyperlinks: next };
  return out;
}

/**
 * Removes every hyperlink whose classified kind matches `kind`, across every
 * sheet. Returns both the mutated snapshot and the count of removed rows so
 * the UI can render a confirmation toast ("N 件のリンクを削除しました").
 *
 * "unknown" is a valid bulk target — lets the user clean up garbage entries
 * surfaced by the listing.
 */
export function bulkDeleteHyperlinksByKind(
  snapshot: string | HyperlinkSnapshot | null | undefined,
  kind: HyperlinkListing["kind"],
): { snapshotMutated: HyperlinkSnapshot; deletedCount: number } {
  const out = ensureSnapshot(snapshot);
  let deletedCount = 0;
  const sheetIds = Object.keys(out.sheets ?? {});
  for (const sheetId of sheetIds) {
    const sheet = out.sheets?.[sheetId];
    if (!sheet || !Array.isArray(sheet._hyperlinks)) continue;
    const kept = sheet._hyperlinks.filter((r) => {
      if (!r || typeof r !== "object") return true;
      const target = typeof r.target === "string" ? r.target : "";
      return classifyHyperlinkKind(target) !== kind;
    });
    if (kept.length !== sheet._hyperlinks.length) {
      deletedCount += sheet._hyperlinks.length - kept.length;
      out.sheets![sheetId] = { ...sheet, _hyperlinks: kept };
    }
  }
  return { snapshotMutated: out, deletedCount };
}

/**
 * Lightweight syntax-only check on a hyperlink target. We deliberately do
 * *not* probe the network — the dialog needs a synchronous, deterministic
 * verdict it can render against hundreds of rows. The checks are aimed at
 * the everyday hand-typing mistakes:
 *
 *   - empty / whitespace target
 *   - http(s) without a host
 *   - mailto without a local-part@domain
 *   - file:/ without a path body
 *   - internal `#` ref that's empty after the hash
 *
 * Returns `{ ok: true }` for all well-formed kinds (including `file:`, drive
 * paths, UNC, and exotic schemes) — those may still fail on click, but we
 * can't tell from syntax alone and don't want to flag false positives.
 */
export function validateUrl(target: string): { ok: boolean; reason?: string } {
  if (typeof target !== "string") return { ok: false, reason: "empty" };
  const trimmed = target.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // Stray whitespace inside the URL body is almost always a copy-paste
  // accident — URLs don't carry literal spaces.
  if (/\s/.test(trimmed)) return { ok: false, reason: "whitespace" };

  const kind = classifyHyperlinkKind(trimmed);
  switch (kind) {
    case "internal": {
      // `#Sheet!A1` or `#Sheet`. Bare `#` is meaningless.
      if (trimmed.length <= 1) return { ok: false, reason: "empty-anchor" };
      return { ok: true };
    }
    case "mailto": {
      const body = trimmed.slice("mailto:".length);
      // Coarse RFC-5321-ish check — local@domain with a TLD-ish piece.
      // We don't try to be exhaustive; obvious typos like "mailto:foo" fail.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)) {
        return { ok: false, reason: "bad-email" };
      }
      return { ok: true };
    }
    case "external": {
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("http://") || lower.startsWith("https://")) {
        // URL constructor catches missing host, invalid characters, etc.
        try {
          const u = new URL(trimmed);
          if (!u.hostname) return { ok: false, reason: "missing-host" };
          return { ok: true };
        } catch {
          return { ok: false, reason: "bad-url" };
        }
      }
      // Other schemes (ftp://, custom://) — we can't validate them generically
      // beyond "has a scheme + body", which classifyHyperlinkKind already
      // implies by returning "external".
      return { ok: true };
    }
    case "file": {
      // file:/// must have something after the scheme; drive/UNC paths are
      // already structurally OK if classify identified them.
      if (/^file:/i.test(trimmed)) {
        const body = trimmed.replace(/^file:\/*/i, "");
        if (!body) return { ok: false, reason: "empty-file-path" };
      }
      return { ok: true };
    }
    case "unknown":
    default:
      return { ok: false, reason: "unrecognized" };
  }
}
