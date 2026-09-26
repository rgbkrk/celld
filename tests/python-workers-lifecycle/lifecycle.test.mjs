// Black-box regression for opt-in invalidation after hard execution
// termination. Requires CELLD_BIN. Uses loopback ports from CELLD_TEST_PORTS
// (default 19476,19477), disposable project copies, and bounded waits.
//
//   CELLD_BIN=/path/to/celld EVIDENCE_DIR=/tmp/out node --test lifecycle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const INVALIDATED =
  "Python runtime invalidated after execution termination; recreate the worker";
const [LOADER_PORT, POOL_PORT] = (process.env.CELLD_TEST_PORTS ?? "19476,19477")
  .split(",")
  .map(Number);
const evidenceDir = process.env.EVIDENCE_DIR;

async function evidence(name, value) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, name), JSON.stringify(value, null, 2) + "\n");
}

async function startCelld(fixture, config, port, env = {}) {
  const bin = process.env.CELLD_BIN;
  if (!bin) throw new Error("Set CELLD_BIN");
  const project = await mkdtemp(join(process.env.CELLD_TEST_TMP ?? tmpdir(), "celld-lifecycle-"));
  await cp(join(here, fixture), project, { recursive: true });
  await writeFile(
    join(project, "wrangler.json"),
    JSON.stringify({ name: `lifecycle-${fixture}`, main: "index.js", no_bundle: true,
      compatibility_date: "2026-09-21", ...config }),
  );
  let logs = "";
  const child = spawn(bin, ["dev", project, "--port", String(port), "--no-watch", "--logs"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const exited = new Promise((done) => child.once("exit", done));
  const spawnFailed = new Promise((_, reject) => child.once("error", reject));
  spawnFailed.catch(() => {});
  const close = async () => {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (child.pid === undefined) break;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((done) => setTimeout(() => done(false), 5000)),
      ]);
      if (stopped) break;
    }
    await rm(project, { recursive: true, force: true });
  };
  try {
    await Promise.race([spawnFailed, new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout\n${logs}`)), 60000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`celld exited ${code}\n${logs}`));
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => {
          logs += data;
          if (logs.includes("ready  http://")) {
            clearTimeout(timer);
            done();
          }
        });
    })]);
  } catch (error) {
    // A failed start still owns its process group and project copy.
    await close();
    throw error;
  }
  return { url: `http://127.0.0.1:${port}`, logs: () => logs, close };
}

async function getJson(url, ms) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

async function timed(url, ms) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: response.status, body: await response.text(), elapsedMs: Date.now() - started };
  } catch (error) {
    return { error: String(error?.name ?? error), elapsedMs: Date.now() - started };
  }
}

test("dynamic Worker: flagged JS/WASM invalidation, sibling, replacement, unflagged control",
  { timeout: 180000 }, async (t) => {
    const server = await startCelld("loader", { worker_loaders: [{ binding: "LOADER" }] }, LOADER_PORT);
    t.after(server.close);
    const results = {};
    for (const [name, query] of [
      ["flagged-wasm", "flags=python_workers&trigger=spinWasm"],
      ["flagged-js", "flags=python_workers&trigger=spinJs"],
      ["unflagged-wasm", "trigger=spinWasm&pendingMs=1500"],
    ]) {
      results[name] = await getJson(`${server.url}/?${query}`, 90000);
    }
    await evidence("loader.json", results);
    await evidence("loader-logs.json", server.logs().split("\n").filter((line) => /isolate|invalidat|LIFECYCLE-LEAK/.test(line)));

    for (const name of ["flagged-wasm", "flagged-js"]) {
      const r = results[name];
      await t.test(name, () => {
        assert.equal(r.first.ok, true, JSON.stringify(r.first));
        assert.equal(r.pendingStarted, true);
        assert.match(r.termination.error ?? "", /exceeded CPU limit/, JSON.stringify(r.termination));
        // The suspended request fails promptly, not when its timer fires.
        assert.equal(r.pending.ok, false, JSON.stringify(r.pending));
        assert.notEqual(r.pending.timeout, true, JSON.stringify(r.pending));
        assert.ok(r.pending.elapsedMs < 2000, JSON.stringify(r.pending));
        // Later entry is refused by the host before JavaScript runs.
        assert.equal(r.rpcAfter.error, INVALIDATED, JSON.stringify(r.rpcAfter));
        assert.equal(r.fetchAfter.ok, false, JSON.stringify(r.fetchAfter));
        assert.match(r.fetchAfter.error, /invalidated after execution termination/);
        // A sibling isolate keeps its state.
        const before = JSON.parse(r.siblingFirst.value.body);
        const after = JSON.parse(r.siblingAfter.value.body);
        assert.equal(after.id, before.id);
        assert.equal(after.counter, before.counter + 1);
        // An answered streaming body produced by the isolate ends with the
        // invalidation error promptly: not a clean, truncated end of body.
        assert.equal(r.stream.first, "first\n");
        assert.equal(r.stream.rest.ok, false, JSON.stringify(r.stream));
        assert.notEqual(r.stream.rest.timeout, true, JSON.stringify(r.stream));
        assert.match(r.stream.rest.error, /invalidated after execution termination/);
        assert.ok(r.stream.rest.elapsedMs < 2000, JSON.stringify(r.stream));
        // Fresh replacements work, repeatedly, and are each invalidated again.
        const ids = new Set();
        for (const replacement of r.replacements) {
          assert.equal(replacement.id.ok, true, JSON.stringify(replacement));
          ids.add(JSON.parse(replacement.id.value.body).id);
          assert.equal(replacement.after.error, INVALIDATED, JSON.stringify(replacement));
        }
        assert.equal(ids.size, 5);
        // Termination before the handler's first await: no queued guest
        // microtask may run after the latch (harness or V8 auto-checkpoint).
        assert.match(r.microtask.termination.error ?? "", /exceeded CPU limit/, JSON.stringify(r.microtask));
        assert.equal(r.microtask.after.error, INVALIDATED, JSON.stringify(r.microtask));
        assert.ok(!server.logs().includes(`LIFECYCLE-LEAK ${r.microtask.tag}`),
          `guest microtask ran after invalidation (${r.microtask.tag})`);
      });
    }
    const control = results["unflagged-wasm"];
    await t.test("unflagged control keeps ordinary JS reuse", () => {
      assert.match(control.termination.error ?? "", /exceeded CPU limit/);
      // Ordinary Worker semantics: the pending request is not failed by
      // another entry's CPU limit, and the same isolate serves later calls.
      assert.equal(control.pending.ok, true, JSON.stringify(control.pending));
      assert.equal(control.pending.value.body, "pending finished after its timer");
      assert.equal(control.rpcAfter.ok, true, JSON.stringify(control.rpcAfter));
      assert.equal(control.rpcAfter.value, JSON.parse(control.first.value.body).id);
      assert.equal(control.fetchAfter.ok, true);
      assert.equal(control.stream.rest.ok, true, JSON.stringify(control.stream));
      assert.equal(control.stream.rest.value, "second\n");
      // Positive control for the flagged microtask assertions: without the
      // flag the queued reaction still runs and its marker reaches the log.
      assert.ok(server.logs().includes(`LIFECYCLE-LEAK ${control.microtask.tag}`),
        "unflagged microtask marker missing from the log");
    });
  });

for (const flagged of [true, false]) {
  test(`one-isolate pool: ${flagged ? "flagged retires and replaces" : "unflagged control reuses"}`,
    { timeout: 150000 }, async (t) => {
      const flags = ["nodejs_compat", ...(flagged ? ["python_workers"] : [])];
      const server = await startCelld("pool", { compatibility_flags: flags }, POOL_PORT,
        { CELLD_MAX_STATELESS_ISOLATES: "1" });
      t.after(server.close);
      const rounds = [];
      for (let i = 0; i < 5; i++) {
        const before = await timed(`${server.url}/id`, 5000);
        const pending = timed(`${server.url}/pending?ms=${flagged ? 8000 : 1500}`, 10000);
        let started = false;
        for (let j = 0; j < 100 && !started; j++) {
          const state = await timed(`${server.url}/pending-started`, 2000);
          started = state.status === 200 && JSON.parse(state.body).pendingStarted;
          if (!started) await new Promise((done) => setTimeout(done, 10));
        }
        const exit = await timed(`${server.url}/exit-microtask`, 5000);
        const pendingResult = await pending;
        const after = await timed(`${server.url}/id`, 5000);
        rounds.push({ before, started, exit, pending: pendingResult, after });
      }
      // Paced maintenance (REAP_INTERVAL = 30 s) frees drained retired heaps.
      const freedCount = () => server.logs().split("\n").filter((line) => line.includes("isolate freed")).length;
      for (let waited = 0; flagged && freedCount() < rounds.length && waited < 65000; waited += 500)
        await new Promise((done) => setTimeout(done, 500));
      const census = await timed(`${server.url}/id`, 5000);
      await evidence(`pool-${flagged ? "flagged" : "unflagged"}.json`, rounds);
      await evidence(`pool-${flagged ? "flagged" : "unflagged"}-logs.json`, { census, logs: server.logs().split("\n").filter((line) => /isolate|LIFECYCLE-LEAK/.test(line)) });
      for (const round of rounds) {
        assert.equal(round.started, true);
        assert.equal(round.exit.status, 500, JSON.stringify(round.exit));
        assert.equal(round.after.status, 200, JSON.stringify(round.after));
        const before = JSON.parse(round.before.body).id;
        const after = JSON.parse(round.after.body).id;
        if (flagged) {
          assert.ok(round.pending.elapsedMs < 3000, JSON.stringify(round.pending));
          assert.equal(round.pending.status, 500, JSON.stringify(round.pending));
          assert.match(round.pending.body, /invalidated after execution termination/);
          assert.notEqual(after, before, "a fresh isolate replaces the invalidated one");
        } else {
          assert.equal(round.pending.status, 200, JSON.stringify(round.pending));
          assert.equal(after, before, "ordinary Workers keep their isolate");
        }
      }
      if (flagged) {
        const ids = new Set(rounds.map((round) => JSON.parse(round.before.body).id));
        assert.equal(ids.size, rounds.length);
        // Resource ownership: every invalidated heap retires, then is freed
        // once its affiliated requests have drained.
        const lines = server.logs().split("\n");
        const retired = lines.filter((line) => line.includes("invalidated isolate retiring")).length;
        const freed = lines.filter((line) => line.includes("isolate freed")).length;
        assert.equal(retired, rounds.length, "one retirement per invalidation");
        assert.ok(freed >= rounds.length, `freed ${freed} of ${retired} retired heaps`);
        assert.ok(!server.logs().includes("LIFECYCLE-LEAK pool"), "guest microtask ran after invalidation");
      } else {
        // Positive control: ordinary Workers still run the queued reaction.
        assert.ok(server.logs().includes("LIFECYCLE-LEAK pool"), "unflagged microtask marker missing");
      }
    });
}
