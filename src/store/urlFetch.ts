// External API connectivity (issue #138).
//
// Thin wrapper around the Tauri `http_fetch` command. The renderer never
// performs HTTP itself — it always routes through Rust so the allow-list
// and SSRF defenses cannot be bypassed by a malicious macro or webview
// content. Errors are returned as opaque tag strings (see http_fetch.rs).

import { invoke } from "@tauri-apps/api/core";

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
