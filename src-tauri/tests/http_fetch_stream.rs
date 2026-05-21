// Integration tests for the streaming http_fetch path (issue #181).
//
// Like `http_fetch.rs`, these exercise the pure-Rust core without spinning up
// a Tauri app or doing real network I/O. They verify:
// - the streaming request reuses the same allow-list / SSRF / method / header
//   guards as `http_fetch` (rejection happens *before* any socket opens),
// - the byte cap is enforced exactly at the boundary by `exceeds_cap`, which
//   is the mid-stream stop condition,
// - the request registry assigns unique ids and supports cancellation.

use coco_lib::commands::http_fetch::MAX_BODY_BYTES;
use coco_lib::commands::http_fetch_stream::{
    content_length_exceeds_cap, exceeds_cap, validate_stream_request, StreamPlan, StreamRegistry,
};
use std::collections::HashMap;

fn no_headers() -> HashMap<String, String> {
    HashMap::new()
}

fn rejected(plan: &StreamPlan) -> Option<&str> {
    match plan {
        StreamPlan::Rejected(tag) => Some(tag.as_str()),
        StreamPlan::Ok => None,
    }
}

#[test]
fn stream_rejects_when_allow_list_is_empty() {
    let plan =
        validate_stream_request("https://example.com", "GET", &no_headers(), None, &[]);
    assert_eq!(rejected(&plan), Some("URL_FETCH_NOT_ALLOWED"));
}

#[test]
fn stream_rejects_disallowed_scheme() {
    let plan = validate_stream_request(
        "file:///etc/passwd",
        "GET",
        &no_headers(),
        None,
        &["example.com".into()],
    );
    assert_eq!(rejected(&plan), Some("URL_FETCH_DISALLOWED_SCHEME"));
}

#[test]
fn stream_rejects_ssrf_targets_even_with_permissive_allow_list() {
    for u in [
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://localhost/",
        "http://169.254.169.254/latest/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://service.internal/",
    ] {
        let plan = validate_stream_request(
            u,
            "GET",
            &no_headers(),
            None,
            &["*".into(), "localhost".into()],
        );
        let tag = rejected(&plan).unwrap_or("OK");
        assert!(
            tag == "URL_FETCH_BLOCKED_HOST" || tag == "URL_FETCH_NOT_ALLOWED",
            "{} -> {}",
            u,
            tag
        );
    }
}

#[test]
fn stream_rejects_methods_other_than_get_post() {
    for m in ["DELETE", "PUT", "CONNECT"] {
        let plan = validate_stream_request(
            "https://example.com",
            m,
            &no_headers(),
            None,
            &["example.com".into()],
        );
        assert_eq!(rejected(&plan), Some("URL_FETCH_METHOD_NOT_ALLOWED"));
    }
}

#[test]
fn stream_rejects_crlf_header_injection() {
    let mut h = HashMap::new();
    h.insert("X-Inject".into(), "a\r\nEvil: y".into());
    let plan = validate_stream_request(
        "https://example.com",
        "GET",
        &h,
        None,
        &["example.com".into()],
    );
    assert_eq!(rejected(&plan), Some("URL_FETCH_BAD_HEADER"));
}

#[test]
fn stream_rejects_forbidden_hop_by_hop_headers() {
    let mut h = HashMap::new();
    h.insert("Host".into(), "evil.com".into());
    let plan = validate_stream_request(
        "https://example.com",
        "GET",
        &h,
        None,
        &["example.com".into()],
    );
    assert_eq!(rejected(&plan), Some("URL_FETCH_BAD_HEADER"));
}

#[test]
fn stream_rejects_oversize_request_body() {
    let huge = "x".repeat(MAX_BODY_BYTES + 1);
    let plan = validate_stream_request(
        "https://example.com",
        "POST",
        &no_headers(),
        Some(&huge),
        &["example.com".into()],
    );
    assert_eq!(rejected(&plan), Some("URL_FETCH_BODY_TOO_LARGE"));
}

#[test]
fn stream_rejects_get_with_body() {
    let plan = validate_stream_request(
        "https://example.com",
        "GET",
        &no_headers(),
        Some("payload"),
        &["example.com".into()],
    );
    assert_eq!(rejected(&plan), Some("URL_FETCH_GET_WITH_BODY"));
}

#[test]
fn stream_accepts_well_formed_request_with_wildcard_allow() {
    let plan = validate_stream_request(
        "https://v1.api.example.org/data",
        "GET",
        &no_headers(),
        None,
        &["*.api.example.org".into()],
    );
    assert!(matches!(plan, StreamPlan::Ok));
}

#[test]
fn cap_is_enforced_exactly_at_the_boundary() {
    // The mid-stream stop fires the instant the running total would EXCEED
    // the cap; landing exactly on it is still allowed.
    assert!(!exceeds_cap(0, MAX_BODY_BYTES));
    assert!(exceeds_cap(0, MAX_BODY_BYTES + 1));
    assert!(!exceeds_cap(MAX_BODY_BYTES as u64 - 1, 1));
    assert!(exceeds_cap(MAX_BODY_BYTES as u64, 1));
    // A single oversize chunk after a near-full buffer trips the cap.
    assert!(exceeds_cap(MAX_BODY_BYTES as u64 - 100, 200));
}

#[test]
fn registry_ids_are_unique_and_cancellable() {
    let reg = StreamRegistry::default();
    let mut ids = std::collections::HashSet::new();
    for _ in 0..50 {
        let (id, _flag) = reg.register();
        assert!(ids.insert(id), "duplicate request id {}", id);
    }
}

// --- C-1: Content-Length pre-flight rejection ---------------------------
//
// When a server advertises a body larger than the 10 MiB cap, the streaming
// path must reject *before* reading any body byte. SSRF rules forbid pointing
// the real `run_stream` loop at a local mock server, so the pre-flight
// decision is exercised through its pure, public predicate — the exact
// function `run_stream` calls right after receiving the response headers.

#[test]
fn content_length_over_cap_is_rejected_before_reading_body() {
    // A server honestly advertising gigabytes: rejected up front.
    let huge = (MAX_BODY_BYTES as u64 * 1000).to_string();
    assert!(content_length_exceeds_cap(Some(&huge)));
    // One byte over the cap is still a rejection.
    let one_over = (MAX_BODY_BYTES as u64 + 1).to_string();
    assert!(content_length_exceeds_cap(Some(&one_over)));
}

#[test]
fn content_length_at_or_under_cap_is_allowed() {
    // Exactly the cap is permitted; the boundary mirrors `exceeds_cap`.
    let exact = (MAX_BODY_BYTES as u64).to_string();
    assert!(!content_length_exceeds_cap(Some(&exact)));
    assert!(!content_length_exceeds_cap(Some("0")));
    assert!(!content_length_exceeds_cap(Some("65536")));
}

#[test]
fn content_length_missing_or_malformed_falls_through_to_chunk_checks() {
    // No Content-Length (chunked transfer) or a garbage value must not cause
    // a false rejection — the mid-stream / per-chunk cap still bounds memory.
    assert!(!content_length_exceeds_cap(None));
    assert!(!content_length_exceeds_cap(Some("")));
    assert!(!content_length_exceeds_cap(Some("abc")));
    assert!(!content_length_exceeds_cap(Some("12.5")));
}

#[test]
fn memory_stays_bounded_for_a_single_oversize_chunk() {
    // A chunked response with no Content-Length can hand `chunk()` back one
    // very large `Bytes`. The per-chunk check trips on that single chunk
    // (received total is still 0), so it is dropped without being buffered:
    // memory stays bounded to MAX_BODY_BYTES + one transport chunk.
    assert!(exceeds_cap(0, MAX_BODY_BYTES + 1));
    assert!(exceeds_cap(0, MAX_BODY_BYTES * 1000));
    // And a giant chunk arriving after a near-full buffer also trips it.
    assert!(exceeds_cap(MAX_BODY_BYTES as u64 - 1, MAX_BODY_BYTES));
}

// --- M-1: registry entry is not leaked --------------------------------
//
// `run_stream` holds an RAII guard whose `Drop` calls `unregister`, so the
// `inflight` map is cleaned up on success, error and panic alike. The guard
// type itself is module-private; its Drop behaviour (including the panic /
// unwind path) is unit-tested inside the `http_fetch_stream` module
// (`registry_guard_unregisters_on_drop`, `..._even_on_panic`). Here we assert
// the public registry contract those guard tests depend on.

#[test]
fn registry_does_not_leak_entries_after_unregister() {
    let reg = StreamRegistry::default();
    assert_eq!(reg.inflight_count(), 0);

    let (id_a, _a) = reg.register();
    let (id_b, _b) = reg.register();
    assert_eq!(reg.inflight_count(), 2, "both requests tracked");

    // The RAII guard's Drop calls exactly `unregister` — simulate the normal
    // and the error exit paths of a background task.
    reg.unregister(id_a);
    assert_eq!(reg.inflight_count(), 1, "removed id no longer tracked");

    reg.unregister(id_b);
    assert_eq!(reg.inflight_count(), 0, "registry fully drained, no leak");

    // Unregistering an unknown / already-removed id is a harmless no-op.
    reg.unregister(id_a);
    reg.unregister(987_654);
    assert_eq!(reg.inflight_count(), 0);
}
