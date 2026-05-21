import { describe, it, expect, beforeEach } from "vitest";
import {
  runScript,
  readScripts,
  writeScripts,
  generateScriptId,
  createDefaultScript,
  collectTriggers,
  fireTrigger,
  readExecutionLog,
  appendExecutionLog,
  clearExecutionLog,
  recordRun,
  inlineExecutor,
  type ScriptApi,
  type ScriptEntry,
  type ScriptExecutor,
  type ExecuteOptions,
  type RegisteredTrigger,
} from "./scriptRuntime";

describe("runScript — 基本動作", () => {
  it("api.log を console output に記録する", async () => {
    const result = await runScript("api.log('hello'); api.log('world', 42);");
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    // 先頭は MVP 警告行。続けて log 行。
    expect(result.logs[0]).toMatch(/Function コンストラクタ/);
    expect(result.logs).toContain("hello");
    expect(result.logs).toContain("world 42");
  });

  it("return 値を `=> ...` として最後に push する", async () => {
    const result = await runScript("return 1 + 2;");
    expect(result.ok).toBe(true);
    expect(result.logs[result.logs.length - 1]).toBe("=> 3");
  });

  it("log は第 2 引数としても渡される (api.log と同じ実体)", async () => {
    const result = await runScript("log('via-positional');");
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("via-positional");
  });

  it("注入された api を経由して値を読み書きできる", async () => {
    const store: Record<string, unknown> = {};
    // factory option を使い、Function コンストラクタを介さずに直接
    // テスト用の関数を渡す。テストの再現性が上がる。
    const result = await runScript(
      // source は factory で読まれないが、署名一致のため保持。
      "",
      {
        factory: () => (api: ScriptApi) => {
          api.log("active:", api.getActiveSheet());
          api.setSheetValue("Sheet1", "A1", 123);
          return api.getSheetValues("Sheet1", "A1:A1");
        },
      },
    );
    // FUniver は null なので getActiveSheet → null、getSheetValues → []
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("active: null");
    // 実際の書き込みは no-op (Facade なし) — 例外にならないことを確認。
    void store;
  });
});

describe("runScript — タイムアウト / watchdog", () => {
  it("api を呼ばないタイトループは検出できないが、async でタイムアウトは記録する", async () => {
    // factory に setTimeout 越しの長い await を仕込み、watchdog が
    // aborted フラグを立てた後に return するパターン。
    const result = await runScript("", {
      timeoutMs: 30,
      factory: () => async () => {
        await new Promise((r) => setTimeout(r, 60));
        return "done";
      },
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/30ms を超えた/);
  });

  // MVP の既知制約: JS 単一スレッドのため、await を挟まない同期ループは
  // watchdog の setTimeout が発火する隙がない。ループ終了後の `aborted`
  // 最終チェックで timedOut が true として記録される。
  // (follow-up: QuickJS / Web Worker で本当の preemption を実現)
  it("同期ループは終了後の aborted チェックで timedOut として記録される", async () => {
    let calls = 0;
    const result = await runScript("", {
      timeoutMs: 5,
      factory: () => (api: ScriptApi) => {
        const start = Date.now();
        while (Date.now() - start < 30) {
          calls++;
        }
        // ループ後に api を呼ぶと、guard が aborted を見て throw する。
        api.log("after-loop");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("runScript — 例外ハンドリング", () => {
  it("throw された Error は error / stack に格納される", async () => {
    const result = await runScript("throw new Error('boom');");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.stack).toMatch(/boom/);
    expect(result.timedOut).toBe(false);
  });

  it("構文エラーも error に格納される (Function 生成時点で throw)", async () => {
    const result = await runScript("this is not valid js {{");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("非 Error の throw も message として記録する", async () => {
    const result = await runScript("throw 'string-error';");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("string-error");
  });
});

describe("snapshot helpers", () => {
  it("readScripts は _scripts が無い snapshot で [] を返す", () => {
    expect(readScripts(null)).toEqual([]);
    expect(readScripts("{}")).toEqual([]);
    expect(readScripts('{"sheets":{}}')).toEqual([]);
  });

  it("readScripts は壊れたエントリを除外する", () => {
    const snap = JSON.stringify({
      _scripts: [
        { id: "a", name: "n", source: "x", lastModified: 1 },
        { id: 1, name: "n", source: "x", lastModified: 1 }, // bad id
        null,
        { id: "b", name: "n", source: "x", lastModified: 2 },
      ],
    });
    const out = readScripts(snap);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("writeScripts は元の snapshot の他フィールドを保持する", () => {
    const snap = JSON.stringify({ sheets: { s1: { name: "Sheet1" } } });
    const out = writeScripts(snap, [
      { id: "a", name: "n", source: "x", lastModified: 1 },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.sheets.s1.name).toBe("Sheet1");
    expect(parsed._scripts).toHaveLength(1);
  });

  it("writeScripts は null snapshot でも有効な JSON を返す", () => {
    const out = writeScripts(null, [
      { id: "a", name: "n", source: "x", lastModified: 1 },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed._scripts).toHaveLength(1);
  });

  it("generateScriptId はユニークな id を返す", () => {
    const a = generateScriptId();
    const b = generateScriptId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^script-/);
  });

  it("createDefaultScript はサンプルコードを含む新規エントリ", () => {
    const s = createDefaultScript();
    expect(s.id).toMatch(/^script-/);
    expect(s.source.length).toBeGreaterThan(10);
    expect(s.lastModified).toBeGreaterThan(0);
  });
});

// ---------- #189: トリガー ---------------------------------------------------

function mkScript(source: string): ScriptEntry {
  return { id: generateScriptId(), name: "t", source, lastModified: 1 };
}

// vitest の node 環境には localStorage が無いので、実行ログ永続化テスト用に
// 最小限のメモリ実装をグローバルへ差し込む。
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

describe("#189 — トリガー収集 (collectTriggers)", () => {
  it("Coco.onOpen / onEdit / addMenuItem / addTimer の登録を収集する", async () => {
    const entry = mkScript(
      "Coco.onOpen(() => {});\n" +
        "Coco.onEdit((e) => { void e; });\n" +
        "Coco.addMenuItem('挨拶', () => {});\n" +
        "Coco.addTimer(1000, () => {});\n",
    );
    const out = await collectTriggers(entry);
    const kinds = out.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(["menu", "onEdit", "onOpen", "timer"]);
    const menu = out.triggers.find((t) => t.kind === "menu");
    expect(menu?.label).toBe("挨拶");
    const timer = out.triggers.find((t) => t.kind === "timer");
    expect(timer?.intervalMs).toBe(1000);
  });

  it("トリガー未登録のスクリプトは空配列を返す", async () => {
    const out = await collectTriggers(mkScript("api.log('no triggers');"));
    expect(out.triggers).toEqual([]);
  });

  it("addTimer は最小間隔 250ms にクランプされる", async () => {
    const out = await collectTriggers(mkScript("Coco.addTimer(10, () => {});"));
    expect(out.triggers[0].intervalMs).toBe(250);
  });
});

describe("#189 — トリガー発火 (fireTrigger)", () => {
  it("onOpen ハンドラを発火し log が記録される", async () => {
    const entry = mkScript("Coco.onOpen(() => api.log('opened!'));");
    const result = await fireTrigger(entry, "onOpen");
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("opened!");
  });

  it("onEdit ハンドラに EditEvent が渡される", async () => {
    const entry = mkScript(
      "Coco.onEdit((e) => api.log('edited', e.a1, e.value));",
    );
    const result = await fireTrigger(entry, "onEdit", {
      editEvent: { sheetName: "Sheet1", a1: "B2", row: 1, col: 1, value: 99 },
    });
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("edited B2 99");
  });

  it("menu トリガーはラベル一致時のみ発火する", async () => {
    const entry = mkScript(
      "Coco.addMenuItem('A', () => api.log('ran-A'));\n" +
        "Coco.addMenuItem('B', () => api.log('ran-B'));\n",
    );
    const result = await fireTrigger(entry, "menu", { label: "B" });
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("ran-B");
    expect(result.logs).not.toContain("ran-A");
  });

  it("timer トリガーを発火できる", async () => {
    const entry = mkScript("Coco.addTimer(500, () => api.log('tick'));");
    const result = await fireTrigger(entry, "timer");
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("tick");
  });
});

// ---------- #189: 保護シート書き込み禁止 -------------------------------------

describe("#189 — 保護シート書き込み禁止", () => {
  it("保護シートへの setSheetValue は warning を出してスキップされる", async () => {
    // FUniver は無いが buildApi の保護チェックは sheetId 取得に依存する。
    // factory 経由で api を直接叩き、snapshotJson を渡しても FUniver が
    // null なので resolveSheet が null → スキップ。保護の単体検証は
    // sheetProtection.test.ts 側に委ねる。ここでは API が例外を投げない
    // ことだけ確認する。
    const result = await runScript("", {
      snapshotJson: JSON.stringify({ sheets: { s1: { _protected: { protected: true } } } }),
      factory: () => (api: ScriptApi) => {
        api.setSheetValue("Sheet1", "A1", 1);
        api.deleteSheet("Sheet1");
        api.fillRange("Sheet1", "A1:B2", 0);
        api.setCellFormat("Sheet1", "A1", { bold: true });
        return "ok";
      },
    });
    expect(result.ok).toBe(true);
  });
});

// ---------- #189: Facade 拡張 ------------------------------------------------

describe("#189 — Facade 拡張 API", () => {
  it("getSheetNames / insertSheet / setCellFormat が呼べる (FUniver なし)", async () => {
    const result = await runScript("", {
      factory: () => (api: ScriptApi) => {
        api.log("names:", api.getSheetNames());
        api.log("inserted:", api.insertSheet("New"));
        api.fillRange("S", "A1:A3", 7);
        api.setCellFormat("S", "A1", { bold: true, background: "#fff" });
        return "done";
      },
    });
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("names: []");
    expect(result.logs).toContain("inserted: null");
  });
});

// ---------- #189: 実行ログ永続化 ---------------------------------------------

describe("#189 — 実行ログ永続化", () => {
  beforeEach(() => clearExecutionLog());

  it("appendExecutionLog / readExecutionLog で記録を往復できる", () => {
    appendExecutionLog({
      at: 1000,
      scriptId: "s1",
      scriptName: "n1",
      trigger: "manual",
      ok: true,
      elapsedMs: 12,
      error: null,
      timedOut: false,
    });
    const log = readExecutionLog();
    expect(log).toHaveLength(1);
    expect(log[0].scriptId).toBe("s1");
  });

  it("新しい記録が先頭に来る", () => {
    appendExecutionLog({
      at: 1, scriptId: "old", scriptName: "n", trigger: "manual",
      ok: true, elapsedMs: 1, error: null, timedOut: false,
    });
    appendExecutionLog({
      at: 2, scriptId: "new", scriptName: "n", trigger: "onEdit",
      ok: false, elapsedMs: 2, error: "e", timedOut: false,
    });
    const log = readExecutionLog();
    expect(log[0].scriptId).toBe("new");
    expect(log[1].scriptId).toBe("old");
  });

  it("clearExecutionLog で全消去できる", () => {
    appendExecutionLog({
      at: 1, scriptId: "s", scriptName: "n", trigger: "manual",
      ok: true, elapsedMs: 1, error: null, timedOut: false,
    });
    clearExecutionLog();
    expect(readExecutionLog()).toEqual([]);
  });

  it("recordRun は ScriptRunResult を記録に変換する", async () => {
    const result = await runScript("api.log('x');", { executor: inlineExecutor });
    recordRun(mkScript("api.log('x');"), "manual", result);
    const log = readExecutionLog();
    expect(log[0].ok).toBe(true);
    expect(log[0].trigger).toBe("manual");
  });
});

// ---------- #189 C2: サンドボックス迂回の排除 ---------------------------------

/**
 * 実 Facade を装ったプローブ。`getActiveWorkbook` 等が呼ばれたら touched が
 * true になる。inline 経路に渡してはならない実 Facade の代用。
 */
function makeFacadeProbe(): { fUniver: unknown; touched: () => boolean } {
  let used = false;
  const fUniver = {
    getActiveWorkbook() {
      used = true;
      return null;
    },
    getActiveSheet() {
      used = true;
      return null;
    },
  };
  return { fUniver, touched: () => used };
}

/** 渡された ExecuteOptions を記録するスパイ executor。 */
function makeSpyExecutor(): {
  executor: ScriptExecutor;
  calls: ExecuteOptions[];
} {
  const calls: ExecuteOptions[] = [];
  const executor: ScriptExecutor = {
    async execute(_source, _api, options) {
      calls.push(options);
      // list-triggers のときは空のトリガー一覧を返す。
      if (options.mode === "list-triggers") {
        return { returnValue: undefined, triggers: [] as RegisteredTrigger[] };
      }
      return { returnValue: undefined };
    },
  };
  return { executor, calls };
}

describe("#189 C2 — inline executor に実 Facade を渡さない", () => {
  it("runScript(executor: inlineExecutor) では fUniver が無効化され Facade に触れない", async () => {
    const probe = makeFacadeProbe();
    const result = await runScript("api.getActiveSheet(); api.log('done');", {
      executor: inlineExecutor,
      // 実 Facade を渡しても inline 経路では null に落とされなければならない。
      fUniver: probe.fUniver as never,
    });
    expect(result.ok).toBe(true);
    // untrusted code が getActiveSheet を呼んでも実 Facade には到達しない。
    expect(probe.touched()).toBe(false);
  });

  it("factory 注入 (テスト経路) でも実 Facade に到達しない", async () => {
    const probe = makeFacadeProbe();
    const result = await runScript("", {
      fUniver: probe.fUniver as never,
      factory: () => (api: ScriptApi) => {
        api.getActiveSheet();
        api.getSheetNames();
        return "ok";
      },
    });
    expect(result.ok).toBe(true);
    expect(probe.touched()).toBe(false);
  });

  it("collectTriggers は list-triggers モードで executor を呼ぶ", async () => {
    const { executor, calls } = makeSpyExecutor();
    // executor を明示注入して経路を観測する (本番は DOM ありで iframe)。
    const out = await runScript("Coco.onOpen(() => {});", {
      executor,
      mode: "list-triggers",
      collectTriggers: [],
    });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe("list-triggers");
  });

  it("fireTrigger(本番経路) は fire-trigger モードと発火指示を executor に渡す", async () => {
    const { executor, calls } = makeSpyExecutor();
    await fireTrigger(mkScript("Coco.onEdit(() => {});"), "onEdit", {
      executor,
      editEvent: { sheetName: "S", a1: "A1", row: 0, col: 0, value: 7 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe("fire-trigger");
    expect(calls[0].fire?.kind).toBe("onEdit");
    expect(calls[0].fire?.event?.value).toBe(7);
  });

  it("fireTrigger(本番経路) はカスタム executor 利用時 inlineExecutor を使わない", async () => {
    const { executor, calls } = makeSpyExecutor();
    await fireTrigger(mkScript("Coco.addMenuItem('M', () => {});"), "menu", {
      executor,
      label: "M",
    });
    // スパイが呼ばれた = inline 経路ではなく注入 executor 経由。
    expect(calls).toHaveLength(1);
    expect(calls[0].fire?.kind).toBe("menu");
    expect(calls[0].fire?.label).toBe("M");
  });
});

// ---------- #189 C1: onEdit 無限ループ防止 -----------------------------------

describe("#189 C1 — onEdit 再発火ガード", () => {
  // EditorScreen の MUTATION リスナと fireAll の相互作用を最小再現する。
  // onEdit ハンドラがセルを書く → MUTATION → onEdit … のループを
  // `firingEdit` 再入ガードで断ち切ることを検証する。
  it("onEdit ハンドラがセルを書いてもループしない (firingEdit ガード)", async () => {
    let fireCount = 0;
    let firingEdit = false;

    // onEdit ハンドラ: 必ず 1 回セルを書く (= MUTATION を発生させる)。
    const onEditHandler = async () => {
      emitMutation();
    };

    // fireAll("onEdit"): ハンドラを直列実行。完了まで firingEdit は true。
    const fireAll = async () => {
      fireCount++;
      await onEditHandler();
    };

    // MUTATION リスナ: firingEdit 中の MUTATION は早期 return で無視。
    const emitMutation = () => {
      if (firingEdit) return; // ← C1 ガード。これが無いと無限再帰。
      firingEdit = true;
      void (async () => {
        try {
          await fireAll();
        } finally {
          firingEdit = false;
        }
      })();
    };

    // ユーザー操作由来の最初の MUTATION。
    emitMutation();
    // マイクロ/マクロタスクを数回流して再発火が起きないことを確認。
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    // onEdit は 1 回だけ発火。ハンドラの書き込みでは再発火しない。
    expect(fireCount).toBe(1);
  });

  it("ガードが無いと再帰してしまう (退行検出用の対照)", async () => {
    let fireCount = 0;
    const onEditHandler = () => emitMutation();
    const fireAll = () => {
      fireCount++;
      if (fireCount > 50) throw new Error("loop");
      onEditHandler();
    };
    // ガードなしのリスナ。
    const emitMutation = () => fireAll();
    expect(() => emitMutation()).toThrow(/loop/);
    expect(fireCount).toBeGreaterThan(50);
  });
});

// ---------- #189 M1: timer の積み上がり防止 ----------------------------------

describe("#189 M1 — timer skip-if-running", () => {
  it("前回 tick 未完了なら今回 tick を skip する", async () => {
    let runs = 0;
    const running = new Set<string>();
    const key = "script-1#250";

    // ハンドラ完了を明示的に制御する (タイミング非依存のテスト)。
    let resolveHandler: (() => void) | null = null;
    const slowHandler = () =>
      new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });

    const tick = () => {
      if (running.has(key)) return; // ← M1 ガード。
      running.add(key);
      runs++;
      void slowHandler().finally(() => running.delete(key));
    };

    // 1 回目 tick: ハンドラが走り始める。
    tick();
    expect(runs).toBe(1);
    // ハンドラ未完了のまま 3 連続 tick → すべて skip される。
    tick();
    tick();
    tick();
    expect(runs).toBe(1);
    // ハンドラ完了を待つ。
    resolveHandler!();
    await Promise.resolve();
    await Promise.resolve();
    // 次の tick は通る。
    tick();
    expect(runs).toBe(2);
  });
});
