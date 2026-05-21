// UrlFetch credential persistence (issue #180, follow-up of #138).
//
// Stores per-host authentication credentials for the `http_fetch` command so
// callers no longer have to pass an `Authorization` header on every request.
//
// Security design
// - SECRET material (Bearer token, API key, OAuth client secret / refresh
//   token) is NEVER written to the app DB or any plain file. It lives only in
//   the OS secure store via the `keyring` crate (Windows Credential Manager /
//   macOS Keychain / Linux Secret Service). The DB only holds a non-secret
//   *index*: which host patterns have a credential, the credential kind, and
//   non-secret OAuth parameters (token endpoint, client id). This index lets
//   the UI render a masked list without ever touching the secret.
// - The list command returns only `configured: true` plus the kind — never the
//   token value — so the renderer (and any user macro) cannot exfiltrate it.
// - Secrets are never logged: error paths log opaque context only.
//
// OAuth 2.0 — see the note above `http_fetch`'s auto-attach logic and the
// report. Client-credentials flow is implemented end to end (token endpoint
// POST -> access_token, with a short in-memory cache); the long-term refresh
// token storage hook is the `oauth_refresh` keyring suffix.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::db::app_db::open_app_db_at;

/// DB settings key holding the non-secret credential index (JSON array).
pub const CREDENTIAL_INDEX_KEY: &str = "urlFetch.credentialHosts";

/// `keyring` service name. The account is the lower-cased host pattern,
/// optionally suffixed (see `keyring_account`).
const KEYRING_SERVICE: &str = "coco-urlfetch";

/// Kind of credential attached to a host pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    /// A literal Bearer token. Sent as `Authorization: Bearer <token>`.
    Bearer,
    /// An API key sent verbatim in a caller-named header (default
    /// `Authorization`). Stored value is the raw key.
    ApiKey,
    /// OAuth 2.0 client-credentials grant. The secret store holds the client
    /// secret; the index holds the token endpoint + client id.
    OauthClientCredentials,
}

/// Non-secret index entry persisted in the app DB. No token material here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialIndexEntry {
    /// Host pattern this credential applies to (same grammar as the allow
    /// list: exact host or `*.example.com`). Lower-cased.
    pub host: String,
    pub kind: CredentialKind,
    /// Header name for `ApiKey` credentials. `None` => `Authorization`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub header_name: Option<String>,
    /// OAuth token endpoint URL (only for `OauthClientCredentials`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token_url: Option<String>,
    /// OAuth client id (only for `OauthClientCredentials`). Not secret.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_id: Option<String>,
    /// OAuth scope string (only for `OauthClientCredentials`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub scope: Option<String>,
}

/// What the renderer sees in the list command: never the secret value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub host: String,
    pub kind: CredentialKind,
    pub header_name: Option<String>,
    pub token_url: Option<String>,
    pub client_id: Option<String>,
    pub scope: Option<String>,
    /// Always true for a listed entry — present so the UI can render a masked
    /// `••••` placeholder without inspecting the secret store.
    pub configured: bool,
}

impl From<&CredentialIndexEntry> for CredentialSummary {
    fn from(e: &CredentialIndexEntry) -> Self {
        CredentialSummary {
            host: e.host.clone(),
            kind: e.kind,
            header_name: e.header_name.clone(),
            token_url: e.token_url.clone(),
            client_id: e.client_id.clone(),
            scope: e.scope.clone(),
            configured: true,
        }
    }
}

/// Abstraction over the OS secure store so tests never touch a real keychain.
/// Implemented for real by `OsKeyringStore`; tests use `InMemoryStore`.
pub trait SecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// Production implementation: `keyring` -> OS secure storage.
pub struct OsKeyringStore;

impl SecretStore for OsKeyringStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| {
            log::warn!("url_fetch credential keyring open failed");
            let _ = e;
            "URL_FETCH_CRED_STORE_FAILED".to_string()
        })?;
        entry.set_password(secret).map_err(|e| {
            log::warn!("url_fetch credential keyring write failed");
            let _ = e;
            "URL_FETCH_CRED_STORE_FAILED".to_string()
        })
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| {
            log::warn!("url_fetch credential keyring open failed");
            let _ = e;
            "URL_FETCH_CRED_STORE_FAILED".to_string()
        })?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => {
                log::warn!("url_fetch credential keyring read failed");
                let _ = e;
                Err("URL_FETCH_CRED_STORE_FAILED".to_string())
            }
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| {
            log::warn!("url_fetch credential keyring open failed");
            let _ = e;
            "URL_FETCH_CRED_STORE_FAILED".to_string()
        })?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => {
                log::warn!("url_fetch credential keyring delete failed");
                let _ = e;
                Err("URL_FETCH_CRED_STORE_FAILED".to_string())
            }
        }
    }
}

/// In-memory store for unit tests. Process-local; never persists.
#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<HashMap<String, String>>,
}

impl SecretStore for InMemoryStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.inner
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.inner.lock().unwrap().get(account).cloned())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.inner.lock().unwrap().remove(account);
        Ok(())
    }
}

/// keyring account for the primary secret of a host pattern.
fn keyring_account(host: &str) -> String {
    host.to_ascii_lowercase()
}

/// keyring account for an OAuth client secret (kept separate from any future
/// refresh-token entry under the same host).
fn keyring_account_oauth_secret(host: &str) -> String {
    format!("{}#oauth_secret", host.to_ascii_lowercase())
}

/// Normalize/validate a host pattern. Mirrors `http_fetch::host_matches`
/// grammar: exact host or `*.suffix`. Rejects empty / whitespace / schemes.
pub fn normalize_host_pattern(raw: &str) -> Result<String, String> {
    let p = raw.trim().to_ascii_lowercase();
    if p.is_empty()
        || p.contains('/')
        || p.contains(' ')
        || p.contains(':')
        || p == "*"
    {
        return Err("URL_FETCH_CRED_BAD_HOST".to_string());
    }
    let body = p.strip_prefix("*.").unwrap_or(&p);
    if body.is_empty() || !body.contains('.') {
        return Err("URL_FETCH_CRED_BAD_HOST".to_string());
    }
    Ok(p)
}

/// Parse the JSON index. Tolerant: any error yields an empty index.
pub fn parse_index(raw: Option<&str>) -> Vec<CredentialIndexEntry> {
    let Some(s) = raw else { return Vec::new() };
    let s = s.trim();
    if s.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<CredentialIndexEntry>>(s).unwrap_or_default()
}

/// Serialize the index to JSON for DB storage.
fn serialize_index(index: &[CredentialIndexEntry]) -> Result<String, String> {
    serde_json::to_string(index).map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())
}

/// Specification of a credential to persist. Comes from the renderer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub host: String,
    pub kind: CredentialKind,
    /// Secret material. For Bearer/ApiKey this is the token/key; for OAuth
    /// client-credentials this is the client secret.
    pub secret: String,
    pub header_name: Option<String>,
    pub token_url: Option<String>,
    pub client_id: Option<String>,
    pub scope: Option<String>,
}

/// Result of matching a request host against the credential index.
#[derive(Debug, Clone)]
pub struct MatchedCredential {
    pub entry: CredentialIndexEntry,
    /// The secret value pulled from the secure store.
    pub secret: String,
}

/// Find the most specific index entry whose pattern matches `host`. Exact
/// matches win over wildcard matches; among wildcards the longest suffix wins.
pub fn best_match<'a>(
    host: &str,
    index: &'a [CredentialIndexEntry],
) -> Option<&'a CredentialIndexEntry> {
    let host = host.to_ascii_lowercase();
    let mut best: Option<&CredentialIndexEntry> = None;
    let mut best_score: isize = -1;
    for e in index {
        if !crate::commands::http_fetch::host_matches(&host, &e.host) {
            continue;
        }
        // Exact pattern => very high score; wildcard => suffix length.
        let score: isize = if e.host.starts_with("*.") {
            e.host.len() as isize
        } else {
            1_000_000
        };
        if score > best_score {
            best_score = score;
            best = Some(e);
        }
    }
    best
}

// --- core operations (pure, store-injected; used by tests) ---------------

/// Persist a credential: secret -> secure store, metadata -> DB index.
pub fn set_credential_core(
    data_dir: &Path,
    store: &dyn SecretStore,
    input: CredentialInput,
) -> Result<(), String> {
    let host = normalize_host_pattern(&input.host)?;
    if input.secret.is_empty() {
        return Err("URL_FETCH_CRED_EMPTY_SECRET".to_string());
    }
    if matches!(input.kind, CredentialKind::OauthClientCredentials) {
        let token_url = input
            .token_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let client_id = input
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if token_url.is_none() || client_id.is_none() {
            return Err("URL_FETCH_CRED_OAUTH_INCOMPLETE".to_string());
        }
    }

    // Write the secret first. For OAuth the secret is the client secret.
    let account = if matches!(input.kind, CredentialKind::OauthClientCredentials) {
        keyring_account_oauth_secret(&host)
    } else {
        keyring_account(&host)
    };
    store.set(&account, &input.secret)?;

    let entry = CredentialIndexEntry {
        host: host.clone(),
        kind: input.kind,
        header_name: input
            .header_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        token_url: input
            .token_url
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        client_id: input
            .client_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        scope: input
            .scope
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };

    let conn = open_app_db_at(data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, CREDENTIAL_INDEX_KEY)
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())?;
    let mut index = parse_index(raw.as_deref());
    index.retain(|e| e.host != host);
    index.push(entry);
    let json = serialize_index(&index)?;
    crate::db::operations::set_setting(&conn, CREDENTIAL_INDEX_KEY, &json)
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())?;
    Ok(())
}

/// Remove a credential: drop the secret from the store and the DB index entry.
pub fn delete_credential_core(
    data_dir: &Path,
    store: &dyn SecretStore,
    host: &str,
) -> Result<(), String> {
    let host = normalize_host_pattern(host)?;
    let conn = open_app_db_at(data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, CREDENTIAL_INDEX_KEY)
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())?;
    let mut index = parse_index(raw.as_deref());
    let removed = index.iter().find(|e| e.host == host).cloned();
    index.retain(|e| e.host != host);
    let json = serialize_index(&index)?;
    crate::db::operations::set_setting(&conn, CREDENTIAL_INDEX_KEY, &json)
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())?;

    // Best-effort secret removal. A stale secret with no index entry is
    // unreachable (list/match only consult the index) but we still clean up.
    if let Some(entry) = removed {
        let account = if matches!(entry.kind, CredentialKind::OauthClientCredentials) {
            keyring_account_oauth_secret(&host)
        } else {
            keyring_account(&host)
        };
        store.delete(&account)?;
    } else {
        // No index entry: try both account shapes opportunistically.
        let _ = store.delete(&keyring_account(&host));
        let _ = store.delete(&keyring_account_oauth_secret(&host));
    }
    Ok(())
}

/// List configured credentials as masked summaries (no secret values).
pub fn list_credentials_core(data_dir: &Path) -> Result<Vec<CredentialSummary>, String> {
    let conn = open_app_db_at(data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, CREDENTIAL_INDEX_KEY)
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())?;
    let index = parse_index(raw.as_deref());
    Ok(index.iter().map(CredentialSummary::from).collect())
}

/// Resolve the credential (if any) for a request host, pulling the secret from
/// the secure store. Returns `Ok(None)` when no host pattern matches.
pub fn resolve_credential(
    data_dir: &Path,
    store: &dyn SecretStore,
    host: &str,
) -> Result<Option<MatchedCredential>, String> {
    let conn = open_app_db_at(data_dir)?;
    let raw = crate::db::operations::get_setting(&conn, CREDENTIAL_INDEX_KEY)
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())?;
    let index = parse_index(raw.as_deref());
    let Some(entry) = best_match(host, &index) else {
        return Ok(None);
    };
    let account = if matches!(entry.kind, CredentialKind::OauthClientCredentials) {
        keyring_account_oauth_secret(&entry.host)
    } else {
        keyring_account(&entry.host)
    };
    let Some(secret) = store.get(&account)? else {
        // Index says configured but the secret is gone (e.g. user cleared the
        // OS store). Treat as "no credential" rather than erroring the fetch.
        log::warn!("url_fetch credential index/secret mismatch for a host");
        return Ok(None);
    };
    Ok(Some(MatchedCredential {
        entry: entry.clone(),
        secret,
    }))
}

// --- Tauri commands ------------------------------------------------------

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|_| "URL_FETCH_CRED_INTERNAL".to_string())
}

#[tauri::command]
pub fn url_fetch_set_credential(
    app: tauri::AppHandle,
    credential: CredentialInput,
) -> Result<(), String> {
    let dir = data_dir(&app)?;
    set_credential_core(&dir, &OsKeyringStore, credential)
}

#[tauri::command]
pub fn url_fetch_delete_credential(app: tauri::AppHandle, host: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    delete_credential_core(&dir, &OsKeyringStore, &host)
}

#[tauri::command]
pub fn url_fetch_list_credentials(
    app: tauri::AppHandle,
) -> Result<Vec<CredentialSummary>, String> {
    let dir = data_dir(&app)?;
    list_credentials_core(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_host_pattern_accepts_valid() {
        assert_eq!(
            normalize_host_pattern("  API.Example.com "),
            Ok("api.example.com".to_string())
        );
        assert_eq!(
            normalize_host_pattern("*.example.com"),
            Ok("*.example.com".to_string())
        );
    }

    #[test]
    fn normalize_host_pattern_rejects_bad() {
        for bad in [
            "",
            "   ",
            "*",
            "no-tld",
            "has space.com",
            "https://example.com",
            "example.com/path",
            "example.com:8080",
            "*.",
        ] {
            assert!(
                normalize_host_pattern(bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn parse_index_tolerates_garbage() {
        assert!(parse_index(None).is_empty());
        assert!(parse_index(Some("")).is_empty());
        assert!(parse_index(Some("not-json")).is_empty());
        assert!(parse_index(Some("{}")).is_empty());
    }

    #[test]
    fn best_match_prefers_exact_then_longest_wildcard() {
        let index = vec![
            CredentialIndexEntry {
                host: "*.example.com".into(),
                kind: CredentialKind::Bearer,
                header_name: None,
                token_url: None,
                client_id: None,
                scope: None,
            },
            CredentialIndexEntry {
                host: "*.api.example.com".into(),
                kind: CredentialKind::Bearer,
                header_name: None,
                token_url: None,
                client_id: None,
                scope: None,
            },
            CredentialIndexEntry {
                host: "v1.api.example.com".into(),
                kind: CredentialKind::Bearer,
                header_name: None,
                token_url: None,
                client_id: None,
                scope: None,
            },
        ];
        // Exact wins.
        assert_eq!(
            best_match("v1.api.example.com", &index).unwrap().host,
            "v1.api.example.com"
        );
        // Longest wildcard suffix wins.
        assert_eq!(
            best_match("v2.api.example.com", &index).unwrap().host,
            "*.api.example.com"
        );
        // Only the broad wildcard matches.
        assert_eq!(
            best_match("foo.example.com", &index).unwrap().host,
            "*.example.com"
        );
        // Nothing matches.
        assert!(best_match("other.com", &index).is_none());
    }

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn set_list_resolve_delete_bearer_round_trip() {
        let dir = tmp_dir();
        let store = InMemoryStore::default();

        set_credential_core(
            dir.path(),
            &store,
            CredentialInput {
                host: "api.example.com".into(),
                kind: CredentialKind::Bearer,
                secret: "tok-secret-123".into(),
                header_name: None,
                token_url: None,
                client_id: None,
                scope: None,
            },
        )
        .unwrap();

        // List exposes the entry but never the secret.
        let listed = list_credentials_core(dir.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].host, "api.example.com");
        assert!(listed[0].configured);
        assert_eq!(listed[0].kind, CredentialKind::Bearer);
        // Summary has no `secret` field at all — serialize and confirm.
        let json = serde_json::to_string(&listed[0]).unwrap();
        assert!(!json.contains("tok-secret-123"));

        // Resolve pulls the secret from the store.
        let m = resolve_credential(dir.path(), &store, "api.example.com")
            .unwrap()
            .unwrap();
        assert_eq!(m.secret, "tok-secret-123");

        // Delete drops both index and secret.
        delete_credential_core(dir.path(), &store, "api.example.com").unwrap();
        assert!(list_credentials_core(dir.path()).unwrap().is_empty());
        assert!(resolve_credential(dir.path(), &store, "api.example.com")
            .unwrap()
            .is_none());
        assert!(store.get(&keyring_account("api.example.com")).unwrap().is_none());
    }

    #[test]
    fn set_credential_replaces_existing_host() {
        let dir = tmp_dir();
        let store = InMemoryStore::default();
        let mk = |secret: &str| CredentialInput {
            host: "api.example.com".into(),
            kind: CredentialKind::Bearer,
            secret: secret.into(),
            header_name: None,
            token_url: None,
            client_id: None,
            scope: None,
        };
        set_credential_core(dir.path(), &store, mk("old")).unwrap();
        set_credential_core(dir.path(), &store, mk("new")).unwrap();
        assert_eq!(list_credentials_core(dir.path()).unwrap().len(), 1);
        let m = resolve_credential(dir.path(), &store, "api.example.com")
            .unwrap()
            .unwrap();
        assert_eq!(m.secret, "new");
    }

    #[test]
    fn set_credential_rejects_empty_secret() {
        let dir = tmp_dir();
        let store = InMemoryStore::default();
        let r = set_credential_core(
            dir.path(),
            &store,
            CredentialInput {
                host: "api.example.com".into(),
                kind: CredentialKind::Bearer,
                secret: "".into(),
                header_name: None,
                token_url: None,
                client_id: None,
                scope: None,
            },
        );
        assert_eq!(r.unwrap_err(), "URL_FETCH_CRED_EMPTY_SECRET");
    }

    #[test]
    fn oauth_requires_token_url_and_client_id() {
        let dir = tmp_dir();
        let store = InMemoryStore::default();
        let r = set_credential_core(
            dir.path(),
            &store,
            CredentialInput {
                host: "api.example.com".into(),
                kind: CredentialKind::OauthClientCredentials,
                secret: "client-secret".into(),
                header_name: None,
                token_url: None,
                client_id: Some("client-id".into()),
                scope: None,
            },
        );
        assert_eq!(r.unwrap_err(), "URL_FETCH_CRED_OAUTH_INCOMPLETE");
    }

    #[test]
    fn oauth_round_trip_stores_metadata_not_secret() {
        let dir = tmp_dir();
        let store = InMemoryStore::default();
        set_credential_core(
            dir.path(),
            &store,
            CredentialInput {
                host: "api.example.com".into(),
                kind: CredentialKind::OauthClientCredentials,
                secret: "client-secret-xyz".into(),
                header_name: None,
                token_url: Some("https://auth.example.com/token".into()),
                client_id: Some("client-id".into()),
                scope: Some("read".into()),
            },
        )
        .unwrap();
        let listed = list_credentials_core(dir.path()).unwrap();
        assert_eq!(listed[0].kind, CredentialKind::OauthClientCredentials);
        assert_eq!(
            listed[0].token_url.as_deref(),
            Some("https://auth.example.com/token")
        );
        assert_eq!(listed[0].client_id.as_deref(), Some("client-id"));
        let json = serde_json::to_string(&listed[0]).unwrap();
        assert!(!json.contains("client-secret-xyz"));
        // Secret resolvable from the store.
        let m = resolve_credential(dir.path(), &store, "api.example.com")
            .unwrap()
            .unwrap();
        assert_eq!(m.secret, "client-secret-xyz");
    }

    #[test]
    fn resolve_returns_none_when_secret_missing() {
        let dir = tmp_dir();
        let store = InMemoryStore::default();
        set_credential_core(
            dir.path(),
            &store,
            CredentialInput {
                host: "api.example.com".into(),
                kind: CredentialKind::Bearer,
                secret: "tok".into(),
                header_name: None,
                token_url: None,
                client_id: None,
                scope: None,
            },
        )
        .unwrap();
        // Simulate the user clearing the OS store out from under us.
        store.delete(&keyring_account("api.example.com")).unwrap();
        assert!(resolve_credential(dir.path(), &store, "api.example.com")
            .unwrap()
            .is_none());
    }
}
