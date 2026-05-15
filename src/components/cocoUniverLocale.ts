import SheetsEnUS from "@univerjs/sheets/locale/en-US";
import SheetsUIEnUS from "@univerjs/sheets-ui/locale/en-US";
import UIEnUS from "@univerjs/ui/locale/en-US";
import DocsUIEnUS from "@univerjs/docs-ui/locale/en-US";
import SheetsFormulaUIEnUS from "@univerjs/sheets-formula-ui/locale/en-US";
import FindReplaceEnUS from "@univerjs/find-replace/locale/en-US";
import SheetsFindReplaceEnUS from "@univerjs/sheets-find-replace/locale/en-US";
import type { Locale } from "../i18n/locale";

type LanguageValue = string | string[] | LocaleRecord | LocaleRecord[] | boolean;
interface LocaleRecord {
  [key: string]: LanguageValue;
}

const enUSLocaleParts = [
  SheetsEnUS,
  SheetsUIEnUS,
  UIEnUS,
  DocsUIEnUS,
  SheetsFormulaUIEnUS,
  FindReplaceEnUS,
  SheetsFindReplaceEnUS,
] as LocaleRecord[];

const jaJPOverride = {
  rightClick: {
    copy: "コピー",
    copyAs: "コピー形式",
    paste: "貼り付け",
    pasteSpecial: "形式を選択して貼り付け",
    pasteValue: "値のみ貼り付け",
    pasteFormat: "書式のみ貼り付け",
    pasteColWidth: "列幅を貼り付け",
    pasteBesidesBorder: "罫線以外を貼り付け",
    cut: "切り取り",
    insert: "挿入",
    insertRow: "行を挿入",
    insertRowBefore: "上に行を挿入",
    insertColumn: "列を挿入",
    insertColumnBefore: "左に列を挿入",
    delete: "削除",
    deleteCell: "セルを削除",
    insertCell: "セルを挿入",
    deleteSelected: "選択範囲を削除",
    hide: "非表示",
    hideSelected: "選択範囲を非表示",
    showHide: "非表示を再表示",
    deleteSelectedRow: "選択した行を削除",
    deleteSelectedColumn: "選択した列を削除",
    hideSelectedRow: "選択した行を非表示",
    showHideRow: "選択した行を再表示",
    hideSelectedColumn: "選択した列を非表示",
    showHideColumn: "選択した列を再表示",
    clearSelection: "クリア",
    clearContent: "内容をクリア",
    clearFormat: "書式をクリア",
    clearAll: "すべてクリア",
    sortSelection: "並べ替え",
    filterSelection: "フィルター",
    rowHeight: "行の高さ",
    columnWidth: "列の幅",
    fitContent: "データに合わせる",
    freeze: "固定",
    freezeCol: "この列まで固定",
    freezeRow: "この行まで固定",
    cancelFreeze: "固定を解除",
    moveLeft: "左へ移動",
    moveUp: "上へ移動",
    moveRight: "右へ移動",
    moveDown: "下へ移動",
    chartGeneration: "グラフを作成",
    protectRange: "行と列を保護",
    editProtectRange: "保護範囲を設定",
    removeProtectRange: "保護範囲を削除",
    turnOnProtectRange: "保護範囲を追加",
    viewAllProtectArea: "すべての保護範囲を表示",
    deleteAllRowsAlert: "シート上のすべての行は削除できません",
    deleteAllColumnsAlert: "シート上のすべての列は削除できません",
    hideAllRowsAlert: "シート上のすべての行は非表示にできません",
    hideAllColumnsAlert: "シート上のすべての列は非表示にできません",
  },
} satisfies LocaleRecord;

function isRecord(value: unknown): value is LocaleRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function cloneValue(value: LanguageValue): LanguageValue {
  if (Array.isArray(value)) {
    return value.map((item) => (isRecord(item) ? deepMerge({}, item) : item)) as LanguageValue;
  }
  if (isRecord(value)) {
    return deepMerge({}, value);
  }
  return value;
}

function deepMerge(target: LocaleRecord, ...sources: LocaleRecord[]): LocaleRecord {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (isRecord(value) && isRecord(target[key])) {
        target[key] = deepMerge({ ...target[key] }, value);
      } else {
        target[key] = cloneValue(value);
      }
    }
  }
  return target;
}

export function buildCocoUniverLocale(locale: Locale): LocaleRecord {
  const base = deepMerge({}, ...enUSLocaleParts);
  return locale === "ja-JP" ? deepMerge(base, jaJPOverride) : base;
}
