# Python Workers

A Worker whose `main` is a `.py` file runs on celld with the
[Cloudflare Python Workers](https://developers.cloudflare.com/workers/languages/python/)
API: a `Default` class that extends `WorkerEntrypoint`, the `Response`
and `fetch` of the `workers` package, and bindings on `self.env`. The same
project runs on Cloudflare without a change.

```python
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        await self.env.KV.put("greeting", "hello")
        return Response(await self.env.KV.get("greeting"))
```

celld supports a bounded part of the Python Workers platform. This page
lists what that part is.

## Build a project

Vendor the project's packages with Cloudflare's `pywrangler`, then deploy
or run the project as usual:

```sh
uv run pywrangler sync
celld dev .
```

`pywrangler sync` writes the packages to `python_modules/`, including the
Workers SDK (`workers-runtime-sdk`). `celld deploy` embeds every `.py` file
below the directory of `main`, and the files of `python_modules/`, in one
bundle with the Pyodide runtime. Nothing is downloaded when the Worker
runs.

The first build downloads the Pyodide runtime files from the Pyodide CDN
and checks the SHA-256 of each one. Later builds reuse them from
`~/.cache/celld/pyodide-0.28.3`. Set `CELLD_PYTHON_RUNTIME_DIR` to use
another directory; a directory that already holds the files lets a build
run offline. The build needs `esbuild` on `PATH`, as a JavaScript build
does, or `CELLD_ESBUILD` set to its path.

A Python deployment requires the `python-workers-v1` feature, so a node
that predates it refuses the deployment at deploy time.

## Runtime version

celld runs Pyodide 0.28.3 with CPython 3.13.2 and the `pyodide_2025_0`
wheel ABI. This is the runtime line that Cloudflare selects with
`python_workers_20250116` (Cloudflare runs Pyodide 0.28.2 with its own
patches). The configuration must select that line and the vendored SDK:

- `compatibility_flags` includes `python_workers`.
- `compatibility_date` is 2026-04-21 or later, which turns on
  `enable_python_external_sdk`, `python_no_global_handlers`, and the
  `python_modules` search path.
- `compatibility_date` is before 2026-09-08, or the flags include
  `no_python_workers_314`. From 2026-09-08 Cloudflare runs Pyodide 314
  (Python 3.14), which needs wheels for another ABI.

celld refuses other settings at deploy time. `python_process_pth_files`
follows its compatibility date (2026-05-26).

## Supported

| API | Notes |
| --- | --- |
| `Default(WorkerEntrypoint).fetch` | One instance for each request, as on Cloudflare |
| `workers.Response`, `Response.json`, request body, text and headers | Compared with workerd in the tests |
| `workers.fetch` | Outbound HTTP |
| `self.env` bindings | Tested with KV. Other bindings are the objects a JavaScript Worker gets, untested from Python |
| `self.ctx.waitUntil` | Python awaitables are kept alive until they settle |
| Pure-Python packages in `python_modules/` | Tested with `beautifulsoup4` |
| `from js import ...` | The JavaScript globals of the isolate |

## Not supported

- Durable Objects, Workflows, Cron Triggers and Queue consumers written
  in Python. `celld deploy` refuses a Python project that declares them.
- Named entrypoint classes and RPC to Python methods.
- Packages with compiled extensions (`.so` files), and the standard
  library modules that Pyodide ships as separate packages: `ssl`,
  `sqlite3`, `lzma`, and the OpenSSL-backed `hashlib` algorithms.
- `pyodide.ffi.run_sync`, and `workers.import_from_javascript` for
  modules other than `cloudflare:workers` and `cloudflare:sockets`. celld
  hides WebAssembly stack switching (JSPI) from the runtime, because under
  JSPI each async entry leaks C stack until the interpreter stops.
- `process.exit()` throws an error in a Python Worker.
- Memory snapshots and the import patches of the `_cloudflare` package.
  Package patches that need them, such as synchronous FastAPI handlers,
  do not apply.

## Failure behavior

The interpreter starts on the first request that an isolate handles, and
concurrent first requests share that start. If the main module raises an
error, every request to that isolate fails with the same traceback.

A fatal interpreter error, such as a C stack overflow from deep
recursion, fails the request in flight and every later request to that
isolate. Cloudflare replaces the isolate in this case. celld does not yet,
so the isolate keeps failing until celld retires it for another reason,
such as a new deployment.
