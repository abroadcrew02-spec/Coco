import { useCallback, useEffect, useState } from "react";
import "./InsertImageDialog.css";

export interface ImagePickResult {
  /** Lowercased extension without the leading dot, e.g. "png" | "jpg" | "gif". */
  ext: string;
  /** RFC 4648 base64 of the file bytes. Empty string is invalid. */
  base64: string;
  /** Display-only file name (basename). */
  name: string;
}

export interface ImageFormValue {
  /** Anchor cell in A1 notation (single cell, top-left). */
  cell: string;
  /** Lowercased ext used to derive the new media part name. */
  ext: string;
  /** Base64 of the file bytes — embedded straight into _preservedParts. */
  base64: string;
}

interface Props {
  initialCell: string;
  /**
   * Caller-supplied picker — typically opens a Tauri open-dialog and reads
   * the bytes via the read_file_bytes_base64 command. Returns null when the
   * user cancels. Injectable so tests can stub the file-system round-trip.
   */
  pickFile: () => Promise<ImagePickResult | null>;
  /**
   * Return null on success (dialog closes), or a localized error string to
   * keep the dialog open and surface in the inline error area. This lets the
   * caller reject impossible inserts (e.g. sheet already has a drawing —
   * issue #50) without falling back to a silent console.warn.
   */
  onApply: (value: ImageFormValue) => string | null;
  onClose: () => void;
}

// Same A1 single-cell regex used elsewhere — image anchors are single cells.
const A1_RE = /^\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateCell(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return "セル参照は必須です";
  if (!A1_RE.test(trimmed)) return "セル参照は A1 形式の単一セルで指定してください";
  return null;
}

export default function InsertImageDialog({
  initialCell,
  pickFile,
  onApply,
  onClose,
}: Props) {
  const [cell, setCell] = useState(initialCell);
  const [picked, setPicked] = useState<ImagePickResult | null>(null);
  const [busy, setBusy] = useState(false);
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

  const handlePick = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await pickFile();
      if (result) {
        if (!result.base64) {
          setError("ファイルを読み込めませんでした");
          return;
        }
        setPicked(result);
      }
    } catch (e) {
      setError(`ファイル選択に失敗しました: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [pickFile]);

  const submit = () => {
    const cellErr = validateCell(cell);
    if (cellErr) {
      setError(cellErr);
      return;
    }
    if (!picked) {
      setError("画像ファイルを選択してください");
      return;
    }
    setError(null);
    const applyErr = onApply({
      cell: cell.trim(),
      ext: picked.ext,
      base64: picked.base64,
    });
    if (applyErr) {
      // #50: keep the dialog open so the user sees why the insert couldn't
      // proceed (e.g. existing drawing on this sheet) instead of the modal
      // disappearing as though it succeeded.
      setError(applyErr);
      return;
    }
    onClose();
  };

  // Approximate size shown to the user (base64 inflates by ~4/3, so the raw
  // bytes are roughly 3/4 of the encoded string length minus padding).
  const approxBytes = picked
    ? Math.floor((picked.base64.replace(/=+$/, "").length * 3) / 4)
    : 0;
  const approxKb = (approxBytes / 1024).toFixed(1);

  return (
    <div className="iimg-backdrop" onClick={onClose}>
      <div
        className="iimg-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="iimg-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="iimg-header">
          <h2 id="iimg-title" className="iimg-title">画像の挿入</h2>
          <button type="button" className="iimg-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="iimg-body">
          <label className="iimg-field">
            <span className="iimg-field-label">アンカーセル</span>
            <input
              type="text"
              className="iimg-input"
              value={cell}
              onChange={(e) => setCell(e.target.value)}
              placeholder="A1"
            />
          </label>
          <div className="iimg-field">
            <span className="iimg-field-label">画像ファイル</span>
            <div className="iimg-pick-row">
              <button
                type="button"
                className="iimg-btn"
                onClick={handlePick}
                disabled={busy}
              >
                {busy ? "読込中..." : "ファイルを選択..."}
              </button>
              <span className="iimg-pick-label">
                {picked ? `${picked.name} (${approxKb} KB)` : "未選択"}
              </span>
            </div>
          </div>
          {error && <p className="iimg-error">{error}</p>}
        </div>
        <footer className="iimg-footer">
          <p className="iimg-hint">
            画像はワークブックに埋め込まれ、次回保存時に xl/media/ に書き出されます。
            アンカーセル位置に約 4 列 × 10 行のサイズで配置されます。
          </p>
          <div className="iimg-footer-actions">
            <button type="button" className="iimg-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="iimg-btn iimg-btn--primary"
              onClick={submit}
              disabled={!picked || busy}
            >
              挿入
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
