// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup, configure } from "@testing-library/react";

// Each evaluation hashes the snapshot with Web Crypto and the hook re-runs it
// on every store change; under a loaded machine (full suite, parallel cargo
// build) the default 1 s waitFor budget is not enough.
configure({ asyncUtilTimeout: 5000 });

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { useScriptTrustGate } from "./useScriptTrustGate";
import { useWorkbookStore } from "../store/useWorkbookStore";
import {
  createMemoryTrustPersistence,
  createScriptTrustStore,
  type ScriptTrustStore,
} from "../store/scriptTrust";
import { checkGrant } from "../store/scriptGrant";

const SRC = "api.log('hook');";

function snap(sources: string[], cell = "x") {
  return JSON.stringify({
    sheets: { s1: { cellData: { 0: { 0: { v: cell } } } } },
    _scripts: sources.map((source, i) => ({ id: `s${i}`, name: `s${i}`, source, lastModified: 1 })),
  });
}

function openDoc(key: string, snapshotJson: string, path: string | null = "C:\\b\\book.coco") {
  act(() => {
    useWorkbookStore.setState({
      docSessionKey: key,
      trustLookupPath: null,
      currentHandle: {
        workbookId: "wb",
        path,
        sourceType: "coco",
        snapshotJson,
        requiresSaveAsOnFirstSave: false,
      },
      currentSnapshotJson: snapshotJson,
    });
  });
}

let store: ScriptTrustStore;

beforeEach(() => {
  store = createScriptTrustStore(createMemoryTrustPersistence());
  useWorkbookStore.setState({
    docSessionKey: null,
    trustLookupPath: null,
    currentHandle: null,
    currentSnapshotJson: null,
  });
});

afterEach(() => cleanup());

describe("useScriptTrustGate", () => {
  it("reports none and no grant without a document", () => {
    const { result } = renderHook(() => useScriptTrustGate(store));
    expect(result.current.state).toEqual({ kind: "none" });
    expect(result.current.grant).toBeNull();
  });

  it("starts untrusted, grants after allowOnce, keeps the grant across cell edits", async () => {
    openDoc("hook-1", snap([SRC]));
    const { result } = renderHook(() => useScriptTrustGate(store));
    await waitFor(() => expect(result.current.state.kind).toBe("untrusted"));
    expect(result.current.grant).toBeNull();

    await act(async () => {
      await result.current.allowOnce();
    });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "trusted", scope: "session" }));
    const grant = result.current.grant;
    expect(checkGrant(grant, SRC).ok).toBe(true);

    // A cell edit changes the snapshot but not the active content: once the
    // re-evaluation has settled, the very same grant object is still in use.
    const evaluate = store.evaluate;
    let settled = 0;
    store.evaluate = async (...args) => {
      try {
        return await evaluate(...args);
      } finally {
        settled += 1;
      }
    };
    act(() => {
      useWorkbookStore.setState({ currentSnapshotJson: snap([SRC], "edited") });
    });
    expect(result.current.grant).toBe(grant); // kept while evaluating
    await waitFor(() => expect(settled).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.grant).toBe(grant);
  });

  it("drops the grant immediately when the document session changes", async () => {
    openDoc("hook-2", snap([SRC]));
    const { result } = renderHook(() => useScriptTrustGate(store));
    await waitFor(() => expect(result.current.state.kind).toBe("untrusted"));
    await act(async () => {
      await result.current.allowOnce();
    });
    await waitFor(() => expect(result.current.grant).not.toBeNull());

    openDoc("hook-3", snap([SRC]));
    // Same render as the key change: no grant from the previous document.
    expect(result.current.grant).toBeNull();
    await waitFor(() => expect(result.current.state.kind).toBe("untrusted"));
    expect(result.current.grant).toBeNull();
  });

  it("promotes an in-app edit of a trusted document to self", async () => {
    const first = snap([SRC]);
    openDoc("hook-4", first);
    const { result } = renderHook(() => useScriptTrustGate(store));
    await waitFor(() => expect(result.current.state.kind).toBe("untrusted"));
    await act(async () => {
      await result.current.allowOnce();
    });
    await waitFor(() => expect(result.current.grant).not.toBeNull());

    const edited = snap(["api.log('edited in app');"]);
    await act(async () => {
      void result.current.adoptLocalEdit(first, edited);
      useWorkbookStore.setState({ currentSnapshotJson: edited });
    });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "trusted", scope: "self" }));
    expect(checkGrant(result.current.grant, "api.log('edited in app');").ok).toBe(true);
  });

  it("falls back to untrusted when the always record is revoked", async () => {
    openDoc("hook-5", snap([SRC]));
    const { result } = renderHook(() => useScriptTrustGate(store));
    await waitFor(() => expect(result.current.state.kind).toBe("untrusted"));
    await act(async () => {
      await result.current.allowAlways();
    });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "trusted", scope: "always" }));
    const grant = result.current.grant;

    await act(async () => {
      await store.revoke("C:\\b\\book.coco");
    });
    await waitFor(() => expect(result.current.state.kind).toBe("untrusted"));
    expect(result.current.grant).toBeNull();
    expect(checkGrant(grant, SRC).ok).toBe(false);
  });
});
