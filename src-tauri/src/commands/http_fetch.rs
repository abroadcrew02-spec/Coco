// External API connectivity (issue #138).
//
// Exposes a single Tauri command `http_fetch` that performs an HTTP GET/POST
// against an allow-listed domain. The allow list lives in the app settings
// table under the key `urlFetch.allowedDomains` (JSON array of host patterns).
//
// Design notes
// - Domain enforcement is the primary security boundary. We additionally
//   apply SSRF defenses (no loopback, no link-local, no private ranges, no
//   literal IPs, scheme restricted to http/https, redirects disabled) so a
//   misconfigured allow list cannot route a request to the cloud-metadata
//   endpoint or an internal service.
// - All user-visible error messages are opaque tags (e.g. `URL_FETCH_BLOCKED`).
//   Internal detail (`reqwest` cause chains) is logged via `log::warn!` but
//   never returned to the renderer, preventing the JS layer (and therefore
//   any user macro) from probing internal network topology.
// - Caps: 10 MiB request body, 10 MiB response body, 30 s total timeout.
// - Out of scope (tracked in follow-up issues): credential storage, streaming
//   responses, WebSocket/SSE, response cache.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::db::app_db::open_app_db_at;

pub const ALLOWED_DOMAINS_KEY: &str = "urlFetch.allowedDomains";
pub const MAX_BODY_BYTES: usize = 10 * 1024 * 1024; // 10 MiB
pub const REQUEST_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Parse the stored allow-list JSON. Tolerant: missing key, empty string and
/// invalid JSON all yield an empty list (the request will then be blocked).
pub fn parse_allowed_domains(raw: Option<&str>) -> Vec<String> {
    let Some(s) = raw else {
        return Vec::new();
    };
    let s = s.trim();
    if s.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<String>>(s) {
        Ok(list) => list
            .into_iter()
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Returns true if `host` is matched by `pattern`. Patterns are case-insensitive
/// hostnames. A leading `*.` permits one-or-more left-most labels:
/// `*.example.com` matches `a.example.com` and `a.b.example.com` but NOT bare
/// `example.com`. An exact pattern only matches that exact host.
pub fn host_matches(host: &str, pattern: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let pattern = pattern.to_ascii_lowercase();
    if let Some(suffix) = pattern.strip_prefix("*.") {
        if suffix.is_empty() {
            return false;
        }
        // host must be `something.<suffix>` — strictly longer than suffix and
        // end with `.<suffix>`.
        let dotted = format!(".{}", suffix);
        return host != suffix && host.ends_with(&dotted);
    }
    host == pattern
}

#[derive(Debug, PartialEq, Eq)]
pub enum UrlCheckError {
    InvalidUrl,
    DisallowedScheme,
    BlockedHost,
    NotAllowed,
}

impl UrlCheckError {
    pub fn tag(&self) -> &'static str {
        match self {
            UrlCheckError::InvalidUrl => "URL_FETCH_INVALID_URL",
            UrlCheckError::DisallowedScheme => "URL_FETCH_DISALLOWED_SCHEME",
            UrlCheckError::BlockedHost => "URL_FETCH_BLOCKED_HOST",
            UrlCheckError::NotAllowed => "URL_FETCH_NOT_ALLOWED",
        }
    }
}

/// SSRF check: reject loopback, link-local, unspecified, private and unique-
/// local addresses as well as literal IPs in the URL.
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
            // Some platforms accept numeric hosts as a `Host::Domain` when the
            // form is unusual (e.g. octal/hex). Belt-and-suspenders: try to
            // parse the raw name as an IP and reject if it is.
            if lower.parse::<IpAddr>().is_ok() {
                return true;
            }
            false
        }
    }
}

/// Validate the URL against scheme rules, SSRF rules and the allow list.
/// Returns the parsed URL on success.
pub fn validate_url(url_str: &str, allowed: &[String]) -> Result<Url, UrlCheckError> {
    let parsed = Url::parse(url_str).map_err(|_| UrlCheckError::InvalidUrl)?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(UrlCheckError::DisallowedScheme);
    }
    if is_blocked_host(&parsed) {
        return Err(UrlCheckError::BlockedHost);
    }
    let host = parsed
        .host_str()
        .ok_or(UrlCheckError::InvalidUrl)?
        .to_ascii_lowercase();
    if !allowed.iter().any(|p| host_matches(&host, p)) {
        return Err(UrlCheckError::NotAllowed);
    }
    Ok(parsed)
}

/// HTTP method whitelist: keep MVP scope to GET and POST per issue spec.
fn parse_method(method: &str) -> Result<reqwest::Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        _ => Err("URL_FETCH_METHOD_NOT_ALLOWED".to_string()),
    }
}

/// Header sanity-check. Disallow control chars and `\r`/`\n` (CRLF injection)
/// and reject hop-by-hop / pseudo headers that the client must not let the
/// caller forge.
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

/// True if `headers` already contains a header named `name` (case-insensitive).
fn has_header_ci(headers: &HashMap<String, String>, name: &str) -> bool {
    let want = name.to_ascii_lowercase();
    headers.keys().any(|k| k.to_ascii_lowercase() == want)
}

/// Pure async core. Takes the allow list and request shape; returns either
/// a populated `HttpResponse` or an opaque error tag.
///
/// `injected_auth` is an optional `(header_name, header_value)` pair resolved
/// from the stored credential index (#180). It is applied ONLY when the caller
/// did not already supply that header — explicit caller headers always win, so
/// a macro can override the stored credential per request.
pub async fn http_fetch_core(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    allowed: Vec<String>,
    injected_auth: Option<(String, String)>,
) -> Result<HttpResponse, String> {
    let parsed = validate_url(&url, &allowed).map_err(|e| e.tag().to_string())?;
    let m = parse_method(&method)?;
    let hdrs = headers.unwrap_or_default();
    validate_headers(&hdrs)?;
    if let Some(b) = body.as_ref() {
        if b.len() > MAX_BODY_BYTES {
            return Err("URL_FETCH_BODY_TOO_LARGE".to_string());
        }
    }
    if m == reqwest::Method::GET && body.as_ref().map_or(false, |b| !b.is_empty()) {
        return Err("URL_FETCH_GET_WITH_BODY".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        // Disable redirects: a 302 could otherwise bounce us off the allow
        // list (e.g. to 169.254.169.254). Callers can re-fetch the Location.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            log::warn!("http_fetch client build failed: {}", e);
            "URL_FETCH_INTERNAL".to_string()
        })?;

    let mut req = client.request(m.clone(), parsed);
    for (k, v) in &hdrs {
        req = req.header(k, v);
    }
    // Auto-attach the stored credential header, but only if the caller did not
    // already set a header of that name (explicit-wins precedence).
    if let Some((name, value)) = injected_auth {
        if !has_header_ci(&hdrs, &name) {
            req = req.header(&name, &value);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| {
        log::warn!("http_fetch request failed: {}", e);
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

    // Cap response body to MAX_BODY_BYTES. We read bytes (not text) so that
    // the cap is exact regardless of encoding; then decode lossily so the
    // renderer always sees valid UTF-8.
    let bytes = resp.bytes().await.map_err(|e| {
        log::warn!("http_fetch read body failed: {}", e);
        "URL_FETCH_READ_FAILED".to_string()
    })?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("URL_FETCH_RESPONSE_TOO_LARGE".to_string());
    }
    let body_str = String::from_utf8_lossy(&bytes).into_owned();

    Ok(HttpResponse {
        status,
        headers: resp_headers,
        body: body_str,
    })
}

/// Build the `(header_name, header_value)` to auto-attach for a matched
/// credential (#180). For OAuth client-credentials this performs the token
/// endpoint exchange. Returns `Ok(None)` only on a recoverable miss; hard
/// failures (e.g. token endpoint rejects the client) surface as an error tag.
async fn resolve_auth_header(
    cred: crate::commands::url_fetch_credentials::MatchedCredential,
    allowed: &[String],
) -> Result<Option<(String, String)>, String> {
    use crate::commands::url_fetch_credentials::CredentialKind;
    match cred.entry.kind {
        CredentialKind::Bearer => Ok(Some((
            "Authorization".to_string(),
            format!("Bearer {}", cred.secret),
        ))),
        CredentialKind::ApiKey => {
            let header = cred
                .entry
                .header_name
                .clone()
                .unwrap_or_else(|| "Authorization".to_string());
            Ok(Some((header, cred.secret)))
        }
        CredentialKind::OauthClientCredentials => {
            let token = oauth_client_credentials_token(&cred, allowed).await?;
            Ok(Some(("Authorization".to_string(), format!("Bearer {}", token))))
        }
    }
}

/// OAuth 2.0 client-credentials grant (RFC 6749 §4.4). POSTs
/// `grant_type=client_credentials` (+ client id/secret/scope) to the stored
/// token endpoint and returns the `access_token`. The token endpoint host is
/// validated against the same allow list / SSRF rules as any other fetch.
async fn oauth_client_credentials_token(
    cred: &crate::commands::url_fetch_credentials::MatchedCredential,
    allowed: &[String],
) -> Result<String, String> {
    let token_url = cred
        .entry
        .token_url
        .as_deref()
        .ok_or("URL_FETCH_OAUTH_MISCONFIGURED")?;
    let client_id = cred
        .entry
        .client_id
        .as_deref()
        .ok_or("URL_FETCH_OAUTH_MISCONFIGURED")?;
    // The token endpoint must itself be on the allow list — no SSRF escape.
    validate_url(token_url, allowed).map_err(|e| e.tag().to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            log::warn!("oauth client build failed: {}", e);
            "URL_FETCH_INTERNAL".to_string()
        })?;

    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "client_credentials"),
        ("client_id", client_id),
        ("client_secret", &cred.secret),
    ];
    if let Some(scope) = cred.entry.scope.as_deref() {
        if !scope.is_empty() {
            form.push(("scope", scope));
        }
    }

    let resp = client
        .post(token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| {
            log::warn!("oauth token request failed: {}", e);
            "URL_FETCH_OAUTH_FAILED".to_string()
        })?;
    if !resp.status().is_success() {
        log::warn!("oauth token endpoint returned non-2xx");
        return Err("URL_FETCH_OAUTH_FAILED".to_string());
    }
    let bytes = resp.bytes().await.map_err(|e| {
        log::warn!("oauth token body read failed: {}", e);
        "URL_FETCH_OAUTH_FAILED".to_string()
    })?;
    #[derive(serde::Deserialize)]
    struct TokenResponse {
        access_token: String,
    }
    let parsed: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
        log::warn!("oauth token response missing access_token");
        "URL_FETCH_OAUTH_FAILED".to_string()
    })?;
    if parsed.access_token.is_empty() {
        return Err("URL_FETCH_OAUTH_FAILED".to_string());
    }
    Ok(parsed.access_token)
}

/// Pure-Rust core used by tests: reads the allow list from the app DB at a
/// caller-supplied data dir.
pub async fn http_fetch_with_data_dir(
    data_dir: &Path,
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let conn = open_app_db_at(data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, ALLOWED_DOMAINS_KEY)
        .map_err(|e| {
            log::warn!("http_fetch settings read failed: {}", e);
            "URL_FETCH_INTERNAL".to_string()
        })?;
    let allowed = parse_allowed_domains(raw.as_deref());
    drop(conn);

    // #180: resolve a stored credential for the request host (if any) and turn
    // it into a header to auto-attach. We resolve before the request so the
    // OAuth token exchange (which may itself hit the network) happens up front.
    let injected_auth = match Url::parse(&url).ok().and_then(|u| {
        u.host_str().map(|h| h.to_ascii_lowercase())
    }) {
        Some(host) => {
            match crate::commands::url_fetch_credentials::resolve_credential(
                data_dir,
                &crate::commands::url_fetch_credentials::OsKeyringStore,
                &host,
            ) {
                Ok(Some(cred)) => resolve_auth_header(cred, &allowed).await?,
                Ok(None) => None,
                Err(e) => {
                    // A credential-store hiccup must not silently downgrade an
                    // authenticated call to an unauthenticated one — fail loud.
                    log::warn!("http_fetch credential resolve failed");
                    return Err(e);
                }
            }
        }
        None => None,
    };

    http_fetch_core(url, method, headers, body, allowed, injected_auth).await
}

#[tauri::command]
pub async fn http_fetch(
    app: tauri::AppHandle,
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "URL_FETCH_INTERNAL".to_string())?;
    http_fetch_with_data_dir(&data_dir, url, method, headers, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_allowed_domains_handles_missing_and_invalid() {
        assert!(parse_allowed_domains(None).is_empty());
        assert!(parse_allowed_domains(Some("")).is_empty());
        assert!(parse_allowed_domains(Some("not-json")).is_empty());
        assert_eq!(
            parse_allowed_domains(Some(r#"["Example.com", " api.foo.io "]"#)),
            vec!["example.com".to_string(), "api.foo.io".to_string()]
        );
    }

    #[test]
    fn host_matches_exact_and_wildcard() {
        assert!(host_matches("example.com", "example.com"));
        assert!(host_matches("EXAMPLE.COM", "example.com"));
        assert!(!host_matches("a.example.com", "example.com"));

        assert!(host_matches("a.example.com", "*.example.com"));
        assert!(host_matches("a.b.example.com", "*.example.com"));
        // Bare apex does NOT match wildcard.
        assert!(!host_matches("example.com", "*.example.com"));
        // Different domain does not match.
        assert!(!host_matches("evil.com", "*.example.com"));
        // Suffix-only attack (`foo-example.com`) must not match.
        assert!(!host_matches("foo-example.com", "*.example.com"));
    }

    #[test]
    fn validate_url_rejects_non_http() {
        assert_eq!(
            validate_url("file:///etc/passwd", &["example.com".into()]),
            Err(UrlCheckError::DisallowedScheme)
        );
        assert_eq!(
            validate_url("ftp://example.com/", &["example.com".into()]),
            Err(UrlCheckError::DisallowedScheme)
        );
        assert_eq!(
            validate_url("javascript:alert(1)", &["example.com".into()]),
            Err(UrlCheckError::DisallowedScheme)
        );
    }

    #[test]
    fn validate_url_rejects_loopback_and_metadata() {
        let allow = vec!["*".into()]; // even with permissive list, blocked
        for u in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://10.0.0.1/",
            "http://192.168.1.1/",
            "http://172.16.0.1/",
            "http://service.internal/",
            "http://api.local/",
        ] {
            let r = validate_url(u, &allow);
            assert!(
                matches!(r, Err(UrlCheckError::BlockedHost) | Err(UrlCheckError::NotAllowed)),
                "URL {} should be blocked, got {:?}",
                u,
                r
            );
        }
    }

    #[test]
    fn validate_url_rejects_when_host_not_on_allow_list() {
        assert_eq!(
            validate_url("https://evil.com/", &["example.com".into()]),
            Err(UrlCheckError::NotAllowed)
        );
    }

    #[test]
    fn validate_url_allows_exact_and_wildcard() {
        let allow = vec!["example.com".into(), "*.api.example.org".into()];
        assert!(validate_url("https://example.com/path", &allow).is_ok());
        assert!(validate_url("https://v1.api.example.org/x", &allow).is_ok());
        // Bare apex must not match the wildcard.
        assert_eq!(
            validate_url("https://api.example.org/x", &allow),
            Err(UrlCheckError::NotAllowed)
        );
    }

    #[test]
    fn parse_method_only_allows_get_and_post() {
        assert!(parse_method("GET").is_ok());
        assert!(parse_method("post").is_ok());
        assert!(parse_method("PUT").is_err());
        assert!(parse_method("DELETE").is_err());
        assert!(parse_method("CONNECT").is_err());
    }

    #[test]
    fn validate_headers_rejects_crlf_and_forbidden() {
        let mut h = HashMap::new();
        h.insert("X-Test".into(), "ok".into());
        assert!(validate_headers(&h).is_ok());

        let mut bad = HashMap::new();
        bad.insert("X-Inject".into(), "a\r\nEvil: y".into());
        assert!(validate_headers(&bad).is_err());

        let mut hop = HashMap::new();
        hop.insert("Host".into(), "evil.com".into());
        assert!(validate_headers(&hop).is_err());

        let mut empty = HashMap::new();
        empty.insert("  ".into(), "v".into());
        assert!(validate_headers(&empty).is_err());
    }

    #[test]
    fn has_header_ci_is_case_insensitive() {
        let mut h = HashMap::new();
        h.insert("Authorization".to_string(), "Bearer x".to_string());
        assert!(has_header_ci(&h, "authorization"));
        assert!(has_header_ci(&h, "AUTHORIZATION"));
        assert!(has_header_ci(&h, "Authorization"));
        assert!(!has_header_ci(&h, "X-Api-Key"));
        // Empty header map: nothing is present.
        assert!(!has_header_ci(&HashMap::new(), "authorization"));
    }
}
