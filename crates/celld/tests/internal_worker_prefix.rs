// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The internal Worker prefix contract, through the shipped binary.
//!
//! Each test starts `celld dev` on a temporary project whose Worker echoes the
//! pathname it parsed and the `x-celld-internal` value it received. Requests
//! are written as raw HTTP/1.1, so a request target such as
//! `/x/../internal` reaches celld exactly as written instead of being
//! normalized by a client library.

// The tests drive a real child process over real sockets, so they use the
// host clock and filesystem directly.
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const WORKER: &str = r#"export default {
  async fetch(request) {
    return Response.json({
      worker: true,
      path: new URL(request.url).pathname,
      marker: request.headers.get("x-celld-internal"),
    });
  },
};
"#;

const CONFIG: &str = r#"{
  "name": "internal-worker-prefix",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "no_bundle": true
}
"#;

const NOT_FOUND: &str = r#"{"error":"not_found"}"#;

struct Node {
    child: Child,
    public: SocketAddr,
    internal: SocketAddr,
    _project: tempfile::TempDir,
}

impl Node {
    /// Start `celld dev` with `CELLD_INTERNAL_WORKER_PREFIXES` set to
    /// `prefixes`, or unset for `None`, and wait until both listeners serve.
    fn start(prefixes: Option<&str>) -> Self {
        let project = tempfile::tempdir().expect("create the project directory");
        std::fs::write(project.path().join("index.js"), WORKER).expect("write the Worker");
        std::fs::write(project.path().join("wrangler.jsonc"), CONFIG).expect("write the config");
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .expect("reserve a public port")
            .port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_celld"));
        command
            .arg("dev")
            .arg(project.path())
            .args(["--port", &port.to_string(), "--logs", "--no-watch"])
            .env("NO_COLOR", "1")
            .env_remove("FORCE_COLOR")
            .env_remove("CELLD_INTERNAL_WORKER_PREFIXES")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(prefixes) = prefixes {
            command.env("CELLD_INTERNAL_WORKER_PREFIXES", prefixes);
        }
        let mut child = command.spawn().expect("start celld dev");
        let stderr = child.stderr.take().expect("piped stderr");
        let (lines_tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[celld dev] {line}");
                if lines_tx.send(line).is_err() {
                    // Keep draining so the child never blocks on a full pipe.
                    continue;
                }
            }
        });
        let mut node = Self {
            child,
            public: SocketAddr::from(([127, 0, 0, 1], port)),
            internal: SocketAddr::from(([127, 0, 0, 1], 0)),
            _project: project,
        };
        let deadline = Instant::now() + Duration::from_secs(180);
        let mut ready = false;
        while !ready || node.internal.port() == 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = match lines.recv_timeout(remaining) {
                Ok(line) => line,
                Err(error) => panic!("celld dev did not become ready: {error}"),
            };
            if let Some(rest) = line.split("celld internal listening on ").nth(1) {
                node.internal = rest
                    .split_whitespace()
                    .next()
                    .and_then(|address| address.parse().ok())
                    .expect("parse the internal listener address");
            }
            ready |= line.contains("ready") && line.contains(&format!("127.0.0.1:{port}"));
        }
        node
    }

    fn public(&self, target: &str, headers: &[(&str, &str)]) -> (u16, String) {
        request(self.public, target, headers)
    }

    fn internal(&self, target: &str, headers: &[(&str, &str)]) -> (u16, String) {
        request(self.internal, target, headers)
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        // SIGTERM lets the supervisor stop its node; SIGKILL would orphan the
        // node on a host without a parent-death signal.
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One `GET` with `Connection: close`, returning the status and the decoded
/// body.
fn request(address: SocketAddr, target: &str, headers: &[(&str, &str)]) -> (u16, String) {
    let mut stream = TcpStream::connect(address).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .expect("set a read timeout");
    let mut head = format!("GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .expect("write the request");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("read the response");
    let raw = String::from_utf8(raw).expect("a UTF-8 response");
    let (head, body) = raw.split_once("\r\n\r\n").expect("a response head");
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse().ok())
        .expect("a status code");
    let chunked = head.lines().any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with("transfer-encoding:") && line.contains("chunked")
    });
    let body = if chunked {
        dechunk(body)
    } else {
        body.to_string()
    };
    (status, body)
}

fn dechunk(mut body: &str) -> String {
    let mut decoded = String::new();
    loop {
        let (size, rest) = body.split_once("\r\n").expect("a chunk size");
        let size = usize::from_str_radix(size.trim(), 16).expect("a hex chunk size");
        if size == 0 {
            return decoded;
        }
        decoded.push_str(&rest[..size]);
        body = &rest[size + 2..];
    }
}

fn worker_saw(body: &str) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|error| panic!("expected the Worker's JSON, got {body:?}: {error}"));
    assert_eq!(value["worker"], true, "{body}");
    value
}

#[test]
fn a_configured_prefix_is_internal_only() {
    let node = Node::start(Some("/internal/"));

    // An internal request under the prefix reaches the Worker with the
    // marker that celld sets, replacing any value the client sent.
    for (target, path) in [
        ("/internal", "/internal"),
        ("/internal/quota", "/internal/quota"),
        ("/internal/quota/rules?limit=5", "/internal/quota/rules"),
    ] {
        let (status, body) = node.internal(target, &[]);
        assert_eq!(status, 200, "{target}: {body}");
        let saw = worker_saw(&body);
        assert_eq!(saw["path"], path, "{target}");
        assert_eq!(saw["marker"], "1", "{target}");
    }
    let (status, body) = node.internal(
        "/internal/quota",
        &[("X-Celld-Internal", "0"), ("x-celld-internal", "forged")],
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(worker_saw(&body)["marker"], "1");

    // Every other unknown internal path still gets celld's 404, including a
    // path that a reader could resolve out of the prefix.
    for target in [
        "/",
        "/other",
        "/internalx",
        "/internal-x/quota",
        "/Internal/quota",
        "/%69nternal/quota",
        "/x/../internal/quota",
        "/internal/../secret",
        "/internal/%2e%2e/secret",
        "/internal/..%2fsecret",
        "/internal/%252e%252e/secret",
    ] {
        let (status, body) = node.internal(target, &[]);
        assert_eq!((status, body.as_str()), (404, NOT_FOUND), "{target}");
    }

    // celld's own routes still answer on the internal listener.
    let (status, body) = node.internal("/state", &[]);
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains("\"worker\""), "{body}");

    // The public listener strips a forged marker on every path.
    for target in ["/", "/public/route", "/internalx"] {
        let (status, body) = node.public(target, &[("X-Celld-Internal", "1")]);
        assert_eq!(status, 200, "{target}: {body}");
        let saw = worker_saw(&body);
        assert_eq!(saw["marker"], serde_json::Value::Null, "{target}");
    }

    // The public listener refuses every reading of a path under the prefix,
    // without running the Worker.
    for target in [
        "/internal",
        "/internal/",
        "/internal/quota",
        "/internal/quota?limit=5",
        "/INTERNAL/quota",
        "/%69nternal/quota",
        "/x/../internal/quota",
        "/x/%2e%2e/internal/quota",
        "/x/..%2finternal/quota",
        "//internal/quota",
    ] {
        let (status, body) = node.public(target, &[("x-celld-internal", "1")]);
        assert_eq!((status, body.as_str()), (404, NOT_FOUND), "{target}");
    }
    let (status, body) = node.public(
        "/internal/quota",
        &[
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("Sec-WebSocket-Version", "13"),
        ],
    );
    assert_eq!(
        (status, body.as_str()),
        (404, NOT_FOUND),
        "WebSocket upgrade"
    );

    // A segment that only starts with the prefix is an ordinary public path.
    let (status, body) = node.public("/internalx/quota", &[]);
    assert_eq!(status, 200, "{body}");
    assert_eq!(worker_saw(&body)["path"], "/internalx/quota");
}

#[test]
fn no_prefix_leaves_routing_unchanged() {
    let node = Node::start(None);

    let (status, body) = node.internal("/internal/quota", &[]);
    assert_eq!((status, body.as_str()), (404, NOT_FOUND));

    let (status, body) = node.public("/internal/quota", &[]);
    assert_eq!(status, 200, "{body}");
    let saw = worker_saw(&body);
    assert_eq!(saw["path"], "/internal/quota");
    assert_eq!(saw["marker"], serde_json::Value::Null);

    // The marker is stripped even without a prefix, so a Worker that checks
    // it cannot be fooled by a node that lost its configuration.
    let (status, body) = node.public("/internal/quota", &[("x-celld-internal", "1")]);
    assert_eq!(status, 200, "{body}");
    assert_eq!(worker_saw(&body)["marker"], serde_json::Value::Null);
}

#[test]
fn startup_refuses_a_prefix_that_overlaps_a_celld_route() {
    for (args, env, reserved) in [
        (vec!["--internal-worker-prefix", "/state"], None, "/state"),
        (
            vec![
                "--internal-worker-prefix",
                "/internal",
                "--internal-worker-prefix",
                "/peer/probe",
            ],
            None,
            "/peer",
        ),
        (vec!["--region", "test"], Some("/internal,/do"), "/do"),
        (
            vec!["--internal-worker-prefix", "/.well-known/celld/health"],
            None,
            "/.well-known/celld",
        ),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_celld"));
        command
            .args(&args)
            .env_remove("CELLD_INTERNAL_WORKER_PREFIXES")
            .stdin(Stdio::null());
        if let Some(env) = env {
            command.env("CELLD_INTERNAL_WORKER_PREFIXES", env);
        }
        let output = command.output().expect("run celld");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{args:?} {env:?}: {stderr}");
        assert!(
            stderr.contains(&format!("overlaps celld's own route namespace {reserved}")),
            "{args:?} {env:?}: {stderr}"
        );
    }
}
