// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import ScriptTrustBanner, { type ScriptTrustBannerProps } from "./ScriptTrustBanner";
import {
  computeActiveContent,
  createMemoryTrustPersistence,
  createScriptTrustStore,
  type ActiveContent,
  type TrustState,
} from "../store/scriptTrust";
import {
  SCRIPT_TRUST_NOTICE_SEEN_KEY,
  resetScriptTrustFirstRunNoticeForTests,
} from "../store/scriptTrustNotice";
import { useScriptTrustGate } from "../hooks/useScriptTrustGate";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { checkGrant } from "../store/scriptGrant";

const SRC = "api.log('banner');";

function snap(sources: string[]) {
  return JSON.stringify({
    sheets: { s1: { cellData: {} } },
    _scripts: sources.map((source, i) => ({ id: `s${i}`, name: `s${i}`, source, lastModified: 1 })),
  });
}

let content: ActiveContent;

type Gate = ScriptTrustBannerProps["gate"];

function makeGate(overrides: Partial<Gate> = {}, sessionKey = "sess-1"): Gate {
  return {
    state: { kind: "untrusted", reason: "new", canAlways: true },
    content,
    subject: { sessionKey, path: "C:\\b\\book.coco", lookupPath: null },
    allowOnce: vi.fn(async () => {}),
    allowAlways: vi.fn(async () => ({ degraded: false })),
    ...overrides,
  };
}

beforeEach(async () => {
  localStorage.setItem("coco.locale", "ja-JP");
  invokeMock.mockReset();
  // First-run notice already seen unless a test says otherwise.
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_setting" ? "true" : undefined));
  resetScriptTrustFirstRunNoticeForTests();
  content = await computeActiveContent(snap([SRC, "api.log(2)"]));
});

afterEach(() => cleanup());

describe("ScriptTrustBanner", () => {
  it.each<TrustState>([
    { kind: "none" },
    { kind: "evaluating" },
    { kind: "trusted", scope: "session" },
    { kind: "trusted", scope: "always" },
    { kind: "trusted", scope: "self" },
  ])("renders nothing for %o", (state) => {
    const { container } = render(<ScriptTrustBanner gate={makeGate({ state })} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the message and counts without taking focus", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    render(<ScriptTrustBanner gate={makeGate()} />);
    expect(screen.getByRole("region", { name: "自動で動く内容の確認" })).toBeTruthy();
    expect(screen.getByText("このブックには自動で動く内容があります")).toBeTruthy();
    expect(screen.getByText("スクリプト 2 件・自動更新 0 件があります")).toBeTruthy();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("reveals both choices and the caution, then allows once", async () => {
    const user = userEvent.setup();
    const gate = makeGate();
    render(<ScriptTrustBanner gate={gate} />);
    const enable = screen.getByRole("button", { name: "有効にする" });
    expect(enable.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group")).toBeNull();

    await user.click(enable);
    expect(enable.getAttribute("aria-expanded")).toBe("true");
    const group = screen.getByRole("group", { name: "有効にする範囲" });
    expect(enable.getAttribute("aria-controls")).toBe(group.id);
    expect(screen.getByText(/閉じるまでの間だけ/)).toBeTruthy();
    expect(screen.getByText(/このファイルのこの内容に限り/)).toBeTruthy();
    expect(screen.getByText(/外部との通信や、保存済みの資格情報/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "今回だけ有効にする" }));
    expect(gate.allowOnce).toHaveBeenCalledTimes(1);
    expect(gate.allowAlways).not.toHaveBeenCalled();
  });

  it("shows the trust-the-author hint right after the caution, described by both choices", async () => {
    const user = userEvent.setup();
    render(<ScriptTrustBanner gate={makeGate({ state: { kind: "untrusted", reason: "new", canAlways: false } })} />);
    expect(screen.queryByText("作成元を信頼できるブックだけ有効にしてください")).toBeNull();
    await user.click(screen.getByRole("button", { name: "有効にする" }));

    const hint = screen.getByText("作成元を信頼できるブックだけ有効にしてください");
    const caution = screen.getByText(/外部との通信や、保存済みの資格情報/);
    expect(hint.className).toBe(caution.className);
    expect(caution.nextElementSibling).toBe(hint);
    for (const name of ["今回だけ有効にする", "このブックを常に信頼する"]) {
      const ids = screen.getByRole("button", { name }).getAttribute("aria-describedby")!.split(" ");
      expect(ids).toContain(caution.id);
      expect(ids).toContain(hint.id);
    }
  });

  it("always trust calls allowAlways when the workbook has a path", async () => {
    const user = userEvent.setup();
    const gate = makeGate();
    render(<ScriptTrustBanner gate={gate} />);
    await user.click(screen.getByRole("button", { name: "有効にする" }));
    const always = screen.getByRole("button", { name: "このブックを常に信頼する" });
    expect(always.getAttribute("aria-disabled")).toBeNull();
    await user.click(always);
    expect(gate.allowAlways).toHaveBeenCalledTimes(1);
  });

  it("offers only 'this session' without a saved path (tooltip + visible reason)", async () => {
    const user = userEvent.setup();
    const gate = makeGate({ state: { kind: "untrusted", reason: "new", canAlways: false } });
    render(<ScriptTrustBanner gate={gate} />);
    await user.click(screen.getByRole("button", { name: "有効にする" }));
    const always = screen.getByRole("button", { name: "このブックを常に信頼する" });
    expect(always.getAttribute("aria-disabled")).toBe("true");
    expect(always.getAttribute("title")).toBe("保存前のブックはファイルを特定できないため、常に信頼できません");
    expect(always.getAttribute("aria-describedby")).toMatch(/always-hint/);
    await user.click(always);
    expect(gate.allowAlways).not.toHaveBeenCalled();
    // Still reachable by keyboard.
    always.focus();
    expect(document.activeElement).toBe(always);
  });

  it("says the content changed when a record exists for another fingerprint", () => {
    render(<ScriptTrustBanner gate={makeGate({ state: { kind: "untrusted", reason: "changed", canAlways: true } })} />);
    expect(screen.getByText("前回信頼した時から内容が変わったため、もう一度確認しています")).toBeTruthy();
  });

  it("dismiss hides the banner for this session only; nothing is allowed", async () => {
    const user = userEvent.setup();
    const gate = makeGate();
    const { rerender, container } = render(<ScriptTrustBanner gate={gate} />);
    await user.click(screen.getByRole("button", { name: "このバナーを閉じる" }));
    expect(container.innerHTML).toBe("");
    expect(gate.allowOnce).not.toHaveBeenCalled();
    expect(gate.allowAlways).not.toHaveBeenCalled();

    rerender(<ScriptTrustBanner gate={{ ...gate }} />);
    expect(container.innerHTML).toBe("");

    rerender(<ScriptTrustBanner gate={makeGate({}, "sess-2")} />);
    expect(screen.getByText("このブックには自動で動く内容があります")).toBeTruthy();
  });

  it("shows an error instead of closing quietly when allowing fails", async () => {
    const user = userEvent.setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = makeGate({
      allowOnce: vi.fn(async () => {
        throw new Error("The document session has ended");
      }),
      allowAlways: vi.fn(async () => {
        throw new Error("Always-trust requires a saved file path");
      }),
    });
    render(<ScriptTrustBanner gate={gate} />);
    await user.click(screen.getByRole("button", { name: "有効にする" }));
    await user.click(screen.getByRole("button", { name: "今回だけ有効にする" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "有効にできませんでした。ブックを開き直してから、もう一度お試しください",
    );
    await user.click(screen.getByRole("button", { name: "このブックを常に信頼する" }));
    await waitFor(() => expect(gate.allowAlways).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("このブックには自動で動く内容があります")).toBeTruthy();
    warn.mockRestore();
  });

  it("reports a failed save of 'always' through onNotice", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const gate = makeGate({ allowAlways: vi.fn(async () => ({ degraded: true })) });
    render(<ScriptTrustBanner gate={gate} onNotice={onNotice} />);
    await user.click(screen.getByRole("button", { name: "有効にする" }));
    await user.click(screen.getByRole("button", { name: "このブックを常に信頼する" }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "今回だけ有効にしました。設定を保存できなかったため、次に開いた時にもう一度確認します",
      ),
    );
  });

  it("asks to reopen instead of offering to enable when evaluation failed", () => {
    render(
      <ScriptTrustBanner
        gate={makeGate({ content: null, state: { kind: "untrusted", reason: "new", canAlways: false } })}
      />,
    );
    expect(screen.getByText(/確認できなかったため、止めたままにしています/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "有効にする" })).toBeNull();
    expect(screen.getByRole("button", { name: "このバナーを閉じる" })).toBeTruthy();
  });

  it("works from the keyboard: Tab to enable, Enter, Tab to a choice, Space", async () => {
    const user = userEvent.setup();
    const gate = makeGate();
    render(<ScriptTrustBanner gate={gate} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "有効にする" }));
    await user.keyboard("{Enter}");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "今回だけ有効にする" }));
    await user.keyboard(" ");
    expect(gate.allowOnce).toHaveBeenCalledTimes(1);
  });

  it("shows the first-run notice once and stores it as seen", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_setting" ? null : undefined));
    const { unmount } = render(<ScriptTrustBanner gate={makeGate({}, "first-a")} />);
    expect(
      await screen.findByText("このバージョンから、開いただけではスクリプトは実行されません"),
    ).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("set_setting", {
      key: SCRIPT_TRUST_NOTICE_SEEN_KEY,
      value: "true",
    });
    unmount();

    render(<ScriptTrustBanner gate={makeGate({}, "first-b")} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/このバージョンから/)).toBeNull();
  });

  it("does not show the first-run notice when it was already seen", async () => {
    render(<ScriptTrustBanner gate={makeGate({}, "seen")} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/このバージョンから/)).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("set_setting", expect.anything());
  });
});

describe("ScriptTrustBanner with the real trust gate", () => {
  function Harness({ store }: { store: ReturnType<typeof createScriptTrustStore> }) {
    const gate = useScriptTrustGate(store);
    return (
      <>
        <ScriptTrustBanner gate={gate} />
        <output data-testid="grant">{gate.grant ? "granted" : "none"}</output>
      </>
    );
  }

  it("untrusted → 今回だけ → banner gone and a grant for the source", async () => {
    const user = userEvent.setup();
    const store = createScriptTrustStore(createMemoryTrustPersistence());
    const json = snap([SRC]);
    useWorkbookStore.setState({
      docSessionKey: "real-1",
      trustLookupPath: null,
      currentHandle: {
        workbookId: "wb",
        path: null,
        sourceType: "coco",
        snapshotJson: json,
        requiresSaveAsOnFirstSave: false,
      },
      currentSnapshotJson: json,
    });
    render(<Harness store={store} />);
    await user.click(await screen.findByRole("button", { name: "有効にする" }));
    // Template / unsaved workbook: only "this session".
    expect(
      screen.getByRole("button", { name: "このブックを常に信頼する" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "今回だけ有効にする" }));
    await waitFor(() => expect(screen.getByTestId("grant").textContent).toBe("granted"));
    expect(screen.queryByRole("region", { name: "自動で動く内容の確認" })).toBeNull();

    const evaluation = await store.evaluate(
      { sessionKey: "real-1", path: null, lookupPath: null },
      json,
    );
    expect(checkGrant(evaluation.grant, SRC).ok).toBe(true);
  });
});
