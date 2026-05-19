// Pure helpers for the workbook-wide Comments Manager dialog. Aggregates
// every comment across every sheet into a flat listing for table render,
// bulk actions (resolve / delete), and export to Markdown / CSV.
//
// Reads the same Coco-extended snapshot shape used by commentIndicators.ts
// and threadedComments.ts:
//
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         _comments?: Array<{
//           cell?: string;       cellRef?: string;
//           author?: string;
//           text?: string;       body?: string;
//           createdAt?: string;
//           replies?: Array<{ author?: string; body?: string; createdAt?: string }>;
//           resolved?: boolean;  resolvedAt?: string;  resolvedBy?: string;
//         }>
//       }
//     }
//   }
//
// All mutators return a fresh snapshot object (never mutate the input) so the
// caller can JSON.stringify the result back into the workbook store while
// retaining the previous snapshot for undo. Kept side-effect free so it can
// be unit-tested without Univer.

import { normalizeToThread, type RawCommentRow } from "./threadedComments";

/** Row shape consumed by the Comments Manager table. */
export interface CommentListing {
  sheetId: string;
  sheetName: string;
  cellRef: string;
  author?: string;
  body: string;
  createdAt?: string;
  replies: number;
  resolved: boolean;
}

interface CommentsSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        _comments?: RawCommentRow[];
      }
    | undefined
  >;
}

function parseSnapshot(input: unknown): CommentsSnapshot | null {
  if (input && typeof input === "object") return input as CommentsSnapshot;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as CommentsSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

function listAllCommentsInternal(
  parsed: CommentsSnapshot,
): CommentListing[] {
  const sheets = parsed.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const order =
    Array.isArray(parsed.sheetOrder) && parsed.sheetOrder.length > 0
      ? parsed.sheetOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(sheets);

  const out: CommentListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const arr = sheet._comments;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const thread = normalizeToThread(raw);
      // Skip rows that ended up with no cellRef AND no body — they're
      // unrecoverable garbage we shouldn't pretend exist.
      if (!thread.cellRef && !thread.body) continue;
      const row: CommentListing = {
        sheetId,
        sheetName,
        cellRef: thread.cellRef,
        body: thread.body,
        replies: thread.replies.length,
        resolved: thread.resolved,
      };
      if (thread.author) row.author = thread.author;
      if (thread.createdAt) row.createdAt = thread.createdAt;
      out.push(row);
    }
  }
  return out;
}

// ---------- Module-level string-identity cache ----------
//
// CommentsManagerDialog re-runs `listAllComments(workbookSnapshotJson)` on
// every parent re-render. Typing in any cell — even one with no comments —
// changes the snapshot JSON string and forces a fresh JSON.parse + scan,
// which costs seconds on 50k-comment workbooks.
//
// The string-identity cache trades a single reference comparison for the
// full parse + walk: identical string inputs (memoized parent state, same
// dialog session with no edits) return the cached result instantly. When
// the snapshot mutates, the new string is a fresh allocation → cache miss
// → recompute. Doesn't solve the worst-case (heavy typing while dialog is
// open) but eliminates the no-op cost.
//
// `clearListAllCommentsCache` is exported so tests / callers that mutate
// behind the scenes can force a recompute.

let lastListInput: string | null = null;
let lastListResult: CommentListing[] = [];

/** Test / caller hook: drop the identity cache so the next call recomputes. */
export function clearListAllCommentsCache(): void {
  lastListInput = null;
  lastListResult = [];
}

/**
 * Walks every sheet's `_comments` array and emits a flat list of
 * `CommentListing` rows in (sheetOrder, original-array-order) order.
 *
 * Accepts either a snapshot JSON string or a pre-parsed snapshot object so
 * callers that already have the parsed shape don't pay a re-parse cost.
 *
 * When called with a string input, the result is cached against that exact
 * string reference — subsequent calls with the same string return the
 * cached array instantly. The cache is invalidated automatically when a
 * different string is passed in; tests can force invalidation via
 * {@link clearListAllCommentsCache}.
 *
 * Tolerates malformed snapshots, missing sheets, missing `_comments`, and
 * bad rows (silently skipped). Returns [] for null/undefined input so the
 * dialog can render unconditionally.
 */
export function listAllComments(
  snapshot: string | CommentsSnapshot | null | undefined,
): CommentListing[] {
  if (snapshot === null || snapshot === undefined) return [];
  if (typeof snapshot === "string") {
    if (snapshot === lastListInput) return lastListResult;
    const parsed = parseSnapshot(snapshot);
    if (!parsed || typeof parsed !== "object") {
      lastListInput = snapshot;
      lastListResult = [];
      return lastListResult;
    }
    lastListInput = snapshot;
    lastListResult = listAllCommentsInternal(parsed);
    return lastListResult;
  }
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return [];
  return listAllCommentsInternal(parsed);
}

/**
 * Returns the parsed snapshot object as-is when given an object, or after
 * a JSON.parse when given a string. Returns null when the input can't be
 * parsed so callers can fail-safe (mutators below treat null as "nothing
 * to do" and return an empty snapshot stub).
 */
function ensureSnapshot(
  snapshot: string | CommentsSnapshot | null | undefined,
): CommentsSnapshot {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return { sheets: {} };
  // Clone shallow so we can re-assign `sheets` / `_comments` without
  // mutating the caller's reference. Deep clone of arrays / per-row
  // objects happens at the mutation site.
  return { ...parsed, sheets: { ...(parsed.sheets ?? {}) } };
}

function cloneRow(row: RawCommentRow): RawCommentRow {
  // Replies is the only nested array we mutate elsewhere; clone it too so
  // a downstream addReply on the returned snapshot doesn't bleed into the
  // input. Other fields are scalars.
  return {
    ...row,
    ...(Array.isArray(row.replies) ? { replies: row.replies.map((r) => ({ ...r })) } : {}),
  };
}

function findCommentIndex(
  rows: RawCommentRow[],
  cellRef: string,
): number {
  return rows.findIndex((r) => {
    if (!r || typeof r !== "object") return false;
    const ref = typeof r.cellRef === "string" ? r.cellRef : typeof r.cell === "string" ? r.cell : "";
    return ref === cellRef;
  });
}

/**
 * Toggles the resolved flag on the comment anchored at (sheetId, cellRef).
 * When `resolved` is true, stamps `resolvedAt` with the current time; when
 * false, clears `resolvedAt` / `resolvedBy` so the audit trail doesn't
 * carry stale data after a reopen (matches threadedComments.setResolved).
 *
 * Returns a fresh snapshot object. When the target row can't be found the
 * returned snapshot is structurally identical to the input (no-op) so the
 * caller can safely diff without special-casing the miss.
 */
export function setCommentResolved(
  snapshot: string | CommentsSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
  resolved: boolean,
): CommentsSnapshot {
  const out = ensureSnapshot(snapshot);
  const sheet = out.sheets?.[sheetId];
  if (!sheet || !Array.isArray(sheet._comments)) return out;
  const idx = findCommentIndex(sheet._comments, cellRef);
  if (idx < 0) return out;
  const nextRows = sheet._comments.slice();
  const updated = cloneRow(nextRows[idx]);
  if (resolved) {
    updated.resolved = true;
    updated.resolvedAt = new Date().toISOString();
  } else {
    updated.resolved = false;
    delete updated.resolvedAt;
    delete updated.resolvedBy;
  }
  nextRows[idx] = updated;
  out.sheets![sheetId] = { ...sheet, _comments: nextRows };
  return out;
}

/**
 * Removes the comment anchored at (sheetId, cellRef). Returns a fresh
 * snapshot; missing target → no-op snapshot (see {@link setCommentResolved}).
 */
export function deleteComment(
  snapshot: string | CommentsSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
): CommentsSnapshot {
  const out = ensureSnapshot(snapshot);
  const sheet = out.sheets?.[sheetId];
  if (!sheet || !Array.isArray(sheet._comments)) return out;
  const idx = findCommentIndex(sheet._comments, cellRef);
  if (idx < 0) return out;
  const nextRows = sheet._comments.slice();
  nextRows.splice(idx, 1);
  out.sheets![sheetId] = { ...sheet, _comments: nextRows };
  return out;
}

/**
 * Deletes every resolved comment across every sheet. Returns both the
 * mutated snapshot and the count of removed rows so the UI can show a
 * confirmation toast ("N 件の解決済みコメントを削除しました").
 */
export function bulkDeleteResolved(
  snapshot: string | CommentsSnapshot | null | undefined,
): { snapshotMutated: CommentsSnapshot; deletedCount: number } {
  const out = ensureSnapshot(snapshot);
  let deletedCount = 0;
  const sheetIds = Object.keys(out.sheets ?? {});
  for (const sheetId of sheetIds) {
    const sheet = out.sheets?.[sheetId];
    if (!sheet || !Array.isArray(sheet._comments)) continue;
    const kept = sheet._comments.filter((r) => {
      if (!r || typeof r !== "object") return true;
      return r.resolved !== true;
    });
    if (kept.length !== sheet._comments.length) {
      deletedCount += sheet._comments.length - kept.length;
      out.sheets![sheetId] = { ...sheet, _comments: kept };
    }
  }
  return { snapshotMutated: out, deletedCount };
}

// CSV-escape per RFC 4180: wrap in double quotes whenever the value contains
// a comma, quote, CR or LF; double up any embedded quotes. Always quoting
// would also be valid but keeps the file noisier and harder to eyeball.
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Escape pipe / newline so they don't break a Markdown table row.
function mdEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Renders the listing as a GitHub-flavoured Markdown table. Empty list →
 * a short "_(コメントなし)_" placeholder so the user knows the export ran
 * but had nothing to write.
 */
export function exportToMarkdown(comments: CommentListing[]): string {
  if (comments.length === 0) {
    return "# コメント一覧\n\n_(コメントなし)_\n";
  }
  const header = [
    "# コメント一覧",
    "",
    "| Sheet | Cell | Author | Body | CreatedAt | Replies | Resolved |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = comments.map((c) => {
    const cells = [
      mdEscape(c.sheetName),
      mdEscape(c.cellRef),
      mdEscape(c.author ?? ""),
      mdEscape(c.body),
      mdEscape(c.createdAt ?? ""),
      String(c.replies),
      c.resolved ? "✓" : "",
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return header.concat(rows).join("\n") + "\n";
}

/**
 * Renders the listing as RFC-4180 CSV with a header row. Always emits the
 * header even when the list is empty so the consuming tool sees a
 * well-formed file.
 */
export function exportToCsv(comments: CommentListing[]): string {
  const header = "Sheet,Cell,Author,Body,CreatedAt,Replies,Resolved";
  const rows = comments.map((c) =>
    [
      csvEscape(c.sheetName),
      csvEscape(c.cellRef),
      csvEscape(c.author ?? ""),
      csvEscape(c.body),
      csvEscape(c.createdAt ?? ""),
      String(c.replies),
      c.resolved ? "true" : "false",
    ].join(","),
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}
