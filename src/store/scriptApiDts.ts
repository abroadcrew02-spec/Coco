// #189 — スクリプトエディタ向けの型補完用 `.d.ts` テキスト。
//
// Monaco をフル統合していないため (バンドルサイズ過大)、エディタ側では
// この宣言テキストを「リファレンスパネル」として表示し、ユーザがスクリプト
// 内で使える API を一覧できるようにする。将来 Monaco を統合した際は、この
// 文字列を `monaco.languages.typescript.javascriptDefaults.addExtraLib()`
// にそのまま渡せる形にしてある。
//
// 通常の `.ts` モジュールとして文字列定数を export する (`.d.ts` 単体だと
// tsc が宣言ファイル扱いして `export const` の値を出力しないため)。

/** スクリプトエディタの補完リファレンスとして表示する `.d.ts` テキスト。 */
export const SCRIPT_API_DTS = `// Coco スクリプト API リファレンス (#136 / #189)
//
// スクリプト本文では引数として 'api' / 'log' / 'Coco' が渡されます。
// 'Coco' は 'api' のエイリアスです。

interface EditEvent {
  /** 編集されたシート名 */
  sheetName: string;
  /** 編集セルの A1 表記 (例: "B2") */
  a1: string;
  /** 0 始まりの行 */
  row: number;
  /** 0 始まりの列 */
  col: number;
  /** 編集後の値 */
  value: unknown;
}

interface ScriptApi {
  // ---- 読み取り ----
  /** 範囲の値を 2 次元配列で取得。空セルは null。 */
  getSheetValues(sheetName: string, a1Range: string): unknown[][];
  /** アクティブシート名 (無ければ null)。 */
  getActiveSheet(): string | null;
  /** 全シート名の一覧。 */
  getSheetNames(): string[];

  // ---- 書き込み (保護シートでは無視されます) ----
  /** 単一セルへ値を書き込む。 */
  setSheetValue(sheetName: string, a1: string, value: unknown): void;
  /** 範囲を 1 つの値で埋める。 */
  fillRange(sheetName: string, a1Range: string, value: unknown): void;
  /** セル / 範囲に書式を適用する。指定しないキーは据え置き。 */
  setCellFormat(
    sheetName: string,
    a1Range: string,
    format: { bold?: boolean; italic?: boolean; background?: string; fontColor?: string },
  ): void;

  // ---- シート操作 ----
  /** シートを追加し、その名前を返す (失敗時 null)。 */
  insertSheet(name?: string): string | null;
  /** シートを削除する。 */
  deleteSheet(sheetName: string): void;

  // ---- ログ ----
  /** コンソール出力に 1 行追加する。 */
  log(...args: unknown[]): void;

  // ---- トリガー登録 (#189) ----
  /** ブックを開いたときに呼ばれるハンドラを登録。 */
  onOpen(handler: () => void): void;
  /** セルを編集したときに呼ばれるハンドラを登録。 */
  onEdit(handler: (e: EditEvent) => void): void;
  /** カスタムメニュー項目を登録 (スクリプトエディタの「メニュー」から実行)。 */
  addMenuItem(name: string, handler: () => void): void;
  /** 一定間隔で呼ばれるタイマートリガーを登録 (最小 250ms)。 */
  addTimer(intervalMs: number, handler: () => void): void;
}

declare const api: ScriptApi;
declare const Coco: ScriptApi;
declare const log: ScriptApi["log"];
`;

/** 補完候補 (識別子 → シグネチャ) — 軽量オートコンプリート用。 */
export const SCRIPT_API_COMPLETIONS: { label: string; signature: string }[] = [
  { label: "api.getSheetValues", signature: "(sheetName, a1Range): unknown[][]" },
  { label: "api.setSheetValue", signature: "(sheetName, a1, value): void" },
  { label: "api.getActiveSheet", signature: "(): string | null" },
  { label: "api.getSheetNames", signature: "(): string[]" },
  { label: "api.insertSheet", signature: "(name?): string | null" },
  { label: "api.deleteSheet", signature: "(sheetName): void" },
  { label: "api.fillRange", signature: "(sheetName, a1Range, value): void" },
  { label: "api.setCellFormat", signature: "(sheetName, a1Range, format): void" },
  { label: "api.log", signature: "(...args): void" },
  { label: "Coco.onOpen", signature: "(handler): void" },
  { label: "Coco.onEdit", signature: "(handler): void" },
  { label: "Coco.addMenuItem", signature: "(name, handler): void" },
  { label: "Coco.addTimer", signature: "(intervalMs, handler): void" },
];
