import { useEffect, useMemo, useState } from "react";
import type { CellLinkParams } from "../store/cellLinker";
import { buildLinkFormula } from "../store/cellLinker";
import "./CellLinkerDialog.css";

interface SheetOption {
  id: string;
  name: string;
}

interface Props {
  /** A1 reference of the destination cell (typically the active cell). */
  initialTargetCell: string;
  /** All sheets in the workbook, used to populate the source dropdown. */
  availableSheets: SheetOption[];
  /** Sheet id where the formula will be written (active sheet). */
  activeSheetId: string;
  /** Optional starting value for the source cell input. Defaults to "A1". */
  defaultSourceCell?: string;
  onApply: (params: CellLinkParams) => void;
  onClose: () => void;
}

// Bare single-cell A1 reference. Absolute markers ($) are accepted but the
// dialog never inserts them itself; this matches the Sort dialog's tolerant
// parser style.
const CELL_RE = /^\$?[A-Za-z]+\$?[1-9]\d*$/;

function validateCell(ref: string, label: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return `${label} は必須です`;
  if (!CELL_RE.test(trimmed)) return `${label} は単一セルの A1 形式で指定してください (例: A1)`;
  return null;
}

export default function CellLinkerDialog({
  initialTargetCell,
  availableSheets,
  activeSheetId,
  defaultSourceCell,
  onApply,
  onClose,
}: Props) {
  // Pick the first non-active sheet as the default source — that's the
  // common case (linking *across* sheets). Fall back to the active sheet
  // when only one sheet exists.
  const defaultSourceSheet = useMemo(() => {
    const other = availableSheets.find((s) => s.id !== activeSheetId);
    return (other ?? availableSheets[0])?.name ?? "";
  }, [availableSheets, activeSheetId]);

  const [targetCell, setTargetCell] = useState(initialTargetCell);
  const [sourceSheetName, setSourceSheetName] = useState(defaultSourceSheet);
  const [sourceCell, setSourceCell] = useState(defaultSourceCell ?? "A1");
  const [liveLink, setLiveLink] = useState(true);
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

  // Preview is a live-link formula or the literal "(value will be copied)"
  // hint. Resolving the actual value for the copy-mode preview would require
  // the snapshot here; we keep the dialog snapshot-free and let the apply
  // path do the read via resolveSourceValue.
  const preview = useMemo(() => {
    if (!sourceSheetName || !sourceCell.trim()) return "";
    if (liveLink) return buildLinkFormula(sourceSheetName, sourceCell);
    return `(${sourceSheetName}!${sourceCell.trim()} の現在値をコピー)`;
  }, [sourceSheetName, sourceCell, liveLink]);

  const submit = () => {
    const tErr = validateCell(targetCell, "リンク先セル");
    if (tErr) {
      setError(tErr);
      return;
    }
    const sErr = validateCell(sourceCell, "参照元セル");
    if (sErr) {
      setError(sErr);
      return;
    }
    if (!sourceSheetName) {
      setError("参照元シートを選択してください");
      return;
    }
    setError(null);
    onApply({
      targetSheetId: activeSheetId,
      targetCellRef: targetCell.trim(),
      sourceSheetName,
      sourceCellRef: sourceCell.trim(),
      liveLink,
    });
    onClose();
  };

  return (
    <div className="cl-backdrop" onClick={onClose}>
      <div
        className="cl-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cl-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-header">
          <h2 id="cl-title" className="cl-title">セルリンクの挿入</h2>
          <button type="button" className="cl-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="cl-body">
          <fieldset className="cl-section">
            <legend>リンク先</legend>
            <label className="cl-field">
              <span className="cl-field-label">セル (アクティブセル)</span>
              <input
                type="text"
                className="cl-input"
                value={targetCell}
                onChange={(e) => setTargetCell(e.target.value)}
                placeholder="A1"
                autoFocus
              />
            </label>
          </fieldset>
          <fieldset className="cl-section">
            <legend>参照元</legend>
            <div className="cl-row">
              <label className="cl-field">
                <span className="cl-field-label">シート</span>
                <select
                  className="cl-select"
                  value={sourceSheetName}
                  onChange={(e) => setSourceSheetName(e.target.value)}
                  aria-label="参照元シート"
                >
                  {availableSheets.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cl-field">
                <span className="cl-field-label">セル</span>
                <input
                  type="text"
                  className="cl-input"
                  value={sourceCell}
                  onChange={(e) => setSourceCell(e.target.value)}
                  placeholder="A1"
                />
              </label>
            </div>
            <label className="cl-checkbox">
              <input
                type="checkbox"
                checked={liveLink}
                onChange={(e) => setLiveLink(e.target.checked)}
              />
              <span>ライブリンク（変更を反映する数式を書き込む）</span>
            </label>
          </fieldset>
          <div className="cl-preview">
            <span className="cl-preview-label">プレビュー</span>
            <div
              className={`cl-preview-box${preview ? "" : " cl-preview-box--empty"}`}
            >
              {preview || "—"}
            </div>
          </div>
          {error && <p className="cl-error">{error}</p>}
        </div>
        <footer className="cl-footer">
          <button type="button" className="cl-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="cl-btn cl-btn--primary"
            onClick={submit}
            disabled={availableSheets.length === 0}
          >
            適用
          </button>
        </footer>
      </div>
    </div>
  );
}
