import { useEffect, useMemo, useState } from "react";
import {
  addReply,
  deleteReply,
  editOriginal,
  editReply,
  normalizeToThread,
  setResolved,
  type ThreadedComment,
} from "../store/threadedComments";
import "./ThreadedCommentDialog.css";

interface Props {
  cellRef: string;
  /** null = creating a new thread, otherwise editing an existing one. */
  initialComment: ThreadedComment | null;
  /** Author auto-filled into the reply form and root post on first save. */
  defaultAuthor: string;
  onSave: (comment: ThreadedComment) => void;
  onDelete: () => void;
  onClose: () => void;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  // toLocaleString is locale-aware via the browser; avoids pulling in a
  // date library just for this one display. Wrap in try/catch since a
  // malformed ISO string would otherwise blow up the whole dialog render.
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Threaded comment dialog — successor to InsertCommentDialog, with reply
 * threads and resolve/reopen support. All edits are buffered in local
 * state until the user clicks "保存"; only then do we emit the final
 * ThreadedComment via onSave. This matches the buffering convention used
 * by InsertCommentDialog so users can cancel out of speculative edits.
 *
 * Backward compatibility: callers pass `initialComment` after running
 * `normalizeToThread` on the raw snapshot row, so this component doesn't
 * need to know about legacy `cell`/`text` field names.
 */
export default function ThreadedCommentDialog({
  cellRef,
  initialComment,
  defaultAuthor,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const isEditing = initialComment !== null;

  // Seed local state. When creating, start with an empty draft thread so
  // the reply form acts as the "first post" composer; the submit path
  // detects this and promotes the buffered draft into the root post.
  const [thread, setThread] = useState<ThreadedComment>(() =>
    initialComment ? normalizeToThread(initialComment) : {
      cellRef,
      body: "",
      replies: [],
      resolved: false,
    }
  );

  const [replyAuthor, setReplyAuthor] = useState<string>(defaultAuthor);
  const [replyBody, setReplyBody] = useState<string>("");

  // For a brand-new thread, we also need an author for the root post.
  // Defaults to defaultAuthor; the user can override before saving.
  const [rootAuthor, setRootAuthor] = useState<string>(
    initialComment?.author ?? defaultAuthor,
  );
  const [rootBody, setRootBody] = useState<string>(initialComment?.body ?? "");

  // Inline edit state: which post is being edited, plus the buffered text.
  // `editing` is null when nothing is being edited, "root" for the root
  // post, or a number for the reply index.
  const [editing, setEditing] = useState<"root" | number | null>(null);
  const [editBuffer, setEditBuffer] = useState<string>("");

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // For a new thread (no initialComment), the root post is composed via
  // the dedicated rootBody/rootAuthor inputs below. For an existing
  // thread, we render the root post as a regular post with edit/delete
  // affordances. This flag drives the conditional render.
  const showRootComposer = !isEditing;

  const handleStartEdit = (target: "root" | number, body: string) => {
    setEditing(target);
    setEditBuffer(body);
  };

  const handleCancelEdit = () => {
    setEditing(null);
    setEditBuffer("");
  };

  const handleCommitEdit = () => {
    if (editing === null) return;
    const trimmed = editBuffer.trim();
    if (!trimmed) {
      setError("本文を入力してください");
      return;
    }
    if (editing === "root") {
      setThread((t) => editOriginal(t, trimmed));
    } else {
      setThread((t) => editReply(t, editing, trimmed));
    }
    setEditing(null);
    setEditBuffer("");
    setError(null);
  };

  const handleDeleteReply = (idx: number) => {
    setThread((t) => deleteReply(t, idx));
  };

  const handleAddReply = () => {
    const trimmed = replyBody.trim();
    if (!trimmed) {
      setError("返信本文を入力してください");
      return;
    }
    const author = replyAuthor.trim();
    setThread((t) =>
      addReply(t, {
        body: trimmed,
        ...(author ? { author } : {}),
      }),
    );
    setReplyBody("");
    setError(null);
  };

  const handleToggleResolved = () => {
    const nextResolved = !thread.resolved;
    const actor = (replyAuthor || rootAuthor || defaultAuthor).trim();
    setThread((t) => setResolved(t, nextResolved, actor));
  };

  const handleSave = () => {
    let finalThread = thread;
    if (showRootComposer) {
      // New thread path: promote the rootBody/rootAuthor inputs into the
      // root post. Reject empty bodies — an empty root with replies is
      // nonsensical, and a totally empty thread shouldn't be saved at all.
      const trimmedBody = rootBody.trim();
      if (!trimmedBody) {
        setError("コメントを入力してください");
        return;
      }
      const trimmedAuthor = rootAuthor.trim();
      finalThread = {
        ...thread,
        cellRef,
        body: trimmedBody,
        createdAt: thread.createdAt ?? new Date().toISOString(),
        ...(trimmedAuthor ? { author: trimmedAuthor } : {}),
      };
    } else if (!finalThread.body.trim() && finalThread.replies.length === 0) {
      setError("コメントを入力してください");
      return;
    }
    onSave(finalThread);
    onClose();
  };

  const handleDelete = () => {
    onDelete();
    onClose();
  };

  const resolvedClass = thread.resolved ? "tcd-resolved" : "";

  // Memoize the rendered reply list so re-renders of the dialog (e.g. on
  // typing in the reply textarea) don't redo the date formatting work
  // for every existing reply.
  const renderedReplies = useMemo(
    () =>
      thread.replies.map((r, idx) => {
        const isThisEditing = editing === idx;
        return (
          <div key={idx} className="tcd-post" data-testid={`tcd-reply-${idx}`}>
            <div className="tcd-post-head">
              <span className="tcd-post-author">{r.author || "—"}</span>
              <span className="tcd-post-time">{formatTimestamp(r.createdAt)}</span>
            </div>
            {isThisEditing ? (
              <div className="tcd-inline-edit">
                <textarea
                  className="tcd-inline-textarea"
                  value={editBuffer}
                  onChange={(e) => setEditBuffer(e.target.value)}
                  autoFocus
                />
                <div className="tcd-inline-actions">
                  <button type="button" className="tcd-mini-btn" onClick={handleCancelEdit}>
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="tcd-mini-btn"
                    onClick={handleCommitEdit}
                  >
                    確定
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="tcd-post-body">{r.body}</div>
                <div className="tcd-post-actions">
                  <button
                    type="button"
                    className="tcd-mini-btn"
                    onClick={() => handleStartEdit(idx, r.body)}
                    disabled={thread.resolved}
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    className="tcd-mini-btn tcd-mini-btn--danger"
                    onClick={() => handleDeleteReply(idx)}
                    disabled={thread.resolved}
                  >
                    削除
                  </button>
                </div>
              </>
            )}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread.replies, thread.resolved, editing, editBuffer],
  );

  return (
    <div className="tcd-backdrop" onClick={onClose}>
      <div
        className={`tcd-modal ${resolvedClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tcd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tcd-header">
          <h2
            id="tcd-title"
            className={`tcd-title ${thread.resolved ? "tcd-title-resolved" : ""}`}
          >
            {thread.resolved && (
              <span className="tcd-check" aria-hidden="true">
                ✓
              </span>
            )}
            {isEditing
              ? thread.resolved
                ? "解決済みスレッド"
                : "スレッドコメント"
              : "コメントスレッドを作成"}
          </h2>
          <div className="tcd-header-actions">
            {isEditing && (
              <button
                type="button"
                className="tcd-btn tcd-btn--secondary"
                onClick={handleToggleResolved}
              >
                {thread.resolved ? "再開" : "解決"}
              </button>
            )}
            <button
              type="button"
              className="tcd-close"
              onClick={onClose}
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </header>
        <div className="tcd-body">
          <div className="tcd-cell-label">
            セル: <span className="tcd-cell-ref">{cellRef}</span>
          </div>

          {showRootComposer ? (
            // New-thread composer: author + body. Replies array stays
            // editable below in case the user pastes a quick follow-up,
            // but in practice this is a single-post creation flow.
            <>
              <label className="tcd-field">
                <span className="tcd-field-label">作成者</span>
                <input
                  type="text"
                  className="tcd-input"
                  value={rootAuthor}
                  onChange={(e) => setRootAuthor(e.target.value)}
                  placeholder="Author"
                />
              </label>
              <label className="tcd-field">
                <span className="tcd-field-label">コメント</span>
                <textarea
                  className="tcd-textarea"
                  value={rootBody}
                  onChange={(e) => setRootBody(e.target.value)}
                  placeholder="コメントを入力..."
                  autoFocus
                />
              </label>
            </>
          ) : (
            // Existing thread: render root post + replies + reply form.
            <div className="tcd-thread">
              <div className="tcd-post tcd-post-root" data-testid="tcd-root">
                <div className="tcd-post-head">
                  <span className="tcd-post-author">{thread.author || "—"}</span>
                  <span className="tcd-post-time">
                    {formatTimestamp(thread.createdAt)}
                  </span>
                </div>
                {editing === "root" ? (
                  <div className="tcd-inline-edit">
                    <textarea
                      className="tcd-inline-textarea"
                      value={editBuffer}
                      onChange={(e) => setEditBuffer(e.target.value)}
                      autoFocus
                    />
                    <div className="tcd-inline-actions">
                      <button
                        type="button"
                        className="tcd-mini-btn"
                        onClick={handleCancelEdit}
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        className="tcd-mini-btn"
                        onClick={handleCommitEdit}
                      >
                        確定
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="tcd-post-body">{thread.body}</div>
                    <div className="tcd-post-actions">
                      <button
                        type="button"
                        className="tcd-mini-btn"
                        onClick={() => handleStartEdit("root", thread.body)}
                        disabled={thread.resolved}
                      >
                        編集
                      </button>
                    </div>
                  </>
                )}
              </div>

              {thread.replies.length === 0 ? (
                <p className="tcd-empty">まだ返信はありません</p>
              ) : (
                renderedReplies
              )}

              <div className="tcd-reply-form">
                <label className="tcd-field">
                  <span className="tcd-field-label">返信者</span>
                  <input
                    type="text"
                    className="tcd-input"
                    value={replyAuthor}
                    onChange={(e) => setReplyAuthor(e.target.value)}
                    placeholder="Author"
                    disabled={thread.resolved}
                  />
                </label>
                <label className="tcd-field">
                  <span className="tcd-field-label">返信本文</span>
                  <textarea
                    className="tcd-textarea"
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder="返信を入力..."
                    disabled={thread.resolved}
                  />
                </label>
                <div className="tcd-inline-actions">
                  <button
                    type="button"
                    className="tcd-btn tcd-btn--secondary"
                    onClick={handleAddReply}
                    disabled={thread.resolved}
                  >
                    返信
                  </button>
                </div>
              </div>
            </div>
          )}
          {error && <p className="tcd-error">{error}</p>}
        </div>
        <footer className="tcd-footer">
          <div className="tcd-footer-left">
            {isEditing && (
              <button
                type="button"
                className="tcd-btn tcd-btn--danger"
                onClick={handleDelete}
              >
                スレッドを削除
              </button>
            )}
          </div>
          <div className="tcd-footer-right">
            <button type="button" className="tcd-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="tcd-btn tcd-btn--primary"
              onClick={handleSave}
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
