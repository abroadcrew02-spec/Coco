import SheetsEnUS from "@univerjs/sheets/locale/en-US";
import SheetsUIEnUS from "@univerjs/sheets-ui/locale/en-US";
import UIEnUS from "@univerjs/ui/locale/en-US";
import DocsUIEnUS from "@univerjs/docs-ui/locale/en-US";
import SheetsFormulaUIEnUS from "@univerjs/sheets-formula-ui/locale/en-US";
import FindReplaceEnUS from "@univerjs/find-replace/locale/en-US";
import SheetsFindReplaceEnUS from "@univerjs/sheets-find-replace/locale/en-US";
import type { Locale } from "../i18n/locale";
import { FUNCTION_LIST_JA_ABSTRACT } from "./univerFunctionListJa";

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

// #179 (area D): turn the flat NAME → abstract map into the nested shape
// Univer's `formula.functionList` expects ({ NAME: { abstract } }), so
// `deepMerge` only replaces the `abstract` key and leaves `description` /
// `functionParameter` as Univer's English copy.
function buildFunctionListJa(): LocaleRecord {
  const out: LocaleRecord = {};
  for (const [name, abstract] of Object.entries(FUNCTION_LIST_JA_ABSTRACT)) {
    out[name] = { abstract };
  }
  return out;
}

// Univer 0.5.x は ja-JP locale を出荷していない (en-US / zh-CN / zh-TW / fr-FR /
// ru-RU / fa-IR / vi-VN のみ)。en-US を base にして、Coco の UI で目に入る
// 範囲を網羅的に日本語へオーバーライドする。
const jaJPOverride = {
  spreadsheetLabel: "スプレッドシート",
  spreadsheetRightLabel: "シートをもっと見る",
  "sheet-view": "シートを表示",
  "sheet-edit": "シートを編集",
  "common-edit": "編集の共通ショートカット",
  "toggle-shortcut-panel": "ショートカットパネルを切り替え",
  "global-shortcut": "グローバルショートカット",
  "find-replace-shortcuts": "検索と置換",

  ribbon: {
    start: "ホーム",
    insert: "挿入",
    formulas: "数式",
    data: "データ",
    view: "表示",
    others: "その他",
    more: "もっと見る",
  },

  toolbar: {
    undo: "元に戻す",
    redo: "やり直し",
    formatPainter: "書式のコピー/貼り付け",
    currencyFormat: "通貨表示形式",
    percentageFormat: "パーセント表示形式",
    numberDecrease: "小数点以下の桁数を減らす",
    numberIncrease: "小数点以下の桁数を増やす",
    moreFormats: "その他の表示形式",
    font: "フォント",
    fontSize: "フォントサイズ",
    bold: "太字",
    italic: "斜体",
    strikethrough: "取り消し線",
    subscript: "下付き文字",
    superscript: "上付き文字",
    underline: "下線",
    textColor: { main: "文字の色", right: "色を選択" },
    resetColor: "リセット",
    customColor: "カスタム",
    alternatingColors: "交互の色",
    confirmColor: "OK",
    cancelColor: "キャンセル",
    collapse: "折りたたむ",
    fillColor: { main: "塗りつぶしの色", right: "色を選択" },
    border: { main: "罫線", right: "罫線スタイル" },
    mergeCell: { main: "セルを結合", right: "結合方法を選択" },
    horizontalAlignMode: { main: "横位置", right: "配置" },
    verticalAlignMode: { main: "縦位置", right: "配置" },
    textWrapMode: { main: "折り返し", right: "折り返しモード" },
    textRotateMode: { main: "文字の回転", right: "文字の回転モード" },
    freezeTopRow: "先頭行を固定",
    sortAndFilter: "並べ替えとフィルター",
    findAndReplace: "検索と置換",
    sum: "合計",
    autoSum: "オートSUM",
    moreFunction: "その他の関数",
    conditionalFormatting: "条件付き書式",
    comment: "コメント",
    pivotTable: "ピボットテーブル",
    chart: "グラフ",
    screenshot: "スクリーンショット",
    splitColumn: "区切り位置",
    insertImage: "画像を挿入",
    insertLink: "リンクを挿入",
    dataValidation: "データの入力規則",
    protection: "シートの保護",
    clearText: "色をクリア",
    noColorSelectedText: "色が選択されていません",
    toolMore: "詳細",
    toolLess: "簡略",
    toolClose: "閉じる",
    toolMoreTip: "その他の機能",
    moreOptions: "その他のオプション",
    cellFormat: "セルの書式設定",
    print: "印刷",
    borderMethod: {
      top: "上罫線",
      bottom: "下罫線",
      left: "左罫線",
      right: "右罫線",
    },
    more: "もっと見る",
    hideGridlines: "グリッド線を非表示",
    showGridlines: "グリッド線を表示",
    toggleGridlines: "グリッド線の表示切替",
    // docs-ui 側で出てくるツールバー項目
    table: { main: "表", insert: "表を挿入", colCount: "列数", rowCount: "行数" },
    order: "番号付きリスト",
    unorder: "箇条書きリスト",
    checklist: "タスクリスト",
    documentFlavor: "モダンモード",
    alignLeft: "左揃え",
    alignCenter: "中央揃え",
    alignRight: "右揃え",
    alignJustify: "両端揃え",
    headerFooter: "ヘッダーとフッター",
  },

  defaultFmt: {
    Automatic: { text: "自動", value: "General", example: "" },
    Number: { text: "数値", value: "##0.00", example: "1000.12" },
    Percent: { text: "パーセント", value: "#0.00%", example: "12.21%" },
    PlainText: { text: "テキスト", value: "@", example: "" },
    Scientific: { text: "指数", value: "0.00E+00", example: "1.01E+5" },
    Accounting: { text: "会計", value: "¥(0.00)", example: "¥(1200.09)" },
    Currency: { text: "通貨", value: "¥0.00", example: "¥1200.09" },
    Date: { text: "日付", value: "yyyy-MM-dd", example: "2017-11-29" },
    Time: { text: "時刻", value: "hh:mm AM/PM", example: "3:00 PM" },
    Time24H: { text: "時刻 24時間", value: "hh:mm", example: "15:00" },
    DateTime: { text: "日付と時刻", value: "yyyy-MM-dd hh:mm AM/PM", example: "2017-11-29 3:00 PM" },
    DateTime24H: { text: "日付と時刻 24時間", value: "yyyy-MM-dd hh:mm", example: "2017-11-29 15:00" },
    CustomFormats: { text: "ユーザー定義", value: "fmtOtherSelf", example: "" },
  },

  format: {
    moreCurrency: "その他の通貨表示形式",
    moreDateTime: "その他の日付と時刻の表示形式",
    moreNumber: "その他の数値表示形式",
    titleCurrency: "通貨表示形式",
    decimalPlaces: "小数点以下の桁数",
    titleDateTime: "日付と時刻の表示形式",
    titleNumber: "数値表示形式",
  },

  print: {
    normalBtn: "標準",
    layoutBtn: "ページレイアウト",
    pageBtn: "改ページプレビュー",
    menuItemPrint: "印刷 (Ctrl+P)",
    menuItemAreas: "印刷範囲",
    menuItemRows: "印刷タイトル行",
    menuItemColumns: "印刷タイトル列",
  },

  align: {
    left: "左揃え",
    center: "中央揃え",
    right: "右揃え",
    top: "上揃え",
    middle: "中央揃え",
    bottom: "下揃え",
  },

  button: {
    confirm: "OK",
    cancel: "キャンセル",
    close: "閉じる",
    update: "更新",
    delete: "削除",
    insert: "挿入",
    prevPage: "前へ",
    nextPage: "次へ",
    total: "合計：",
  },

  punctuation: {
    tab: "タブ",
    semicolon: "セミコロン",
    comma: "カンマ",
    space: "スペース",
  },

  colorPicker: {
    collapse: "折りたたむ",
    customColor: "カスタム",
    change: "変更",
    confirmColor: "OK",
    cancelColor: "キャンセル",
  },

  borderLine: {
    borderTop: "上罫線",
    borderBottom: "下罫線",
    borderLeft: "左罫線",
    borderRight: "右罫線",
    borderNone: "罫線なし",
    borderAll: "格子",
    borderOutside: "外枠",
    borderInside: "内側",
    borderHorizontal: "横罫線",
    borderVertical: "縦罫線",
    borderColor: "罫線の色",
    borderSize: "罫線の太さ",
    borderType: "罫線の種類",
  },

  merge: {
    all: "すべて結合",
    vertical: "縦方向に結合",
    horizontal: "横方向に結合",
    cancel: "結合を解除",
    overlappingError: "重なり合う範囲は結合できません",
    partiallyError: "一部だけ結合されたセルにはこの操作を実行できません",
    confirm: {
      title: "結合を続行すると左上のセルの値のみが残り、他の値は破棄されます。続行しますか？",
      cancel: "結合をキャンセル",
      confirm: "結合を続行",
      waring: "警告",
      dismantleMergeCellWaring: "結合されたセルの一部が分割されます。続行しますか？",
    },
  },

  filter: {
    confirm: {
      error: "問題が発生しました",
      notAllowedToInsertRange: "フィルターを解除するまでセルをここに移動できません",
    },
  },

  textWrap: {
    overflow: "はみ出して表示",
    wrap: "折り返して表示",
    clip: "切り取って表示",
  },

  textRotate: {
    none: "なし",
    angleUp: "右上がり",
    angleDown: "右下がり",
    vertical: "縦書き",
    rotationUp: "上向きに回転",
    rotationDown: "下向きに回転",
  },

  sheetConfig: {
    delete: "削除",
    copy: "コピー",
    rename: "名前の変更",
    changeColor: "色を変更",
    hide: "非表示",
    unhide: "再表示",
    moveLeft: "左へ移動",
    moveRight: "右へ移動",
    resetColor: "色をリセット",
    cancelText: "キャンセル",
    chooseText: "色を確定",
    tipNameRepeat: "シート名は重複できません。変更してください",
    noMoreSheet: "ブックには表示中のシートが少なくとも1つ必要です。削除するには新しいシートを挿入するか、非表示のシートを再表示してください。",
    confirmDelete: "削除してもよろしいですか",
    redoDelete: "Ctrl+Z で元に戻せます",
    noHide: "少なくとも1つのシートタブを残す必要があります",
    chartEditNoOpt: "グラフ編集モードではこの操作はできません",
    sheetNameErrorTitle: "問題が発生しました",
    sheetNameSpecCharError: "名前は31文字以内で、' で始めたり終えたりすることはできません。次の文字も使用できません: [ ] : \\ ? * /",
    sheetNameCannotIsEmptyError: "シート名を空にすることはできません。",
    sheetNameAlreadyExistsError: "そのシート名は既に存在します。別の名前を入力してください。",
    deleteSheet: "シートを削除",
    deleteSheetContent: "このシートを削除します。削除後は復元できません。本当に削除しますか？",
    addProtectSheet: "シートを保護",
    removeProtectSheet: "シートの保護を解除",
    changeSheetPermission: "シートの権限を変更",
    viewAllProtectArea: "すべての保護範囲を表示",
  },

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
    toTopAdd: "上に追加",
    toBottomAdd: "下に追加",
    toLeftAdd: "左に追加",
    toRightAdd: "右に追加",
    to: "方向",
    left: "左",
    right: "右",
    top: "上",
    bottom: "下",
    add: "追加",
    row: "行",
    column: "列",
    width: "幅",
    height: "高さ",
    number: "数",
    confirm: "OK",
    orderAZ: "昇順 (A→Z)",
    orderZA: "降順 (Z→A)",
    firstLineTitle: "先頭行をタイトルに",
    untitled: "無題",
    zenEditor: "全画面エディター",
  },

  info: {
    tooltip: "ヒント",
    error: "エラー",
    notChangeMerge: "結合されたセルの一部だけを変更することはできません",
    detailUpdate: "新しく開きました",
    detailSave: "ローカルキャッシュを復元しました",
    loading: "読み込み中...",
    copy: "コピー",
    return: "終了",
    rename: "名前の変更",
    tips: "名前の変更",
    noName: "無題のスプレッドシート",
    wait: "更新を待機中",
    add: "追加",
    addLast: "末尾に行を追加",
    backTop: "先頭へ戻る",
    // eslint-disable-next-line no-template-curly-in-string
    pageInfo: "全 ${total} 件、${totalPage} ページ、現在 ${currentPage} ページ目",
    nextPage: "次へ",
    tipInputNumber: "数値を入力してください",
    tipInputNumberLimit: "増分は 1 〜 100 の範囲で指定してください",
    tipRowHeightLimit: "行の高さは 0 〜 545 の範囲で指定してください",
    tipColumnWidthLimit: "列の幅は 0 〜 2038 の範囲で指定してください",
    // eslint-disable-next-line no-template-curly-in-string
    pageInfoFull: "全 ${total} 件、${totalPage} ページ、すべて表示中",
    problem: "問題が発生しました",
    forceStringInfo: "数値が文字列として保存されています",
  },

  clipboard: {
    paste: {
      exceedMaxCells: "貼り付けるセル数が上限を超えています",
      overlappingMergedCells: "貼り付け範囲が結合セルと重なっています",
    },
    shortCutNotify: {
      title: "キーボードショートカットで貼り付けてください。",
      useShortCutInstead: "Excel のコンテンツを検出しました。キーボードショートカットで貼り付けてください。",
    },
    authentication: {
      title: "アクセス権がありません",
      content: "Univer がクリップボードにアクセスすることを許可してください。",
    },
  },

  statusbar: {
    sum: "合計",
    average: "平均",
    min: "最小",
    max: "最大",
    count: "数値の個数",
    countA: "データの個数",
    clickToCopy: "クリックしてコピー",
    copied: "コピーしました",
  },

  autoFill: {
    copy: "セルのコピー",
    series: "連続データ",
    formatOnly: "書式のみコピー",
    noFormat: "書式なしコピー",
  },

  rangeSelector: {
    placeholder: "範囲を選択または値を入力",
    tooltip: "範囲を選択",
    title: "データ範囲を選択",
    addAnotherRange: "範囲を追加",
    buttonTooltip: "データ範囲を選択",
    placeHolder: "範囲を選択するか入力します。",
    confirm: "OK",
    cancel: "キャンセル",
  },

  textEditor: {
    formulaError: "有効な数式を入力してください（例: =SUM(A1)）",
    rangeError: "有効な範囲を入力してください（例: A1:B10）",
  },

  shortcut: {
    undo: "元に戻す",
    redo: "やり直し",
    cut: "切り取り",
    copy: "コピー",
    paste: "貼り付け",
    "shortcut-panel": "ショートカットパネルを切り替え",
    sheet: {
      "zoom-in": "拡大",
      "zoom-out": "縮小",
      "reset-zoom": "ズームをリセット",
      "select-below-cell": "下のセルを選択",
      "select-up-cell": "上のセルを選択",
      "select-left-cell": "左のセルを選択",
      "select-right-cell": "右のセルを選択",
      "select-next-cell": "次のセルを選択",
      "select-previous-cell": "前のセルを選択",
      "select-up-value-cell": "上方向の値があるセルを選択",
      "select-below-value-cell": "下方向の値があるセルを選択",
      "select-left-value-cell": "左方向の値があるセルを選択",
      "select-right-value-cell": "右方向の値があるセルを選択",
      "expand-selection-down": "下方向に選択範囲を拡張",
      "expand-selection-up": "上方向に選択範囲を拡張",
      "expand-selection-left": "左方向に選択範囲を拡張",
      "expand-selection-right": "右方向に選択範囲を拡張",
      "expand-selection-to-left-gap": "左端まで選択範囲を拡張",
      "expand-selection-to-below-gap": "下端まで選択範囲を拡張",
      "expand-selection-to-right-gap": "右端まで選択範囲を拡張",
      "expand-selection-to-up-gap": "上端まで選択範囲を拡張",
      "select-all": "すべて選択",
      "toggle-editing": "編集モードを切り替え",
      "delete-and-start-editing": "クリアして編集を開始",
      "abort-editing": "編集を中止",
      "break-line": "改行",
      "set-bold": "太字を切り替え",
      "start-editing": "編集を開始（選択をエディターへ）",
      "set-italic": "斜体を切り替え",
      "set-underline": "下線を切り替え",
      "set-strike-through": "取り消し線を切り替え",
    },
  },

  "shortcut-panel": { title: "ショートカット" },

  definedName: {
    managerTitle: "名前の管理",
    managerDescription: "セルや数式を選択し、テキストボックスに名前を入力して定義名を作成します。",
    addButton: "名前を追加",
    featureTitle: "定義済みの名前",
    ratioRange: "範囲",
    ratioFormula: "数式",
    confirm: "OK",
    cancel: "キャンセル",
    scopeWorkbook: "ブック",
    inputNamePlaceholder: "名前を入力してください（スペースは使用できません）",
    inputCommentPlaceholder: "コメントを入力してください",
    inputRangePlaceholder: "範囲を入力してください（スペースは使用できません）",
    inputFormulaPlaceholder: "数式を入力してください（スペースは使用できません）",
    nameEmpty: "名前を空にすることはできません",
    nameDuplicate: "その名前は既に存在します",
    formulaOrRefStringEmpty: "数式または参照を空にすることはできません",
    formulaOrRefStringInvalid: "数式または参照が無効です",
    defaultName: "定義名",
    updateButton: "更新",
    deleteButton: "削除",
    deleteConfirmText: "この定義名を削除してもよろしいですか？",
    nameConflict: "関数名と競合しています",
    nameInvalid: "名前が無効です",
    nameSheetConflict: "シート名と競合しています",
  },

  uploadLoading: {
    loading: "読み込み中、残り",
    error: "エラー",
  },

  permission: {
    toolbarMenu: "保護",
    panel: {
      title: "行と列を保護",
      name: "名前",
      protectedRange: "保護範囲",
      permissionDirection: "権限の説明",
      permissionDirectionPlaceholder: "権限の説明を入力",
      editPermission: "編集権限",
      onlyICanEdit: "自分のみ編集可",
      designedUserCanEdit: "指定したユーザーが編集可",
      viewPermission: "閲覧権限",
      othersCanView: "他のユーザーも閲覧可",
      noOneElseCanView: "他のユーザーは閲覧不可",
      designedPerson: "指定ユーザー",
      addPerson: "ユーザーを追加",
      canEdit: "編集可",
      canView: "閲覧可",
      delete: "削除",
      currentSheet: "現在のシート",
      allSheet: "すべてのシート",
      edit: "編集",
      Print: "印刷",
      Comment: "コメント",
      Copy: "コピー",
      SetCellStyle: "セルのスタイル設定",
      SetCellValue: "セルの値を設定",
      SetHyperLink: "ハイパーリンクを設定",
      Sort: "並べ替え",
      Filter: "フィルター",
      PivotTable: "ピボットテーブル",
      FloatImage: "フローティング画像",
      RowHeightColWidth: "行の高さと列の幅",
      RowHeightColWidthReadonly: "行の高さと列の幅（読み取り専用）",
      FilterReadonly: "読み取り専用フィルター",
      nameError: "名前を空にすることはできません",
      created: "作成済み",
      iCanEdit: "編集できます",
      iCanNotEdit: "編集できません",
      iCanView: "閲覧できます",
      iCanNotView: "閲覧できません",
      emptyRangeError: "範囲を空にすることはできません",
      rangeOverlapError: "範囲が重複しています",
      rangeOverlapOverPermissionError: "同じ権限の範囲と重複しています",
      InsertHyperlink: "ハイパーリンクを挿入",
      SetRowStyle: "行のスタイル設定",
      SetColumnStyle: "列のスタイル設定",
      InsertColumn: "列を挿入",
      InsertRow: "行を挿入",
      DeleteRow: "行を削除",
      DeleteColumn: "列を削除",
      EditExtraObject: "追加オブジェクトの編集",
    },
    dialog: {
      allowUserToEdit: "ユーザーに編集を許可",
      allowedPermissionType: "許可する権限の種類",
      setCellValue: "セルの値を設定",
      setCellStyle: "セルのスタイル設定",
      copy: "コピー",
      alert: "通知",
      search: "検索",
      alertContent: "この範囲は保護されており、現在編集権限がありません。編集が必要な場合は作成者にお問い合わせください。",
      userEmpty: "指定ユーザーがいません。共有リンクから招待してください。",
      listEmpty: "保護範囲やシートはまだ設定されていません。",
      commonErr: "この範囲は保護されています。操作する権限がありません。作成者にお問い合わせください。",
      editErr: "この範囲は保護されています。編集する権限がありません。",
      pasteErr: "この範囲は保護されています。貼り付ける権限がありません。",
      setStyleErr: "この範囲は保護されています。スタイルを設定する権限がありません。",
      copyErr: "この範囲は保護されています。コピーする権限がありません。",
      workbookCopyErr: "このブックは保護されています。コピーする権限がありません。",
      setRowColStyleErr: "この範囲は保護されています。行や列のスタイルを設定する権限がありません。",
      moveRowColErr: "この範囲は保護されています。行や列を移動する権限がありません。",
      moveRangeErr: "この範囲は保護されています。選択範囲を移動する権限がありません。",
      autoFillErr: "この範囲は保護されています。オートフィルを実行する権限がありません。",
      filterErr: "この範囲は保護されています。フィルターを使用する権限がありません。",
      operatorSheetErr: "このシートは保護されています。シートを操作する権限がありません。",
      insertOrDeleteMoveRangeErr: "挿入または削除する範囲が保護範囲と交差しているため、現在この操作はサポートされていません。",
      printErr: "このシートは保護されています。印刷する権限がありません。",
      formulaErr: "範囲または参照先の範囲が保護されており、編集権限がありません。",
      hyperLinkErr: "この範囲は保護されています。ハイパーリンクを設定する権限がありません。",
    },
    button: {
      confirm: "OK",
      cancel: "キャンセル",
      addNewPermission: "権限を追加",
    },
  },

  sheets: {
    tabs: {
      sheetCopy: "（コピー{0}）",
      // The initial sheet from workbook_new() is named "Sheet1" (English).
      // Keeping this prefix as "Sheet" makes added tabs continue as
      // "Sheet2", "Sheet3", ... so the names AND the numbering line up.
      // Previously this was "シート", which produced "シート1" / "シート2"
      // out of sync with the existing "Sheet1".
      sheet: "Sheet",
    },
    info: {
      overlappingSelections: "重なり合う選択範囲ではこのコマンドを使用できません",
      acrossMergedCell: "結合セルをまたいでいます",
      partOfCell: "結合セルの一部のみが選択されています",
      hideSheet: "このシートを非表示にすると表示中のシートがなくなります",
    },
  },

  "find-replace": {
    toolbar: "検索と置換",
    shortcut: {
      "open-find-dialog": "検索ダイアログを開く",
      "open-replace-dialog": "置換ダイアログを開く",
      "close-dialog": "検索と置換ダイアログを閉じる",
      "go-to-next-match": "次の一致へ移動",
      "go-to-previous-match": "前の一致へ移動",
    },
    dialog: {
      title: "検索",
      find: "検索",
      replace: "置換",
      "replace-all": "すべて置換",
      "case-sensitive": "大文字と小文字を区別",
      "find-placeholder": "このシート内を検索",
      "advanced-finding": "詳細な検索と置換",
      "replace-placeholder": "置換後の文字列を入力",
      "match-the-whole-cell": "セル内容が完全に同一",
      "find-direction": {
        title: "検索方向",
        row: "行で検索",
        column: "列で検索",
      },
      "find-scope": {
        title: "検索範囲",
        "current-sheet": "現在のシート",
        workbook: "ブック",
      },
      "find-by": {
        title: "検索対象",
        value: "値で検索",
        formula: "数式で検索",
      },
      "no-match": "検索を完了しましたが、一致はありませんでした。",
      "no-result": "結果なし",
    },
    replace: {
      "all-success": "{0} 件すべて置換しました",
      "all-failure": "置換に失敗しました",
      confirm: {
        title: "すべての一致を置換してもよろしいですか？",
      },
    },
  },

  "sheet-find-replace": {
    replace: {
      "partial-failure": "一部のセルの置換に失敗しました",
      failure: "すべてのセルの置換に失敗しました",
    },
  },

  formula: {
    insert: {
      tooltip: "関数",
      sum: "SUM",
      average: "AVERAGE",
      count: "COUNT",
      max: "MAX",
      min: "MIN",
      more: "その他の関数...",
    },
    prompt: {
      helpExample: "例",
      helpAbstract: "説明",
      required: "必須。",
      optional: "省略可。",
    },
    error: {
      title: "エラー",
      divByZero: "ゼロ除算エラー",
      name: "名前エラー",
      value: "値エラー",
      num: "数値エラー",
      na: "値が利用できません",
      cycle: "循環参照エラー",
      ref: "セル参照が無効です",
      spill: "スピル範囲が空ではありません",
      calc: "計算エラー",
      error: "エラー",
      connect: "データを取得中",
      null: "Null エラー",
    },
    functionType: {
      financial: "財務",
      date: "日付/時刻",
      math: "数学/三角",
      statistical: "統計",
      lookup: "検索/行列",
      database: "データベース",
      text: "文字列操作",
      logical: "論理",
      information: "情報",
      engineering: "エンジニアリング",
      cube: "キューブ",
      compatibility: "互換性",
      web: "Web",
      array: "配列",
      univer: "Univer",
      user: "ユーザー定義",
      definedname: "定義名",
    },
    moreFunctions: {
      confirm: "OK",
      prev: "前へ",
      next: "次へ",
      searchFunctionPlaceholder: "関数を検索",
      allFunctions: "すべての関数",
      syntax: "構文",
    },
    operation: {
      pasteFormula: "数式を貼り付け",
    },
    // #179 (area D): JA `abstract` for the ~200 most-used functions. Merged
    // over Univer's en-US `formula.functionList`; `description` /
    // `functionParameter` keep Univer's English copy.
    functionList: buildFunctionListJa(),
  },

  table: {
    insert: "挿入",
    insertRowAbove: "上に行を挿入",
    insertRowBelow: "下に行を挿入",
    insertColumnLeft: "左に列を挿入",
    insertColumnRight: "右に列を挿入",
    delete: "表を削除",
    deleteRows: "行を削除",
    deleteColumns: "列を削除",
    deleteTable: "表を削除",
  },

  headerFooter: {
    header: "ヘッダー",
    footer: "フッター",
    panel: "ヘッダーとフッターの設定",
    firstPageCheckBox: "先頭ページのみ別指定",
    oddEvenCheckBox: "奇数/偶数ページを別指定",
    headerTopMargin: "ヘッダーの上余白 (px)",
    footerBottomMargin: "フッターの下余白 (px)",
    closeHeaderFooter: "ヘッダーとフッターを閉じる",
    disableText: "ヘッダーとフッターの設定は無効です",
  },

  doc: {
    menu: { paragraphSetting: "段落の設定" },
    slider: { paragraphSetting: "段落の設定" },
    paragraphSetting: {
      alignment: "配置",
      indentation: "インデント",
      left: "左",
      right: "右",
      firstLine: "最初の行",
      hanging: "ぶら下げ",
      spacing: "間隔",
      before: "段落前",
      after: "段落後",
      lineSpace: "行間",
      multiSpace: "倍数",
      fixedValue: "固定値 (px)",
    },
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
