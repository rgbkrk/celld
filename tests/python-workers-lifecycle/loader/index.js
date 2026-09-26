// Generic JS/WASM regression for opt-in invalidation after hard execution
// termination. No Python is involved: the child is plain JavaScript plus a
// three-instruction WebAssembly module that never returns, so CPU exhaustion
// abandons WebAssembly frames the way an interrupted interpreter would.
//
// Driven by lifecycle.test.mjs through `celld dev`; every wait is bounded.

// (module (func (export "spin") (loop (br 0))))
const SPIN_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
  0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07,
  0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b,
]);

const CHILD = `
import { WorkerEntrypoint } from "cloudflare:workers";
import spinModule from "spin.wasm";
const spin = new WebAssembly.Instance(spinModule, {}).exports.spin;
const id = crypto.randomUUID();
let counter = 0;
let pendingStarted = false;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/id") return Response.json({ id, counter: ++counter });
    if (url.pathname === "/pending-started") return Response.json({ pendingStarted });
    if (url.pathname === "/microtask-then-spin") {
      // Queued guest work that must never run once the host has latched
      // the isolate invalidated.
      queueMicrotask(() => console.log("LIFECYCLE-LEAK " + url.searchParams.get("tag")));
      if (url.searchParams.get("spin") === "js") for (;;) {}
      spin();
    }
    if (url.pathname === "/stream") {
      // An answered request whose body is still produced by this isolate.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      (async () => {
        await writer.write(encoder.encode("first\\n"));
        await new Promise((done) => setTimeout(done, Number(url.searchParams.get("ms"))));
        await writer.write(encoder.encode("second\\n"));
        await writer.close();
      })();
      return new Response(readable);
    }
    if (url.pathname === "/pending") {
      pendingStarted = true;
      await new Promise((done) => setTimeout(done, Number(url.searchParams.get("ms"))));
      return new Response("pending finished after its timer");
    }
    return new Response("not found", { status: 404 });
  },
};
export class Control extends WorkerEntrypoint {
  spinJs() { for (;;) {} }
  spinWasm() { spin(); }
  isAlive() { return id; }
}
`;

function code(flags) {
  return {
    mainModule: "child.js",
    compatibilityDate: "2026-09-21",
    compatibilityFlags: flags,
    globalOutbound: null,
    modules: { "child.js": CHILD, "spin.wasm": { wasm: SPIN_WASM } },
  };
}

const settle = async (promise, ms) => {
  const started = Date.now();
  let timer;
  try {
    const value = await Promise.race([
      promise.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      ),
      new Promise((done) => {
        timer = setTimeout(() => done({ ok: false, timeout: true, error: `unsettled after ${ms} ms` }), ms);
      }),
    ]);
    return { ...value, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
};

const text = (response) => response.then(async (r) => ({ status: r.status, body: await r.text() }));
const get = (stub, path, cpuMs = 1000) =>
  text(stub.getEntrypoint(null, { limits: { cpuMs } }).fetch(`https://child.invalid${path}`));
const control = (stub, cpuMs) => stub.getEntrypoint("Control", { limits: { cpuMs, subRequests: 0 } });

async function scenario(flags, trigger, pendingMs) {
  const stub = LOADER.load(code(flags));
  const sibling = LOADER.load(code(flags));
  const out = { flags, trigger };
  try {
    out.first = await settle(get(stub, "/id"), 5000);
    out.siblingFirst = await settle(get(sibling, "/id"), 5000);
    // A suspended request in the same isolate, owned by a different entry.
    const pending = get(stub, `/pending?ms=${pendingMs}`, 1000);
    for (let i = 0; i < 100; i++) {
      const state = await settle(get(stub, "/pending-started"), 2000);
      if (state.ok && JSON.parse(state.value.body).pendingStarted) {
        out.pendingStarted = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    const started = Date.now();
    out.termination = await settle(control(stub, 10)[trigger](), 5000);
    out.pending = await settle(pending, 3000);
    out.pendingSinceTerminationMs = Date.now() - started;
    out.rpcAfter = await settle(control(stub, 1000).isAlive(), 3000);
    out.fetchAfter = await settle(get(stub, "/id"), 3000);
    out.siblingAfter = await settle(get(sibling, "/id"), 3000);
    out.stream = await streamScenario(flags, trigger, pendingMs);
    out.microtask = await microtaskScenario(flags, trigger);
    // Fresh replacements, each terminated again, with the old stub disposed.
    out.replacements = [];
    for (let i = 0; i < 5; i++) {
      const next = LOADER.load(code(flags));
      try {
        const id = await settle(get(next, "/id"), 5000);
        const termination = await settle(control(next, 10)[trigger](), 5000);
        const after = await settle(control(next, 1000).isAlive(), 3000);
        out.replacements.push({ id, termination, after });
      } finally {
        next.dispose();
      }
    }
    return out;
  } finally {
    stub.dispose();
    sibling.dispose();
  }
}

// A streaming response already answered when another entry exhausts CPU.
async function streamScenario(flags, trigger, pendingMs) {
  const stub = LOADER.load(code(flags));
  try {
    const response = await stub.getEntrypoint(null, { limits: { cpuMs: 1000 } })
      .fetch(`https://child.invalid/stream?ms=${pendingMs}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    const termination = await settle(control(stub, 10)[trigger](), 5000);
    const rest = await settle((async () => {
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value);
      }
    })(), 3000 + pendingMs);
    return { status: response.status, first, termination, rest };
  } finally {
    stub.dispose();
  }
}

// A fetch handler hard-terminated before its first await, with a microtask
// queued. The marker is observed in the server log by the test.
async function microtaskScenario(flags, trigger) {
  const stub = LOADER.load(code(flags));
  const tag = `${flags.join("+") || "unflagged"}-${trigger}`;
  try {
    const termination = await settle(get(stub, `/microtask-then-spin?tag=${tag}&spin=${trigger === "spinJs" ? "js" : "wasm"}`, 10), 5000);
    const after = await settle(control(stub, 1000).isAlive(), 3000);
    return { tag, termination, after };
  } finally {
    stub.dispose();
  }
}

let LOADER;
export default {
  async fetch(request, env) {
    LOADER = env.LOADER;
    const url = new URL(request.url);
    const flags = url.searchParams.get("flags") ? url.searchParams.get("flags").split(",") : [];
    const trigger = url.searchParams.get("trigger") ?? "spinWasm";
    const pendingMs = Number(url.searchParams.get("pendingMs") ?? 6000);
    return Response.json(await scenario(flags, trigger, pendingMs));
  },
};
