// Top-level stateless Worker for the one-isolate pool regression. Run with
// CELLD_MAX_STATELESS_ISOLATES=1. `process.exit` is a host hard termination
// that needs no per-invocation CPU knob (top-level fetch has none).
const id = crypto.randomUUID();
let counter = 0;
let pendingStarted = false;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/id") return Response.json({ id, counter: ++counter });
    if (url.pathname === "/pending-started") return Response.json({ id, pendingStarted });
    if (url.pathname === "/pending") {
      pendingStarted = true;
      await new Promise((done) => setTimeout(done, Number(url.searchParams.get("ms"))));
      return new Response("pending finished after its timer");
    }
    if (url.pathname === "/exit") globalThis.process.exit(1);
    if (url.pathname === "/exit-microtask") {
      queueMicrotask(() => console.log("LIFECYCLE-LEAK pool"));
      globalThis.process.exit(1);
    }
    return new Response("not found", { status: 404 });
  },
};
