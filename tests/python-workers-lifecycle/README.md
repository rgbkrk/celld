# `python_workers` hard-termination lifecycle regression

Black-box checks of the opt-in invalidation policy, run against a `celld`
binary through `celld dev`. No Python is involved: the loaded child is plain
JavaScript plus a three-instruction WebAssembly loop, so CPU exhaustion
abandons Wasm frames the way an interrupted interpreter would.

```sh
CELLD_BIN=/path/to/celld node --test tests/python-workers-lifecycle/lifecycle.test.mjs
```

`CELLD_TEST_PORTS` (default `19476,19477`) selects the loopback ports;
`EVIDENCE_DIR` saves the raw observations. Each test copies its fixture into a
temporary project and removes it afterwards. Runtime is about one minute; the
flagged pool case polls (up to 65 s) for the 30 s maintenance pass to free the
retired heaps.

Covered, for a Worker Loader child with `compatibilityFlags: ["python_workers"]`,
with termination in a Wasm loop and in a JS loop:

- a request suspended on a timer fails promptly when another entry exceeds
  its CPU limit;
- later RPC and fetch entry is refused with the host invalidation error;
- an answered streaming body produced by the isolate ends with that error;
- a microtask queued by a fetch handler terminated before its first await
  never runs (its `console.log` marker stays out of the log);
- a sibling loaded Worker keeps its isolate and state;
- five fresh replacements each work and are each invalidated again.

For a top-level Worker with `CELLD_MAX_STATELESS_ISOLATES=1` and
`process.exit`: five rounds each fail the pending request promptly, place the
next request on a fresh isolate, and retire then free the invalidated heaps;
the handler queues a microtask before `process.exit`, which must not run.

Controls without the flag keep ordinary reuse: the pending request and the
streaming body complete normally, the queued microtask runs (the positive
control for the marker checks), and the same isolate serves later calls.
