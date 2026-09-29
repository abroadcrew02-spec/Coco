//! #359 — `src/store/updater.ts`'s `fetchRawManifest()` used to call the
//! renderer's own `fetch()` straight at GitHub Releases. GitHub never returns
//! CORS headers on that response, so the call always fails from
//! `http://tauri.localhost` and `rollout` (the staged-rollout gate) reads as
//! `null` — silently disabling the gate. This is why v0.8.4's 0% rollout
//! hold never actually held anything (まつり's measurement). This command
//! performs the GET from the Rust side instead, where CORS doesn't apply.
//!
//! Deliberately takes no argument: the URL is fixed to the same endpoint
//! configured in `tauri.conf.json`'s `plugins.updater.endpoints[0]`. Because
//! the caller can never supply a URL, this sits outside the allow-list / SSRF
//! machinery in `http_fetch.rs` — that machinery exists specifically to
//! screen a *caller-controlled* URL (e.g. one a workbook script could pass);
//! there is nothing to screen here.

use std::time::Duration;

/// Must match `plugins.updater.endpoints[0]` in `src-tauri/tauri.conf.json`
/// exactly. Not read back from the Tauri config at runtime: `tauri::Config`
/// exposes plugin config as an untyped per-plugin JSON blob with no typed
/// accessor for the updater plugin's `endpoints` array in the `tauri`/
/// `tauri-plugin-updater` versions this project pins, and no other command
/// in this file tree reads its own plugin config back that way either —
/// duplicating the literal here (like the endpoint's pinned pubkey sitting
/// beside it in the same config block) is the existing convention, not a
/// shortcut invented for this command.
/// ※要確認: if this ever drifts from tauri.conf.json, the updater check
/// silently starts hitting a stale/wrong URL instead of failing loudly —
/// worth a `/doc-sync`-style reminder if the endpoint is ever rotated.
const UPDATE_MANIFEST_URL: &str =
    "https://github.com/abroadcrew02-spec/Coco/releases/latest/download/latest.json";

const REQUEST_TIMEOUT_SECS: u64 = 10;

/// `latest.json` is a small hand-written document (version/path/notes/
/// rollout); 1 MiB is generous headroom against a compromised or
/// misbehaving host, not a real-world expectation for its size.
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// No existing User-Agent convention was found anywhere else in this crate
/// to match (`http_fetch.rs`'s client doesn't set one, and none of the other
/// `reqwest::Client::builder()` call sites do either — checked before
/// picking this). GitHub's own docs ask API/asset clients to identify
/// themselves, so one is set here regardless.
fn user_agent() -> String {
    format!("Nicel-Updater/{}", env!("CARGO_PKG_VERSION"))
}

/// Fetches `url` and returns the response body verbatim as a UTF-8 string.
/// `timeout` bounds the whole request (connect + read), reqwest's own
/// end-to-end timeout — the same mechanism `http_fetch.rs` uses for its main
/// request, just without that file's separate DNS-lookup timeout (there is
/// no manual resolve-and-pin step here; see the module doc comment for why).
///
/// Redirects ARE followed (reqwest's default policy, capped at 10 hops) —
/// the opposite of `http_fetch.rs`, which disables them. GitHub's
/// `/releases/latest/download/...` always 302s to the real asset host, and
/// unlike `http_fetch.rs` there is no caller-supplied URL a redirect could
/// use to smuggle a request off an allow list, since `url` here is always
/// one of exactly two things: the fixed production constant, or a test's own
/// local server.
///
/// Every error collapses to a short, generic tag; the underlying `reqwest`
/// error (which can embed the URL, headers, or partial response) is only
/// ever logged via `log::warn!`, never returned to the caller.
pub async fn fetch_manifest_from(url: &str, timeout: Duration) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(user_agent())
        .build()
        .map_err(|e| {
            log::warn!("updater_fetch_manifest client build failed: {e}");
            "UPDATER_FETCH_INTERNAL".to_string()
        })?;

    let resp = client.get(url).send().await.map_err(|e| {
        log::warn!("updater_fetch_manifest request failed: {e}");
        if e.is_timeout() {
            "UPDATER_FETCH_TIMEOUT".to_string()
        } else if e.is_connect() {
            "UPDATER_FETCH_CONNECT_FAILED".to_string()
        } else {
            "UPDATER_FETCH_FAILED".to_string()
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        log::warn!("updater_fetch_manifest non-2xx status: {}", status.as_u16());
        return Err(format!("UPDATER_FETCH_HTTP_{}", status.as_u16()));
    }

    let bytes = resp.bytes().await.map_err(|e| {
        log::warn!("updater_fetch_manifest read body failed: {e}");
        "UPDATER_FETCH_READ_FAILED".to_string()
    })?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        log::warn!(
            "updater_fetch_manifest response too large: {} bytes",
            bytes.len()
        );
        return Err("UPDATER_FETCH_RESPONSE_TOO_LARGE".to_string());
    }

    // Strict UTF-8, not `from_utf8_lossy`: this response is supposed to be
    // `latest.json`. A non-UTF-8 body means something is badly wrong
    // (corrupted transfer, compromised host) and the TS-side `JSON.parse`
    // would reject a lossily-mangled body anyway — better to fail loudly
    // here than hand back silently-corrupted "success".
    String::from_utf8(bytes.to_vec()).map_err(|e| {
        log::warn!("updater_fetch_manifest response was not valid UTF-8: {e}");
        "UPDATER_FETCH_INVALID_ENCODING".to_string()
    })
}

/// Pure-Rust core: always targets the fixed `UPDATE_MANIFEST_URL` with the
/// production timeout.
pub async fn updater_fetch_manifest_core() -> Result<String, String> {
    fetch_manifest_from(UPDATE_MANIFEST_URL, Duration::from_secs(REQUEST_TIMEOUT_SECS)).await
}

#[tauri::command]
pub async fn updater_fetch_manifest() -> Result<String, String> {
    updater_fetch_manifest_core().await
}
