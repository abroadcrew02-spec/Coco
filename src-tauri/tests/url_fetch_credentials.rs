// Integration tests for UrlFetch credential persistence (issue #180).
//
// These exercise the store-injected core functions with an in-memory secret
// store, so they never touch a real OS keychain — safe in CI. They verify the
// CRUD round-trip, host matching, and that listed summaries never carry the
// secret value.

use coco_lib::commands::url_fetch_credentials::{
    best_match, delete_credential_core, list_credentials_core, parse_index, resolve_credential,
    set_credential_core, CredentialIndexEntry, CredentialInput, CredentialKind, InMemoryStore,
};

fn bearer(host: &str, secret: &str) -> CredentialInput {
    CredentialInput {
        host: host.into(),
        kind: CredentialKind::Bearer,
        secret: secret.into(),
        header_name: None,
        token_url: None,
        client_id: None,
        scope: None,
    }
}

#[test]
fn crud_round_trip_with_in_memory_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = InMemoryStore::default();

    // Create.
    set_credential_core(dir.path(), &store, bearer("api.example.com", "secret-1")).unwrap();
    set_credential_core(dir.path(), &store, bearer("*.other.com", "secret-2")).unwrap();

    // List — masked summaries only, no secret material.
    let listed = list_credentials_core(dir.path()).unwrap();
    assert_eq!(listed.len(), 2);
    let json = serde_json::to_string(&listed).unwrap();
    assert!(!json.contains("secret-1"));
    assert!(!json.contains("secret-2"));
    assert!(listed.iter().all(|s| s.configured));

    // Resolve pulls the secret from the store.
    let m = resolve_credential(dir.path(), &store, "api.example.com")
        .unwrap()
        .unwrap();
    assert_eq!(m.secret, "secret-1");
    assert_eq!(m.entry.kind, CredentialKind::Bearer);

    // Wildcard match.
    let w = resolve_credential(dir.path(), &store, "sub.other.com")
        .unwrap()
        .unwrap();
    assert_eq!(w.secret, "secret-2");

    // Delete.
    delete_credential_core(dir.path(), &store, "api.example.com").unwrap();
    assert_eq!(list_credentials_core(dir.path()).unwrap().len(), 1);
    assert!(resolve_credential(dir.path(), &store, "api.example.com")
        .unwrap()
        .is_none());
}

#[test]
fn host_with_no_credential_resolves_to_none() {
    let dir = tempfile::tempdir().unwrap();
    let store = InMemoryStore::default();
    set_credential_core(dir.path(), &store, bearer("api.example.com", "x")).unwrap();
    assert!(resolve_credential(dir.path(), &store, "unrelated.com")
        .unwrap()
        .is_none());
}

#[test]
fn best_match_picks_most_specific_pattern() {
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
            host: "api.example.com".into(),
            kind: CredentialKind::Bearer,
            header_name: None,
            token_url: None,
            client_id: None,
            scope: None,
        },
    ];
    assert_eq!(
        best_match("api.example.com", &index).unwrap().host,
        "api.example.com"
    );
    assert_eq!(
        best_match("cdn.example.com", &index).unwrap().host,
        "*.example.com"
    );
    assert!(best_match("example.org", &index).is_none());
}

#[test]
fn parse_index_is_tolerant_of_corrupt_db_value() {
    assert!(parse_index(Some("garbage")).is_empty());
    assert!(parse_index(Some("")).is_empty());
    assert!(parse_index(None).is_empty());
}

#[test]
fn api_key_credential_uses_custom_header() {
    let dir = tempfile::tempdir().unwrap();
    let store = InMemoryStore::default();
    set_credential_core(
        dir.path(),
        &store,
        CredentialInput {
            host: "api.example.com".into(),
            kind: CredentialKind::ApiKey,
            secret: "key-abc".into(),
            header_name: Some("X-Api-Key".into()),
            token_url: None,
            client_id: None,
            scope: None,
        },
    )
    .unwrap();
    let listed = list_credentials_core(dir.path()).unwrap();
    assert_eq!(listed[0].kind, CredentialKind::ApiKey);
    assert_eq!(listed[0].header_name.as_deref(), Some("X-Api-Key"));
    let m = resolve_credential(dir.path(), &store, "api.example.com")
        .unwrap()
        .unwrap();
    assert_eq!(m.secret, "key-abc");
}
