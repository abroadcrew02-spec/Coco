// Integration tests for the http_fetch command (issue #138).
//
// These tests exercise the pure-Rust core (`http_fetch_core` and the
// validation helpers) without spinning up a real Tauri app. They do not
// perform actual network I/O — they verify that the allow-list, SSRF
// defenses and method/header validation reject bad inputs *before* any
// socket would be opened.

use coco_lib::commands::http_fetch::{
    host_matches, http_fetch_core, parse_allowed_domains, validate_url, UrlCheckError,
};
use std::collections::HashMap;

#[tokio::test]
async fn fetch_rejects_when_allow_list_is_empty() {
    let r = http_fetch_core(
        "https://example.com".into(),
        "GET".into(),
        None,
        None,
        Vec::new(),
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_NOT_ALLOWED");
}

#[tokio::test]
async fn fetch_rejects_disallowed_scheme() {
    let r = http_fetch_core(
        "file:///etc/passwd".into(),
        "GET".into(),
        None,
        None,
        vec!["example.com".into()],
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_DISALLOWED_SCHEME");
}

#[tokio::test]
async fn fetch_rejects_loopback_even_when_allow_list_is_permissive() {
    for u in [
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://localhost/",
        "http://169.254.169.254/latest/",
    ] {
        let r = http_fetch_core(
            u.into(),
            "GET".into(),
            None,
            None,
            vec!["*".into(), "localhost".into()],
            None,
        )
        .await;
        let err = r.unwrap_err();
        assert!(
            err == "URL_FETCH_BLOCKED_HOST" || err == "URL_FETCH_NOT_ALLOWED",
            "{} -> {}",
            u,
            err
        );
    }
}

#[tokio::test]
async fn fetch_rejects_methods_other_than_get_post() {
    let r = http_fetch_core(
        "https://example.com".into(),
        "DELETE".into(),
        None,
        None,
        vec!["example.com".into()],
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_METHOD_NOT_ALLOWED");
}

#[tokio::test]
async fn fetch_rejects_oversize_request_body() {
    let huge = "x".repeat(11 * 1024 * 1024);
    let r = http_fetch_core(
        "https://example.com".into(),
        "POST".into(),
        None,
        Some(huge),
        vec!["example.com".into()],
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_BODY_TOO_LARGE");
}

#[tokio::test]
async fn fetch_rejects_get_with_body() {
    let r = http_fetch_core(
        "https://example.com".into(),
        "GET".into(),
        None,
        Some("not allowed".into()),
        vec!["example.com".into()],
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_GET_WITH_BODY");
}

#[tokio::test]
async fn fetch_rejects_crlf_header_injection() {
    let mut h = HashMap::new();
    h.insert("X-Inject".into(), "a\r\nEvil: y".into());
    let r = http_fetch_core(
        "https://example.com".into(),
        "GET".into(),
        Some(h),
        None,
        vec!["example.com".into()],
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_BAD_HEADER");
}

#[tokio::test]
async fn fetch_rejects_forbidden_hop_by_hop_headers() {
    let mut h = HashMap::new();
    h.insert("Host".into(), "evil.com".into());
    let r = http_fetch_core(
        "https://example.com".into(),
        "GET".into(),
        Some(h),
        None,
        vec!["example.com".into()],
        None,
    )
    .await;
    assert_eq!(r.unwrap_err(), "URL_FETCH_BAD_HEADER");
}

#[test]
fn allow_list_parses_and_matches_via_wildcard() {
    let list = parse_allowed_domains(Some(r#"["api.example.com", "*.foo.io"]"#));
    assert_eq!(list, vec!["api.example.com", "*.foo.io"]);
    assert!(validate_url("https://api.example.com/x", &list).is_ok());
    assert!(validate_url("https://a.foo.io/x", &list).is_ok());
    assert_eq!(
        validate_url("https://foo.io/x", &list),
        Err(UrlCheckError::NotAllowed)
    );
}

#[test]
fn host_matches_does_not_treat_suffix_substring_as_match() {
    assert!(!host_matches("evil-example.com", "*.example.com"));
    assert!(!host_matches("aexample.com", "example.com"));
}
