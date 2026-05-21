// External API connectivity (issue #138).
//
// Thin wrapper around the Tauri `http_fetch` command. The renderer never
// performs HTTP itself — it always routes through Rust so the allow-list
// and SSRF defenses cannot be bypassed by a malicious macro or webview
// content. Errors are returned as opaque tag strings (see http_fetch.rs).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const ALLOWED_DOMAINS_KEY = "urlFetch.allowedDomains";

export type HttpMethod = "GET" | "POST";

export interface HttpFetchRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Perform an HTTP request via the Rust backend.
 *
 * - Only GET and POST are supported (other verbs are rejected by Rust).
 * - URL host must be on the allow list configured in Settings → 許可ドメイン.
 * - 10 MiB cap on request and response bodies; 30 s total timeout.
 * - Redirects are NOT followed; the caller receives the 3xx directly.
 *
 * Throws an `Error` whose `message` is one of the Rust tags
 * (`URL_FETCH_NOT_ALLOWED`, `URL_FETCH_TIMEOUT`, ...) on failure.
 */
export async function httpFetch(
  req: HttpFetchRequest,
): Promise<HttpFetchResponse> {
  const method: HttpMethod = req.method ?? "GET";
  return await invoke<HttpFetchResponse>("http_fetch", {
    url: req.url,
    method,
    headers: req.headers ?? null,
    body: req.body ?? null,
  });
}

/**
 * Serialize a list of allowed-domain patterns to the JSON form persisted
 * under `urlFetch.allowedDomains`. Trims, lower-cases, dedupes, drops blanks.
 */
export function serializeAllowedDomains(lines: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return JSON.stringify(out);
}

/**
 * Parse the stored JSON form into a list of patterns. Tolerant of empty /
 * invalid input (returns []).
 */
export function parseAllowedDomains(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Best-effort client-side validation of a single pattern line. Used only to
 * help the Settings UI surface obvious typos — the Rust side re-validates
 * every request, so a permissive check here is safe.
 */
export function isLikelyValidDomainPattern(pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.includes("/") || p.includes(" ") || p.includes(":")) return false;
  // Disallow obvious SSRF targets in the allow list itself so the UI warns
  // before save. Rust will block these anyway.
  if (
    p === "localhost" ||
    p === "*" ||
    p.endsWith(".local") ||
    p.endsWith(".internal") ||
    p.endsWith(".localhost")
  ) {
    return false;
  }
  // Numeric host (IP literal) — block.
  if (/^[0-9.]+$/.test(p) || p.includes("[")) return false;
  const stripped = p.startsWith("*.") ? p.slice(2) : p;
  // Must look like a dotted hostname.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    stripped,
  );
}

// --- Credential persistence (issue #180) ---------------------------------
//
// Per-host auth credentials are stored by Rust in the OS secure store
// (Windows Credential Manager / macOS Keychain / Linux Secret Service). The
// renderer NEVER receives a stored secret back: the list command returns only
// masked summaries. Secrets only ever travel renderer -> Rust on save.

export type CredentialKind = "bearer" | "api_key" | "oauth_client_credentials";

/** A credential to persist. `secret` is the token / API key / OAuth client secret. */
export interface UrlFetchCredentialInput {
  host: string;
  kind: CredentialKind;
  secret: string;
  /** Header name for `api_key` credentials. Defaults to `Authorization`. */
  headerName?: string;
  /** OAuth token endpoint URL (required for `oauth_client_credentials`). */
  tokenUrl?: string;
  /** OAuth client id (required for `oauth_client_credentials`). */
  clientId?: string;
  /** Optional OAuth scope string. */
  scope?: string;
}

/** Masked summary returned by the list command. Never contains the secret. */
export interface UrlFetchCredentialSummary {
  host: string;
  kind: CredentialKind;
  headerName: string | null;
  tokenUrl: string | null;
  clientId: string | null;
  scope: string | null;
  /** Always true — present so the UI can render a `••••` placeholder. */
  configured: boolean;
}

/**
 * Persist (or replace) a credential for a host pattern. The secret is written
 * to the OS secure store; only non-secret metadata is kept in the app DB.
 *
 * Throws an opaque `URL_FETCH_CRED_*` tag on failure.
 */
export async function setUrlFetchCredential(
  credential: UrlFetchCredentialInput,
): Promise<void> {
  await invoke("url_fetch_set_credential", { credential });
}

/** Remove the stored credential (secret + index entry) for a host pattern. */
export async function deleteUrlFetchCredential(host: string): Promise<void> {
  await invoke("url_fetch_delete_credential", { host });
}

/** List configured credentials as masked summaries (no secret values). */
export async function listUrlFetchCredentials(): Promise<
  UrlFetchCredentialSummary[]
> {
  return await invoke<UrlFetchCredentialSummary[]>(
    "url_fetch_list_credentials",
  );
}

/**
 * Best-effort client-side validation of a credential before save. Rust
 * re-validates, so a permissive check here is safe — it only surfaces obvious
 * mistakes in the Settings UI.
 */
export function isValidCredentialInput(c: UrlFetchCredentialInput): boolean {
  if (!isLikelyValidDomainPattern(c.host)) return false;
  if (!c.secret || c.secret.trim().length === 0) return false;
  if (c.kind === "oauth_client_credentials") {
    if (!c.tokenUrl || !/^https?:\/\//i.test(c.tokenUrl.trim())) return false;
    if (!c.clientId || c.clientId.trim().length === 0) return false;
  }
  return true;
}

// --- Streaming responses (issue #181) ------------------------------------
//
// `httpFetch` buffers the whole response and then checks the 10 MiB cap. For
// large downloads (or progress UIs) `streamFetch` instead reads the body
// chunk-by-chunk: Rust emits `http-fetch-chunk` events and enforces the byte
// cap *mid-stream* so a malicious server cannot exhaust memory. The same
// allow-list / SSRF / header guards apply as for `httpFetch`.

/** Event name Rust emits for every streamed chunk and the terminal marker. */
export const HTTP_FETCH_CHUNK_EVENT = "http-fetch-chunk";

/** Opaque identifier for an in-flight streaming request. */
export type RequestId = number;

/** Payload of a single `http-fetch-chunk` event. */
export interface HttpFetchChunkEvent {
  /** The request this event belongs to. */
  requestId: RequestId;
  /** HTTP status — present only on the first event. */
  status?: number;
  /** Response headers — present only on the first event. */
  headers?: Record<string, string>;
  /** Base64-encoded chunk bytes (empty on the terminal event). */
  chunk: string;
  /** Running total of body bytes received so far. */
  received: number;
  /** True on the final event of the stream. */
  done: boolean;
  /** Opaque error tag (e.g. `URL_FETCH_RESPONSE_TOO_LARGE`) on failure. */
  error?: string;
}

/** Decoded chunk handed to a {@link StreamFetchHandlers.onChunk} callback. */
export interface StreamChunk {
  requestId: RequestId;
  status?: number;
  headers?: Record<string, string>;
  /** The decoded chunk bytes. */
  bytes: Uint8Array;
  received: number;
}

/** Callbacks driven by {@link streamFetch}. */
export interface StreamFetchHandlers {
  /** Called for every body chunk, in order. */
  onChunk?: (chunk: StreamChunk) => void;
  /** Called once when the stream completes successfully. */
  onDone?: (received: number) => void;
  /** Called once with the opaque tag if the stream fails (incl. cancel). */
  onError?: (tag: string, received: number) => void;
}

/** Handle returned by {@link streamFetch}; lets the caller cancel + clean up. */
export interface StreamFetchHandle {
  requestId: RequestId;
  /** Ask Rust to abort the stream. Safe to call after completion (no-op). */
  cancel: () => Promise<void>;
}

/** Decode a base64 string into raw bytes. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Cancel an in-flight streaming request. Resolves to `true` if Rust still knew
 * the id (and so flagged it for abort), `false` if it had already finished.
 */
export async function cancelStreamFetch(
  requestId: RequestId,
): Promise<boolean> {
  return await invoke<boolean>("http_fetch_cancel", { requestId });
}

/**
 * Perform a streaming HTTP request via the Rust backend.
 *
 * Subscribes to `http-fetch-chunk` events *before* issuing the command (so no
 * early chunk is missed), then starts the stream. The returned handle exposes
 * the `requestId` and a `cancel()` that aborts the stream mid-flight.
 *
 * The event subscription is torn down automatically once the stream reaches
 * its terminal (`done`) event — success, error or cancel.
 *
 * Throws an opaque `URL_FETCH_*` tag if the request is rejected up front
 * (bad URL, not allow-listed, bad header, ...).
 */
export async function streamFetch(
  req: HttpFetchRequest,
  handlers: StreamFetchHandlers = {},
): Promise<StreamFetchHandle> {
  const method: HttpMethod = req.method ?? "GET";

  // requestId is not known until the command returns, but events may already
  // be flowing — buffer any that arrive before we learn our id.
  let requestId: RequestId | null = null;
  let unlisten: UnlistenFn | null = null;
  let finished = false;
  const pending: HttpFetchChunkEvent[] = [];

  const teardown = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  const handle = (ev: HttpFetchChunkEvent) => {
    if (finished) return;
    if (ev.error !== undefined) {
      finished = true;
      teardown();
      handlers.onError?.(ev.error, ev.received);
      return;
    }
    if (ev.done) {
      finished = true;
      teardown();
      handlers.onDone?.(ev.received);
      return;
    }
    handlers.onChunk?.({
      requestId: ev.requestId,
      status: ev.status,
      headers: ev.headers,
      bytes: decodeBase64(ev.chunk),
      received: ev.received,
    });
  };

  unlisten = await listen<HttpFetchChunkEvent>(
    HTTP_FETCH_CHUNK_EVENT,
    (event) => {
      const payload = event.payload;
      if (requestId === null) {
        pending.push(payload);
        return;
      }
      if (payload.requestId !== requestId) return;
      handle(payload);
    },
  );

  try {
    requestId = await invoke<RequestId>("http_fetch_stream", {
      url: req.url,
      method,
      headers: req.headers ?? null,
      body: req.body ?? null,
    });
  } catch (e) {
    teardown();
    throw e;
  }

  // Drain anything that arrived before the id was known.
  for (const ev of pending) {
    if (ev.requestId === requestId) handle(ev);
  }

  return {
    requestId,
    cancel: async () => {
      if (requestId !== null) await cancelStreamFetch(requestId);
    },
  };
}

// --- Real-time: WebSocket + SSE (issue #182) -----------------------------
//
// `httpFetch` / `streamFetch` cover finite request/response exchanges. For
// long-lived, bidirectional channels (WebSocket) or open-ended server push
// (Server-Sent Events) the renderer routes through Rust the same way: Rust
// owns the socket, applies the same allow-list / SSRF / header guards, caps
// the concurrent-connection count (DoS defence) and the per-message size,
// then relays inbound traffic via `coco:ws-message` / `coco:sse-event`.

/** Event name Rust emits for every inbound WebSocket message. */
export const WS_MESSAGE_EVENT = "coco:ws-message";
/** Event name Rust emits for every inbound Server-Sent Event. */
export const SSE_EVENT = "coco:sse-event";

/** Opaque identifier for a live WS or SSE connection. */
export type ConnectionId = number;

/** Discriminator for an outbound or inbound WebSocket frame. */
export type WsMessageKind = "text" | "binary" | "close" | "error";

/** Payload of a `coco:ws-message` event. */
export interface WsMessageEvent {
  connId: ConnectionId;
  /** `text` | `binary` | `close` | `error`. */
  kind: WsMessageKind;
  /**
   * For `text`: the message text. For `binary`: base64-encoded bytes.
   * For `close`: empty. For `error`: an opaque `WS_FETCH_*` tag.
   */
  data: string;
}

/** Callbacks driven by {@link wsConnect}. */
export interface WsHandlers {
  /** Inbound text frame. */
  onText?: (text: string) => void;
  /** Inbound binary frame, decoded to raw bytes. */
  onBinary?: (bytes: Uint8Array) => void;
  /** The connection closed (server- or client-initiated). */
  onClose?: () => void;
  /** A transport error occurred; `tag` is an opaque `WS_FETCH_*` string. */
  onError?: (tag: string) => void;
}

/** Handle returned by {@link wsConnect}. */
export interface WsConnection {
  connId: ConnectionId;
  /** Send a UTF-8 text frame. */
  sendText: (text: string) => Promise<void>;
  /** Send a binary frame (raw bytes are base64-encoded for transport). */
  sendBinary: (bytes: Uint8Array) => Promise<void>;
  /** Close the connection and stop listening. Safe to call more than once. */
  close: () => Promise<void>;
}

/** Payload of a `coco:sse-event` event. */
export interface SseEventPayload {
  connId: ConnectionId;
  /** SSE event name (absent ⇒ the default `message`). */
  event?: string;
  /** Joined data lines. */
  data?: string;
  /** Server-provided last-event-id, if any. */
  id?: string;
  /** True on the final event of the stream. */
  done: boolean;
  /** Opaque `WS_FETCH_*` tag on a failed stream. */
  error?: string;
}

/** Callbacks driven by {@link sseConnect}. */
export interface SseHandlers {
  /** A server-sent event arrived. */
  onEvent?: (ev: { event?: string; data?: string; id?: string }) => void;
  /** The stream completed normally. */
  onDone?: () => void;
  /** The stream failed; `tag` is an opaque `WS_FETCH_*` string. */
  onError?: (tag: string) => void;
}

/** Handle returned by {@link sseConnect}. */
export interface SseConnection {
  connId: ConnectionId;
  /** Close the stream and stop listening. Safe to call more than once. */
  close: () => Promise<void>;
}

/** Encode raw bytes to a base64 string (for outbound binary WS frames). */
function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Open a WebSocket connection via the Rust backend.
 *
 * The URL host must be on the allow list (Settings → 許可ドメイン) and is
 * re-validated for `ws`/`wss` + SSRF by Rust. `headers` and `subprotocols`
 * are caller-specified; hop-by-hop / `Sec-WebSocket-*` headers are rejected.
 *
 * Subscribes to `coco:ws-message` *before* issuing the connect command so no
 * early frame is missed. The subscription is torn down automatically on
 * close / error, and by the returned `close()`.
 *
 * Throws an opaque `WS_FETCH_*` tag if the connection is rejected up front
 * (bad URL, not allow-listed, concurrent-connection cap reached, ...).
 */
export async function wsConnect(
  url: string,
  handlers: WsHandlers = {},
  opts: { headers?: Record<string, string>; subprotocols?: string[] } = {},
): Promise<WsConnection> {
  let connId: ConnectionId | null = null;
  let unlisten: UnlistenFn | null = null;
  let finished = false;
  const pending: WsMessageEvent[] = [];

  const teardown = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  const handle = (ev: WsMessageEvent) => {
    if (finished) return;
    switch (ev.kind) {
      case "text":
        handlers.onText?.(ev.data);
        break;
      case "binary":
        handlers.onBinary?.(decodeBase64(ev.data));
        break;
      case "close":
        finished = true;
        teardown();
        handlers.onClose?.();
        break;
      case "error":
        finished = true;
        teardown();
        handlers.onError?.(ev.data);
        break;
    }
  };

  unlisten = await listen<WsMessageEvent>(WS_MESSAGE_EVENT, (event) => {
    const payload = event.payload;
    if (connId === null) {
      pending.push(payload);
      return;
    }
    if (payload.connId !== connId) return;
    handle(payload);
  });

  try {
    connId = await invoke<ConnectionId>("ws_connect", {
      url,
      headers: opts.headers ?? null,
      subprotocols: opts.subprotocols ?? null,
    });
  } catch (e) {
    teardown();
    throw e;
  }

  // Drain anything that arrived before the id was known.
  for (const ev of pending) {
    if (ev.connId === connId) handle(ev);
  }

  return {
    connId,
    sendText: async (text: string) => {
      await invoke("ws_send", { connId, kind: "text", data: text });
    },
    sendBinary: async (bytes: Uint8Array) => {
      await invoke("ws_send", {
        connId,
        kind: "binary",
        data: encodeBase64(bytes),
      });
    },
    close: async () => {
      teardown();
      if (connId !== null) await invoke("ws_close", { connId });
    },
  };
}

/**
 * Open a Server-Sent Events stream via the Rust backend.
 *
 * The URL host must be on the allow list and is re-validated for `http`/
 * `https` + SSRF by Rust. Subscribes to `coco:sse-event` before issuing the
 * connect command; the subscription is torn down automatically on the
 * terminal (`done`) event and by the returned `close()`.
 *
 * Throws an opaque `WS_FETCH_*` tag if the stream is rejected up front.
 */
export async function sseConnect(
  url: string,
  handlers: SseHandlers = {},
  opts: { headers?: Record<string, string> } = {},
): Promise<SseConnection> {
  let connId: ConnectionId | null = null;
  let unlisten: UnlistenFn | null = null;
  let finished = false;
  const pending: SseEventPayload[] = [];

  const teardown = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  const handle = (ev: SseEventPayload) => {
    if (finished) return;
    if (ev.error !== undefined) {
      finished = true;
      teardown();
      handlers.onError?.(ev.error);
      return;
    }
    if (ev.done) {
      finished = true;
      teardown();
      handlers.onDone?.();
      return;
    }
    handlers.onEvent?.({ event: ev.event, data: ev.data, id: ev.id });
  };

  unlisten = await listen<SseEventPayload>(SSE_EVENT, (event) => {
    const payload = event.payload;
    if (connId === null) {
      pending.push(payload);
      return;
    }
    if (payload.connId !== connId) return;
    handle(payload);
  });

  try {
    connId = await invoke<ConnectionId>("sse_connect", {
      url,
      headers: opts.headers ?? null,
    });
  } catch (e) {
    teardown();
    throw e;
  }

  for (const ev of pending) {
    if (ev.connId === connId) handle(ev);
  }

  return {
    connId,
    close: async () => {
      teardown();
      if (connId !== null) await invoke("sse_close", { connId });
    },
  };
}
