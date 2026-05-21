// Real-time connectivity: WebSocket + Server-Sent Events (issue #182,
// follow-up to #138 / #181).
//
// The MVP `http_fetch` (#138) only does single-shot GET/POST and `#181` adds
// chunked streaming of a *finite* response. Neither covers a long-lived,
// bidirectional channel (`ws://` / `wss://`) or an open-ended server push
// stream (SSE). This module adds:
//
// - `ws_connect(url, headers?, subprotocols?) -> ConnectionId` — opens a
//   WebSocket, drives the read loop off-thread, emits `coco:ws-message`.
// - `ws_send(conn_id, kind, data)` — sends a text or (base64) binary frame.
// - `ws_close(conn_id)` — closes the socket.
// - `sse_connect(url, headers?) -> ConnectionId` — opens an SSE stream, emits
//   `coco:sse-event` per server-sent event.
// - `sse_close(conn_id)` — closes the stream.
//
// Security: WS/SSE reuse the *exact same* guards as `http_fetch` — the allow
// list, the SSRF `is_blocked_host` check, the header CRLF/hop-by-hop
// validation. `validate_ws_url` accepts `ws`/`wss` (and `http`/`https` for
// SSE) but applies the identical SSRF predicate against the *hostname* so a
// literal loopback / link-local / private-range / cloud-metadata target is
// rejected. Note this is a hostname-based allow-list / SSRF check: it does
// NOT defend against DNS rebinding, where the host validates fine but an
// attacker-controlled DNS re-resolves the name to an internal IP at connect
// time (the validation and the actual socket connect resolve the host
// independently — a TOCTOU gap). This is a known residual risk inherited
// from `http_fetch`; a real fix (resolve once, then connect to the pinned
// IP) is tracked separately.
// Additional DoS defences specific to long-lived connections:
//   - a hard cap on the number of *concurrent* connections (`MAX_CONNECTIONS`),
//   - a per-message size cap (`MAX_MESSAGE_BYTES`) on both directions,
//   - a connection-establishment timeout (`CONNECT_TIMEOUT_SECS`).
//
// As in #181, SSRF rules forbid pointing the real read loops at a local mock
// server, so the network-free pieces — URL validation, the registry, the
// concurrent-connection cap and the RAII cleanup guard — are factored into
// pure, public items that are unit-tested for equivalent coverage.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::{Message as WsMessage, WebSocketConfig};
use url::{Host, Url};

use crate::commands::http_fetch::{parse_allowed_domains, host_matches, ALLOWED_DOMAINS_KEY};
use crate::db::app_db::open_app_db_at;

/// Event emitted for every inbound WebSocket message.
pub const WS_MESSAGE_EVENT: &str = "coco:ws-message";
/// Event emitted for every inbound Server-Sent Event.
pub const SSE_EVENT: &str = "coco:sse-event";

/// Hard cap on the number of WS + SSE connections alive at once. A long-lived
/// connection holds an OS socket and a background task for its whole lifetime,
/// so an unbounded count is a trivial local DoS — `*_connect` rejects with
/// `WS_FETCH_TOO_MANY_CONNECTIONS` once this many are open.
pub const MAX_CONNECTIONS: usize = 16;

/// Per-message size cap (inbound and outbound), 1 MiB. A peer cannot push a
/// giant frame to exhaust memory, and the caller cannot send one either.
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Timeout for establishing a connection (TCP + TLS + WS upgrade / SSE
/// headers). The connection is *long-lived* afterwards, so this bounds only
/// the handshake, not the session.
pub const CONNECT_TIMEOUT_SECS: u64 = 30;

/// Opaque error tags. Internal causes are logged via `log::warn!` and never
/// returned to the renderer (no network-topology probing from JS / macros).
#[derive(Debug, PartialEq, Eq)]
pub enum WsCheckError {
    InvalidUrl,
    DisallowedScheme,
    BlockedHost,
    NotAllowed,
}

impl WsCheckError {
    pub fn tag(&self) -> &'static str {
        match self {
            WsCheckError::InvalidUrl => "WS_FETCH_INVALID_URL",
            WsCheckError::DisallowedScheme => "WS_FETCH_DISALLOWED_SCHEME",
            WsCheckError::BlockedHost => "WS_FETCH_BLOCKED_HOST",
            WsCheckError::NotAllowed => "WS_FETCH_NOT_ALLOWED",
        }
    }
}

/// SSRF check, identical predicate to `http_fetch::is_blocked_host`: reject
/// literal IPs and loopback / link-local / `.local` / `.internal` hostnames.
/// Duplicated (the original is private to `http_fetch`) — the *rule* is the
/// conceptual single source of truth and is covered by tests in both modules.
fn is_blocked_host(parsed: &Url) -> bool {
    let Some(host) = parsed.host() else {
        return true;
    };
    match host {
        Host::Ipv4(_) | Host::Ipv6(_) => true,
        Host::Domain(name) => {
            let lower = name.to_ascii_lowercase();
            if lower == "localhost"
                || lower.ends_with(".localhost")
                || lower.ends_with(".local")
                || lower.ends_with(".internal")
            {
                return true;
            }
            if lower.parse::<std::net::IpAddr>().is_ok() {
                return true;
            }
            false
        }
    }
}

/// Which transport a URL is being validated for. WebSocket connects accept
/// only `ws`/`wss`; SSE connects accept only `http`/`https` (SSE rides on a
/// plain HTTP response with `text/event-stream`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    WebSocket,
    Sse,
}

/// Validate a connection URL against scheme rules, SSRF rules and the allow
/// list. The allow list is the same host-pattern list `http_fetch` uses, so
/// the operator configures one list for HTTP, streaming, WS and SSE alike.
pub fn validate_ws_url(
    url_str: &str,
    transport: Transport,
    allowed: &[String],
) -> Result<Url, WsCheckError> {
    let parsed = Url::parse(url_str).map_err(|_| WsCheckError::InvalidUrl)?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    let scheme_ok = match transport {
        Transport::WebSocket => scheme == "ws" || scheme == "wss",
        Transport::Sse => scheme == "http" || scheme == "https",
    };
    if !scheme_ok {
        return Err(WsCheckError::DisallowedScheme);
    }
    if is_blocked_host(&parsed) {
        return Err(WsCheckError::BlockedHost);
    }
    let host = parsed
        .host_str()
        .ok_or(WsCheckError::InvalidUrl)?
        .to_ascii_lowercase();
    if !allowed.iter().any(|p| host_matches(&host, p)) {
        return Err(WsCheckError::NotAllowed);
    }
    Ok(parsed)
}

/// Header validation: identical rules to `http_fetch::validate_headers`
/// (control chars, CRLF injection, hop-by-hop / pseudo headers). The WS
/// upgrade also forges its own `Connection` / `Upgrade` / `Sec-WebSocket-*`
/// headers, so callers must not be allowed to set those.
pub fn validate_headers(headers: &HashMap<String, String>) -> Result<(), String> {
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
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
    ];
    for (k, v) in headers {
        let trimmed = k.trim();
        if trimmed.is_empty() || trimmed != k {
            return Err("WS_FETCH_BAD_HEADER".to_string());
        }
        if k.chars().any(|c| c.is_control() || c == ':') {
            return Err("WS_FETCH_BAD_HEADER".to_string());
        }
        if v.chars().any(|c| c == '\r' || c == '\n') {
            return Err("WS_FETCH_BAD_HEADER".to_string());
        }
        if FORBIDDEN.contains(&k.to_ascii_lowercase().as_str()) {
            return Err("WS_FETCH_BAD_HEADER".to_string());
        }
    }
    Ok(())
}

/// A subprotocol token (RFC 6455 §4.1): a non-empty HTTP token — visible ASCII
/// without separators / control chars. Rejecting junk here keeps the upgrade
/// header well-formed and uninjectable.
pub fn validate_subprotocols(protos: &[String]) -> Result<(), String> {
    const SEPARATORS: &str = "()<>@,;:\\\"/[]?={} \t";
    for p in protos {
        if p.is_empty() {
            return Err("WS_FETCH_BAD_SUBPROTOCOL".to_string());
        }
        if p.chars()
            .any(|c| c.is_control() || !c.is_ascii() || SEPARATORS.contains(c))
        {
            return Err("WS_FETCH_BAD_SUBPROTOCOL".to_string());
        }
    }
    Ok(())
}

// --- Connection registry -------------------------------------------------

/// What kind of transport a registry entry tracks. Used by the registry
/// introspection helper the tests rely on to tell WS and SSE entries apart.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnKind {
    WebSocket,
    Sse,
}

/// Per-transport control channel held by the registry. WebSocket needs an
/// outbound queue (so `ws_send` can hand frames to the read/write task); SSE
/// is receive-only and only needs a close signal. The variant also records
/// the connection kind, so no separate `kind` field is required.
enum ConnEntry {
    /// Outbound WS frames. `None` is the explicit "close now" sentinel.
    WebSocket(mpsc::UnboundedSender<Option<WsMessage>>),
    /// Close signal for an SSE stream. Dropping the sender ends the stream.
    Sse(mpsc::UnboundedSender<()>),
}

/// Registry of live WS + SSE connections. Bounds the concurrent count to
/// `MAX_CONNECTIONS` (DoS defence) and lets `*_close` reach a running task.
#[derive(Default)]
pub struct ConnRegistry {
    next_id: AtomicU64,
    conns: Mutex<HashMap<u64, ConnEntry>>,
}

/// Reason a registration attempt failed.
#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    /// The concurrent-connection cap is already reached.
    TooManyConnections,
}

impl ConnRegistry {
    /// Number of connections currently alive. Used by tests to assert the
    /// registry neither leaks nor over-counts.
    pub fn active_count(&self) -> usize {
        self.conns.lock().expect("ws registry poisoned").len()
    }

    /// Whether a fresh connection may be opened without exceeding the cap.
    /// Pure decision split out so the cap is directly unit-testable.
    pub fn has_capacity(&self) -> bool {
        self.active_count() < MAX_CONNECTIONS
    }

    /// Reserve an id for a WebSocket connection. Fails closed when the
    /// concurrent-connection cap is reached (DoS defence). On success the
    /// returned receiver is the outbound-frame queue for the read/write task.
    fn register_ws(
        &self,
    ) -> Result<(u64, mpsc::UnboundedReceiver<Option<WsMessage>>), RegisterError> {
        let mut conns = self.conns.lock().expect("ws registry poisoned");
        if conns.len() >= MAX_CONNECTIONS {
            return Err(RegisterError::TooManyConnections);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        conns.insert(id, ConnEntry::WebSocket(tx));
        Ok((id, rx))
    }

    /// Reserve an id for an SSE connection. Fails closed at the cap. The
    /// returned receiver fires (or closes) when the connection is asked to
    /// stop.
    fn register_sse(&self) -> Result<(u64, mpsc::UnboundedReceiver<()>), RegisterError> {
        let mut conns = self.conns.lock().expect("ws registry poisoned");
        if conns.len() >= MAX_CONNECTIONS {
            return Err(RegisterError::TooManyConnections);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        conns.insert(id, ConnEntry::Sse(tx));
        Ok((id, rx))
    }

    /// Remove a connection's entry. Idempotent — driven by `RegistryGuard::drop`
    /// so it runs on every exit path of a background task (incl. panic).
    fn unregister(&self, id: u64) {
        self.conns
            .lock()
            .expect("ws registry poisoned")
            .remove(&id);
    }

    /// Queue an outbound WebSocket frame for `id`. Returns an opaque tag if the
    /// id is unknown or is not a WebSocket connection.
    fn send_ws(&self, id: u64, msg: WsMessage) -> Result<(), String> {
        let conns = self.conns.lock().expect("ws registry poisoned");
        match conns.get(&id) {
            Some(ConnEntry::WebSocket(tx)) => tx
                .send(Some(msg))
                .map_err(|_| "WS_FETCH_NOT_CONNECTED".to_string()),
            Some(ConnEntry::Sse(_)) => Err("WS_FETCH_WRONG_KIND".to_string()),
            None => Err("WS_FETCH_NOT_CONNECTED".to_string()),
        }
    }

    /// Ask connection `id` to close. Returns false for an unknown id (already
    /// closed or never existed). The background task observes the signal and
    /// exits; its `RegistryGuard` then drops the entry.
    pub fn request_close(&self, id: u64) -> bool {
        let conns = self.conns.lock().expect("ws registry poisoned");
        match conns.get(&id) {
            // `None` is the close sentinel on the outbound queue.
            Some(ConnEntry::WebSocket(tx)) => {
                let _ = tx.send(None);
                true
            }
            Some(ConnEntry::Sse(tx)) => {
                let _ = tx.send(());
                true
            }
            None => false,
        }
    }

    /// Kind of a tracked connection, or `None` if the id is unknown. Test-only
    /// introspection so WS / SSE entries can be told apart.
    #[cfg(test)]
    pub fn kind_of(&self, id: u64) -> Option<ConnKind> {
        self.conns
            .lock()
            .expect("ws registry poisoned")
            .get(&id)
            .map(|e| match e {
                ConnEntry::WebSocket(_) => ConnKind::WebSocket,
                ConnEntry::Sse(_) => ConnKind::Sse,
            })
    }
}

/// RAII guard that removes a connection's registry entry on drop. Holding it
/// for the lifetime of a background task guarantees `unregister` runs on every
/// exit path — normal return, error return, panic — so a dead connection can
/// never leak a registry slot and silently consume the concurrency budget.
struct RegistryGuard {
    registry: Arc<ConnRegistry>,
    id: u64,
}

impl Drop for RegistryGuard {
    fn drop(&mut self) {
        self.registry.unregister(self.id);
    }
}

// --- Event payloads ------------------------------------------------------

/// Payload of a `coco:ws-message` event. `kind` is `text` | `binary` |
/// `close` | `error`; `data` is the text / base64 bytes / close reason /
/// opaque error tag depending on `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsMessageEvent {
    pub conn_id: u64,
    pub kind: String,
    pub data: String,
}

/// Payload of a `coco:sse-event`. `event` is the SSE event name (default
/// `message`); `data` is the joined data lines; `id` is the last-event-id if
/// the server sent one. `done`/`error` mark the terminal event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseEvent {
    pub conn_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Minimal RFC 4648 base64 encoder for binary WS frames (a JSON string cannot
/// carry raw bytes). Mirrors `http_fetch_stream::b64_encode`.
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

/// Minimal RFC 4648 base64 decoder for outbound binary WS frames.
pub fn b64_decode(input: &str) -> Result<Vec<u8>, ()> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.len() % 4 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|&&b| b == b'=').count();
        if pad > 2 {
            return Err(());
        }
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = if c == b'=' { 0 } else { val(c).ok_or(())? };
            n |= (v as u32) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// Emit an event on the main webview window (global emit as a fallback).
fn emit_event<S: Serialize + Clone>(app: &tauri::AppHandle, name: &str, payload: S) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(name, payload);
    } else {
        let _ = app.emit(name, payload);
    }
}

/// Load the shared allow list from the app DB. Mirrors `http_fetch`'s lookup
/// so HTTP / streaming / WS / SSE all enforce one operator-configured list.
fn load_allowed(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "WS_FETCH_INTERNAL".to_string())?;
    let conn = open_app_db_at(&data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, ALLOWED_DOMAINS_KEY).map_err(|e| {
        log::warn!("ws_fetch settings read failed: {}", e);
        "WS_FETCH_INTERNAL".to_string()
    })?;
    Ok(parse_allowed_domains(raw.as_deref()))
}

// --- SSE line parser -----------------------------------------------------

/// Accumulator for an in-progress SSE event being assembled line by line.
/// Public + unit-tested: the parser is the only network-free part of the SSE
/// path, so it carries the SSE test coverage.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SseEventBuilder {
    pub event: Option<String>,
    pub data: Vec<String>,
    pub id: Option<String>,
}

impl SseEventBuilder {
    pub fn is_empty(&self) -> bool {
        self.event.is_none() && self.data.is_empty() && self.id.is_none()
    }

    /// Finish the current event: join data lines with `\n` (per the spec).
    /// Returns `None` when no field was seen (a stray blank line).
    pub fn take(&mut self) -> Option<(Option<String>, Option<String>, Option<String>)> {
        if self.is_empty() {
            return None;
        }
        let event = self.event.take();
        let id = self.id.take();
        let data = if self.data.is_empty() {
            None
        } else {
            Some(self.data.join("\n"))
        };
        self.data.clear();
        Some((event, data, id))
    }
}

/// Feed one already-stripped line (no trailing CR/LF) into `builder`.
/// Returns a finished event tuple when `line` is the terminating blank line.
/// Implements the WHATWG SSE field grammar: `event:`, `data:`, `id:`, comments
/// (`:` prefix) ignored, an optional single leading space after the colon.
pub fn sse_feed_line(
    builder: &mut SseEventBuilder,
    line: &str,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    if line.is_empty() {
        return builder.take();
    }
    if line.starts_with(':') {
        // Comment line — ignored.
        return None;
    }
    let (field, value) = match line.split_once(':') {
        Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
        // A line with no colon is a field name with an empty value.
        None => (line, ""),
    };
    match field {
        "event" => builder.event = Some(value.to_string()),
        "data" => builder.data.push(value.to_string()),
        "id" => {
            // The spec drops an id containing a NUL; otherwise it is kept.
            if !value.contains('\u{0}') {
                builder.id = Some(value.to_string());
            }
        }
        // `retry` and unknown fields are ignored for this MVP.
        _ => {}
    }
    None
}

// --- WebSocket -----------------------------------------------------------

/// Open a WebSocket connection. Validates the URL (allow list + SSRF, `ws`/
/// `wss` only), headers and subprotocols, enforces the concurrent-connection
/// cap, then drives the socket off-thread and returns the `ConnectionId`.
#[tauri::command]
pub async fn ws_connect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<ConnRegistry>>,
    url: String,
    headers: Option<HashMap<String, String>>,
    subprotocols: Option<Vec<String>>,
) -> Result<u64, String> {
    let hdrs = headers.unwrap_or_default();
    let protos = subprotocols.unwrap_or_default();

    // Pre-flight: same guards as `http_fetch`, reject before any socket opens.
    let allowed = load_allowed(&app)?;
    let parsed = validate_ws_url(&url, Transport::WebSocket, &allowed)
        .map_err(|e| e.tag().to_string())?;
    validate_headers(&hdrs)?;
    validate_subprotocols(&protos)?;

    // Reserve a slot — fails closed at the concurrency cap (DoS defence).
    let registry = registry.inner().clone();
    let (conn_id, outbound) = registry.register_ws().map_err(|e| match e {
        RegisterError::TooManyConnections => "WS_FETCH_TOO_MANY_CONNECTIONS".to_string(),
    })?;

    // Build the upgrade request: caller headers + subprotocols.
    let request = match build_ws_request(&parsed, &hdrs, &protos) {
        Ok(r) => r,
        Err(tag) => {
            registry.unregister(conn_id);
            return Err(tag);
        }
    };

    // Establish the connection up front (bounded by CONNECT_TIMEOUT_SECS) so
    // the command can report a handshake failure synchronously. The config
    // caps inbound message/frame size so an oversize frame fails as a
    // protocol error on read rather than exhausting memory (see C1).
    let connect = tokio_tungstenite::connect_async_with_config(
        request,
        Some(ws_socket_config()),
        false,
    );
    let stream = match tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        connect,
    )
    .await
    {
        Ok(Ok((stream, _resp))) => stream,
        Ok(Err(e)) => {
            log::warn!("ws_connect handshake failed: {}", e);
            registry.unregister(conn_id);
            return Err("WS_FETCH_CONNECT_FAILED".to_string());
        }
        Err(_) => {
            log::warn!("ws_connect handshake timed out");
            registry.unregister(conn_id);
            return Err("WS_FETCH_TIMEOUT".to_string());
        }
    };

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        // RAII: drops the registry slot on every exit path (incl. panic).
        let _guard = RegistryGuard {
            registry,
            id: conn_id,
        };
        run_ws(&app_for_task, conn_id, stream, outbound).await;
    });

    Ok(conn_id)
}

/// WebSocket protocol config used for every `ws_connect`. tungstenite's
/// defaults allow a 64 MiB message / 16 MiB frame; both are clamped to
/// `MAX_MESSAGE_BYTES` so an oversize frame is rejected as a protocol error
/// during the post-handshake read — *before* `handle_inbound` ever sees it —
/// instead of being buffered to `MAX_MESSAGE_BYTES * MAX_CONNECTIONS` of RAM.
/// The `handle_inbound` size check stays as a defence-in-depth backstop.
pub fn ws_socket_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..WebSocketConfig::default()
    }
}

/// Build the tungstenite upgrade request, attaching caller headers and the
/// `Sec-WebSocket-Protocol` list. tungstenite synthesises the mandatory
/// `Host`, `Connection`, `Upgrade` and `Sec-WebSocket-Key`/`-Version` headers.
fn build_ws_request(
    url: &Url,
    headers: &HashMap<String, String>,
    subprotocols: &[String],
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| {
            log::warn!("ws_connect bad request: {}", e);
            "WS_FETCH_INVALID_URL".to_string()
        })?;
    let hmap = request.headers_mut();
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| "WS_FETCH_BAD_HEADER".to_string())?;
        let value =
            HeaderValue::from_str(v).map_err(|_| "WS_FETCH_BAD_HEADER".to_string())?;
        hmap.append(name, value);
    }
    if !subprotocols.is_empty() {
        let joined = subprotocols.join(", ");
        let value = HeaderValue::from_str(&joined)
            .map_err(|_| "WS_FETCH_BAD_SUBPROTOCOL".to_string())?;
        hmap.insert("Sec-WebSocket-Protocol", value);
    }
    Ok(request)
}

/// Drive a connected WebSocket: pump caller frames out and server frames in,
/// emitting `coco:ws-message` events. Returns when the socket closes, the
/// caller requests a close, or an error occurs.
async fn run_ws(
    app: &tauri::AppHandle,
    conn_id: u64,
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut outbound: mpsc::UnboundedReceiver<Option<WsMessage>>,
) {
    let (mut sink, mut source) = stream.split();
    loop {
        tokio::select! {
            // Outbound: caller frames + the `None` close sentinel.
            queued = outbound.recv() => {
                match queued {
                    Some(Some(msg)) => {
                        if sink.send(msg).await.is_err() {
                            emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                                conn_id,
                                kind: "error".to_string(),
                                data: "WS_FETCH_SEND_FAILED".to_string(),
                            });
                            break;
                        }
                    }
                    // `Some(None)` = explicit close request, `None` = the
                    // registry entry (and its sender) was dropped.
                    Some(None) | None => {
                        let _ = sink.send(WsMessage::Close(None)).await;
                        emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                            conn_id,
                            kind: "close".to_string(),
                            data: String::new(),
                        });
                        break;
                    }
                }
            }
            // Inbound: server frames.
            incoming = source.next() => {
                match incoming {
                    Some(Ok(msg)) => {
                        if !handle_inbound(app, conn_id, msg) {
                            break; // server-initiated close
                        }
                    }
                    Some(Err(e)) => {
                        log::warn!("ws read error: {}", e);
                        emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                            conn_id,
                            kind: "error".to_string(),
                            data: "WS_FETCH_READ_FAILED".to_string(),
                        });
                        break;
                    }
                    None => {
                        emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                            conn_id,
                            kind: "close".to_string(),
                            data: String::new(),
                        });
                        break;
                    }
                }
            }
        }
    }
}

/// Handle one inbound WS frame. Emits the matching `coco:ws-message` event.
/// Returns `false` when the frame is a server `Close` (read loop should stop).
/// Oversize text/binary frames are dropped with an `error` event (DoS guard).
fn handle_inbound(app: &tauri::AppHandle, conn_id: u64, msg: WsMessage) -> bool {
    match msg {
        WsMessage::Text(text) => {
            if text.len() > MAX_MESSAGE_BYTES {
                emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                    conn_id,
                    kind: "error".to_string(),
                    data: "WS_FETCH_MESSAGE_TOO_LARGE".to_string(),
                });
                return true;
            }
            emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                conn_id,
                kind: "text".to_string(),
                data: text.to_string(),
            });
            true
        }
        WsMessage::Binary(bytes) => {
            if bytes.len() > MAX_MESSAGE_BYTES {
                emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                    conn_id,
                    kind: "error".to_string(),
                    data: "WS_FETCH_MESSAGE_TOO_LARGE".to_string(),
                });
                return true;
            }
            emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                conn_id,
                kind: "binary".to_string(),
                data: b64_encode(&bytes),
            });
            true
        }
        // Ping/Pong are handled by tungstenite's auto-pong; surface nothing.
        WsMessage::Ping(_) | WsMessage::Pong(_) => true,
        WsMessage::Close(_) => {
            emit_event(app, WS_MESSAGE_EVENT, WsMessageEvent {
                conn_id,
                kind: "close".to_string(),
                data: String::new(),
            });
            false
        }
        // `Frame` is only produced by the low-level API; unreachable here.
        WsMessage::Frame(_) => true,
    }
}

/// Send a frame on an open WebSocket. `kind` is `text` or `binary`; for
/// `binary`, `data` must be base64. Rejects an oversize message (DoS guard).
#[tauri::command]
pub fn ws_send(
    registry: tauri::State<'_, Arc<ConnRegistry>>,
    conn_id: u64,
    kind: String,
    data: String,
) -> Result<(), String> {
    let msg = match kind.as_str() {
        "text" => {
            if data.len() > MAX_MESSAGE_BYTES {
                return Err("WS_FETCH_MESSAGE_TOO_LARGE".to_string());
            }
            WsMessage::Text(data.into())
        }
        "binary" => {
            let bytes = b64_decode(&data).map_err(|_| "WS_FETCH_BAD_PAYLOAD".to_string())?;
            if bytes.len() > MAX_MESSAGE_BYTES {
                return Err("WS_FETCH_MESSAGE_TOO_LARGE".to_string());
            }
            WsMessage::Binary(bytes.into())
        }
        _ => return Err("WS_FETCH_BAD_KIND".to_string()),
    };
    registry.send_ws(conn_id, msg)
}

/// Close a WebSocket connection. Returns `false` if the id is unknown
/// (already closed or never existed).
#[tauri::command]
pub fn ws_close(registry: tauri::State<'_, Arc<ConnRegistry>>, conn_id: u64) -> bool {
    registry.request_close(conn_id)
}

// --- Server-Sent Events --------------------------------------------------

/// Open an SSE stream. Validates the URL (allow list + SSRF, `http`/`https`)
/// and headers, enforces the concurrent-connection cap, then reads the stream
/// off-thread emitting `coco:sse-event` events. Returns the `ConnectionId`.
#[tauri::command]
pub async fn sse_connect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<ConnRegistry>>,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<u64, String> {
    let hdrs = headers.unwrap_or_default();

    let allowed = load_allowed(&app)?;
    let parsed =
        validate_ws_url(&url, Transport::Sse, &allowed).map_err(|e| e.tag().to_string())?;
    validate_headers(&hdrs)?;

    let registry = registry.inner().clone();
    let (conn_id, close_rx) = registry.register_sse().map_err(|e| match e {
        RegisterError::TooManyConnections => "WS_FETCH_TOO_MANY_CONNECTIONS".to_string(),
    })?;

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = RegistryGuard {
            registry,
            id: conn_id,
        };
        let result = run_sse(&app_for_task, conn_id, parsed, hdrs, close_rx).await;
        if let Err(tag) = result {
            emit_event(&app_for_task, SSE_EVENT, SseEvent {
                conn_id,
                event: None,
                data: None,
                id: None,
                done: true,
                error: Some(tag),
            });
        }
    });

    Ok(conn_id)
}

/// Drive an SSE stream: connect, then parse the `text/event-stream` body line
/// by line, emitting `coco:sse-event` events. Returns `Err(tag)` only on a
/// failure *before* it could emit its own terminal event.
async fn run_sse(
    app: &tauri::AppHandle,
    conn_id: u64,
    parsed: Url,
    headers: HashMap<String, String>,
    mut close_rx: mpsc::UnboundedReceiver<()>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        // Redirects disabled — a 3xx could bounce off the allow list.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            log::warn!("sse_connect client build failed: {}", e);
            "WS_FETCH_INTERNAL".to_string()
        })?;

    let mut req = client.get(parsed).header("Accept", "text/event-stream");
    for (k, v) in &headers {
        req = req.header(k, v);
    }

    let resp = tokio::select! {
        r = req.send() => r.map_err(|e| {
            log::warn!("sse_connect request failed: {}", e);
            if e.is_timeout() { "WS_FETCH_TIMEOUT".to_string() }
            else if e.is_connect() { "WS_FETCH_CONNECT_FAILED".to_string() }
            else { "WS_FETCH_FAILED".to_string() }
        })?,
        _ = close_rx.recv() => return Ok(()), // closed before connect completed
    };
    if !resp.status().is_success() {
        log::warn!("sse_connect non-2xx status: {}", resp.status());
        return Err("WS_FETCH_FAILED".to_string());
    }

    let mut stream = resp.bytes_stream();
    let mut builder = SseEventBuilder::default();
    // Carry-over for a partial line split across two transport chunks.
    let mut pending = String::new();

    loop {
        let chunk = tokio::select! {
            next = stream.next() => next,
            _ = close_rx.recv() => {
                emit_event(app, SSE_EVENT, SseEvent {
                    conn_id, event: None, data: None, id: None,
                    done: true, error: None,
                });
                return Ok(());
            }
        };
        let chunk = match chunk {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                log::warn!("sse read error: {}", e);
                return Err("WS_FETCH_READ_FAILED".to_string());
            }
            None => {
                // Stream ended — flush any half-built event then terminate.
                if let Some((event, data, id)) = builder.take() {
                    emit_sse(app, conn_id, event, data, id);
                }
                emit_event(app, SSE_EVENT, SseEvent {
                    conn_id, event: None, data: None, id: None,
                    done: true, error: None,
                });
                return Ok(());
            }
        };

        pending.push_str(&String::from_utf8_lossy(&chunk));
        // DoS guard: a server that never sends a newline could grow `pending`
        // without bound — cap a single un-terminated line at MAX_MESSAGE_BYTES.
        if pending.len() > MAX_MESSAGE_BYTES {
            return Err("WS_FETCH_MESSAGE_TOO_LARGE".to_string());
        }

        // Consume every complete line; keep the trailing partial in `pending`.
        while let Some(idx) = pending.find('\n') {
            let mut line: String = pending.drain(..=idx).collect();
            line.pop(); // drop '\n'
            if line.ends_with('\r') {
                line.pop();
            }
            if let Some((event, data, id)) = sse_feed_line(&mut builder, &line) {
                emit_sse(app, conn_id, event, data, id);
            }
        }
    }
}

/// Emit one parsed SSE event as a `coco:sse-event`.
fn emit_sse(
    app: &tauri::AppHandle,
    conn_id: u64,
    event: Option<String>,
    data: Option<String>,
    id: Option<String>,
) {
    emit_event(app, SSE_EVENT, SseEvent {
        conn_id,
        event,
        data,
        id,
        done: false,
        error: None,
    });
}

/// Close an SSE connection. Returns `false` if the id is unknown.
#[tauri::command]
pub fn sse_close(registry: tauri::State<'_, Arc<ConnRegistry>>, conn_id: u64) -> bool {
    registry.request_close(conn_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow_all() -> Vec<String> {
        vec!["*.example.com".into(), "example.com".into()]
    }

    // --- URL validation: scheme, SSRF, allow list ------------------------

    #[test]
    fn ws_url_accepts_ws_and_wss_on_allow_list() {
        assert!(validate_ws_url("ws://example.com/feed", Transport::WebSocket, &allow_all()).is_ok());
        assert!(
            validate_ws_url("wss://api.example.com/s", Transport::WebSocket, &allow_all()).is_ok()
        );
    }

    #[test]
    fn ws_url_rejects_http_scheme_for_websocket() {
        assert_eq!(
            validate_ws_url("https://example.com/", Transport::WebSocket, &allow_all()),
            Err(WsCheckError::DisallowedScheme)
        );
        assert_eq!(
            validate_ws_url("file:///etc/passwd", Transport::WebSocket, &allow_all()),
            Err(WsCheckError::DisallowedScheme)
        );
    }

    #[test]
    fn sse_url_accepts_http_https_only() {
        assert!(validate_ws_url("https://example.com/sse", Transport::Sse, &allow_all()).is_ok());
        assert!(validate_ws_url("http://example.com/sse", Transport::Sse, &allow_all()).is_ok());
        assert_eq!(
            validate_ws_url("ws://example.com/sse", Transport::Sse, &allow_all()),
            Err(WsCheckError::DisallowedScheme)
        );
    }

    #[test]
    fn ws_url_rejects_ssrf_targets_even_with_permissive_allow_list() {
        let allow = vec!["*".into(), "localhost".into()];
        for u in [
            "ws://127.0.0.1/",
            "ws://localhost/",
            "ws://[::1]/",
            "ws://10.0.0.1/",
            "ws://192.168.1.1/",
            "ws://172.16.0.1/",
            "wss://169.254.169.254/",
            "ws://service.internal/",
            "ws://printer.local/",
        ] {
            let r = validate_ws_url(u, Transport::WebSocket, &allow);
            assert!(
                matches!(r, Err(WsCheckError::BlockedHost) | Err(WsCheckError::NotAllowed)),
                "{} should be blocked, got {:?}",
                u,
                r
            );
        }
    }

    #[test]
    fn sse_url_rejects_ssrf_targets() {
        let allow = vec!["*".into()];
        for u in [
            "http://127.0.0.1/sse",
            "http://169.254.169.254/latest/",
            "http://[::1]/sse",
            "https://10.1.2.3/sse",
        ] {
            let r = validate_ws_url(u, Transport::Sse, &allow);
            assert!(
                matches!(r, Err(WsCheckError::BlockedHost) | Err(WsCheckError::NotAllowed)),
                "{} should be blocked, got {:?}",
                u,
                r
            );
        }
    }

    #[test]
    fn ws_url_rejects_host_not_on_allow_list() {
        assert_eq!(
            validate_ws_url("wss://evil.com/", Transport::WebSocket, &["example.com".into()]),
            Err(WsCheckError::NotAllowed)
        );
    }

    #[test]
    fn ws_url_rejects_invalid_url() {
        assert_eq!(
            validate_ws_url("not a url", Transport::WebSocket, &allow_all()),
            Err(WsCheckError::InvalidUrl)
        );
    }

    #[test]
    fn ws_url_empty_allow_list_blocks_everything() {
        assert_eq!(
            validate_ws_url("wss://example.com/", Transport::WebSocket, &[]),
            Err(WsCheckError::NotAllowed)
        );
    }

    // --- Header validation ----------------------------------------------

    #[test]
    fn headers_reject_crlf_and_hop_by_hop() {
        let mut ok = HashMap::new();
        ok.insert("X-Token".into(), "abc".into());
        assert!(validate_headers(&ok).is_ok());

        let mut crlf = HashMap::new();
        crlf.insert("X-Inject".into(), "a\r\nEvil: y".into());
        assert!(validate_headers(&crlf).is_err());

        for forbidden in ["Host", "Connection", "Upgrade", "Sec-WebSocket-Key"] {
            let mut h = HashMap::new();
            h.insert(forbidden.to_string(), "x".into());
            assert!(validate_headers(&h).is_err(), "{} must be rejected", forbidden);
        }
    }

    // --- Subprotocol validation -----------------------------------------

    #[test]
    fn subprotocols_accept_valid_tokens_reject_junk() {
        assert!(validate_subprotocols(&["graphql-ws".into(), "v1.json".into()]).is_ok());
        assert!(validate_subprotocols(&[]).is_ok());
        assert!(validate_subprotocols(&["".into()]).is_err());
        assert!(validate_subprotocols(&["bad proto".into()]).is_err());
        assert!(validate_subprotocols(&["a\r\nb".into()]).is_err());
        assert!(validate_subprotocols(&["コメント".into()]).is_err());
        assert!(validate_subprotocols(&["a,b".into()]).is_err());
    }

    // --- WebSocket socket config (inbound size cap) ---------------------

    #[test]
    fn ws_socket_config_caps_inbound_message_and_frame_size() {
        let cfg = ws_socket_config();
        // Both caps must be set to MAX_MESSAGE_BYTES, overriding tungstenite's
        // 64 MiB / 16 MiB defaults so an oversize frame is rejected on read.
        assert_eq!(cfg.max_message_size, Some(MAX_MESSAGE_BYTES));
        assert_eq!(cfg.max_frame_size, Some(MAX_MESSAGE_BYTES));
        // A hard cap, never the "no limit" sentinel.
        assert!(cfg.max_message_size.is_some());
        assert!(cfg.max_frame_size.is_some());
        // Sanity: the cap is well below tungstenite's defaults it replaces.
        assert!(cfg.max_message_size.unwrap() <= 64 << 20);
        assert!(cfg.max_frame_size.unwrap() <= 16 << 20);
    }

    // --- Registry + concurrent-connection cap ---------------------------

    #[test]
    fn registry_assigns_unique_ids() {
        let reg = ConnRegistry::default();
        let mut ids = std::collections::HashSet::new();
        for _ in 0..MAX_CONNECTIONS {
            let (id, _rx) = reg.register_ws().expect("under cap");
            assert!(ids.insert(id), "duplicate id {}", id);
        }
    }

    #[test]
    fn registry_enforces_concurrent_connection_cap() {
        let reg = ConnRegistry::default();
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            assert!(reg.has_capacity());
            held.push(reg.register_ws().expect("under cap").0);
        }
        // Cap reached: the next WS and SSE registrations both fail closed.
        assert!(!reg.has_capacity());
        assert_eq!(reg.register_ws().err(), Some(RegisterError::TooManyConnections));
        assert_eq!(reg.register_sse().err(), Some(RegisterError::TooManyConnections));
        assert_eq!(reg.active_count(), MAX_CONNECTIONS);

        // Freeing one slot lets exactly one more in.
        reg.unregister(held[0]);
        assert!(reg.has_capacity());
        assert!(reg.register_sse().is_ok());
        assert!(!reg.has_capacity());
    }

    #[test]
    fn registry_unregister_is_idempotent_and_drains() {
        let reg = ConnRegistry::default();
        let (a, _ra) = reg.register_ws().unwrap();
        let (b, _rb) = reg.register_sse().unwrap();
        assert_eq!(reg.active_count(), 2);
        assert_eq!(reg.kind_of(a), Some(ConnKind::WebSocket));
        assert_eq!(reg.kind_of(b), Some(ConnKind::Sse));

        reg.unregister(a);
        assert_eq!(reg.active_count(), 1);
        reg.unregister(a); // idempotent no-op
        reg.unregister(999); // unknown id no-op
        assert_eq!(reg.active_count(), 1);
        reg.unregister(b);
        assert_eq!(reg.active_count(), 0, "registry fully drained, no leak");
    }

    #[test]
    fn registry_close_reports_known_vs_unknown_ids() {
        let reg = ConnRegistry::default();
        let (id, _rx) = reg.register_ws().unwrap();
        assert!(reg.request_close(id), "known id closes");
        assert!(!reg.request_close(999_999), "unknown id reports false");
    }

    #[test]
    fn registry_send_rejects_unknown_id_and_wrong_kind() {
        let reg = ConnRegistry::default();
        let (sse_id, _rx) = reg.register_sse().unwrap();
        // Sending to an SSE connection is a kind mismatch.
        assert_eq!(
            reg.send_ws(sse_id, WsMessage::Text("x".into())),
            Err("WS_FETCH_WRONG_KIND".to_string())
        );
        // Sending to an unknown id reports not-connected.
        assert_eq!(
            reg.send_ws(424_242, WsMessage::Text("x".into())),
            Err("WS_FETCH_NOT_CONNECTED".to_string())
        );
    }

    // --- RAII cleanup guard ---------------------------------------------

    #[test]
    fn registry_guard_unregisters_on_drop() {
        let reg = Arc::new(ConnRegistry::default());
        let (id, _rx) = reg.register_ws().unwrap();
        assert_eq!(reg.active_count(), 1);
        {
            let _guard = RegistryGuard {
                registry: reg.clone(),
                id,
            };
        } // dropped here
        assert_eq!(reg.active_count(), 0, "guard drop removes the slot");
    }

    #[test]
    fn registry_guard_unregisters_even_on_panic() {
        let reg = Arc::new(ConnRegistry::default());
        let (id, _rx) = reg.register_sse().unwrap();
        let reg_for_thread = reg.clone();
        let result = std::panic::catch_unwind(move || {
            let _guard = RegistryGuard {
                registry: reg_for_thread,
                id,
            };
            panic!("simulated task panic");
        });
        assert!(result.is_err(), "closure was expected to panic");
        assert_eq!(
            reg.active_count(),
            0,
            "guard drop during unwind must free the slot"
        );
    }

    // --- base64 round-trip (binary frames) ------------------------------

    #[test]
    fn b64_round_trips_known_vectors() {
        for (raw, enc) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(b64_encode(raw), enc);
            assert_eq!(b64_decode(enc).unwrap(), raw);
        }
    }

    #[test]
    fn b64_decode_rejects_malformed_input() {
        assert!(b64_decode("Zg=").is_err()); // wrong length
        assert!(b64_decode("****").is_err()); // bad alphabet
        assert!(b64_decode("Z===").is_err()); // too much padding
    }

    // --- SSE line parser -------------------------------------------------

    #[test]
    fn sse_parses_a_simple_event() {
        let mut b = SseEventBuilder::default();
        assert!(sse_feed_line(&mut b, "data: hello").is_none());
        let done = sse_feed_line(&mut b, "").expect("blank line ends event");
        assert_eq!(done, (None, Some("hello".to_string()), None));
    }

    #[test]
    fn sse_parses_event_name_id_and_multiline_data() {
        let mut b = SseEventBuilder::default();
        sse_feed_line(&mut b, "event: tick");
        sse_feed_line(&mut b, "id: 42");
        sse_feed_line(&mut b, "data: line one");
        sse_feed_line(&mut b, "data: line two");
        let done = sse_feed_line(&mut b, "").expect("event completes");
        assert_eq!(
            done,
            (
                Some("tick".to_string()),
                Some("line one\nline two".to_string()),
                Some("42".to_string()),
            )
        );
    }

    #[test]
    fn sse_ignores_comments_and_handles_no_leading_space() {
        let mut b = SseEventBuilder::default();
        assert!(sse_feed_line(&mut b, ": this is a comment").is_none());
        // No space after colon is still valid.
        sse_feed_line(&mut b, "data:nospace");
        let done = sse_feed_line(&mut b, "").unwrap();
        assert_eq!(done, (None, Some("nospace".to_string()), None));
    }

    #[test]
    fn sse_blank_line_with_no_fields_yields_nothing() {
        let mut b = SseEventBuilder::default();
        assert!(sse_feed_line(&mut b, "").is_none());
        assert!(b.is_empty());
    }

    #[test]
    fn sse_field_with_no_colon_is_empty_value() {
        let mut b = SseEventBuilder::default();
        sse_feed_line(&mut b, "data");
        let done = sse_feed_line(&mut b, "").unwrap();
        // A bare `data` line contributes an empty data line.
        assert_eq!(done, (None, Some(String::new()), None));
    }

    #[test]
    fn sse_unknown_fields_and_retry_are_ignored() {
        let mut b = SseEventBuilder::default();
        sse_feed_line(&mut b, "retry: 5000");
        sse_feed_line(&mut b, "unknown: junk");
        sse_feed_line(&mut b, "data: real");
        let done = sse_feed_line(&mut b, "").unwrap();
        assert_eq!(done, (None, Some("real".to_string()), None));
    }
}
