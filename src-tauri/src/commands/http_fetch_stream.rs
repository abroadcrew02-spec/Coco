// Streaming HTTP responses (issue #181, follow-up to #138).
//
// The MVP `http_fetch` buffers the whole response body and only then checks
// the 10 MiB cap. A malicious server can stream gigabytes over TLS and exhaust
// memory *before* that post-hoc check ever runs. This module adds a streaming
// variant that:
//
// - rejects up front when the `Content-Length` header already advertises a
//   body over `MAX_BODY_BYTES` — no body byte is read off the socket,
// - reads the body chunk-by-chunk (`reqwest::Response::chunk()`),
// - emits each chunk to the renderer as a `http-fetch-chunk` event,
// - enforces the byte cap *mid-stream* — the moment the running total (or a
//   single oversize chunk) would exceed `MAX_BODY_BYTES` we stop pulling
//   chunks (the response is dropped, which closes the connection), so memory
//   use is bounded to `MAX_BODY_BYTES` + at most one transport chunk
//   regardless of how much the server intends to send,
// - supports cancellation from JS via `http_fetch_cancel(request_id)`.
//
// Security: this path reuses the *exact same* guards as `http_fetch` — the
// allow list, the SSRF `validate_url`/`is_blocked_host` checks, the HTTP
// method whitelist, the header CRLF/hop-by-hop validation, redirects disabled,
// and the 30 s timeout. There is no second, weaker code path.
//
// The original `http_fetch` command is intentionally left untouched.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::commands::http_fetch::{
    parse_allowed_domains, validate_url, ALLOWED_DOMAINS_KEY, MAX_BODY_BYTES, REQUEST_TIMEOUT_SECS,
};
use crate::db::app_db::open_app_db_at;

/// Event name emitted for every streamed chunk and for the terminal
/// (`done` / `error`) notification.
pub const CHUNK_EVENT: &str = "http-fetch-chunk";

/// Chunk size hint surfaced to the renderer. `reqwest::chunk()` returns
/// whatever the transport hands us (often ~16 KiB frames); we re-buffer into
/// at least 64 KiB slices before emitting so the JS side is not flooded with
/// tiny events.
pub const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// RFC 4648 base64 encoder. Chunk payloads are arbitrary bytes, so they are
/// base64-encoded for the JSON event (a JSON string cannot carry raw bytes).
/// Kept self-contained — see the matching note in `file_io::b64_encode`.
fn b64_encode(input: &[u8]) -> String {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | input[i + 2] as u32;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

/// Registry of in-flight streaming requests. Each entry maps a request id to a
/// cancellation flag; `http_fetch_cancel` flips the flag and the streaming
/// loop observes it before pulling the next chunk.
#[derive(Default)]
pub struct StreamRegistry {
    next_id: AtomicU64,
    inflight: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl StreamRegistry {
    /// Reserve a fresh request id and register a cancellation flag for it.
    pub fn register(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let flag = Arc::new(AtomicBool::new(false));
        self.inflight
            .lock()
            .expect("stream registry poisoned")
            .insert(id, flag.clone());
        (id, flag)
    }

    /// Drop the entry once the stream finishes (success, error or cancel).
    /// Driven by `RegistryGuard::drop`, never called directly by `run_stream`.
    pub fn unregister(&self, id: u64) {
        self.inflight
            .lock()
            .expect("stream registry poisoned")
            .remove(&id);
    }

    /// Number of in-flight requests currently tracked. Exposed for tests that
    /// assert the registry does not leak entries (issue #181 M-1).
    pub fn inflight_count(&self) -> usize {
        self.inflight
            .lock()
            .expect("stream registry poisoned")
            .len()
    }

    /// Flip the cancel flag for `id`. Returns false if the id is unknown
    /// (already finished or never existed).
    fn cancel(&self, id: u64) -> bool {
        match self
            .inflight
            .lock()
            .expect("stream registry poisoned")
            .get(&id)
        {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// Payload of a `http-fetch-chunk` event.
///
/// Every event for a given `request_id` is one of:
/// - a data chunk: `chunk` set, `done == false`, `error == None`;
/// - the terminal success marker: `done == true`, `error == None`;
/// - the terminal failure marker: `done == true`, `error == Some(tag)`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkEvent {
    /// Request id this event belongs to (the value returned by the command).
    pub request_id: u64,
    /// HTTP status, sent once on the first event so the renderer can react
    /// before the body arrives. `None` on chunk/terminal events after the
    /// first, and on a failure that happened before headers were received.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Response headers, sent once alongside `status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    /// Base64-encoded chunk bytes. Empty string on terminal events.
    pub chunk: String,
    /// Running total of body bytes received so far (post-cap-check value).
    pub received: u64,
    /// True on the final event of the stream.
    pub done: bool,
    /// Opaque error tag on a failed stream; `None` on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Emit a single chunk event on the main webview window.
fn emit_chunk(app: &tauri::AppHandle, event: ChunkEvent) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(CHUNK_EVENT, event);
    } else {
        // Fall back to a global emit if the main window is unavailable.
        let _ = app.emit(CHUNK_EVENT, event);
    }
}

/// Resolve the allow list from the app DB. Mirrors `http_fetch`'s lookup.
fn load_allowed(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "URL_FETCH_INTERNAL".to_string())?;
    let conn = open_app_db_at(&data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, ALLOWED_DOMAINS_KEY).map_err(|e| {
        log::warn!("http_fetch_stream settings read failed: {}", e);
        "URL_FETCH_INTERNAL".to_string()
    })?;
    Ok(parse_allowed_domains(raw.as_deref()))
}

/// HTTP method whitelist for the streaming path. Kept in sync with
/// `http_fetch`'s GET/POST-only policy.
fn parse_method(method: &str) -> Result<reqwest::Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        _ => Err("URL_FETCH_METHOD_NOT_ALLOWED".to_string()),
    }
}

/// Header validation: identical rules to `http_fetch::validate_headers`
/// (control chars, CRLF injection, hop-by-hop / pseudo headers). Duplicated
/// here because the original is private to `http_fetch`; the *rules* are the
/// single source of truth conceptually and are covered by tests in both
/// modules.
fn validate_headers(headers: &HashMap<String, String>) -> Result<(), String> {
    const FORBIDDEN: &[&str] = &[
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "trailer",
        "upgrade",
    ];
    for (k, v) in headers {
        let trimmed = k.trim();
        if trimmed.is_empty() || trimmed != k {
            return Err("URL_FETCH_BAD_HEADER".to_string());
        }
        if k.chars().any(|c| c.is_control() || c == ':') {
            return Err("URL_FETCH_BAD_HEADER".to_string());
        }
        if v.chars().any(|c| c == '\r' || c == '\n') {
            return Err("URL_FETCH_BAD_HEADER".to_string());
        }
        if FORBIDDEN.contains(&k.to_ascii_lowercase().as_str()) {
            return Err("URL_FETCH_BAD_HEADER".to_string());
        }
    }
    Ok(())
}

/// Outcome of validating a streaming request shape, before any socket opens.
/// Pure and synchronous so it can be unit-tested without network access.
pub enum StreamPlan {
    Ok,
    Rejected(String),
}

/// Run the same pre-flight checks `http_fetch` applies — URL allow list +
/// SSRF, method whitelist, header sanity, request-body cap, GET-with-body.
/// Returns the opaque error tag on the first failing rule.
pub fn validate_stream_request(
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    allowed: &[String],
) -> StreamPlan {
    if let Err(e) = validate_url(url, allowed) {
        return StreamPlan::Rejected(e.tag().to_string());
    }
    let m = match parse_method(method) {
        Ok(m) => m,
        Err(e) => return StreamPlan::Rejected(e),
    };
    if let Err(e) = validate_headers(headers) {
        return StreamPlan::Rejected(e);
    }
    if let Some(b) = body {
        if b.len() > MAX_BODY_BYTES {
            return StreamPlan::Rejected("URL_FETCH_BODY_TOO_LARGE".to_string());
        }
        if m == reqwest::Method::GET && !b.is_empty() {
            return StreamPlan::Rejected("URL_FETCH_GET_WITH_BODY".to_string());
        }
    }
    StreamPlan::Ok
}

/// Decide, given the running byte total and the size of the next chunk,
/// whether the cap is now exceeded. Extracted as a pure function so the
/// mid-stream enforcement is directly unit-testable.
pub fn exceeds_cap(received_before: u64, chunk_len: usize) -> bool {
    received_before.saturating_add(chunk_len as u64) > MAX_BODY_BYTES as u64
}

/// Parse a `Content-Length` header value and decide whether the advertised
/// body size already exceeds `MAX_BODY_BYTES`. Returns `true` only when the
/// header is present, well-formed and over the cap — a missing or malformed
/// header yields `false` (the mid-stream / per-chunk checks still apply).
///
/// This is the cheap, certain pre-flight defence for issue #181 C-1: when a
/// server honestly advertises a multi-gigabyte body we reject *before* reading
/// a single byte off the socket.
pub fn content_length_exceeds_cap(header_value: Option<&str>) -> bool {
    match header_value.and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(len) => len > MAX_BODY_BYTES as u64,
        None => false,
    }
}

/// RAII guard that removes a request's registry entry on drop. Holding this
/// for the lifetime of `run_stream` guarantees `unregister` runs on *every*
/// exit path — normal return, error return, and panic (Mutex poisoning, emit
/// failures, etc.) — so a panicking background task cannot leak an `inflight`
/// HashMap entry (issue #181 M-1).
struct RegistryGuard {
    registry: Arc<StreamRegistry>,
    request_id: u64,
}

impl Drop for RegistryGuard {
    fn drop(&mut self) {
        self.registry.unregister(self.request_id);
    }
}

/// Start a streaming fetch. Validates the request, returns a `request_id`
/// immediately and drives the body in a background task, emitting
/// `http-fetch-chunk` events. The byte cap is enforced *mid-stream*.
#[tauri::command]
pub async fn http_fetch_stream(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<StreamRegistry>>,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<u64, String> {
    let method = method.unwrap_or_else(|| "GET".to_string());
    let hdrs = headers.unwrap_or_default();

    // Pre-flight: identical guards to `http_fetch`. Reject *before* reserving
    // a request id or opening a socket.
    let allowed = load_allowed(&app)?;
    match validate_stream_request(&url, &method, &hdrs, body.as_deref(), &allowed) {
        StreamPlan::Ok => {}
        StreamPlan::Rejected(tag) => return Err(tag),
    }
    // Already validated above; unwraps below cannot fail.
    let parsed = validate_url(&url, &allowed).map_err(|e| e.tag().to_string())?;
    let m = parse_method(&method)?;

    let registry = registry.inner().clone();
    let (request_id, cancel_flag) = registry.register();

    // Drive the stream off-thread so the command returns the id immediately.
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        // The guard removes the registry entry on *every* exit path of this
        // task — normal return, error return, or panic (issue #181 M-1).
        let _guard = RegistryGuard {
            registry,
            request_id,
        };
        let result = run_stream(
            &app_for_task,
            request_id,
            cancel_flag,
            parsed,
            m,
            hdrs,
            body,
        )
        .await;
        if let Err(tag) = result {
            emit_chunk(
                &app_for_task,
                ChunkEvent {
                    request_id,
                    status: None,
                    headers: None,
                    chunk: String::new(),
                    received: 0,
                    done: true,
                    error: Some(tag),
                },
            );
        }
    });

    Ok(request_id)
}

/// The streaming body loop. Emits chunk events; returns `Err(tag)` if the
/// stream failed *before* it could emit its own terminal event (so the caller
/// emits the failure). On success / mid-stream-cap / cancel it emits its own
/// terminal event and returns `Ok(())`.
async fn run_stream(
    app: &tauri::AppHandle,
    request_id: u64,
    cancel_flag: Arc<AtomicBool>,
    parsed: url::Url,
    method: reqwest::Method,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        // Redirects disabled — a 3xx could bounce off the allow list (e.g. to
        // 169.254.169.254). Same policy as `http_fetch`.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            log::warn!("http_fetch_stream client build failed: {}", e);
            "URL_FETCH_INTERNAL".to_string()
        })?;

    let mut req = client.request(method, parsed);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    // Honour a cancel that arrived before the connection was even made.
    if cancel_flag.load(Ordering::SeqCst) {
        emit_terminal(app, request_id, 0, Some("URL_FETCH_CANCELLED"));
        return Ok(());
    }

    let mut resp = req.send().await.map_err(|e| {
        log::warn!("http_fetch_stream request failed: {}", e);
        if e.is_timeout() {
            "URL_FETCH_TIMEOUT".to_string()
        } else if e.is_connect() {
            "URL_FETCH_CONNECT_FAILED".to_string()
        } else {
            "URL_FETCH_FAILED".to_string()
        }
    })?;

    let status = resp.status().as_u16();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), s.to_string());
        }
    }

    // *** C-1, defence #1: Content-Length pre-flight. ***
    // If the server honestly advertises a body larger than the cap, reject
    // here — *before* a single body byte is pulled off the socket.
    if content_length_exceeds_cap(
        resp.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()),
    ) {
        log::warn!(
            "http_fetch_stream rejected: Content-Length exceeds {} byte cap",
            MAX_BODY_BYTES
        );
        emit_terminal(app, request_id, 0, Some("URL_FETCH_RESPONSE_TOO_LARGE"));
        return Ok(()); // `resp` dropped here -> connection closed, body never read
    }

    let mut received: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(STREAM_CHUNK_BYTES);
    let mut first = true;

    loop {
        // Cooperative cancellation: checked before every network read so a
        // `cancel()` stops the stream by the next chunk at the latest.
        if cancel_flag.load(Ordering::SeqCst) {
            emit_terminal(app, request_id, received, Some("URL_FETCH_CANCELLED"));
            return Ok(());
        }

        let next = resp.chunk().await.map_err(|e| {
            log::warn!("http_fetch_stream chunk read failed: {}", e);
            if e.is_timeout() {
                "URL_FETCH_TIMEOUT".to_string()
            } else {
                "URL_FETCH_READ_FAILED".to_string()
            }
        });

        let chunk = match next {
            Ok(Some(c)) => c,
            Ok(None) => break, // end of body
            Err(tag) => {
                emit_terminal(app, request_id, received, Some(&tag));
                return Ok(());
            }
        };

        // *** C-1, defence #2: per-chunk boundary protection. ***
        // The cap check runs *before* the chunk is appended to `buf`. This
        // covers two cases with one test:
        //   - cumulative: many small chunks whose running total tops the cap;
        //   - single oversize chunk: `chunk()` can hand back a large `Bytes`
        //     (chunked body, no Content-Length) that on its own breaches the
        //     remaining budget — it is dropped here, never copied into `buf`.
        // We do NOT append the chunk, and we drop `resp` (return), which
        // closes the connection so the server cannot keep sending. Memory is
        // therefore bounded to `MAX_BODY_BYTES` + at most one transport chunk.
        if exceeds_cap(received, chunk.len()) {
            log::warn!(
                "http_fetch_stream aborted: response exceeded {} byte cap",
                MAX_BODY_BYTES
            );
            emit_terminal(
                app,
                request_id,
                received,
                Some("URL_FETCH_RESPONSE_TOO_LARGE"),
            );
            return Ok(()); // `resp` dropped here -> connection closed
        }

        received += chunk.len() as u64;
        buf.extend_from_slice(&chunk);

        // Re-buffer into >=64 KiB slices so the renderer is not flooded.
        while buf.len() >= STREAM_CHUNK_BYTES {
            let rest = buf.split_off(STREAM_CHUNK_BYTES);
            let slice = std::mem::replace(&mut buf, rest);
            emit_chunk(
                app,
                ChunkEvent {
                    request_id,
                    status: first.then_some(status),
                    headers: first.then(|| resp_headers.clone()),
                    chunk: b64_encode(&slice),
                    received,
                    done: false,
                    error: None,
                },
            );
            first = false;
        }
    }

    // Flush any trailing partial buffer.
    if !buf.is_empty() || first {
        emit_chunk(
            app,
            ChunkEvent {
                request_id,
                status: first.then_some(status),
                headers: first.then(|| resp_headers.clone()),
                chunk: b64_encode(&buf),
                received,
                done: false,
                error: None,
            },
        );
    }

    emit_terminal(app, request_id, received, None);
    Ok(())
}

/// Emit the single terminal (`done == true`) event for a stream.
fn emit_terminal(app: &tauri::AppHandle, request_id: u64, received: u64, error: Option<&str>) {
    emit_chunk(
        app,
        ChunkEvent {
            request_id,
            status: None,
            headers: None,
            chunk: String::new(),
            received,
            done: true,
            error: error.map(|s| s.to_string()),
        },
    );
}

/// Cancel an in-flight streaming request. The streaming loop observes the flag
/// before its next chunk read and stops, emitting a `URL_FETCH_CANCELLED`
/// terminal event. Returns `false` for an unknown / already-finished id.
#[tauri::command]
pub fn http_fetch_cancel(registry: tauri::State<'_, Arc<StreamRegistry>>, request_id: u64) -> bool {
    registry.cancel(request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_headers() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn b64_encode_matches_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn exceeds_cap_is_enforced_at_the_boundary() {
        // Exactly at the cap is allowed; one byte over is not.
        assert!(!exceeds_cap(MAX_BODY_BYTES as u64 - 10, 10));
        assert!(exceeds_cap(MAX_BODY_BYTES as u64 - 10, 11));
        assert!(exceeds_cap(MAX_BODY_BYTES as u64, 1));
        assert!(!exceeds_cap(0, MAX_BODY_BYTES));
        assert!(exceeds_cap(0, MAX_BODY_BYTES + 1));
    }

    #[test]
    fn exceeds_cap_does_not_overflow() {
        // saturating_add guards against a pathological u64 wrap.
        assert!(exceeds_cap(u64::MAX, 1));
    }

    #[test]
    fn content_length_precheck_rejects_oversize_advertised_body() {
        // A Content-Length over the cap is rejected before reading the body.
        let over = (MAX_BODY_BYTES as u64 + 1).to_string();
        assert!(content_length_exceeds_cap(Some(&over)));
        assert!(content_length_exceeds_cap(Some("9999999999")));
        // Exactly at the cap is allowed (the boundary mirrors `exceeds_cap`).
        let exact = (MAX_BODY_BYTES as u64).to_string();
        assert!(!content_length_exceeds_cap(Some(&exact)));
        assert!(!content_length_exceeds_cap(Some("0")));
        assert!(!content_length_exceeds_cap(Some(" 1024 ")));
    }

    #[test]
    fn content_length_precheck_ignores_missing_or_malformed_header() {
        // A missing or unparseable header falls through to the mid-stream /
        // per-chunk checks rather than rejecting.
        assert!(!content_length_exceeds_cap(None));
        assert!(!content_length_exceeds_cap(Some("")));
        assert!(!content_length_exceeds_cap(Some("not-a-number")));
        assert!(!content_length_exceeds_cap(Some("-1")));
    }

    #[test]
    fn registry_guard_unregisters_on_drop() {
        let registry = Arc::new(StreamRegistry::default());
        let (id, _flag) = registry.register();
        assert!(registry.cancel(id), "id should be registered before drop");
        {
            let _guard = RegistryGuard {
                registry: registry.clone(),
                request_id: id,
            };
        } // guard dropped here
        assert!(
            !registry.cancel(id),
            "guard drop must remove the inflight entry"
        );
    }

    #[test]
    fn registry_guard_unregisters_even_on_panic() {
        // Simulate a panicking background task: the guard's Drop still runs
        // during unwinding, so the registry must not leak the entry.
        let registry = Arc::new(StreamRegistry::default());
        let (id, _flag) = registry.register();
        let reg_for_thread = registry.clone();
        let result = std::panic::catch_unwind(move || {
            let _guard = RegistryGuard {
                registry: reg_for_thread,
                request_id: id,
            };
            panic!("simulated task panic");
        });
        assert!(result.is_err(), "the closure was expected to panic");
        assert!(
            !registry.cancel(id),
            "guard drop during unwind must remove the inflight entry"
        );
    }

    #[test]
    fn validate_rejects_when_allow_list_is_empty() {
        let plan = validate_stream_request(
            "https://example.com",
            "GET",
            &empty_headers(),
            None,
            &[],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_NOT_ALLOWED"
        ));
    }

    #[test]
    fn validate_rejects_disallowed_scheme() {
        let plan = validate_stream_request(
            "file:///etc/passwd",
            "GET",
            &empty_headers(),
            None,
            &["example.com".into()],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_DISALLOWED_SCHEME"
        ));
    }

    #[test]
    fn validate_rejects_ssrf_targets_even_with_permissive_allow_list() {
        for u in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://169.254.169.254/latest/",
            "http://[::1]/",
            "http://10.0.0.1/",
            "http://service.internal/",
        ] {
            let plan = validate_stream_request(
                u,
                "GET",
                &empty_headers(),
                None,
                &["*".into(), "localhost".into()],
            );
            assert!(
                matches!(&plan, StreamPlan::Rejected(t)
                    if t == "URL_FETCH_BLOCKED_HOST" || t == "URL_FETCH_NOT_ALLOWED"),
                "{} should be rejected",
                u
            );
        }
    }

    #[test]
    fn validate_rejects_methods_other_than_get_post() {
        let plan = validate_stream_request(
            "https://example.com",
            "DELETE",
            &empty_headers(),
            None,
            &["example.com".into()],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_METHOD_NOT_ALLOWED"
        ));
    }

    #[test]
    fn validate_rejects_crlf_header_injection() {
        let mut h = HashMap::new();
        h.insert("X-Inject".into(), "a\r\nEvil: y".into());
        let plan = validate_stream_request(
            "https://example.com",
            "GET",
            &h,
            None,
            &["example.com".into()],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_BAD_HEADER"
        ));
    }

    #[test]
    fn validate_rejects_forbidden_hop_by_hop_headers() {
        let mut h = HashMap::new();
        h.insert("Host".into(), "evil.com".into());
        let plan = validate_stream_request(
            "https://example.com",
            "GET",
            &h,
            None,
            &["example.com".into()],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_BAD_HEADER"
        ));
    }

    #[test]
    fn validate_rejects_oversize_request_body() {
        let huge = "x".repeat(MAX_BODY_BYTES + 1);
        let plan = validate_stream_request(
            "https://example.com",
            "POST",
            &empty_headers(),
            Some(&huge),
            &["example.com".into()],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_BODY_TOO_LARGE"
        ));
    }

    #[test]
    fn validate_rejects_get_with_body() {
        let plan = validate_stream_request(
            "https://example.com",
            "GET",
            &empty_headers(),
            Some("payload"),
            &["example.com".into()],
        );
        assert!(matches!(
            plan,
            StreamPlan::Rejected(t) if t == "URL_FETCH_GET_WITH_BODY"
        ));
    }

    #[test]
    fn validate_accepts_a_well_formed_request() {
        let plan = validate_stream_request(
            "https://api.example.com/data",
            "GET",
            &empty_headers(),
            None,
            &["api.example.com".into()],
        );
        assert!(matches!(plan, StreamPlan::Ok));
    }

    #[test]
    fn registry_assigns_unique_ids_and_tracks_cancellation() {
        let reg = StreamRegistry::default();
        let (id1, flag1) = reg.register();
        let (id2, flag2) = reg.register();
        assert_ne!(id1, id2);
        assert!(!flag1.load(Ordering::SeqCst));

        // Cancelling a known id flips its flag and reports success.
        assert!(reg.cancel(id1));
        assert!(flag1.load(Ordering::SeqCst));
        assert!(!flag2.load(Ordering::SeqCst));

        // Cancelling an unknown id reports failure.
        assert!(!reg.cancel(99_999));

        // After unregister the id is no longer cancellable.
        reg.unregister(id1);
        assert!(!reg.cancel(id1));
    }
}
