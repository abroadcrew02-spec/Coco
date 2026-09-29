// @vitest-environment happy-dom
//
// #355 — the trust gate in runScript. A call without a live grant covering the
// exact source must not create a sandbox iframe, call an executor, start the
// watchdog, write logs or evaluate anything. The positive controls show the
// same detectors do see an iframe / an evaluation when the grant is right.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as runtime from "./scriptRuntime";
import {
  collectTriggers,
  fireTrigger,
  runScript,
  inlineExecutor,
  SCRIPT_NOT_TRUSTED,
  type ScriptEntry,
  type ScriptExecutor,
} from "./scriptRuntime";
import {
  issueGrant,
  revokeSessionGrants,
  type ScriptExecutionGrant,
} from "./scriptGrant";

const EVAL_FLAG = "__evaluated";
const SOURCE = `globalThis.${EVAL_FLAG} = true; Nicel.onOpen(() => { globalThis.${EVAL_FLAG} = true; });`;

const entry: ScriptEntry = { id: "s1", name: "s1", source: SOURCE, lastModified: 0 };

let seq = 0;
function grantFor(...sources: string[]): ScriptExecutionGrant {
  return issueGrant(`gate-test-${++seq}`, "sha256:gate", "session", {
    sources,
    connectionSignatures: [],
  });
}

type BadGrantCase = { name: string; make: () => unknown };

const badGrants: BadGrantCase[] = [
  { name: "missing", make: () => null },
  {
    name: "forged",
    make: () => ({
      __brand: "ScriptExecutionGrant",
      sessionKey: "gate-forged",
      fingerprint: "sha256:gate",
      scope: "always",
    }),
  },
  {
    name: "revoked",
    make: () => {
      const key = `gate-revoked-${++seq}`;
      const g = issueGrant(key, "sha256:gate", "session", {
        sources: [SOURCE],
        connectionSignatures: [],
      });
      revokeSessionGrants(key);
      return g;
    },
  },
  { name: "source-mismatch", make: () => grantFor("api.log('something else');") },
];

function iframeCreations(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((c) => String(c[0]).toLowerCase() === "iframe").length;
}

function spyExecutor(): { executor: ScriptExecutor; calls: number } {
  const state = { executor: null as unknown as ScriptExecutor, calls: 0 };
  state.executor = {
    async execute() {
      state.calls += 1;
      (globalThis as Record<string, unknown>)[EVAL_FLAG] = true;
      return { returnValue: undefined, triggers: [] };
    },
  };
  return state;
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[EVAL_FLAG];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("about:blank");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>)[EVAL_FLAG];
});

describe.each(badGrants)("untrusted call ($name) has no side effects", ({ make }) => {
  it("runScript: no iframe, no executor, no timer, no evaluation", async () => {
    const createSpy = vi.spyOn(document, "createElement");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const spy = spyExecutor();

    const pending = runScript(SOURCE, { grant: make() as ScriptExecutionGrant | null });
    // Refused synchronously: nothing was created before the first await.
    expect(iframeCreations(createSpy)).toBe(0);
    const r = await pending;

    expect(r.ok).toBe(false);
    expect(r.error).toBe(SCRIPT_NOT_TRUSTED);
    expect(r.logs).toEqual([]);
    expect(iframeCreations(createSpy)).toBe(0);
    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect(timeoutSpy).not.toHaveBeenCalled();

    const viaExecutor = await runScript(SOURCE, {
      grant: make() as ScriptExecutionGrant | null,
      executor: spy.executor,
    });
    expect(viaExecutor.error).toBe(SCRIPT_NOT_TRUSTED);
    expect(spy.calls).toBe(0);

    const viaInline = await runScript(SOURCE, {
      grant: make() as ScriptExecutionGrant | null,
      executor: inlineExecutor,
    });
    expect(viaInline.error).toBe(SCRIPT_NOT_TRUSTED);

    const viaFactory = await runScript(SOURCE, {
      grant: make() as ScriptExecutionGrant | null,
      factory: () => () => {
        (globalThis as Record<string, unknown>)[EVAL_FLAG] = true;
      },
    });
    expect(viaFactory.error).toBe(SCRIPT_NOT_TRUSTED);
    expect((globalThis as Record<string, unknown>)[EVAL_FLAG]).toBeUndefined();
  });

  it("collectTriggers: no iframe, empty trigger list", async () => {
    const createSpy = vi.spyOn(document, "createElement");
    const pending = collectTriggers(entry, { grant: make() as ScriptExecutionGrant | null });
    expect(iframeCreations(createSpy)).toBe(0);
    const out = await pending;
    expect(out.triggers).toEqual([]);
    expect(iframeCreations(createSpy)).toBe(0);
    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect((globalThis as Record<string, unknown>)[EVAL_FLAG]).toBeUndefined();
  });

  it("fireTrigger: no iframe, no executor (injected or inline), no evaluation", async () => {
    const createSpy = vi.spyOn(document, "createElement");
    const spy = spyExecutor();

    const viaIframe = await fireTrigger(entry, "onOpen", {
      grant: make() as ScriptExecutionGrant | null,
      timeoutMs: 50,
    });
    const viaExecutor = await fireTrigger(entry, "onOpen", {
      grant: make() as ScriptExecutionGrant | null,
      executor: spy.executor,
    });
    const viaInline = await fireTrigger(entry, "onOpen", {
      grant: make() as ScriptExecutionGrant | null,
      executor: inlineExecutor,
    });

    for (const r of [viaIframe, viaExecutor, viaInline]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(SCRIPT_NOT_TRUSTED);
    }
    expect(spy.calls).toBe(0);
    expect(iframeCreations(createSpy)).toBe(0);
    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect((globalThis as Record<string, unknown>)[EVAL_FLAG]).toBeUndefined();
  });
});

describe("positive control: a covering grant reaches the executor", () => {
  it("runScript creates exactly one sandbox iframe", async () => {
    const createSpy = vi.spyOn(document, "createElement");
    const pending = runScript(SOURCE, { grant: grantFor(SOURCE), timeoutMs: 50 });
    expect(iframeCreations(createSpy)).toBe(1);
    expect(document.querySelectorAll("iframe[sandbox]").length).toBe(1);
    await pending; // happy-dom never runs the iframe script; the watchdog settles it
    expect(document.querySelectorAll("iframe").length).toBe(0);
  });

  it("fireTrigger creates exactly one sandbox iframe", async () => {
    const createSpy = vi.spyOn(document, "createElement");
    const pending = fireTrigger(entry, "onOpen", { grant: grantFor(SOURCE), timeoutMs: 50 });
    expect(iframeCreations(createSpy)).toBe(1);
    await pending;
  });

  it("collectTriggers creates exactly one sandbox iframe", async () => {
    const createSpy = vi.spyOn(document, "createElement");
    const pending = collectTriggers(entry, { grant: grantFor(SOURCE) });
    expect(iframeCreations(createSpy)).toBe(1);
    await pending; // settles via the fixed 2000 ms list-triggers timeout
  }, 5000);

  it("inline evaluation happens only with the grant", async () => {
    const r = await runScript(SOURCE, { grant: grantFor(SOURCE), executor: inlineExecutor });
    expect(r.ok).toBe(true);
    expect((globalThis as Record<string, unknown>)[EVAL_FLAG]).toBe(true);
  });

  it("injected executor is called with the grant", async () => {
    const spy = spyExecutor();
    await runScript(SOURCE, { grant: grantFor(SOURCE), executor: spy.executor });
    expect(spy.calls).toBe(1);
  });
});

describe("gate details", () => {
  it("fireTrigger's inline path checks the original source, not the prelude-joined text", async () => {
    const onOpen = { ...entry, source: "Nicel.onOpen(() => api.log('opened'));" };
    const ok = await fireTrigger(onOpen, "onOpen", {
      grant: grantFor(onOpen.source),
      executor: inlineExecutor,
    });
    expect(ok.ok).toBe(true);
    expect(ok.logs).toContain("opened");

    const other = await fireTrigger(onOpen, "onOpen", {
      grant: grantFor("Nicel.onOpen(() => api.log('different'));"),
      executor: inlineExecutor,
    });
    expect(other.error).toBe(SCRIPT_NOT_TRUSTED);
  });

  it("does not accept prelude / trailing code through the public options", async () => {
    const src = "api.log('approved');";
    const r = await runScript(src, {
      grant: grantFor(src),
      executor: inlineExecutor,
      // Former public option and the internal one; both must be ignored.
      triggerCall: `globalThis.${EVAL_FLAG} = true;`,
      inlinePrelude: `globalThis.${EVAL_FLAG} = true;`,
    } as unknown as Parameters<typeof runScript>[1]);
    expect(r.ok).toBe(true);
    expect((globalThis as Record<string, unknown>)[EVAL_FLAG]).toBeUndefined();
  });

  it("marks refusals with blockedByGate; a script throwing the same text is not marked (L3)", async () => {
    const refused = await runScript(SOURCE, { grant: null });
    expect(refused.blockedByGate).toBe(true);

    const imitation = `throw new Error(${JSON.stringify(SCRIPT_NOT_TRUSTED)});`;
    const ran = await runScript(imitation, {
      grant: grantFor(imitation),
      executor: inlineExecutor,
    });
    expect(ran.ok).toBe(false);
    expect(ran.error).toBe(SCRIPT_NOT_TRUSTED);
    expect(ran.blockedByGate).not.toBe(true);

    const fired = await fireTrigger(
      { ...entry, source: `Nicel.onOpen(() => { ${imitation} });` },
      "onOpen",
      { grant: grantFor(`Nicel.onOpen(() => { ${imitation} });`), executor: inlineExecutor },
    );
    expect(fired.error).toBe(SCRIPT_NOT_TRUSTED);
    expect(fired.blockedByGate).not.toBe(true);
  });

  it("refuses when options are missing entirely", async () => {
    const r = await (runScript as unknown as (s: string) => ReturnType<typeof runScript>)(SOURCE);
    expect(r.error).toBe(SCRIPT_NOT_TRUSTED);
  });

  it("does not export the iframe executor factory", () => {
    expect("createIframeExecutor" in runtime).toBe(false);
  });
});
