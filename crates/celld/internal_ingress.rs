// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Worker routes that only the internal listener serves.
//!
//! An operator can name path prefixes with `--internal-worker-prefix` or
//! `CELLD_INTERNAL_WORKER_PREFIXES`. The internal listener then sends a
//! request under one of them to the deployed Worker, with
//! `x-celld-internal: 1` set by celld. Every other unknown internal path
//! still returns celld's 404, so the listener cannot become a general
//! application entrance.
//!
//! The public listener removes `x-celld-internal` from every request, so a
//! Worker can treat the header as proof that the request came through the
//! internal listener. The public listener also answers 404 for a path under a
//! configured prefix and never runs the Worker for it. That refusal is in
//! celld rather than left to the Worker because the Worker reads the path
//! through its own parser and router: one route that forgets to check the
//! header, or a router that decodes `%69nternal` to `internal`, would publish
//! the route through the public listener. celld knows both the configuration
//! and the raw request target, so it can refuse every reading of the path in
//! one place.
//!
//! The two directions match differently on purpose:
//!
//! - The internal listener forwards only a canonical path: the URL parser
//!   leaves it unchanged, and both the path and its fully decoded form are
//!   under a prefix, compared case-sensitively. A path that a reader could
//!   resolve outside the prefix (`..`, `%2e%2e`, an encoded slash) gets
//!   celld's 404.
//! - The public listener refuses a path when any reading falls under a
//!   prefix: the raw path, the path that `new URL(request.url)` returns, or
//!   the fully decoded path with dot segments resolved and empty segments
//!   dropped. It compares ASCII case-insensitively, because some routers do.
//!
//! A prefix is a whole number of path segments, so `/internal` covers
//! `/internal` and `/internal/quota` but not `/internalx`.

use anyhow::bail;

/// The request header that marks a Worker request from the internal listener.
pub const MARKER_HEADER: &str = "x-celld-internal";

/// The only value celld sets for [`MARKER_HEADER`].
pub const MARKER_VALUE: &str = "1";

/// Path namespaces that celld serves or reserves on its listeners. A
/// configured prefix may neither cover nor fall inside one of them, so
/// celld's own routes always win and a later celld route inside one of these
/// namespaces cannot collide with a Worker route.
///
/// Keep this list in step with the routes in `handle_internal` and the public
/// health route in `handle_public`.
pub const RESERVED_NAMESPACES: &[&str] = &[
    "/.well-known/celld",
    "/cell",
    "/do",
    "/evict",
    "/peer",
    "/rebalance",
    "/reload",
    "/runtime",
    "/shutdown",
    "/state",
];

/// The validated prefixes. Each one starts with `/`, has no trailing `/`, and
/// contains only non-empty segments of unreserved URL characters.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InternalWorkerPrefixes {
    prefixes: Vec<String>,
}

impl InternalWorkerPrefixes {
    /// Validate the values of repeated `--internal-worker-prefix` options.
    /// `source` names the option or variable in error messages.
    pub fn parse<I, S>(source: &str, values: I) -> anyhow::Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut prefixes = Vec::new();
        for value in values {
            let prefix = canonical_prefix(source, value.as_ref())?;
            if !prefixes.contains(&prefix) {
                prefixes.push(prefix);
            }
        }
        Ok(Self { prefixes })
    }

    /// Validate a comma-separated list, as `CELLD_INTERNAL_WORKER_PREFIXES`
    /// carries it. Whitespace around an entry is ignored; an empty entry is an
    /// error, so a stray comma cannot hide a missing prefix.
    pub fn parse_list(source: &str, list: &str) -> anyhow::Result<Self> {
        Self::parse(source, list.split(',').map(str::trim))
    }

    pub fn is_empty(&self) -> bool {
        self.prefixes.is_empty()
    }

    pub fn prefixes(&self) -> &[String] {
        &self.prefixes
    }

    /// Whether the internal listener sends this request path to the Worker.
    /// `path` is the path of the request target, without the query.
    pub fn forwards(&self, path: &str) -> bool {
        if self.prefixes.is_empty() {
            return false;
        }
        if url_path(path).as_deref() != Some(path) {
            return false;
        }
        let decoded = decoded_path(path);
        self.prefixes
            .iter()
            .any(|prefix| covers(path, prefix) && covers(&decoded, prefix))
    }

    /// Whether the public listener refuses this request path with 404.
    /// `path` is the path of the request target, without the query.
    pub fn refuses_public(&self, path: &str) -> bool {
        if self.prefixes.is_empty() {
            return false;
        }
        let parsed = url_path(path);
        let parsed = parsed.as_deref().unwrap_or(path);
        let readings = [path, parsed, &decoded_path(path), &decoded_path(parsed)];
        readings.iter().any(|reading| {
            self.prefixes
                .iter()
                .any(|prefix| covers_ignore_ascii_case(reading, prefix))
        })
    }
}

/// Remove every client-supplied marker value. The public listener calls this
/// for every request, whatever the path and whether or not any prefix is
/// configured, so a Worker never sees a forged marker.
pub fn strip_marker(headers: &mut hyper::HeaderMap) {
    headers.remove(MARKER_HEADER);
}

/// Replace any client-supplied marker values with the one celld sets.
pub fn set_marker(headers: &mut hyper::HeaderMap) {
    headers.insert(
        hyper::header::HeaderName::from_static(MARKER_HEADER),
        hyper::header::HeaderValue::from_static(MARKER_VALUE),
    );
}

fn canonical_prefix(source: &str, value: &str) -> anyhow::Result<String> {
    let Some(rest) = value.strip_prefix('/') else {
        bail!("{source} {value:?} must start with `/`");
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        bail!("{source} {value:?} would forward every path; name at least one segment");
    }
    for segment in rest.split('/') {
        if segment.is_empty() {
            bail!("{source} {value:?} has an empty path segment");
        }
        if matches!(segment, "." | "..") {
            bail!("{source} {value:?} has a dot segment");
        }
        if let Some(character) = segment.chars().find(|c| !segment_character(*c)) {
            bail!(
                "{source} {value:?} contains {character:?}; use only letters, digits, \
                 and -._~!$&'()*+,;=:@ in a segment"
            );
        }
    }
    let prefix = format!("/{rest}");
    if let Some(reserved) = RESERVED_NAMESPACES
        .iter()
        .find(|reserved| covers(reserved, &prefix) || covers(&prefix, reserved))
    {
        bail!("{source} {value:?} overlaps celld's own route namespace {reserved}");
    }
    Ok(prefix)
}

/// The RFC 3986 `pchar` set without `%`, so a prefix is literal and has one
/// spelling.
fn segment_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@".contains(character)
}

/// Whether `prefix` covers `path` on a segment boundary.
fn covers(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn covers_ignore_ascii_case(path: &str, prefix: &str) -> bool {
    let (path, prefix) = (path.as_bytes(), prefix.as_bytes());
    path.len() >= prefix.len()
        && path[..prefix.len()].eq_ignore_ascii_case(prefix)
        && (path.len() == prefix.len() || path[prefix.len()] == b'/')
}

/// The pathname a Worker reads from `new URL(request.url)`. celld builds
/// `request.url` from the request target unchanged, and `url::Url` is the
/// parser behind `URL` in the isolate, so this is the Worker's reading by
/// construction. It resolves `.`, `..`, `%2e` and `%2e%2e` segments and
/// treats `\` as `/`.
fn url_path(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    url::Url::parse(&format!("http://celld.local{path}"))
        .ok()
        .map(|url| url.path().to_string())
}

/// The path after percent-decoding until nothing changes (at most four
/// rounds), treating `\` as `/`, dropping empty and `.` segments, and
/// resolving `..`. This is the most a router could undo, so the public
/// refusal and the internal forward both check it.
fn decoded_path(path: &str) -> String {
    let mut current = path.to_string();
    for _ in 0..4 {
        let decoded = percent_encoding::percent_decode_str(&current)
            .decode_utf8_lossy()
            .into_owned();
        if decoded == current {
            break;
        }
        current = decoded;
    }
    let mut segments = Vec::new();
    for segment in current.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            segment => segments.push(segment),
        }
    }
    format!("/{}", segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefixes(values: &[&str]) -> InternalWorkerPrefixes {
        InternalWorkerPrefixes::parse("--internal-worker-prefix", values).unwrap()
    }

    fn rejection(value: &str) -> String {
        InternalWorkerPrefixes::parse("--internal-worker-prefix", [value])
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn a_prefix_has_one_spelling() {
        assert_eq!(prefixes(&["/internal"]).prefixes(), ["/internal"]);
        assert_eq!(prefixes(&["/internal/"]).prefixes(), ["/internal"]);
        assert_eq!(
            prefixes(&["/internal/", "/internal", "/ops/quota"]).prefixes(),
            ["/internal", "/ops/quota"]
        );
        assert!(prefixes(&[]).is_empty());
    }

    #[test]
    fn a_malformed_prefix_stops_startup() {
        for (value, reason) in [
            ("", "must start with `/`"),
            ("internal", "must start with `/`"),
            (" /internal", "must start with `/`"),
            ("/", "would forward every path"),
            ("//", "would forward every path"),
            ("///", "empty path segment"),
            ("/internal//quota", "empty path segment"),
            ("/internal/./quota", "dot segment"),
            ("/internal/../quota", "dot segment"),
            ("/..", "dot segment"),
            ("/internal%2fquota", "contains '%'"),
            ("/%69nternal", "contains '%'"),
            ("/internal?x", "contains '?'"),
            ("/internal#x", "contains '#'"),
            ("/internal quota", "contains ' '"),
            ("/internal\\quota", "contains '\\\\'"),
            ("/intérnal", "contains 'é'"),
        ] {
            let error = rejection(value);
            assert!(error.contains(reason), "{value:?}: {error}");
        }
    }

    #[test]
    fn a_prefix_that_overlaps_a_celld_route_stops_startup() {
        for value in [
            "/peer",
            "/peer/",
            "/peer/probe",
            "/peer/log/seal",
            "/state",
            "/state/",
            "/state/extra",
            "/reload",
            "/rebalance",
            "/rebalance/pause",
            "/shutdown",
            "/runtime",
            "/do",
            "/do/Counter:1",
            "/cell",
            "/evict/x",
            "/.well-known",
            "/.well-known/celld",
            "/.well-known/celld/health",
        ] {
            let error = rejection(value);
            assert!(
                error.contains("overlaps celld's own route namespace"),
                "{value:?}: {error}"
            );
        }
        // A shared leading string is not an overlap: segments must match.
        assert_eq!(
            prefixes(&["/stateful", "/do-admin", "/peers", "/.well-known/acme"]).prefixes(),
            ["/stateful", "/do-admin", "/peers", "/.well-known/acme"]
        );
    }

    #[test]
    fn the_environment_list_is_strict() {
        let source = "CELLD_INTERNAL_WORKER_PREFIXES";
        assert_eq!(
            InternalWorkerPrefixes::parse_list(source, "/internal, /ops/ ")
                .unwrap()
                .prefixes(),
            ["/internal", "/ops"]
        );
        for list in ["/internal,", ",/internal", "/a,,/b", " "] {
            let error = InternalWorkerPrefixes::parse_list(source, list)
                .unwrap_err()
                .to_string();
            assert!(error.starts_with(source), "{list:?}: {error}");
        }
    }

    #[test]
    fn the_internal_listener_forwards_a_canonical_path_under_a_prefix() {
        let routes = prefixes(&["/internal/"]);
        for path in [
            "/internal",
            "/internal/",
            "/internal/quota",
            "/internal/quota/rules/7",
            "/internal/a%2fb",
            "/internal//quota",
            "/internal/%252e%252equota",
        ] {
            assert!(routes.forwards(path), "{path}");
        }
    }

    #[test]
    fn the_internal_listener_refuses_every_other_path() {
        let routes = prefixes(&["/internal"]);
        for path in [
            "/",
            "/internalx",
            "/internal-x/quota",
            "/internal.json",
            "/Internal/quota",
            "/INTERNAL",
            "/%69nternal/quota",
            "/x/internal/quota",
            "//internal/quota",
            // Dot segments, plain and encoded, that resolve out of the prefix.
            "/internal/../secret",
            "/internal/./quota",
            "/internal/%2e%2e/secret",
            "/internal/.%2E/secret",
            "/internal/%2E./secret",
            "/x/../internal/quota",
            // Encoded separators that a decoding router would resolve.
            "/internal/..%2fsecret",
            "/internal/..%2Fsecret",
            "/internal/..%5csecret",
            "/internal%2f..%2f..%2fsecret",
            "/internal/%252e%252e/secret",
            "/internal\\..\\secret",
            "*",
        ] {
            assert!(!routes.forwards(path), "{path}");
        }
    }

    #[test]
    fn the_public_listener_refuses_every_reading_under_a_prefix() {
        let routes = prefixes(&["/internal"]);
        for path in [
            "/internal",
            "/internal/",
            "/internal/quota",
            "/INTERNAL/quota",
            "/Internal",
            "/%69nternal/quota",
            "/%2569nternal/quota",
            "/x/../internal/quota",
            "/x/%2e%2e/internal/quota",
            "/x/..%2finternal/quota",
            "/x%2f..%2finternal",
            "//internal/quota",
            "/./internal",
            "/x\\..\\internal\\quota",
            "/internal%2fquota",
        ] {
            assert!(routes.refuses_public(path), "{path}");
        }
        for path in [
            "/",
            "/internalx",
            "/internal-x/quota",
            "/internal.json",
            "/x/internal/quota",
            "/public/internal",
            "/.well-known/celld/health",
            "*",
        ] {
            assert!(!routes.refuses_public(path), "{path}");
        }
    }

    #[test]
    fn no_prefix_forwards_or_refuses_nothing() {
        let routes = InternalWorkerPrefixes::default();
        for path in ["/", "/internal", "/internal/quota", "/state", "/%69nternal"] {
            assert!(!routes.forwards(path), "{path}");
            assert!(!routes.refuses_public(path), "{path}");
        }
    }

    #[test]
    fn strip_removes_every_spelling_and_value_of_the_marker() {
        let mut headers = hyper::HeaderMap::new();
        for (name, value) in [
            ("X-Celld-Internal", "1"),
            ("x-celld-internal", "true"),
            ("X-CELLD-INTERNAL", "1"),
            ("x-other", "kept"),
        ] {
            headers.append(
                hyper::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                hyper::header::HeaderValue::from_static(value),
            );
        }
        strip_marker(&mut headers);
        assert!(headers.get(MARKER_HEADER).is_none());
        assert_eq!(headers.len(), 1);
        assert_eq!(headers["x-other"], "kept");
    }

    #[test]
    fn set_replaces_a_forged_marker_with_one_value() {
        let mut headers = hyper::HeaderMap::new();
        headers.append(MARKER_HEADER, hyper::header::HeaderValue::from_static("0"));
        headers.append(MARKER_HEADER, hyper::header::HeaderValue::from_static("x"));
        set_marker(&mut headers);
        let values: Vec<_> = headers.get_all(MARKER_HEADER).iter().collect();
        assert_eq!(values, [MARKER_VALUE]);
    }
}
