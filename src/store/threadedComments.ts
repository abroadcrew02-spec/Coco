// Pure helpers for the threaded-comments (replies + resolve) feature.
//
// Snapshot shape (per sheet, additive on top of the existing single-comment
// `_comments` array — mirrors xlsx_io.rs + commentIndicators.ts):
//
//   sheets: {
//     <sheetId>: {
//       _comments?: Array<{
//         // Existing single-comment fields (kept for backward compat):
//         cell?: string;        // a.k.a. cellRef — A1 ref of the anchor cell
//         cellRef?: string;     // alias accepted on read
//         author?: string;
//         text?: string;        // a.k.a. body — root post content
//         body?: string;        // alias accepted on read
//         createdAt?: string;   // ISO-8601 timestamp; absent on legacy rows
//
//         // New optional fields — when absent, the entry behaves as a
//         // single-comment thread with zero replies and resolved=false:
//         replies?: Array<{ author?: string; body: string; createdAt: string }>;
//         resolved?: boolean;
//         resolvedAt?: string;
//         resolvedBy?: string;
//       }>
//     }
//   }
//
// All helpers are pure (no I/O, no Univer references) so they can be
// unit-tested in isolation and shared between the dialog component and any
// future snapshot-rewriting code in EditorScreen / useMenuActions.

/** Single reply inside a thread. createdAt is always set on insert. */
export interface ThreadedReply {
  author?: string;
  body: string;
  createdAt: string;
}

/**
 * The canonical in-memory shape of a threaded comment. `cellRef` is always
 * present; `replies` is always an array (possibly empty); `resolved` is
 * always a boolean. Use {@link normalizeToThread} to coerce raw snapshot
 * rows (which may use the legacy `cell` / `text` field names and omit
 * `replies`/`resolved`) into this shape before passing them around.
 */
export interface ThreadedComment {
  cellRef: string;
  author?: string;
  body: string;
  createdAt?: string;
  replies: ThreadedReply[];
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

/**
 * Subset of the workbook snapshot relevant to threaded comments. Callers
 * typically parse the full snapshot JSON then narrow it to this shape
 * before touching the comment arrays.
 */
export interface WorkbookCommentsSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    {
      name?: string;
      _comments?: RawCommentRow[];
    }
  >;
}

/**
 * Permissive shape used when reading from the snapshot. The legacy writer
 * used `cell` / `text`, but the new helpers prefer `cellRef` / `body` —
 * accept either to stay backward compatible without forcing an in-place
 * migration of every workbook on load.
 */
export interface RawCommentRow {
  cell?: string;
  cellRef?: string;
  author?: string;
  text?: string;
  body?: string;
  createdAt?: string;
  replies?: Array<{ author?: string; body?: string; createdAt?: string }>;
  resolved?: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Wraps any raw snapshot row into the canonical {@link ThreadedComment}
 * shape. Tolerates the legacy single-comment shape (no `replies`, no
 * `resolved`) by defaulting `replies` to `[]` and `resolved` to `false`.
 *
 * Accepts both `cell` / `cellRef` and `text` / `body` as input keys so we
 * don't have to migrate workbooks at load time. Bad rows (missing both
 * cellRef + cell, or missing both body + text) still return an object —
 * the caller decides whether to skip them; we never throw here so the
 * dialog can keep rendering even on unexpected snapshot data.
 */
export function normalizeToThread(c: RawCommentRow): ThreadedComment {
  const cellRef =
    typeof c.cellRef === "string" && c.cellRef
      ? c.cellRef
      : typeof c.cell === "string"
        ? c.cell
        : "";
  const body =
    typeof c.body === "string" && c.body.length > 0
      ? c.body
      : typeof c.text === "string"
        ? c.text
        : "";
  const replies: ThreadedReply[] = Array.isArray(c.replies)
    ? c.replies
        .filter((r): r is { author?: string; body?: string; createdAt?: string } =>
          Boolean(r && typeof r === "object"),
        )
        .map((r) => {
          const reply: ThreadedReply = {
            body: typeof r.body === "string" ? r.body : "",
            createdAt:
              typeof r.createdAt === "string" && r.createdAt
                ? r.createdAt
                : nowIso(),
          };
          if (typeof r.author === "string" && r.author) reply.author = r.author;
          return reply;
        })
    : [];

  const out: ThreadedComment = {
    cellRef,
    body,
    replies,
    resolved: c.resolved === true,
  };
  if (typeof c.author === "string" && c.author) out.author = c.author;
  if (typeof c.createdAt === "string" && c.createdAt) out.createdAt = c.createdAt;
  if (typeof c.resolvedAt === "string" && c.resolvedAt) out.resolvedAt = c.resolvedAt;
  if (typeof c.resolvedBy === "string" && c.resolvedBy) out.resolvedBy = c.resolvedBy;
  return out;
}

/**
 * Appends a reply to an existing thread. Always stamps `createdAt` with
 * the current time (callers can override by passing a pre-stamped reply,
 * but the canonical path is to let the helper own the timestamp so the
 * dialog doesn't have to import Date logic).
 *
 * Returns a new object (does NOT mutate input) so React state setters
 * observe a fresh reference and re-render.
 */
export function addReply(
  comment: ThreadedComment,
  reply: { author?: string; body: string; createdAt?: string },
): ThreadedComment {
  const stamped: ThreadedReply = {
    body: reply.body,
    createdAt: reply.createdAt && reply.createdAt.length > 0 ? reply.createdAt : nowIso(),
  };
  if (reply.author && reply.author.length > 0) stamped.author = reply.author;
  return {
    ...comment,
    replies: [...comment.replies, stamped],
  };
}

/**
 * Toggles the resolved flag and records who/when. When `resolved` is
 * `false` the resolvedAt/resolvedBy fields are cleared so reopened
 * threads don't carry stale audit data — matches Excel's behaviour.
 */
export function setResolved(
  comment: ThreadedComment,
  resolved: boolean,
  author?: string,
): ThreadedComment {
  if (!resolved) {
    const { resolvedAt: _ra, resolvedBy: _rb, ...rest } = comment;
    void _ra;
    void _rb;
    return { ...rest, replies: [...comment.replies], resolved: false };
  }
  const next: ThreadedComment = {
    ...comment,
    replies: [...comment.replies],
    resolved: true,
    resolvedAt: nowIso(),
  };
  if (author && author.length > 0) next.resolvedBy = author;
  return next;
}

/**
 * Removes the reply at `index`. Out-of-range indices return the input
 * unchanged so the dialog can call this defensively (e.g. when state
 * shifts between a click and the dispatch).
 */
export function deleteReply(comment: ThreadedComment, index: number): ThreadedComment {
  if (!Number.isInteger(index) || index < 0 || index >= comment.replies.length) {
    return comment;
  }
  return {
    ...comment,
    replies: comment.replies.filter((_, i) => i !== index),
  };
}

/**
 * Edits the body of the reply at `index`. Out-of-range indices return
 * the input unchanged (see {@link deleteReply}). The reply's `createdAt`
 * is preserved — we don't currently track an "editedAt" field; this can
 * be added later without breaking the snapshot shape since the field is
 * optional throughout.
 */
export function editReply(
  comment: ThreadedComment,
  index: number,
  body: string,
): ThreadedComment {
  if (!Number.isInteger(index) || index < 0 || index >= comment.replies.length) {
    return comment;
  }
  return {
    ...comment,
    replies: comment.replies.map((r, i) => (i === index ? { ...r, body } : r)),
  };
}

/**
 * Edits the root post body. Doesn't touch author / createdAt so the
 * thread's provenance survives edits — matches the "edited" affordance
 * in Excel and Google Sheets.
 */
export function editOriginal(comment: ThreadedComment, body: string): ThreadedComment {
  return { ...comment, body };
}
