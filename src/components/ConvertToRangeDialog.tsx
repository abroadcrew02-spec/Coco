import { useEffect, useMemo, useState } from "react";
import "./ConvertToRangeDialog.css";

export interface ConvertToRangeTableSummary {
  name: string;
  sheetId: string;
  sheetName: string;
  rangeLabel: string;
  columnCount: number;
}

interface Props {
  /** Workbook-wide table listing (name + sheet + A1 range + column count). */
  tables: ConvertToRangeTableSummary[];
  onApply: (params: { sheetId: string; tableName: string; preserveStyles: boolean }) => void;
  onClose: () => void;
}

// Compose a stable per-row identity. Table names are workbook-unique today,
// but pinning sheetId too keeps us safe if that ever changes.
const rowKey = (t: ConvertToRangeTableSummary): string => `${t.sheetId}:${t.name}`;

export default function ConvertToRangeDialog({ tables, onApply, onClose }: Props) {
  // Default selection = first table in the workbook order. We re-derive on
  // every render so a tables-list mutation upstream doesn't strand the dialog
  // on a now-deleted table.
  const initialKey = useMemo(() => (tables[0] ? rowKey(tables[0]) : null), [tables]);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey);
  const [preserveStyles, setPreserveStyles] = useState<boolean>(true);

  useEffect(() => {
    // If the previously-selected table vanished (e.g. dialog stayed open
    // while another flow deleted a table), fall back to the first row.
    if (selectedKey && tables.some((t) => rowKey(t) === selectedKey)) return;
    setSelectedKey(initialKey);
  }, [tables, selectedKey, initialKey]);

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

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return tables.find((t) => rowKey(t) === selectedKey) ?? null;
  }, [tables, selectedKey]);

  const submit = () => {
    if (!selected) return;
    // Excel-style confirm — the destructive intent (table → range) is
    // surfaced inline so the keyboard-only path still requires a deliberate
    // click. We don't gate on `preserveStyles` because both options are valid.
    const ok = window.confirm(
      `テーブル ${selected.name} を通常の範囲に変換します。スタイルは保持されますか？`,
    );
    if (!ok) return;
    onApply({
      sheetId: selected.sheetId,
      tableName: selected.name,
      preserveStyles,
    });
    onClose();
  };

  return (
    <div className="ctr-backdrop" onClick={onClose}>
      <div
        className="ctr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ctr-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ctr-header">
          <h2 id="ctr-title" className="ctr-title">テーブル → 通常の範囲に変換</h2>
          <button type="button" className="ctr-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="ctr-body">
          {tables.length === 0 ? (
            <p className="ctr-empty">
              このブックには変換できるテーブルがありません。
            </p>
          ) : (
            <>
              <div className="ctr-field">
                <span className="ctr-field-label">テーブルを選択</span>
                <ul className="ctr-list" role="listbox" aria-label="テーブル一覧">
                  {tables.map((t) => {
                    const k = rowKey(t);
                    const isSelected = k === selectedKey;
                    return (
                      <li key={k} className="ctr-row">
                        <label
                          className={
                            isSelected ? "ctr-row-label ctr-row-label--active" : "ctr-row-label"
                          }
                        >
                          <input
                            type="radio"
                            name="ctr-table"
                            value={k}
                            checked={isSelected}
                            onChange={() => setSelectedKey(k)}
                          />
                          <div className="ctr-row-main">
                            <div className="ctr-row-name">{t.name}</div>
                            <div className="ctr-row-meta">
                              <span className="ctr-sheet">{t.sheetName}</span>
                              <span className="ctr-sep">/</span>
                              <span className="ctr-range">{t.rangeLabel}</span>
                              <span className="ctr-sep">/</span>
                              <span className="ctr-cols">{t.columnCount} 列</span>
                            </div>
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <label className="ctr-checkbox">
                <input
                  type="checkbox"
                  checked={preserveStyles}
                  onChange={(e) => setPreserveStyles(e.target.checked)}
                />
                <span>書式を保持する (ヘッダー、縞模様、枠線をセルに焼き込みます)</span>
              </label>
            </>
          )}
        </div>
        <footer className="ctr-footer">
          <p className="ctr-hint">
            テーブル定義 (ListObject) を削除し、セルの値はそのまま残します。構造化参照
            (例: <code>Table1[Sales]</code>) は使用できなくなります。
          </p>
          <div className="ctr-footer-actions">
            <button type="button" className="ctr-btn" onClick={onClose}>
              キャンセル
            </button>
            <button
              type="button"
              className="ctr-btn ctr-btn--primary"
              onClick={submit}
              disabled={!selected}
            >
              変換
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
