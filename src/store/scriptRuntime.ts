// #136 — スクリプト実行環境 (Apps Script 相当)。
// #189 — follow-up: トリガー / 完全サンドボックス / Facade 拡張 / ログ永続化。
//
// 現スコープ:
//   - ブック内蔵 JS スニペット (string)
//   - 実行ボタンからの手動実行 + トリガー (onOpen / onEdit / timer / menu)
//   - Univer Facade のサブセットを `api` 引数として注入
//   - 5 秒 watchdog で無限ループ / 暴走 async を検出
//   - 実行は executor 抽象越し:
//       * iframeExecutor  — sandboxed iframe (本番)。window/document/fetch/
//         localStorage/parent を遮断し、postMessage で Facade を仲介。
//         CSP `unsafe-eval` 不要。
//       * inlineExecutor  — Function コンストラクタ (DOM の無いテスト環境 /
//         factory 注入時のフォールバック)。
//
// スクリプトは untrusted code として扱う。iframe 実行下では window /
// document / fetch / localStorage / Tauri invoke は到達不能。

import type { FUniver } from "@univerjs/core/facade";
import { isSheetProtectedInSnapshot } from "./sheetProtection";

/** スクリプトのデフォルト最大実行時間 (ms)。watchdog がこれを超えたら
 *  `aborted` フラグを立て、次のループチェックで throw する。 */
export const DEFAULT_TIMEOUT_MS = 5000;

/** スクリプトエントリの永続化形状。snapshot ルートに `_scripts` として保存。 */
export interface ScriptEntry {
  id: string;
  name: string;
  source: string;
  /** epoch ms */
  lastModified: number;
}

export interface ScriptsSnapshot {
  _scripts?: ScriptEntry[];
}

/** 実行結果。console output と例外情報を含む。 */
export interface ScriptRunResult {
  ok: boolean;
  /** `api.log(msg)` の呼び出し履歴。実行成功時も失敗時も保持される。 */
  logs: string[];
  /** 例外メッセージ。`ok === false` のときのみ非 null。 */
  error: string | null;
  /** 例外の stack trace (デバッグ表示用)。 */
  stack: string | null;
  /** 例外の発生行 (1-origin, ソース基準)。判定できなければ null。 */
  errorLine: number | null;
  /** 実行時間 (ms)。 */
  elapsedMs: number;
  /** タイムアウトで打ち切られたか。 */
  timedOut: boolean;
}

// ---------- トリガー (#189) --------------------------------------------------

/** スクリプトが登録できるトリガー種別。 */
export type TriggerKind = "onOpen" | "onEdit" | "timer" | "menu";

/** `Coco.*` 登録 API でスクリプトが宣言したトリガー。 */
export interface RegisteredTrigger {
  kind: TriggerKind;
  /** menu の表示名 / timer の識別ラベル。onOpen/onEdit では空。 */
  label: string;
  /** timer トリガーの発火間隔 (ms)。timer 以外は 0。 */
  intervalMs: number;
}

/** onEdit ハンドラに渡される編集イベント。 */
export interface EditEvent {
  sheetName: string;
  /** 編集範囲の A1 (単一セルなら "A1")。 */
  a1: string;
  row: number;
  col: number;
  value: unknown;
}

// ---------- Facade API -------------------------------------------------------

/**
 * スクリプトに注入する Univer Facade のサブセット。
 * #189 でシート追加/削除・書式設定・範囲 fill を追加。
 */
export interface ScriptApi {
  /** アクティブシートの A1 範囲を 2 次元配列で返す。値がないセルは null。 */
  getSheetValues(sheetName: string, a1Range: string): unknown[][];
  /** 単一セルに値を書き込む。保護シートでは無視され warning を log。 */
  setSheetValue(sheetName: string, a1: string, value: unknown): void;
  /** アクティブシート名。シートが存在しない場合は null。 */
  getActiveSheet(): string | null;
  /** 全シート名の一覧。 */
  getSheetNames(): string[];
  /** シートを追加し、その名前を返す。失敗時は null。 */
  insertSheet(name?: string): string | null;
  /** シートを削除する。保護シートでは無視される。 */
  deleteSheet(sheetName: string): void;
  /** 範囲を 1 つの値で埋める。保護シートでは無視される。 */
  fillRange(sheetName: string, a1Range: string, value: unknown): void;
  /** セル / 範囲に書式を設定する。指定しないキーは据え置き。 */
  setCellFormat(
    sheetName: string,
    a1Range: string,
    format: { bold?: boolean; italic?: boolean; background?: string; fontColor?: string },
  ): void;
  /** console output に行を追加。 */
  log(...args: unknown[]): void;
  /** ブック開封時に呼ぶハンドラを登録 (#189 トリガー)。 */
  onOpen(handler: () => unknown): void;
  /** セル編集時に呼ぶハンドラを登録 (#189 トリガー)。 */
  onEdit(handler: (e: EditEvent) => unknown): void;
  /** カスタムメニュー項目を登録 (#189 トリガー)。 */
  addMenuItem(name: string, handler: () => unknown): void;
  /** 一定間隔で呼ぶタイマートリガーを登録 (#189 トリガー)。 */
  addTimer(intervalMs: number, handler: () => unknown): void;
}

/** `Coco` 名前空間。`api` のエイリアス + トリガー登録 API。 */
export type CocoNamespace = ScriptApi;

/**
 * 任意の値を log 用文字列に整形する。
 */
function stringifyLogArg(arg: unknown): string {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Facade ヘルパ — シートを名前で解決 (見つからなければアクティブシート)。 */
function resolveSheet(wb: unknown, sheetName: string): unknown {
  const w = wb as {
    getSheetBySheetName?: (n: string) => unknown;
    getActiveSheet?: () => unknown;
  };
  const found = sheetName ? w.getSheetBySheetName?.(sheetName) : null;
  return found ?? w.getActiveSheet?.() ?? null;
}

/** Facade ヘルパ — シート id を取得 (保護判定用)。 */
function sheetIdOf(sheet: unknown): string | null {
  try {
    const id = (sheet as { getSheetId?: () => string }).getSheetId?.();
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

export interface BuildApiContext {
  fUniver: FUniver | null;
  logs: string[];
  /** トリガー登録の収集先。 */
  triggers: RegisteredTrigger[];
  /** 保護判定用の最新 snapshot JSON。 */
  snapshotJson: string | null;
}

/**
 * `ScriptApi` を構築する。FUniver が null の場合は no-op API。
 * 書き込み系 API はシート保護を尊重し、保護シートでは何もせず warning を出す。
 */
export function buildApi(ctx: BuildApiContext): ScriptApi {
  const { fUniver, logs, triggers, snapshotJson } = ctx;

  /** 書き込み前の保護チェック。保護されていれば true を返し warning を出す。 */
  const blockedByProtection = (sheet: unknown, action: string): boolean => {
    const id = sheetIdOf(sheet);
    if (id && isSheetProtectedInSnapshot(snapshotJson, id)) {
      logs.push(`[warn] 保護シートのため ${action} はスキップされました。`);
      return true;
    }
    return false;
  };

  return {
    getSheetValues(sheetName: string, a1Range: string): unknown[][] {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return [];
      try {
        const sheet = resolveSheet(wb, sheetName);
        if (!sheet) return [];
        const range = (sheet as {
          getRange: (r: string) => { getValues?: () => unknown[][] } | null;
        }).getRange(a1Range);
        const values = range?.getValues?.();
        return Array.isArray(values) ? values : [];
      } catch {
        return [];
      }
    },
    setSheetValue(sheetName: string, a1: string, value: unknown): void {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      try {
        const sheet = resolveSheet(wb, sheetName);
        if (!sheet) return;
        if (blockedByProtection(sheet, "setSheetValue")) return;
        const range = (sheet as {
          getRange: (r: string) => { setValue?: (v: unknown) => void } | null;
        }).getRange(a1);
        range?.setValue?.(value);
      } catch {
        // best-effort
      }
    },
    getActiveSheet(): string | null {
      const wb = fUniver?.getActiveWorkbook();
      const sheet = wb?.getActiveSheet();
      if (!sheet) return null;
      try {
        const name = (sheet as { getSheetName?: () => string }).getSheetName?.();
        return typeof name === "string" ? name : null;
      } catch {
        return null;
      }
    },
    getSheetNames(): string[] {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return [];
      try {
        const sheets = (wb as { getSheets?: () => unknown[] }).getSheets?.() ?? [];
        return sheets
          .map((s) => (s as { getSheetName?: () => string }).getSheetName?.())
          .filter((n): n is string => typeof n === "string");
      } catch {
        return [];
      }
    },
    insertSheet(name?: string): string | null {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return null;
      try {
        const w = wb as {
          create?: (n: string, r: number, c: number) => unknown;
          insertSheet?: (n?: string) => unknown;
        };
        // Univer 0.5 Facade: FWorkbook.create(name, rows, cols)
        const sheet =
          w.create?.(name ?? `Sheet${Date.now() % 100000}`, 100, 26) ??
          w.insertSheet?.(name);
        if (!sheet) return null;
        const sn = (sheet as { getSheetName?: () => string }).getSheetName?.();
        return typeof sn === "string" ? sn : (name ?? null);
      } catch {
        return null;
      }
    },
    deleteSheet(sheetName: string): void {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      try {
        const sheet = resolveSheet(wb, sheetName);
        if (!sheet) return;
        if (blockedByProtection(sheet, "deleteSheet")) return;
        const id = sheetIdOf(sheet);
        const w = wb as {
          deleteSheet?: (id: string) => void;
          deleteActiveSheet?: () => void;
        };
        if (id && w.deleteSheet) w.deleteSheet(id);
        else w.deleteActiveSheet?.();
      } catch {
        // best-effort
      }
    },
    fillRange(sheetName: string, a1Range: string, value: unknown): void {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      try {
        const sheet = resolveSheet(wb, sheetName);
        if (!sheet) return;
        if (blockedByProtection(sheet, "fillRange")) return;
        const range = (sheet as {
          getRange: (r: string) => { setValue?: (v: unknown) => void } | null;
        }).getRange(a1Range);
        range?.setValue?.(value);
      } catch {
        // best-effort
      }
    },
    setCellFormat(sheetName, a1Range, format): void {
      const wb = fUniver?.getActiveWorkbook();
      if (!wb) return;
      try {
        const sheet = resolveSheet(wb, sheetName);
        if (!sheet) return;
        if (blockedByProtection(sheet, "setCellFormat")) return;
        const range = (sheet as {
          getRange: (r: string) => Record<string, unknown> | null;
        }).getRange(a1Range);
        if (!range) return;
        const r = range as {
          setFontWeight?: (v: string) => void;
          setFontStyle?: (v: string) => void;
          setBackground?: (v: string) => void;
          setFontColor?: (v: string) => void;
        };
        if (format.bold !== undefined) r.setFontWeight?.(format.bold ? "bold" : "normal");
        if (format.italic !== undefined) r.setFontStyle?.(format.italic ? "italic" : "normal");
        if (format.background !== undefined) r.setBackground?.(format.background);
        if (format.fontColor !== undefined) r.setFontColor?.(format.fontColor);
      } catch {
        // best-effort
      }
    },
    log(...args: unknown[]): void {
      logs.push(args.map(stringifyLogArg).join(" "));
    },
    onOpen(_handler: () => unknown): void {
      void _handler;
      triggers.push({ kind: "onOpen", label: "", intervalMs: 0 });
    },
    onEdit(_handler: (e: EditEvent) => unknown): void {
      void _handler;
      triggers.push({ kind: "onEdit", label: "", intervalMs: 0 });
    },
    addMenuItem(name: string, _handler: () => unknown): void {
      void _handler;
      triggers.push({
        kind: "menu",
        label: String(name || "メニュー項目"),
        intervalMs: 0,
      });
    },
    addTimer(intervalMs: number, _handler: () => unknown): void {
      void _handler;
      const ms = Math.max(250, Math.floor(Number(intervalMs) || 0));
      triggers.push({ kind: "timer", label: `${ms}ms`, intervalMs: ms });
    },
  };
}

// ---------- Executor 抽象 ----------------------------------------------------

/**
 * Executor: スクリプト本体を「どこで・どう」評価するかを差し替え可能にする。
 *  - iframeExecutor : sandboxed iframe (本番、完全分離)
 *  - inlineExecutor : Function コンストラクタ (DOM 無し / テスト)
 */
export interface ScriptExecutor {
  /**
   * `source` を評価する。`api` の各メソッド呼び出しは executor 内部で
   * 仲介される。戻り値は最後の式の値 (あれば)。`mode = "list-triggers"`
   * のときは登録トリガー一覧を `triggers` で返す。
   */
  execute(
    source: string,
    api: ScriptApi,
    options: ExecuteOptions,
  ): Promise<{ returnValue: unknown; triggers?: RegisteredTrigger[] }>;
}

/** iframe executor のトリガー発火指示 (mode = "fire-trigger" 時)。 */
export interface TriggerFireSpec {
  kind: TriggerKind;
  /** menu のとき発火対象を絞るラベル。 */
  label: string;
  /** onEdit のイベント引数。 */
  event: EditEvent | null;
}

export interface ExecuteOptions {
  /** タイムアウト (ms)。 */
  timeoutMs: number;
  /** abort フラグ。watchdog が立てる。 */
  aborted: { flag: boolean };
  /** factory (テスト用、inline executor のみ尊重)。 */
  factory?: (source: string) => (api: ScriptApi, log: ScriptApi["log"]) => unknown;
  /** トリガー発火時、source 末尾にこのコードを足して特定ハンドラを呼ぶ
   *  (inline executor 専用フォールバック)。 */
  triggerCall?: string;
  /**
   * 実行モード (iframe executor のみ尊重):
   *  - "run"          : スクリプト本体を実行 (デフォルト)
   *  - "list-triggers": 本体を実行し、登録トリガー一覧を返す
   *  - "fire-trigger" : 本体を実行後、`fire` の指定ハンドラを発火する
   */
  mode?: "run" | "list-triggers" | "fire-trigger";
  /** mode = "fire-trigger" 時の発火指示。 */
  fire?: TriggerFireSpec;
}

/**
 * inline executor — Function コンストラクタ評価。CSP=null に依存。
 *
 * #189 C2: これは **DOM の無いテスト環境 (vitest) 専用** のフォールバック。
 * inline 経路の untrusted code はメインスレッド・親 origin・親 CSP 下で
 * 評価されるためサンドボックスが効かない。本番 (DOM あり) 経路では決して
 * 使われない (`runScript` が iframe executor を強制する)。実 Facade を
 * 渡してはならない — `runScript` 側で inline 経路には fUniver を null に
 * 落とす。テストは factory 注入 (`options.factory`) で利用する。
 */
export const inlineExecutor: ScriptExecutor = {
  async execute(source, api, options) {
    let fn: (api: ScriptApi, log: ScriptApi["log"], Coco: CocoNamespace) => unknown;
    if (options.factory) {
      fn = options.factory(source) as typeof fn;
    } else {
      const body = `"use strict";\n${source}\n${options.triggerCall ?? ""}\n`;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      fn = new Function("api", "log", "Coco", body) as typeof fn;
    }
    const ret = await fn(api, api.log, api);
    return { returnValue: ret };
  },
};

/** iframe へ渡す読み取り専用スナップショット (getSheetValues 用)。 */
export interface IframeDataBundle {
  activeSheet: string | null;
  sheetNames: string[];
  /** sheetName -> a1Range -> values。スクリプトが要求し得る範囲を事前取得。 */
  sheets: Record<string, Record<string, unknown[][]>>;
}

/**
 * iframe 内で動くブートストラップ HTML。親へ Facade 呼び出しを postMessage
 * し、読み取りは実行開始時に渡されるデータバンドルから引く。
 *
 * sandbox="allow-scripts" のみを付与するため iframe の origin は "null":
 * window.parent / localStorage / cookie / same-origin fetch は SecurityError
 * で遮断される。Blob URL 経由で読み込むため親文書 DOM へも到達不能。
 *
 * #189 C2: トリガーは iframe 内で完結する。`Coco.onOpen/onEdit/addMenuItem/
 * addTimer` で登録されたハンドラ関数は iframe 内の Map (種別/ラベル → 関数)
 * に保持される — 関数参照は iframe 境界を越えられないため。親は
 *   - "list-triggers": スクリプトを実行し、登録されたトリガーの一覧を要求
 *   - "fire-trigger" : 特定種別/ラベルのハンドラをイベント引数付きで発火
 * を postMessage で指示する。これにより untrusted code は常に sandboxed
 * iframe 内 (null origin) でのみ評価され、メインスレッドには到達しない。
 */
function buildIframeHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
(function () {
  "use strict";
  var parentPort = null;
  function send(type, payload) {
    if (parentPort) parentPort.postMessage({ __coco: true, type: type, payload: payload });
  }
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.__coco !== true) return;
    if (d.type === "run") {
      parentPort = ev.ports && ev.ports[0] ? ev.ports[0] : null;
      runUserScript(d.source, d.snapshot, d.mode, d.fire);
    }
  });
  function makeApi(snapshot, logs, registry) {
    function values(sheet, a1) {
      var s = snapshot && snapshot.sheets ? snapshot.sheets[sheet] : null;
      return (s && s[a1]) || [];
    }
    return {
      getSheetValues: function (sheet, a1) { return values(sheet, a1); },
      getActiveSheet: function () { return snapshot ? snapshot.activeSheet : null; },
      getSheetNames: function () { return snapshot ? (snapshot.sheetNames || []) : []; },
      setSheetValue: function (sheet, a1, v) { send("call", { m: "setSheetValue", a: [sheet, a1, v] }); },
      insertSheet: function (n) { send("call", { m: "insertSheet", a: [n] }); return null; },
      deleteSheet: function (sheet) { send("call", { m: "deleteSheet", a: [sheet] }); },
      fillRange: function (sheet, a1, v) { send("call", { m: "fillRange", a: [sheet, a1, v] }); },
      setCellFormat: function (sheet, a1, f) { send("call", { m: "setCellFormat", a: [sheet, a1, f] }); },
      log: function () { logs.push(Array.prototype.slice.call(arguments).map(String).join(" ")); },
      // トリガー登録: ハンドラ関数は iframe 内の registry に保持する。
      onOpen: function (fn) {
        registry.onOpen.push(fn);
        registry.triggers.push({ kind: "onOpen", label: "", intervalMs: 0 });
      },
      onEdit: function (fn) {
        registry.onEdit.push(fn);
        registry.triggers.push({ kind: "onEdit", label: "", intervalMs: 0 });
      },
      addMenuItem: function (name, fn) {
        var label = String(name || "メニュー項目");
        registry.menu.push({ label: label, fn: fn });
        registry.triggers.push({ kind: "menu", label: label, intervalMs: 0 });
      },
      addTimer: function (ms, fn) {
        var iv = Math.max(250, Math.floor(Number(ms) || 0));
        registry.timer.push(fn);
        registry.triggers.push({ kind: "timer", label: iv + "ms", intervalMs: iv });
      }
    };
  }
  function fireRegistered(registry, fire) {
    // fire: { kind, label, event } — 該当ハンドラを直列実行する Promise を返す。
    var queue = [];
    if (fire.kind === "onOpen") {
      registry.onOpen.forEach(function (fn) { queue.push(function () { return fn(); }); });
    } else if (fire.kind === "onEdit") {
      registry.onEdit.forEach(function (fn) {
        queue.push(function () { return fn(fire.event); });
      });
    } else if (fire.kind === "menu") {
      registry.menu.forEach(function (m) {
        if (m.label === fire.label) queue.push(function () { return m.fn(); });
      });
    } else if (fire.kind === "timer") {
      registry.timer.forEach(function (fn) { queue.push(function () { return fn(); }); });
    }
    return (function next(i) {
      if (i >= queue.length) return Promise.resolve();
      return Promise.resolve(queue[i]()).then(function () { return next(i + 1); });
    })(0);
  }
  function runUserScript(source, snapshot, mode, fire) {
    var logs = [];
    var registry = { triggers: [], onOpen: [], onEdit: [], menu: [], timer: [] };
    try {
      var api = makeApi(snapshot, logs, registry);
      var fn = new Function("api", "log", "Coco", '"use strict";\\n' + source + '\\n');
      // スクリプト本体を評価 (トリガー登録 + トップレベルコードを実行)。
      var ret = fn(api, api.log, api);
      Promise.resolve(ret).then(function (v) {
        if (mode === "list-triggers") {
          send("done", { ok: true, logs: logs, triggers: registry.triggers });
          return;
        }
        if (mode === "fire-trigger" && fire) {
          // 本体実行後、登録ハンドラを発火する。
          return fireRegistered(registry, fire).then(function () {
            send("done", { ok: true, logs: logs, returnValue: undefined });
          }, function (err) {
            send("done", { ok: false, logs: logs,
              error: err && err.message ? err.message : String(err),
              stack: err && err.stack ? String(err.stack) : null });
          });
        }
        send("done", { ok: true, logs: logs, returnValue: v });
      }, function (err) {
        send("done", { ok: false, logs: logs,
          error: err && err.message ? err.message : String(err),
          stack: err && err.stack ? String(err.stack) : null });
      });
    } catch (err) {
      send("done", { ok: false, logs: logs,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack) : null });
    }
  }
})();
<\/script>
</body></html>`;
}

/**
 * iframe executor を生成する。`getBundle` は実行直前に getSheetValues 用の
 * 読み取りデータを集めるコールバック。
 */
export function createIframeExecutor(getBundle: () => IframeDataBundle): ScriptExecutor {
  return {
    execute(source, api, options) {
      return new Promise((resolve, reject) => {
        if (typeof document === "undefined") {
          reject(new Error("iframe executor は DOM 環境でのみ利用できます。"));
          return;
        }
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("aria-hidden", "true");
        iframe.style.display = "none";
        const html = buildIframeHtml();
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        iframe.src = url;

        const channel = new MessageChannel();
        let settled = false;
        const cleanup = () => {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* noop */
          }
          channel.port1.close();
          iframe.remove();
        };

        // watchdog: aborted フラグ + iframe のハード kill。
        const killTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          options.aborted.flag = true;
          cleanup();
          reject(
            new Error(`スクリプトが ${options.timeoutMs}ms を超えたため中断しました。`),
          );
        }, options.timeoutMs);

        channel.port1.onmessage = (ev: MessageEvent) => {
          const d = ev.data as
            | { __coco?: boolean; type?: string; payload?: unknown }
            | undefined;
          if (!d || d.__coco !== true) return;
          if (d.type === "call") {
            // iframe からの Facade 書き込み要求をメインスレッドで実行。
            // 保護シートチェックは buildApi 側で引き続き有効。
            const p = d.payload as { m?: string; a?: unknown[] } | undefined;
            const m = p?.m;
            const a = p?.a ?? [];
            const fn = (api as unknown as Record<string, (...x: unknown[]) => unknown>)[
              m ?? ""
            ];
            if (typeof fn === "function") {
              try {
                fn(...a);
              } catch {
                /* best-effort */
              }
            }
          } else if (d.type === "done") {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            const r = d.payload as {
              ok: boolean;
              logs: string[];
              returnValue?: unknown;
              error?: string;
              stack?: string | null;
              triggers?: RegisteredTrigger[];
            };
            // iframe 内 logs をメイン側 logs にマージ (api.log 経由)。
            for (const line of r.logs) api.log(line);
            cleanup();
            if (r.ok) {
              resolve({ returnValue: r.returnValue, triggers: r.triggers });
            } else {
              const err = new Error(r.error ?? "スクリプト実行エラー");
              if (r.stack) err.stack = r.stack;
              reject(err);
            }
          }
        };

        iframe.onload = () => {
          const bundle = getBundle();
          iframe.contentWindow?.postMessage(
            {
              __coco: true,
              type: "run",
              source,
              snapshot: bundle,
              mode: options.mode ?? "run",
              fire: options.fire ?? null,
            },
            "*",
            [channel.port2],
          );
        };

        document.body.appendChild(iframe);
      });
    },
  };
}

// ---------- runScript --------------------------------------------------------

export interface RunScriptOptions {
  /** タイムアウト (ms)。デフォルト 5000。 */
  timeoutMs?: number;
  /** Facade。null の場合は no-op api。 */
  fUniver?: FUniver | null;
  /** 既に開いた logs バッファ (テスト用; 通常は undefined)。 */
  initialLogs?: string[];
  /** Function コンストラクタの代わりに任意の評価関数を注入 (テスト用)。 */
  factory?: (source: string) => (api: ScriptApi, log: ScriptApi["log"]) => unknown;
  /** 評価方式。未指定なら DOM があれば iframe、無ければ inline。 */
  executor?: ScriptExecutor;
  /** 保護判定用の最新 snapshot JSON。 */
  snapshotJson?: string | null;
  /** トリガー発火時の追加呼び出しコード (内部用; inline executor 専用)。 */
  triggerCall?: string;
  /** 収集済みトリガーの参照を返してほしい場合に渡す配列
   *  (iframe executor 経由でも `mode: "list-triggers"` の結果がここに入る)。 */
  collectTriggers?: RegisteredTrigger[];
  /** 実行モード (iframe executor 用)。 */
  mode?: "run" | "list-triggers" | "fire-trigger";
  /** mode = "fire-trigger" 時の発火指示 (iframe executor 用)。 */
  fire?: TriggerFireSpec;
}

/** ソース行と stack から例外発生行を推定する。 */
function inferErrorLine(stack: string | null): number | null {
  if (!stack) return null;
  // "<anonymous>:LINE:COL" もしくは "Function:LINE" 形式から行番号を拾う。
  const m = stack.match(/<anonymous>:(\d+):\d+/) || stack.match(/Function:(\d+)/);
  if (!m) return null;
  const raw = Number(m[1]);
  // Function 本体は `"use strict";\n` で +1 行ずれる。
  return Number.isFinite(raw) ? Math.max(1, raw - 1) : null;
}

export async function runScript(
  source: string,
  options: RunScriptOptions = {},
): Promise<ScriptRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logs: string[] = options.initialLogs ?? [];
  const triggers: RegisteredTrigger[] = options.collectTriggers ?? [];

  // executor 選択: 明示指定 > factory 指定なら inline > DOM あれば iframe。
  // #189 C2: inline executor は untrusted code をメインスレッド・親 origin
  // で評価するためサンドボックスが効かない。本番 (DOM あり) 経路では必ず
  // iframe executor を使い、inline 経路には実 Facade を渡さない。
  const useInline =
    !!options.factory ||
    (options.executor === undefined && typeof document === "undefined") ||
    options.executor === inlineExecutor;

  // inline 経路には実 Facade を絶対に渡さない。Facade を渡すと untrusted
  // code が保護チェックを経由しつつ親スレッドの API へ直接到達してしまう。
  const fUniver: FUniver | null = useInline ? null : options.fUniver ?? null;

  const executor: ScriptExecutor =
    options.executor ??
    (useInline
      ? inlineExecutor
      : createIframeExecutor(() => buildBundle(fUniver)));

  if (useInline) {
    logs.push(
      "[warn] スクリプトはこの環境では Function コンストラクタで評価されます。" +
        "信頼できるコードのみを実行してください。",
    );
  } else {
    logs.push(
      "[info] スクリプトは sandboxed iframe 内で隔離実行されます " +
        "(window / document / fetch / localStorage は遮断)。",
    );
  }

  const start = Date.now();
  let timedOut = false;
  const aborted = { flag: false };

  const watchdog = setTimeout(() => {
    aborted.flag = true;
    timedOut = true;
  }, timeoutMs);

  const rawApi = buildApi({
    fUniver,
    logs,
    triggers,
    snapshotJson: options.snapshotJson ?? null,
  });

  // api をラップして毎回 aborted をチェック (inline executor 用の中断機構)。
  const guard = <F extends (...args: never[]) => unknown>(fn: F): F => {
    return ((...args: unknown[]) => {
      if (aborted.flag) {
        throw new Error(`スクリプトが ${timeoutMs}ms を超えたため中断しました。`);
      }
      return (fn as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as F;
  };
  const api: ScriptApi = {
    getSheetValues: guard(rawApi.getSheetValues.bind(rawApi)),
    setSheetValue: guard(rawApi.setSheetValue.bind(rawApi)),
    getActiveSheet: guard(rawApi.getActiveSheet.bind(rawApi)),
    getSheetNames: guard(rawApi.getSheetNames.bind(rawApi)),
    insertSheet: guard(rawApi.insertSheet.bind(rawApi)),
    deleteSheet: guard(rawApi.deleteSheet.bind(rawApi)),
    fillRange: guard(rawApi.fillRange.bind(rawApi)),
    setCellFormat: guard(rawApi.setCellFormat.bind(rawApi)),
    log: guard(rawApi.log.bind(rawApi)),
    onOpen: rawApi.onOpen.bind(rawApi),
    onEdit: rawApi.onEdit.bind(rawApi),
    addMenuItem: rawApi.addMenuItem.bind(rawApi),
    addTimer: rawApi.addTimer.bind(rawApi),
  };

  try {
    const { returnValue, triggers: iframeTriggers } = await executor.execute(
      source,
      api,
      {
        timeoutMs,
        aborted,
        factory: options.factory,
        triggerCall: options.triggerCall,
        mode: options.mode,
        fire: options.fire,
      },
    );
    // iframe executor は登録トリガーを postMessage 越しに返す。inline
    // 経路は buildApi が triggers 配列へ直接 push 済み。
    if (iframeTriggers && triggers !== iframeTriggers) {
      for (const t of iframeTriggers) triggers.push(t);
    }
    // 同期ループ完了直後は setTimeout がまだ発火していないので 1 マクロ
    // タスク譲って watchdog を確実に起こす (inline executor 向け)。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (aborted.flag) {
      throw new Error(`スクリプトが ${timeoutMs}ms を超えたため中断しました。`);
    }
    if (returnValue !== undefined) {
      logs.push(`=> ${stringifyLogArg(returnValue)}`);
    }
    return {
      ok: true,
      logs,
      error: null,
      stack: null,
      errorLine: null,
      elapsedMs: Date.now() - start,
      timedOut: false,
    };
  } catch (e) {
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
    const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : null;
    return {
      ok: false,
      logs,
      error: message,
      stack,
      errorLine: inferErrorLine(stack),
      elapsedMs: Date.now() - start,
      timedOut,
    };
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * iframe executor 用のデータバンドルを構築する。getSheetValues は事前
 * 取得モデルなので、各シートの代表的範囲 (A1:Z100) を読み出しておく。
 */
function buildBundle(fUniver: FUniver | null): IframeDataBundle {
  const empty: IframeDataBundle = {
    activeSheet: null,
    sheetNames: [],
    sheets: {},
  };
  const wb = fUniver?.getActiveWorkbook();
  if (!wb) return empty;
  try {
    const sheets = (wb as { getSheets?: () => unknown[] }).getSheets?.() ?? [];
    const sheetNames: string[] = [];
    const data: Record<string, Record<string, unknown[][]>> = {};
    for (const s of sheets) {
      const name = (s as { getSheetName?: () => string }).getSheetName?.();
      if (typeof name !== "string") continue;
      sheetNames.push(name);
      try {
        const range = (s as {
          getRange: (r: string) => { getValues?: () => unknown[][] } | null;
        }).getRange("A1:Z100");
        const values = range?.getValues?.();
        data[name] = { "A1:Z100": Array.isArray(values) ? values : [] };
      } catch {
        data[name] = {};
      }
    }
    const active = wb.getActiveSheet();
    const activeName =
      (active as { getSheetName?: () => string } | null)?.getSheetName?.() ?? null;
    return { activeSheet: activeName ?? null, sheetNames, sheets: data };
  } catch {
    return empty;
  }
}

// ---------- トリガー収集 / 発火 (#189) ---------------------------------------

/** 1 スクリプトのトリガー登録一覧。 */
export interface CollectedTriggers {
  scriptId: string;
  scriptName: string;
  triggers: RegisteredTrigger[];
}

/**
 * 単一スクリプトのトリガー登録を収集する。
 *
 * #189 C2: 本番 (DOM あり) では iframe executor の `mode: "list-triggers"`
 * で実行する — スクリプト本体は sandboxed iframe 内 (null origin) で評価
 * され、登録されたトリガーの一覧 (種別/ラベル/間隔) だけが postMessage で
 * 親へ返る。ハンドラ関数は iframe 内の registry に保持される。
 *
 * DOM の無いテスト環境では inline executor へフォールバックする (実 Facade
 * は `runScript` 側で null に落とされる)。
 */
export async function collectTriggers(
  entry: ScriptEntry,
  options: { fUniver?: FUniver | null; snapshotJson?: string | null } = {},
): Promise<CollectedTriggers> {
  const collected: RegisteredTrigger[] = [];
  const hasDom = typeof document !== "undefined";
  await runScript(entry.source, {
    fUniver: options.fUniver ?? null,
    snapshotJson: options.snapshotJson ?? null,
    // DOM があれば iframe (mode 指定)、無ければ inline フォールバック。
    executor: hasDom ? undefined : inlineExecutor,
    mode: "list-triggers",
    collectTriggers: collected,
    timeoutMs: 2000,
  });
  return {
    scriptId: entry.id,
    scriptName: entry.name,
    triggers: collected,
  };
}

/** inline executor (テスト専用) で trigger を発火するためのプレリュード生成。 */
function buildInlineFirePrelude(
  kind: TriggerKind,
  label: string,
  editEvent: EditEvent | null,
): { prelude: string; triggerCall: string } {
  const prelude = `
var __cocoFire = ${JSON.stringify(kind)};
var __cocoLabel = ${JSON.stringify(label)};
var __cocoEvent = ${JSON.stringify(editEvent)};
var __cocoQueue = [];
(function () {
  Coco.onOpen = api.onOpen = function (fn) { if (__cocoFire === "onOpen") __cocoQueue.push(function(){ return fn(); }); };
  Coco.onEdit = api.onEdit = function (fn) { if (__cocoFire === "onEdit") __cocoQueue.push(function(){ return fn(__cocoEvent); }); };
  Coco.addMenuItem = api.addMenuItem = function (name, fn) { if (__cocoFire === "menu" && String(name) === __cocoLabel) __cocoQueue.push(function(){ return fn(); }); };
  Coco.addTimer = api.addTimer = function (ms, fn) { void ms; if (__cocoFire === "timer") __cocoQueue.push(function(){ return fn(); }); };
})();
`;
  const triggerCall = `
;return (async function () {
  for (var __i = 0; __i < __cocoQueue.length; __i++) { await __cocoQueue[__i](); }
})();
`;
  return { prelude, triggerCall };
}

/**
 * 指定スクリプトの特定種別トリガーを発火する。
 *
 * #189 C2: 本番 (DOM あり) では iframe executor の `mode: "fire-trigger"`
 * で実行する — スクリプト本体は sandboxed iframe 内で評価され、登録された
 * 該当ハンドラ (種別/ラベル一致) を iframe 内で直列発火する。ハンドラ参照
 * は iframe 境界を越えず、メインスレッドには到達しない。Facade 書き込みは
 * 引き続き postMessage 越しに保護チェックを通る。
 *
 * DOM の無いテスト環境では inline executor へフォールバックし、登録 API を
 * 差し替えるプレリュード方式で発火する (実 Facade は渡らない)。
 */
export async function fireTrigger(
  entry: ScriptEntry,
  kind: TriggerKind,
  options: {
    fUniver?: FUniver | null;
    snapshotJson?: string | null;
    /** menu のとき発火対象を絞るラベル。 */
    label?: string;
    /** onEdit のイベント。 */
    editEvent?: EditEvent;
    executor?: ScriptExecutor;
    timeoutMs?: number;
  } = {},
): Promise<ScriptRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? "";
  const editEvent = options.editEvent ?? null;

  // 明示 executor 指定 (テスト) または DOM 無し → inline フォールバック。
  const useInline =
    options.executor === inlineExecutor ||
    (options.executor === undefined && typeof document === "undefined");

  if (useInline) {
    const { prelude, triggerCall } = buildInlineFirePrelude(kind, label, editEvent);
    return runScript(prelude + "\n" + entry.source, {
      fUniver: options.fUniver ?? null,
      snapshotJson: options.snapshotJson ?? null,
      executor: inlineExecutor,
      triggerCall,
      timeoutMs,
    });
  }

  // 本番経路: iframe executor の fire-trigger モード。
  return runScript(entry.source, {
    fUniver: options.fUniver ?? null,
    snapshotJson: options.snapshotJson ?? null,
    executor: options.executor,
    mode: "fire-trigger",
    fire: { kind, label, event: editEvent },
    timeoutMs,
  });
}

// ---------- 実行ログ永続化 (#189) --------------------------------------------

const LOG_STORAGE_KEY = "coco.scriptRuntime.executionLog";
const MAX_PERSISTED_LOGS = 100;

/** 永続化される 1 回の実行記録。 */
export interface ExecutionLogRecord {
  /** epoch ms */
  at: number;
  scriptId: string;
  scriptName: string;
  /** "manual" | TriggerKind */
  trigger: string;
  ok: boolean;
  elapsedMs: number;
  error: string | null;
  timedOut: boolean;
}

/** 実行ログを localStorage から読み出す (新しい順)。 */
export function readExecutionLog(): ExecutionLogRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r): r is ExecutionLogRecord =>
        !!r && typeof r.at === "number" && typeof r.scriptId === "string",
    );
  } catch {
    return [];
  }
}

/** 実行ログに 1 件追記する (最大 MAX_PERSISTED_LOGS 件、新しい順)。 */
export function appendExecutionLog(record: ExecutionLogRecord): void {
  if (typeof localStorage === "undefined") return;
  try {
    const next = [record, ...readExecutionLog()].slice(0, MAX_PERSISTED_LOGS);
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** 実行ログを全消去する。 */
export function clearExecutionLog(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(LOG_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/** ScriptRunResult を ExecutionLogRecord に変換して永続化する便利関数。 */
export function recordRun(
  entry: ScriptEntry,
  trigger: string,
  result: ScriptRunResult,
): void {
  appendExecutionLog({
    at: Date.now(),
    scriptId: entry.id,
    scriptName: entry.name,
    trigger,
    ok: result.ok,
    elapsedMs: result.elapsedMs,
    error: result.error,
    timedOut: result.timedOut,
  });
}

// ---------- snapshot helpers ------------------------------------------------

/** snapshot ルートから `_scripts` を取得。存在しない or 壊れていたら []。 */
export function readScripts(snapshotJson: string | null): ScriptEntry[] {
  if (!snapshotJson) return [];
  try {
    const obj = JSON.parse(snapshotJson) as ScriptsSnapshot;
    const arr = obj._scripts;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is ScriptEntry =>
        !!e &&
        typeof e.id === "string" &&
        typeof e.name === "string" &&
        typeof e.source === "string" &&
        typeof e.lastModified === "number",
    );
  } catch {
    return [];
  }
}

/** snapshot ルートに `_scripts` を書き戻す。元の JSON を壊さない。 */
export function writeScripts(
  snapshotJson: string | null,
  scripts: ScriptEntry[],
): string {
  let obj: Record<string, unknown> = {};
  if (snapshotJson) {
    try {
      const parsed = JSON.parse(snapshotJson);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      // 破損した JSON は捨てて新規に書き直す。
    }
  }
  obj._scripts = scripts;
  return JSON.stringify(obj);
}

export function generateScriptId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  return `script-${t}-${r}`;
}

export function createDefaultScript(): ScriptEntry {
  return {
    id: generateScriptId(),
    name: "新しいスクリプト",
    source:
      "// アクティブシートの A1 を読み書きするサンプル\n" +
      "const name = api.getActiveSheet();\n" +
      "api.log('Active sheet:', name);\n" +
      "const values = api.getSheetValues(name, 'A1:B2');\n" +
      "api.log('Values:', values);\n" +
      "// api.setSheetValue(name, 'A1', 'Hello from script');\n" +
      "\n" +
      "// トリガー登録の例:\n" +
      "// Coco.onOpen(() => api.log('ブックを開きました'));\n" +
      "// Coco.onEdit((e) => api.log('編集:', e.a1, e.value));\n" +
      "// Coco.addMenuItem('挨拶', () => api.log('Hello!'));\n",
    lastModified: Date.now(),
  };
}
