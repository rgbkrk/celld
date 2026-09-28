// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! The build path for a Worker whose `main` is a `.py` file.
//!
//! celld implements one line of Cloudflare's Python Workers runtime: Pyodide
//! 0.28 with CPython 3.13, running the application's vendored Workers SDK
//! (the `enable_python_external_sdk` behavior). Configurations that
//! Cloudflare would run on a different Pyodide are refused, because the
//! wheels in `python_modules/` are built for one interpreter ABI.
//!
//! The build embeds the application's `.py` files and its `python_modules/`
//! directory (the output of `pywrangler sync`) in one JavaScript bundle with
//! the pinned upstream Pyodide release. The interpreter and its GC sentinel
//! become compiled Wasm modules. Nothing is fetched when the Worker runs.

use super::BundleOutput;
use anyhow::{anyhow, bail, Context};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Pyodide release embedded in every Python Worker. Cloudflare runs 0.28.2
/// with its own patches for this line; 0.28.3 has the same CPython 3.13.2
/// and wheel ABI (`pyodide_2025_0`), and `pywrangler` resolves packages
/// for Python 3.13 against the 0.28.3 package index.
pub const PYODIDE_VERSION: &str = "0.28.3";
const PYODIDE_BASE_URL: &str = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";

/// Each runtime file with its size and SHA-256. A cached or downloaded file
/// that does not match is refused.
const RUNTIME_FILES: &[(&str, u64, &str)] = &[
    (
        "pyodide.asm.js",
        1_073_033,
        "b22e5831eade9ff10e6fe2c811c68688cd91f10154377b4f80debcf5bafa1e56",
    ),
    (
        "pyodide.asm.wasm",
        8_645_967,
        "5effb6a1a6cc4a1a85bec4622701aa797c031e1de923cbbaf2ad47abdc4ab325",
    ),
    (
        "pyodide.mjs",
        16_347,
        "635a6da3218fe4e5668da595acfe8b5ce77453d597d602f19a423dd250653441",
    ),
    (
        "python_stdlib.zip",
        2_416_866,
        "71fee17f88a6260ec8c9c7c063533ee59c021fdc88a1ce76247378d3c4a35f4c",
    ),
    (
        "pyodide-lock.json",
        109_732,
        "f6e6f42f451f42affbbcddb00e8c9a3278dcbf399f57aab9f3f568839a7ff4a6",
    ),
];

/// The GC sentinel program that `pyodide.mjs` carries as base64.
const SENTINEL_SHA256: &str = "d22ea2a6a2cb1afea8157d6e4570887a06e5af9e388c5f0fa5a984a8e9bb1021";

const SHIMS_JS: &str = include_str!("../python/shims.js");
const WORKER_JS: &str = include_str!("../python/worker.js");
const WORKER_PY: &str = include_str!("../python/worker.py");

/// Directories under the entry directory that never hold application
/// modules. `python_modules` is collected separately, from the project root.
const SKIPPED_SOURCE_DIRECTORIES: &[&str] =
    &["__pycache__", "node_modules", "python_modules", "target"];

/// The Python behavior a configuration selects. Every Cloudflare switch
/// that decides which interpreter, SDK, search path or handler style runs is
/// resolved here, so the bundle carries answers rather than dates.
#[derive(Debug, PartialEq, Eq)]
pub struct PythonCompat {
    pub process_pth_files: bool,
    pub request_headers_preserve_commas: bool,
    pub workflows_implicit_dependencies: bool,
}

/// Refuse a configuration that Cloudflare would not run on the Pyodide 0.28
/// line with the vendored SDK and `Default` entrypoint classes.
///
/// The dates are workerd's `compatibility-date.capnp` at commit
/// da46ad950c54b19158c5ea5cb997a9727491ca17 (v1.20260926.1).
pub fn python_compat(object: &Map<String, Value>) -> anyhow::Result<PythonCompat> {
    let flags: Vec<&str> = object
        .get("compatibility_flags")
        .and_then(Value::as_array)
        .map(|flags| flags.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let has = |flag: &str| flags.contains(&flag);
    let date = object
        .get("compatibility_date")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Python Workers need a `compatibility_date`"))?;
    let since = |day: &str| date >= day;
    let switch =
        |enable: &str, disable: &str, day: &str| has(enable) || (!has(disable) && since(day));
    if !has("python_workers") {
        bail!("Python entries require the python_workers compatibility flag");
    }
    for flag in [
        "python_workers_314",
        "python_workers_20260610",
        "python_workers_development",
    ] {
        if has(flag) {
            bail!(
                "celld runs Python Workers on Pyodide {PYODIDE_VERSION} (Python 3.13); \
                 remove the `{flag}` compatibility flag"
            );
        }
    }
    if switch("python_workers_314", "no_python_workers_314", "2026-09-08") {
        bail!(
            "compatibility_date {date} selects Pyodide 314 (Python 3.14) on Cloudflare, and \
             celld runs Pyodide {PYODIDE_VERSION} (Python 3.13); use a date before 2026-09-08 \
             or add the `no_python_workers_314` compatibility flag"
        );
    }
    // Everything below is on by date from 2026-04-21, so each check only
    // rejects an explicit opt-out or an older date.
    let required = [
        (
            "python_workers_20250116",
            "no_python_workers_20250116",
            "2025-09-29",
            "Pyodide 0.28",
        ),
        (
            "enable_python_external_sdk",
            "disable_python_external_sdk",
            "2026-04-21",
            "the vendored Workers SDK",
        ),
        (
            "python_no_global_handlers",
            "disable_python_no_global_handlers",
            "2025-08-14",
            "`Default` entrypoint classes",
        ),
        (
            "python_workers_force_new_vendor_path",
            "",
            "2025-08-11",
            "the `python_modules` search path",
        ),
    ];
    for (enable, disable, day, behavior) in required {
        if !switch(enable, disable, day) {
            bail!(
                "celld runs Python Workers only with {behavior} ({enable}); use a \
                 compatibility_date from 2026-04-21 without opting out of it"
            );
        }
    }
    Ok(PythonCompat {
        process_pth_files: switch(
            "python_process_pth_files",
            "disable_python_process_pth_files",
            "2026-05-26",
        ),
        request_headers_preserve_commas: switch(
            "python_request_headers_preserve_commas",
            "disable_python_request_headers_preserve_commas",
            "2026-02-17",
        ),
        workflows_implicit_dependencies: switch(
            "python_workflows_implicit_dependencies",
            "no_python_workflows_implicit_dependencies",
            "2026-02-25",
        ),
    })
}

/// Refuse the parts of a configuration that would route an event other than
/// `fetch` to Python. Only `Default.fetch` is dispatched.
pub fn check_supported_events(object: &Map<String, Value>) -> anyhow::Result<()> {
    let non_empty = |value: Option<&Value>| match value {
        None | Some(Value::Null) => false,
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(fields)) => !fields.is_empty(),
        Some(_) => true,
    };
    for (present, what) in [
        (
            non_empty(
                object
                    .get("durable_objects")
                    .and_then(|d| d.get("bindings")),
            ),
            "Durable Objects",
        ),
        (non_empty(object.get("workflows")), "Workflows"),
        (
            non_empty(object.get("triggers").and_then(|t| t.get("crons"))),
            "Cron Triggers",
        ),
        (
            non_empty(object.get("queues").and_then(|q| q.get("consumers"))),
            "Queue consumers",
        ),
        (non_empty(object.get("containers")), "Containers"),
    ] {
        if present {
            bail!("celld does not run {what} in Python Workers yet; a Python Worker handles `fetch` only");
        }
    }
    for key in ["no_bundle", "define", "rules"] {
        if object.contains_key(key) {
            bail!("Python entries do not support `{key}`");
        }
    }
    Ok(())
}

pub fn build(
    root: &Path,
    entry: &str,
    compat: &PythonCompat,
) -> anyhow::Result<(BundleOutput, Value)> {
    let entry_path = Path::new(entry);
    let main_module = entry_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| is_identifier(stem))
        .ok_or_else(|| anyhow!("Python entry {entry} must be named as an importable module"))?;
    let source_root = root.join(entry_path.parent().unwrap_or(Path::new("")));
    let mut files = BTreeMap::new();
    collect_sources(&source_root, "", &mut files)?;
    let sdk = collect_python_modules(&root.join("python_modules"), &mut files)?;

    let runtime = runtime_files()?;
    let directory = tempfile::tempdir().context("create Python build directory")?;
    let out = directory.path();
    for (name, bytes) in &runtime {
        if name != "pyodide.asm.wasm" && name != "pyodide-lock.json" {
            std::fs::write(out.join(name), bytes)?;
        }
    }
    let sentinel = sentinel_bytes(&runtime["pyodide.mjs"])?;
    let lock: Value = serde_json::from_slice(&runtime["pyodide-lock.json"])?;
    let flags = json!({
        "python_workers": true,
        "python_workers_20250116": true,
        "enable_python_external_sdk": true,
        "python_no_global_handlers": true,
        "python_workers_force_new_vendor_path": true,
        "python_process_pth_files": compat.process_pth_files,
        "python_request_headers_preserve_commas": compat.request_headers_preserve_commas,
        "python_workflows_implicit_dependencies": compat.workflows_implicit_dependencies,
    });
    let config = format!(
        "export const SENTINEL_BYTES = new Uint8Array({});\n\
         export const LOCK = {};\n\
         export const MAIN_MODULE = {};\n\
         export const COMPATIBILITY_FLAGS = {flags};\n\
         export const PROCESS_PTH_FILES = {};\n",
        serde_json::to_string(&sentinel)?,
        // The loader checks the lock's interpreter identity. No package is
        // ever loaded from it, so the package table stays out of the bundle.
        json!({ "info": lock["info"], "packages": {} }),
        serde_json::to_string(main_module)?,
        compat.process_pth_files,
    );
    std::fs::write(out.join("config.js"), config)?;
    // The `browser` map of the pyodide npm package: esbuild replaces the
    // loader's Node.js builtins with empty modules, as a browser build does.
    std::fs::write(
        out.join("package.json"),
        r#"{"private":true,"browser":{"fs":false,"vm":false,"ws":false,"url":false,"path":false,"crypto":false,"fs/promises":false,"child_process":false}}"#,
    )?;
    std::fs::write(out.join("shims.js"), SHIMS_JS)?;
    std::fs::write(out.join("worker.js"), WORKER_JS)?;
    std::fs::write(out.join("worker.py"), WORKER_PY)?;
    std::fs::write(out.join("files.bin"), pack(&files)?)?;
    run_esbuild(out)?;
    let bundle = std::fs::read(out.join("index.js")).context("read Python Worker bundle")?;

    let descriptor = json!({
        "pyodide": PYODIDE_VERSION,
        "python": lock["info"]["python"],
        "abi": lock["info"]["abi_version"],
        "sdk": sdk,
        "main_module": main_module,
    });
    let wasm = vec![
        (
            "pyodide.asm.wasm".to_string(),
            runtime["pyodide.asm.wasm"].clone(),
        ),
        ("sentinel.wasm".to_string(), sentinel),
    ];
    Ok((BundleOutput { bundle, wasm }, descriptor))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Every `.py` file below the entry directory, as Wrangler's default
/// `PythonModule` rule collects them, keyed by its path in that directory.
fn collect_sources(
    directory: &Path,
    relative: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("read Python source directory {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("non-UTF-8 name under {}", directory.display()))?;
        let file_type = entry.file_type()?;
        if name.starts_with('.') {
            continue;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if file_type.is_dir() {
            if !SKIPPED_SOURCE_DIRECTORIES.contains(&name.as_str()) {
                collect_sources(&entry.path(), &path, files)?;
            }
        } else if name.ends_with(".py") {
            if !file_type.is_file() {
                bail!("Python source {path} is not a regular file");
            }
            files.insert(path, std::fs::read(entry.path())?);
        }
    }
    Ok(())
}

/// Add `python_modules/` to `files` and return the vendored SDK's identity.
///
/// The tree is what `pywrangler sync` writes: wheels unpacked for the
/// Pyodide target. Compiled extensions need a loader that this build does
/// not have yet, so they are refused rather than left to fail on import.
fn collect_python_modules(
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<Value> {
    if !directory.join("workers").join("__init__.py").is_file() {
        bail!(
            "{} does not contain the Workers SDK (`workers-runtime-sdk`); run \
             `uv run pywrangler sync` to vendor the project's packages",
            directory.display()
        );
    }
    let mut vendored = BTreeMap::new();
    collect_vendored(directory, "", &mut vendored)?;
    let sdk_version = vendored
        .keys()
        .find_map(|path| {
            let name = path.strip_suffix(".dist-info/METADATA")?;
            name.strip_prefix("workers_runtime_sdk-")
                .filter(|version| !version.contains('/'))
        })
        .map(str::to_string)
        .ok_or_else(|| anyhow!("python_modules has no workers_runtime_sdk metadata"))?;
    let digest = format!("{:x}", Sha256::digest(&vendored["workers/entrypoints.py"]));
    for (path, bytes) in vendored {
        files.insert(format!("python_modules/{path}"), bytes);
    }
    Ok(json!({
        "package": "workers-runtime-sdk",
        "version": sdk_version,
        "entrypoints_sha256": digest,
    }))
}

fn collect_vendored(
    directory: &Path,
    relative: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<()> {
    for entry in
        std::fs::read_dir(directory).with_context(|| format!("read {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("non-UTF-8 name under {}", directory.display()))?;
        let file_type = entry.file_type()?;
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if file_type.is_symlink() {
            bail!("python_modules/{path} is a symbolic link; vendor packages as files");
        }
        if file_type.is_dir() {
            if name != "__pycache__" {
                collect_vendored(&entry.path(), &path, files)?;
            }
            continue;
        }
        if !file_type.is_file() {
            bail!("python_modules/{path} is not a regular file");
        }
        if name.ends_with(".so") || name.contains(".so.") {
            bail!(
                "python_modules/{path} is a compiled extension; celld runs pure-Python \
                 packages only"
            );
        }
        if name.ends_with(".pyc") {
            continue;
        }
        files.insert(path, std::fs::read(entry.path())?);
    }
    Ok(())
}

/// The `files.bin` format read by `python/worker.js`: a count, then each
/// path and its bytes, all lengths as little-endian u32.
fn pack(files: &BTreeMap<String, Vec<u8>>) -> anyhow::Result<Vec<u8>> {
    let length = |value: usize| -> anyhow::Result<[u8; 4]> {
        Ok(u32::try_from(value)
            .map_err(|_| anyhow!("Python bundle file is too large"))?
            .to_le_bytes())
    };
    let mut out = Vec::new();
    out.extend(length(files.len())?);
    for (path, bytes) in files {
        out.extend(length(path.len())?);
        out.extend(path.as_bytes());
        out.extend(length(bytes.len())?);
        out.extend(bytes);
    }
    Ok(out)
}

fn sentinel_bytes(loader: &[u8]) -> anyhow::Result<Vec<u8>> {
    use base64::Engine;
    let loader = std::str::from_utf8(loader)?;
    let start = loader
        .find("\"AGFzbQ")
        .ok_or_else(|| anyhow!("pyodide.mjs has no embedded sentinel"))?
        + 1;
    let end = start
        + loader[start..]
            .find('"')
            .ok_or_else(|| anyhow!("unterminated sentinel in pyodide.mjs"))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&loader[start..end])?;
    if format!("{:x}", Sha256::digest(&bytes)) != SENTINEL_SHA256 {
        bail!("pyodide.mjs carries an unexpected sentinel program");
    }
    Ok(bytes)
}

/// Where verified runtime files are kept between builds.
/// `CELLD_PYTHON_RUNTIME_DIR` selects a directory; a directory that already
/// holds the verified files lets a build run offline.
fn runtime_directory() -> anyhow::Result<PathBuf> {
    if let Some(directory) = std::env::var_os("CELLD_PYTHON_RUNTIME_DIR") {
        return Ok(PathBuf::from(directory));
    }
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or_else(|| anyhow!("set CELLD_PYTHON_RUNTIME_DIR to cache the Python runtime"))?;
    Ok(cache
        .join("celld")
        .join(format!("pyodide-{PYODIDE_VERSION}")))
}

fn runtime_files() -> anyhow::Result<BTreeMap<String, Vec<u8>>> {
    let directory = runtime_directory()?;
    let verified = |bytes: &[u8], size: u64, sha256: &str| {
        bytes.len() as u64 == size && format!("{:x}", Sha256::digest(bytes)) == sha256
    };
    let mut files = BTreeMap::new();
    let mut missing = Vec::new();
    for &(name, size, sha256) in RUNTIME_FILES {
        match std::fs::read(directory.join(name)) {
            Ok(bytes) if verified(&bytes, size, sha256) => {
                files.insert(name.to_string(), bytes);
            }
            _ => missing.push((name, size, sha256)),
        }
    }
    if missing.is_empty() {
        return Ok(files);
    }
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create {}", directory.display()))?;
    for (name, bytes) in download(&missing)? {
        let (_, size, sha256) = missing.iter().find(|file| file.0 == name).unwrap();
        if !verified(&bytes, *size, sha256) {
            bail!("downloaded {name} does not match Pyodide {PYODIDE_VERSION}");
        }
        let staged = tempfile::NamedTempFile::new_in(&directory)?;
        std::fs::write(staged.path(), &bytes)?;
        staged
            .persist(directory.join(&name))
            .map_err(|error| anyhow!("store {name}: {error}"))?;
        files.insert(name, bytes);
    }
    Ok(files)
}

/// Fetch runtime files on a private thread, so a build works whether or not
/// the caller is inside an async runtime.
fn download(files: &[(&str, u64, &str)]) -> anyhow::Result<Vec<(String, Vec<u8>)>> {
    let names: Vec<String> = files.iter().map(|file| file.0.to_string()).collect();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let client = reqwest::Client::new();
            let mut out = Vec::new();
            for name in names {
                let url = format!("{PYODIDE_BASE_URL}{name}");
                let response = client
                    .get(&url)
                    .send()
                    .await
                    .and_then(reqwest::Response::error_for_status)
                    .with_context(|| {
                        format!(
                            "download {url}; to build offline, place the Pyodide \
                             {PYODIDE_VERSION} files in CELLD_PYTHON_RUNTIME_DIR"
                        )
                    })?;
                out.push((name, response.bytes().await?.to_vec()));
            }
            Ok(out)
        })
    })
    .join()
    .map_err(|_| anyhow!("Python runtime download panicked"))?
}

fn run_esbuild(directory: &Path) -> anyhow::Result<()> {
    let binary = std::env::var("CELLD_ESBUILD").unwrap_or_else(|_| "esbuild".to_string());
    let output = Command::new(&binary)
        .current_dir(directory)
        .arg("worker.js")
        .arg("--bundle")
        .arg("--format=esm")
        .arg("--platform=browser")
        .arg("--target=es2022")
        .arg("--outfile=index.js")
        .arg("--inject:./shims.js")
        .arg("--loader:.zip=binary")
        .arg("--loader:.bin=binary")
        .arg("--loader:.py=text")
        // The loader treats a defined `process` as Node. These names are
        // replaced only inside the bundle.
        .arg("--define:process=undefined")
        .arg("--define:location=\"https://python-runtime.invalid/\"")
        .arg("--external:cloudflare:*")
        // Dynamic imports on the loader's Node.js path, which never runs.
        .arg("--external:node:*")
        .arg("--external:./pyodide.asm.wasm")
        .arg("--external:./sentinel.wasm")
        .arg("--log-level=warning")
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                anyhow!("esbuild not found ({binary}); install it or set CELLD_ESBUILD")
            } else {
                anyhow!("run esbuild: {error}")
            }
        })?;
    if !output.status.success() {
        bail!(
            "esbuild failed on the Python Worker bundle:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(date: &str, flags: &[&str]) -> Map<String, Value> {
        let mut flags: Vec<&str> = flags.to_vec();
        flags.insert(0, "python_workers");
        json!({ "compatibility_date": date, "compatibility_flags": flags })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn compatibility_envelope_follows_workerd_dates() {
        let compat = python_compat(&config("2026-09-01", &[])).unwrap();
        assert_eq!(
            compat,
            PythonCompat {
                process_pth_files: true,
                request_headers_preserve_commas: true,
                workflows_implicit_dependencies: true,
            }
        );
        let early = python_compat(&config("2026-04-21", &[])).unwrap();
        assert!(!early.process_pth_files);
        let opted_out = config("2026-09-01", &["disable_python_process_pth_files"]);
        assert!(!python_compat(&opted_out).unwrap().process_pth_files);

        for (date, flags, message) in [
            ("2026-09-08", &[][..], "selects Pyodide 314"),
            (
                "2026-09-01",
                &["python_workers_314"][..],
                "python_workers_314",
            ),
            (
                "2026-09-01",
                &["python_workers_20260610"][..],
                "python_workers_20260610",
            ),
            ("2026-04-20", &[][..], "enable_python_external_sdk"),
            (
                "2026-09-01",
                &["disable_python_external_sdk"][..],
                "enable_python_external_sdk",
            ),
            (
                "2026-09-01",
                &["no_python_workers_20250116"][..],
                "python_workers_20250116",
            ),
        ] {
            let error = python_compat(&config(date, flags)).unwrap_err().to_string();
            assert!(error.contains(message), "{date} {flags:?}: {error}");
        }
        assert!(python_compat(&config("2026-09-30", &["no_python_workers_314"])).is_ok());
        let without_flag = json!({ "compatibility_date": "2026-09-01" });
        assert!(python_compat(without_flag.as_object().unwrap()).is_err());
    }

    #[test]
    fn only_fetch_is_routed_to_python() {
        let object = |value: Value| value.as_object().unwrap().clone();
        assert!(check_supported_events(&object(json!({ "kv_namespaces": [] }))).is_ok());
        assert!(check_supported_events(&object(json!({ "triggers": { "crons": [] } }))).is_ok());
        for value in [
            json!({ "durable_objects": { "bindings": [{ "name": "D", "class_name": "C" }] } }),
            json!({ "queues": { "consumers": [{ "queue": "q" }] } }),
            json!({ "workflows": [{ "name": "w" }] }),
            json!({ "triggers": { "crons": ["* * * * *"] } }),
            json!({ "rules": [] }),
        ] {
            assert!(
                check_supported_events(&object(value.clone())).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn packed_files_are_length_prefixed() {
        let mut files = BTreeMap::new();
        files.insert("a.py".to_string(), b"x".to_vec());
        files.insert("python_modules/b".to_string(), Vec::new());
        let packed = pack(&files).unwrap();
        let mut expected = vec![2, 0, 0, 0, 4, 0, 0, 0];
        expected.extend(b"a.py");
        expected.extend([1, 0, 0, 0, b'x', 16, 0, 0, 0]);
        expected.extend(b"python_modules/b");
        expected.extend([0, 0, 0, 0]);
        assert_eq!(packed, expected);
    }

    #[test]
    fn entry_module_names_must_be_importable() {
        assert!(is_identifier("entry"));
        assert!(is_identifier("_main2"));
        assert!(!is_identifier("2main"));
        assert!(!is_identifier("my-worker"));
        assert!(!is_identifier(""));
    }
}
