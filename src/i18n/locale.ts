// Minimal hand-rolled i18n bundle.
//
// Coco currently ships Japanese-only strings throughout the UI. To support
// FR-013 (multinational reuse) we extract the most visible toolbar labels
// and a handful of dialog titles here so they can be flipped between
// ja-JP and en-US via a localStorage setting. This is intentionally a
// foundation, not exhaustive coverage — most secondary dialog body copy
// remains hardcoded JA until a follow-up pass.
//
// No dependency on react-i18next: the bundle is small, locale changes
// require a reload, and `t()` reads localStorage on every call so callers
// don't need a context provider.

export type Locale = "ja-JP" | "en-US";

export const LOCALE_STORAGE_KEY = "coco.locale";

const jaJP = {
  // Toolbar — file/save group
  "toolbar.home": "← ホーム",
  "toolbar.save": "保存",
  "toolbar.saveAs": "別名保存",
  "toolbar.exportXlsx": "xlsx エクスポート",
  "toolbar.exportCsv": "CSV エクスポート",
  "toolbar.history": "履歴",
  // Toolbar — edit group
  "toolbar.dataValidation": "入力規則",
  "toolbar.conditionalFormat": "条件付き書式...",
  "toolbar.numberFormat": "🔢 表示形式",
  "toolbar.formatPainter": "🖌 書式コピー",
  // Toolbar — insert group
  "toolbar.namedRanges": "名前付き範囲",
  "toolbar.insertChart": "📊 グラフ",
  "toolbar.insertImage": "🖼 画像挿入",
  // Toolbar — misc
  "toolbar.sort": "↕ 並べ替え",
  "toolbar.settings": "⚙",
  "toolbar.help": "?",
  // Dialog titles
  "dialog.settings": "設定",
  "dialog.help": "Coco — ヘルプ",
  "dialog.namedRanges": "名前付き範囲",
  "dialog.numberFormat": "表示形式",
  "dialog.sort": "並べ替え",
  "dialog.snapshotHistory": "スナップショット履歴",
  "dialog.pageSetup": "ページ設定",
  "dialog.outlineGroups": "グループ化 / アウトライン",
  "dialog.insertTable": "テーブルの作成",
  "dialog.insertSparkline": "スパークラインの挿入",
  "dialog.cellStyles": "セルスタイル",
  "dialog.goalSeek": "ゴールシーク",
  "dialog.errorChecking": "エラーチェック",
  "dialog.threadComment": "スレッドコメント",
  "panel.tables": "テーブル一覧",
  "panel.sparklines": "スパークライン一覧",
  "panel.errors": "エラー一覧",
  "menu.showFormulas": "数式の表示",
  "menu.exportHtml": "HTML エクスポート...",
  "menu.exportPdf": "PDF エクスポート...",
  "dialog.subtotal": "小計",
  "dialog.removeDuplicates": "重複の削除",
  "dialog.textToColumns": "区切り位置",
  "dialog.advancedFilter": "フィルターの詳細設定",
  "dialog.flashFill": "フラッシュフィル",
  // Settings dialog — language section (new)
  "settings.language": "言語 / Language",
  "settings.languageHint": "表示言語を切り替えます。変更後は再読み込みで反映されます。",
  "settings.languageJa": "日本語 (ja-JP)",
  "settings.languageEn": "English (en-US)",
} as const;

type StringKey = keyof typeof jaJP;

const enUS: Record<StringKey, string> = {
  "toolbar.home": "← Home",
  "toolbar.save": "Save",
  "toolbar.saveAs": "Save As",
  "toolbar.exportXlsx": "Export xlsx",
  "toolbar.exportCsv": "Export CSV",
  "toolbar.history": "History",
  "toolbar.dataValidation": "Validation",
  "toolbar.conditionalFormat": "Conditional Format...",
  "toolbar.numberFormat": "🔢 Number Format",
  "toolbar.formatPainter": "🖌 Format Painter",
  "toolbar.namedRanges": "Named Ranges",
  "toolbar.insertChart": "📊 Chart",
  "toolbar.insertImage": "🖼 Image",
  "toolbar.sort": "↕ Sort",
  "toolbar.settings": "⚙",
  "toolbar.help": "?",
  "dialog.settings": "Settings",
  "dialog.help": "Coco — Help",
  "dialog.namedRanges": "Named Ranges",
  "dialog.numberFormat": "Number Format",
  "dialog.sort": "Sort",
  "dialog.snapshotHistory": "Snapshot History",
  "dialog.pageSetup": "Page Setup",
  "dialog.outlineGroups": "Group / Outline",
  "dialog.insertTable": "Create Table",
  "dialog.insertSparkline": "Insert Sparkline",
  "dialog.cellStyles": "Cell Styles",
  "dialog.goalSeek": "Goal Seek",
  "dialog.errorChecking": "Error Checking",
  "dialog.threadComment": "Comment Thread",
  "panel.tables": "Tables",
  "panel.sparklines": "Sparklines",
  "panel.errors": "Errors",
  "menu.showFormulas": "Show Formulas",
  "menu.exportHtml": "Export HTML...",
  "menu.exportPdf": "Export PDF...",
  "dialog.subtotal": "Subtotal",
  "dialog.removeDuplicates": "Remove Duplicates",
  "dialog.textToColumns": "Text to Columns",
  "dialog.advancedFilter": "Advanced Filter",
  "dialog.flashFill": "Flash Fill",
  "settings.language": "Language / 言語",
  "settings.languageHint":
    "Switch UI language. Reload the app to apply the change.",
  "settings.languageJa": "日本語 (ja-JP)",
  "settings.languageEn": "English (en-US)",
};

export const strings: Record<Locale, Record<StringKey, string>> = {
  "ja-JP": jaJP,
  "en-US": enUS,
};

export function getLocale(): Locale {
  try {
    const stored =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(LOCALE_STORAGE_KEY)
        : null;
    if (stored === "en-US" || stored === "ja-JP") return stored;
  } catch {
    // localStorage may throw in private/sandboxed contexts — fall through.
  }
  const nav =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language
      : "";
  return nav.toLowerCase().startsWith("ja") ? "ja-JP" : "en-US";
}

export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Best-effort — caller will see no error.
  }
}

export function t(key: StringKey): string {
  return strings[getLocale()][key];
}
