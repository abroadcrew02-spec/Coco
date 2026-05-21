import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// `listen` registers an event handler and returns an unlisten fn. The mock
// captures the latest registered handler so streaming tests can drive events.
let lastEventHandler:
  | ((event: { payload: unknown }) => void)
  | null = null;
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: unknown }) => void) => {
      lastEventHandler = handler;
      return unlistenSpy;
    },
  ),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  httpFetch,
  serializeAllowedDomains,
  parseAllowedDomains,
  isLikelyValidDomainPattern,
  setUrlFetchCredential,
  deleteUrlFetchCredential,
  listUrlFetchCredentials,
  isValidCredentialInput,
  streamFetch,
  cancelStreamFetch,
  type UrlFetchCredentialInput,
  type HttpFetchChunkEvent,
} from "./urlFetch";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** Push a `http-fetch-chunk` event into the last-registered `listen` handler. */
function emitChunk(ev: HttpFetchChunkEvent): void {
  if (!lastEventHandler) throw new Error("no event handler registered");
  lastEventHandler({ payload: ev });
}

describe("httpFetch", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("defaults to GET and forwards null for missing optional fields", async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 200, headers: {}, body: "" });
    await httpFetch({ url: "https://example.com" });
    expect(mockedInvoke).toHaveBeenCalledWith("http_fetch", {
      url: "https://example.com",
      method: "GET",
      headers: null,
      body: null,
    });
  });

  it("forwards method, headers and body when provided", async () => {
    mockedInvoke.mockResolvedValueOnce({
      status: 201,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const r = await httpFetch({
      url: "https://api.example.com/x",
      method: "POST",
      headers: { Authorization: "Bearer xxx" },
      body: '{"a":1}',
    });
    expect(r.status).toBe(201);
    expect(mockedInvoke).toHaveBeenCalledWith("http_fetch", {
      url: "https://api.example.com/x",
      method: "POST",
      headers: { Authorization: "Bearer xxx" },
      body: '{"a":1}',
    });
  });

  it("propagates the opaque error tag from Rust", async () => {
    mockedInvoke.mockRejectedValueOnce("URL_FETCH_NOT_ALLOWED");
    await expect(httpFetch({ url: "https://evil.com" })).rejects.toBe(
      "URL_FETCH_NOT_ALLOWED",
    );
  });
});

describe("serializeAllowedDomains / parseAllowedDomains", () => {
  it("trims, lower-cases, dedupes and drops blanks on serialize", () => {
    const raw = serializeAllowedDomains([
      "  Example.com ",
      "example.com",
      "",
      "API.foo.io",
    ]);
    expect(JSON.parse(raw)).toEqual(["example.com", "api.foo.io"]);
  });

  it("round-trips a clean list", () => {
    const json = serializeAllowedDomains(["a.com", "*.b.com"]);
    expect(parseAllowedDomains(json)).toEqual(["a.com", "*.b.com"]);
  });

  it("returns [] for null / empty / invalid JSON / non-array", () => {
    expect(parseAllowedDomains(null)).toEqual([]);
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains("")).toEqual([]);
    expect(parseAllowedDomains("not-json")).toEqual([]);
    expect(parseAllowedDomains('{"x":1}')).toEqual([]);
    expect(parseAllowedDomains('["a", 5, ""]')).toEqual(["a"]);
  });
});

describe("isLikelyValidDomainPattern", () => {
  it("accepts plain hostnames and wildcards", () => {
    expect(isLikelyValidDomainPattern("example.com")).toBe(true);
    expect(isLikelyValidDomainPattern("api.example.com")).toBe(true);
    expect(isLikelyValidDomainPattern("*.example.com")).toBe(true);
    expect(isLikelyValidDomainPattern(" Example.COM ")).toBe(true);
  });

  it("rejects SSRF-prone patterns and bad shapes", () => {
    for (const p of [
      "",
      "localhost",
      "service.local",
      "host.internal",
      "*",
      "127.0.0.1",
      "[::1]",
      "https://example.com",
      "example.com/path",
      "example.com:8080",
      "spaces in here",
      "no-tld",
    ]) {
      expect(isLikelyValidDomainPattern(p)).toBe(false);
    }
  });
});

describe("UrlFetch credentials (#180)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("setUrlFetchCredential forwards the credential to Rust", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const cred: UrlFetchCredentialInput = {
      host: "api.example.com",
      kind: "bearer",
      secret: "tok-123",
    };
    await setUrlFetchCredential(cred);
    expect(mockedInvoke).toHaveBeenCalledWith("url_fetch_set_credential", {
      credential: cred,
    });
  });

  it("deleteUrlFetchCredential forwards the host", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await deleteUrlFetchCredential("api.example.com");
    expect(mockedInvoke).toHaveBeenCalledWith("url_fetch_delete_credential", {
      host: "api.example.com",
    });
  });

  it("listUrlFetchCredentials returns masked summaries without secrets", async () => {
    mockedInvoke.mockResolvedValueOnce([
      {
        host: "api.example.com",
        kind: "bearer",
        headerName: null,
        tokenUrl: null,
        clientId: null,
        scope: null,
        configured: true,
      },
    ]);
    const list = await listUrlFetchCredentials();
    expect(list).toHaveLength(1);
    expect(list[0].configured).toBe(true);
    // The summary type has no `secret` field — confirm none is present.
    expect("secret" in list[0]).toBe(false);
    expect(Object.keys(list[0])).not.toContain("secret");
  });

  it("propagates the opaque credential error tag", async () => {
    mockedInvoke.mockRejectedValueOnce("URL_FETCH_CRED_STORE_FAILED");
    await expect(
      setUrlFetchCredential({
        host: "api.example.com",
        kind: "bearer",
        secret: "x",
      }),
    ).rejects.toBe("URL_FETCH_CRED_STORE_FAILED");
  });
});

describe("isValidCredentialInput", () => {
  it("accepts a well-formed Bearer credential", () => {
    expect(
      isValidCredentialInput({
        host: "api.example.com",
        kind: "bearer",
        secret: "tok",
      }),
    ).toBe(true);
  });

  it("rejects bad host, empty secret", () => {
    expect(
      isValidCredentialInput({ host: "localhost", kind: "bearer", secret: "t" }),
    ).toBe(false);
    expect(
      isValidCredentialInput({
        host: "api.example.com",
        kind: "bearer",
        secret: "   ",
      }),
    ).toBe(false);
  });

  it("requires token URL and client id for OAuth", () => {
    expect(
      isValidCredentialInput({
        host: "api.example.com",
        kind: "oauth_client_credentials",
        secret: "client-secret",
      }),
    ).toBe(false);
    expect(
      isValidCredentialInput({
        host: "api.example.com",
        kind: "oauth_client_credentials",
        secret: "client-secret",
        tokenUrl: "https://auth.example.com/token",
        clientId: "cid",
      }),
    ).toBe(true);
  });
});

describe("streamFetch (#181)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    unlistenSpy.mockReset();
    lastEventHandler = null;
  });

  /** base64 of the ASCII bytes of `s`. */
  const b64 = (s: string): string =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  it("starts the stream with method/headers/body and returns a handle", async () => {
    mockedInvoke.mockResolvedValueOnce(7);
    const handle = await streamFetch({
      url: "https://api.example.com/big",
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "{}",
    });
    expect(handle.requestId).toBe(7);
    expect(mockedInvoke).toHaveBeenCalledWith("http_fetch_stream", {
      url: "https://api.example.com/big",
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "{}",
    });
  });

  it("decodes chunks in order and fires onDone on the terminal event", async () => {
    mockedInvoke.mockResolvedValueOnce(1);
    const chunks: string[] = [];
    let doneTotal = -1;
    await streamFetch(
      { url: "https://api.example.com/x" },
      {
        onChunk: (c) => chunks.push(new TextDecoder().decode(c.bytes)),
        onDone: (received) => {
          doneTotal = received;
        },
      },
    );
    emitChunk({
      requestId: 1,
      status: 200,
      headers: { "content-type": "text/plain" },
      chunk: b64("hello "),
      received: 6,
      done: false,
    });
    emitChunk({ requestId: 1, chunk: b64("world"), received: 11, done: false });
    emitChunk({ requestId: 1, chunk: "", received: 11, done: true });

    expect(chunks).toEqual(["hello ", "world"]);
    expect(doneTotal).toBe(11);
    // The terminal event tears the listener down.
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores events addressed to a different requestId", async () => {
    mockedInvoke.mockResolvedValueOnce(2);
    const chunks: string[] = [];
    await streamFetch(
      { url: "https://api.example.com/x" },
      { onChunk: (c) => chunks.push(new TextDecoder().decode(c.bytes)) },
    );
    emitChunk({ requestId: 999, chunk: b64("nope"), received: 4, done: false });
    emitChunk({ requestId: 2, chunk: b64("yes"), received: 3, done: false });
    expect(chunks).toEqual(["yes"]);
  });

  it("routes a mid-stream cap-exceeded error to onError", async () => {
    mockedInvoke.mockResolvedValueOnce(3);
    let errTag = "";
    let errReceived = -1;
    await streamFetch(
      { url: "https://api.example.com/huge" },
      {
        onError: (tag, received) => {
          errTag = tag;
          errReceived = received;
        },
      },
    );
    emitChunk({ requestId: 3, chunk: b64("partial"), received: 7, done: false });
    emitChunk({
      requestId: 3,
      chunk: "",
      received: 7,
      done: true,
      error: "URL_FETCH_RESPONSE_TOO_LARGE",
    });
    expect(errTag).toBe("URL_FETCH_RESPONSE_TOO_LARGE");
    expect(errReceived).toBe(7);
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });

  it("cancel() forwards the requestId to http_fetch_cancel", async () => {
    mockedInvoke.mockResolvedValueOnce(5); // http_fetch_stream
    const handle = await streamFetch({ url: "https://api.example.com/x" });
    mockedInvoke.mockResolvedValueOnce(true); // http_fetch_cancel
    await handle.cancel();
    expect(mockedInvoke).toHaveBeenLastCalledWith("http_fetch_cancel", {
      requestId: 5,
    });
  });

  it("ignores events that arrive after the terminal event", async () => {
    mockedInvoke.mockResolvedValueOnce(6);
    const chunks: string[] = [];
    await streamFetch(
      { url: "https://api.example.com/x" },
      { onChunk: (c) => chunks.push(new TextDecoder().decode(c.bytes)) },
    );
    emitChunk({ requestId: 6, chunk: "", received: 0, done: true });
    emitChunk({ requestId: 6, chunk: b64("late"), received: 4, done: false });
    expect(chunks).toEqual([]);
  });

  it("tears the listener down if the command rejects up front", async () => {
    mockedInvoke.mockRejectedValueOnce("URL_FETCH_NOT_ALLOWED");
    await expect(
      streamFetch({ url: "https://evil.com" }),
    ).rejects.toBe("URL_FETCH_NOT_ALLOWED");
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });

  it("cancelStreamFetch forwards the id and returns the Rust result", async () => {
    mockedInvoke.mockResolvedValueOnce(false);
    const ok = await cancelStreamFetch(42);
    expect(ok).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith("http_fetch_cancel", {
      requestId: 42,
    });
  });
});
