import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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
  type UrlFetchCredentialInput,
} from "./urlFetch";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

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
