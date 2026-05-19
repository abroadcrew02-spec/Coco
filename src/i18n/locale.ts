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
  "dialog.insertPivot": "ピボットテーブルの作成",
  "dialog.insertSlicer": "スライサーの挿入",
  "dialog.quickAnalysis": "クイック分析",
  "dialog.unhideSheet": "シートの再表示",
  "dialog.moveCopySheet": "シートの移動 / コピー",
  "dialog.insertFunction": "関数の挿入",
  "dialog.customLists": "ユーザー設定リスト",
  "dialog.calcOptions": "計算オプション",
  "dialog.scenarioManager": "シナリオの管理",
  "dialog.forecastSheet": "予測シート",
  "dialog.recommendedCharts": "おすすめグラフ",
  "dialog.cfManageRules": "条件付き書式 — ルールの管理",
  "dialog.snapshotDiff": "スナップショット比較",
  "dialog.spellCheck": "スペルチェック",
  "dialog.dataForm": "データフォーム",
  "dialog.findReplaceAll": "検索と置換 (全シート)",
  "dialog.commentsManager": "コメント一覧",
  "menu.exportWorkspaceBundle": "ワークスペースバンドル出力 (.zip)...",
  "menu.importWorkspaceBundle": "ワークスペースバンドル読込 (.zip)...",
  "dialog.smartDate": "日付に変換",
  "dialog.convertToRange": "テーブル → 通常の範囲に変換",
  "dialog.documentInspector": "ドキュメント検査",
  "dialog.bulkClean": "データクリーニング",
  "dialog.csvImportWizard": "CSV インポート ウィザード",
  "dialog.goTo": "ジャンプ / 名前ボックス",
  "dialog.sheetImport": "シートを別ファイルから取り込み",
  "dialog.numberFormatManage": "表示形式: 一覧管理",
  "dialog.rangeCompare": "範囲の比較",
  "panel.bookmarks": "ブックマーク一覧",
  "dialog.insertSymbol": "記号 / シンボルの挿入",
  "dialog.sheetNote": "シートのメモ",
  "dialog.imageManager": "画像一覧",
  "dialog.templatesGallery": "テンプレートから新規作成",
  "dialog.snapshotControls": "スナップショット設定",
  "menu.snapshotNow": "今すぐスナップショット",
  "dialog.sortByColor": "色で並べ替え",
  "dialog.filterByColor": "色でフィルター",
  "dialog.workbookStats": "ブック統計",
  "dialog.quickPrint": "印刷プレビュー",
  "menu.showAllComments": "コメントをすべて表示",
  "menu.checkUpdate": "更新を確認...",
  "dialog.updateAvailable": "更新が利用可能",
  "dialog.updateAvailable.update": "今すぐ更新",
  "dialog.updateAvailable.skip": "このバージョンをスキップ",
  "dialog.updateAvailable.later": "後で",
  "settings.section.update": "更新",
  "settings.autoUpdate.label": "起動時に更新を確認する",
  "settings.autoUpdate.current": "現在のバージョン",
  "settings.autoUpdate.lastChecked": "最終チェック",
  "settings.autoUpdate.checkNow": "今すぐ確認",
  "status.update.checking": "更新を確認中...",
  "status.update.downloading": "ダウンロード中",
  "status.update.ready": "更新の準備ができました。再起動で適用",
  "status.update.error": "更新の確認に失敗しました",
  "dialog.hyperlinkManager": "ハイパーリンク一覧",
  "dialog.borders": "罫線",
  "dialog.quickCf": "条件付き書式: クイックプリセット",
  "dialog.cellLinker": "セルリンクの挿入",
  "dialog.filterSearch": "値で検索フィルター",
  "panel.pivots": "ピボット一覧",
  "panel.slicers": "スライサー一覧",
  "panel.chartsCanvas": "グラフ表示",
  "panel.trace": "依存関係",
  "panel.watchWindow": "ウォッチウィンドウ",
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
  "dialog.insertPivot": "Create Pivot Table",
  "dialog.insertSlicer": "Insert Slicer",
  "dialog.quickAnalysis": "Quick Analysis",
  "dialog.unhideSheet": "Unhide Sheet",
  "dialog.moveCopySheet": "Move or Copy Sheet",
  "dialog.insertFunction": "Insert Function",
  "dialog.customLists": "Custom Lists",
  "dialog.calcOptions": "Calculation Options",
  "dialog.scenarioManager": "Scenario Manager",
  "dialog.forecastSheet": "Forecast Sheet",
  "dialog.recommendedCharts": "Recommended Charts",
  "dialog.cfManageRules": "Conditional Formatting — Manage Rules",
  "dialog.snapshotDiff": "Compare Snapshots",
  "dialog.spellCheck": "Spell Check",
  "dialog.dataForm": "Data Form",
  "dialog.findReplaceAll": "Find & Replace (All Sheets)",
  "dialog.commentsManager": "Comments Manager",
  "menu.exportWorkspaceBundle": "Export Workspace Bundle (.zip)...",
  "menu.importWorkspaceBundle": "Import Workspace Bundle (.zip)...",
  "dialog.smartDate": "Convert to Date",
  "dialog.convertToRange": "Convert Table to Range",
  "dialog.documentInspector": "Document Inspector",
  "dialog.bulkClean": "Data Cleaning",
  "dialog.csvImportWizard": "CSV Import Wizard",
  "dialog.goTo": "Go To / Name Box",
  "dialog.sheetImport": "Import Sheet from File",
  "dialog.numberFormatManage": "Number Format Manager",
  "dialog.rangeCompare": "Compare Ranges",
  "panel.bookmarks": "Bookmarks",
  "dialog.insertSymbol": "Insert Symbol",
  "dialog.sheetNote": "Sheet Notes",
  "dialog.imageManager": "Image Manager",
  "dialog.templatesGallery": "New from Template",
  "dialog.snapshotControls": "Snapshot Settings",
  "menu.snapshotNow": "Take Snapshot Now",
  "dialog.sortByColor": "Sort by Color",
  "dialog.filterByColor": "Filter by Color",
  "dialog.workbookStats": "Workbook Statistics",
  "dialog.quickPrint": "Print Preview",
  "menu.showAllComments": "Show All Comments",
  "menu.checkUpdate": "Check for Updates...",
  "dialog.updateAvailable": "Update Available",
  "dialog.updateAvailable.update": "Update Now",
  "dialog.updateAvailable.skip": "Skip This Version",
  "dialog.updateAvailable.later": "Later",
  "settings.section.update": "Updates",
  "settings.autoUpdate.label": "Check for updates on startup",
  "settings.autoUpdate.current": "Current version",
  "settings.autoUpdate.lastChecked": "Last checked",
  "settings.autoUpdate.checkNow": "Check Now",
  "status.update.checking": "Checking for updates...",
  "status.update.downloading": "Downloading",
  "status.update.ready": "Update ready. Restart to apply",
  "status.update.error": "Update check failed",
  "dialog.hyperlinkManager": "Hyperlink Manager",
  "dialog.borders": "Borders",
  "dialog.quickCf": "Conditional Formatting: Quick Presets",
  "dialog.cellLinker": "Insert Cell Link",
  "dialog.filterSearch": "Filter Search",
  "panel.pivots": "Pivot Tables",
  "panel.slicers": "Slicers",
  "panel.chartsCanvas": "Chart Canvas",
  "panel.trace": "Trace Precedents / Dependents",
  "panel.watchWindow": "Watch Window",
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
