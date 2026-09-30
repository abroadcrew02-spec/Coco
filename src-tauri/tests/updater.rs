// #359: updater_fetch_manifest's pure-Rust core (`fetch_manifest_from`)
// against a local, hand-rolled HTTP/1.1 server — this crate has no existing
// mock-HTTP-server test helper (http_fetch.rs / ws_fetch.rs deliberately
// never open a real socket in tests, since their SSRF guards would reject
// localhost anyway; see the comments in tests/http_fetch_stream.rs and
// tests/ws_fetch.rs). `fetch_manifest_from` has no such guard — the URL is
// always either the fixed production constant or, here, a local test
// server — so pointing it at 127.0.0.1 is exactly the intended use.

use nicel_lib::commands::updater::fetch_manifest_from;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

/// Binds an ephemeral local port, spawns a thread that accepts exactly one
/// connection and hands it to `respond`, and returns the "http://127.0.0.1:PORT/"
/// URL to hit. `respond` is responsible for writing a complete HTTP/1.1
/// response (status line + headers + body) or, for the timeout test, writing
/// nothing at all.
fn spawn_once<F>(respond: F) -> String
where
    F: FnOnce(TcpStream) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local_addr");
    std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            respond(stream);
        }
    });
    format!("http://{addr}/")
}

/// Drains (and ignores) the request line/headers the client sent, then
/// writes a well-formed HTTP/1.1 response with an explicit Content-Length
/// and `Connection: close` so reqwest doesn't wait for more data.
fn write_response(mut stream: TcpStream, status_line: &str, body: &str) {
    let mut buf = [0u8; 1024];
    let _ = stream.read(&mut buf); // best-effort drain; content is irrelevant
    let response = format!(
        "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[tokio::test]
async fn returns_the_body_verbatim_on_200() {
    let body = r#"{"version":"0.8.5","rollout":50}"#;
    let url = spawn_once({
        let body = body.to_string();
        move |stream| write_response(stream, "HTTP/1.1 200 OK", &body)
    });

    let result = fetch_manifest_from(&url, Duration::from_secs(5)).await;
    assert_eq!(result.as_deref(), Ok(body));
}

#[tokio::test]
async fn a_404_status_is_an_error() {
    let url = spawn_once(|stream| write_response(stream, "HTTP/1.1 404 Not Found", ""));

    let result = fetch_manifest_from(&url, Duration::from_secs(5)).await;
    assert_eq!(result.unwrap_err(), "UPDATER_FETCH_HTTP_404");
}

#[tokio::test]
async fn a_500_status_is_an_error() {
    let url = spawn_once(|stream| write_response(stream, "HTTP/1.1 500 Internal Server Error", ""));

    let result = fetch_manifest_from(&url, Duration::from_secs(5)).await;
    assert_eq!(result.unwrap_err(), "UPDATER_FETCH_HTTP_500");
}

#[tokio::test]
async fn a_server_that_never_responds_times_out() {
    // Accept the connection but never write a byte back; hold it open well
    // past the (short, test-only) timeout below.
    let url = spawn_once(|stream| {
        std::thread::sleep(Duration::from_secs(2));
        drop(stream);
    });

    let result = fetch_manifest_from(&url, Duration::from_millis(200)).await;
    assert_eq!(result.unwrap_err(), "UPDATER_FETCH_TIMEOUT");
}

#[tokio::test]
async fn connecting_to_a_closed_port_is_an_error_not_a_panic() {
    // Bind, read the ephemeral port, then drop the listener immediately so
    // nothing is listening there anymore — a quick, deterministic stand-in
    // for "the endpoint is unreachable" without relying on external network
    // behavior.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let url = format!("http://{addr}/");

    let result = fetch_manifest_from(&url, Duration::from_secs(5)).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn oversized_response_is_rejected() {
    // One byte over MAX_MANIFEST_BYTES (1 MiB) — the cap this module
    // documents as "generous headroom, not a real-world expectation".
    let body = "x".repeat(1024 * 1024 + 1);
    let url = spawn_once({
        let body = body.clone();
        move |stream| write_response(stream, "HTTP/1.1 200 OK", &body)
    });

    let result = fetch_manifest_from(&url, Duration::from_secs(5)).await;
    assert_eq!(result.unwrap_err(), "UPDATER_FETCH_RESPONSE_TOO_LARGE");
}
