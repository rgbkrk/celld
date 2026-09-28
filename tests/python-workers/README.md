# Python Workers tests

These tests run the Python Worker fixtures through a real `celld dev`
and compare them with workerd, which Miniflare runs.

```sh
cargo build -p celld
cd tests/python-workers
npm install
npm test
```

`npm test` first vendors the pinned wheels of `fixtures/wheels.json` into
`.cache/python_modules`. These are the wheels that `uv run pywrangler sync`
resolves for `fixtures/worker/pyproject.toml`. The first run also downloads
the Pyodide runtime files into `.cache/pyodide-0.28.3`, and workerd downloads
its own Pyodide bundle.

| File | What it checks |
| --- | --- |
| `reference.test.mjs` | One Python source and one `python_modules/` on celld and on workerd: environment, responses, bodies, headers, KV, outbound fetch, a package, errors, `waitUntil` |
| `lifecycle.test.mjs` | Interpreter start, a flat C stack, `process.exit()`, client disconnects, unread streams, failed starts, fatal errors |
| `build.test.mjs` | Reproducible versions and the configurations that `celld deploy` refuses |
| `body-stream.test.mjs` | Body streams report `ReadableStream` as their constructor, as on workerd |

`CELLD_BIN` selects another `celld` binary. `CELLD_ESBUILD` and
`CELLD_PYTHON_RUNTIME_DIR` override the esbuild binary and the runtime
directory. Every server listens on loopback, and every project and its
storage are in a temporary directory under `.cache/projects`.
