import { useEffect, useMemo, useState } from "react";
import {
  listAllCfRules,
  summarizeRule,
  type WorkbookCfSnapshot,
} from "../store/cfRuleManager";
import "./CfRuleManagerDialog.css";

interface Props {
  /** Workbook snapshot JSON — same blob the rest of the editor passes around. */
  workbookSnapshotJson: string;
  onReorder: (sheetId: string, ruleIndex: number, direction: "up" | "down") => void;
  onDelete: (sheetId: string, ruleIndex: number) => void;
  /** Opens the existing ConditionalFormattingDialog scoped to the rule's sheet.
   *  MVP — per-rule editing reuses the all-rules dialog on the parent side. */
  onEdit: (sheetId: string) => void;
  /** Opens the existing CF dialog for the active sheet to create a new rule. */
  onNew: () => void;
  onClose: () => void;
}

const ALL_SHEETS = "__all__";

export default function CfRuleManagerDialog({
  workbookSnapshotJson,
  onReorder,
  onDelete,
  onEdit,
  onNew,
  onClose,
}: Props) {
  const [filterSheetId, setFilterSheetId] = useState<string>(ALL_SHEETS);

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

  const snapshot = useMemo<WorkbookCfSnapshot | null>(() => {
    if (!workbookSnapshotJson) return null;
    try {
      return JSON.parse(workbookSnapshotJson) as WorkbookCfSnapshot;
    } catch {
      return null;
    }
  }, [workbookSnapshotJson]);

  const allRules = useMemo(() => listAllCfRules(snapshot), [snapshot]);

  // Build the sheet filter dropdown from sheets that actually contain rules
  // — listing empty sheets in the dropdown would only add noise.
  const sheetOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of allRules) {
      if (!seen.has(entry.sheetId)) seen.set(entry.sheetId, entry.sheetName);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [allRules]);

  const visibleRules = useMemo(() => {
    if (filterSheetId === ALL_SHEETS) return allRules;
    return allRules.filter((e) => e.sheetId === filterSheetId);
  }, [allRules, filterSheetId]);

  return (
    <div className="cfm-backdrop" onClick={onClose}>
      <div
        className="cfm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cfm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cfm-header">
          <h2 id="cfm-title" className="cfm-title">条件付き書式 — ルールの管理</h2>
          <button type="button" className="cfm-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="cfm-body">
          <div className="cfm-toolbar">
            <label className="cfm-filter">
              <span className="cfm-filter-label">表示対象:</span>
              <select
                className="cfm-select"
                value={filterSheetId}
                onChange={(e) => setFilterSheetId(e.target.value)}
              >
                <option value={ALL_SHEETS}>すべてのシート</option>
                {sheetOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="cfm-btn cfm-btn--add" onClick={onNew}>
              + 新規ルール
            </button>
          </div>

          {visibleRules.length === 0 ? (
            <p className="cfm-empty">
              {allRules.length === 0
                ? "条件付き書式ルールはまだ登録されていません。"
                : "選択中のシートにはルールがありません。"}
            </p>
          ) : (
            <div className="cfm-table-wrap">
              <table className="cfm-table" aria-label="条件付き書式ルール一覧">
                <thead>
                  <tr>
                    <th scope="col">シート</th>
                    <th scope="col">範囲</th>
                    <th scope="col">ルール</th>
                    <th scope="col" className="cfm-col-num">優先度</th>
                    <th scope="col" className="cfm-col-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRules.map((entry) => {
                    const { sheetId, sheetName, rule, ruleIndex } = entry;
                    const priority =
                      typeof rule.priority === "number" ? rule.priority : ruleIndex + 1;
                    return (
                      <tr key={`${sheetId}-${ruleIndex}`}>
                        <td className="cfm-cell-sheet">{sheetName}</td>
                        <td className="cfm-cell-sqref">{rule.sqref}</td>
                        <td className="cfm-cell-summary">{summarizeRule(rule)}</td>
                        <td className="cfm-cell-priority">{priority}</td>
                        <td className="cfm-cell-actions">
                          <button
                            type="button"
                            className="cfm-btn cfm-btn--icon"
                            onClick={() => onReorder(sheetId, ruleIndex, "up")}
                            aria-label={`${sheetName} ${rule.sqref} の優先度を上げる`}
                            title="優先度を上げる"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="cfm-btn cfm-btn--icon"
                            onClick={() => onReorder(sheetId, ruleIndex, "down")}
                            aria-label={`${sheetName} ${rule.sqref} の優先度を下げる`}
                            title="優先度を下げる"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="cfm-btn"
                            onClick={() => onEdit(sheetId)}
                            aria-label={`${sheetName} のルールを編集`}
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            className="cfm-btn cfm-btn--danger"
                            onClick={() => onDelete(sheetId, ruleIndex)}
                            aria-label={`${sheetName} ${rule.sqref} のルールを削除`}
                          >
                            削除
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <footer className="cfm-footer">
          <p className="cfm-hint">
            ブック全体の条件付き書式ルールを一覧表示します。優先度は数値が小さいほど高く、上下ボタンで入れ替えできます。
          </p>
          <div className="cfm-footer-actions">
            <button type="button" className="cfm-btn" onClick={onClose}>
              閉じる
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
