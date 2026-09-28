// How celld hosts the interpreter: one start per isolate, a refused hard
// termination, pending work across client disconnects, and a flat C stack.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { body, loopback, project, removeProject, startCelld } from './harness.mjs';

let directory, celld;

before(async () => {
  directory = await project('worker');
  celld = await startCelld(directory);
});

after(async () => {
  await celld?.close();
  await removeProject(directory);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('the deployment requires the Python host features and records its runtime', () => {
  const store = new DatabaseSync(join(directory, '.celld/dev/objects.sqlite3'), { readOnly: true });
  try {
    const rows = store.prepare(
      "select body from objects where key like 'deploy/python-fixture/%/manifest.json'",
    ).all();
    assert.equal(rows.length, 1);
    const manifest = JSON.parse(Buffer.from(rows[0].body).toString());
    assert.ok(manifest.required_features.includes('python-workers-v1'));
    assert.ok(manifest.required_features.includes('wasm-v1'));
    assert.deepEqual(manifest.modules.map((module) => module.name), [
      'index.js', 'pyodide.asm.wasm', 'sentinel.wasm',
    ]);
    const runtime = manifest.raw_metadata.python_runtime;
    assert.equal(runtime.pyodide, '0.28.3');
    assert.equal(runtime.python, '3.13.2');
    assert.equal(runtime.abi, '2025_0');
    assert.equal(runtime.sdk.version, '1.9.0');
  } finally {
    store.close();
  }
});

test('concurrent first requests share one interpreter start per isolate', async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => fetch(`${celld.url}/identity`).then((r) => r.json())),
  );
  const interpreters = new Map();
  for (const { interpreter, imports } of responses) {
    assert.equal(imports, 1, 'the main module ran once in its interpreter');
    interpreters.set(interpreter, (interpreters.get(interpreter) ?? 0) + 1);
  }
  assert.ok(interpreters.size >= 1);
  // Later requests reuse the started interpreters.
  const later = await fetch(`${celld.url}/identity`).then((r) => r.json());
  assert.ok(interpreters.has(later.interpreter));
  assert.equal(later.imports, 1);
});

test('the C stack does not grow across async entries', async () => {
  const depths = new Map();
  for (let index = 0; index < 400; index++) {
    const identity = await fetch(`${celld.url}/identity`).then((r) => r.json());
    const { stack } = await fetch(`${celld.url}/stack`).then((r) => r.json());
    const seen = depths.get(identity.interpreter) ?? new Set();
    seen.add(stack);
    depths.set(identity.interpreter, seen);
  }
  for (const [interpreter, seen] of depths) {
    assert.equal(seen.size, 1, `stack pointer moved in ${interpreter}: ${[...seen]}`);
  }
});

test('process.exit() throws, and a suspended peer and later requests complete', async () => {
  const held = deferred();
  const released = deferred();
  const reports = [];
  const server = await loopback(async (request, response) => {
    if (request.url === '/hold') {
      held.resolve();
      await released.promise;
      response.end('released');
    } else {
      reports.push(await body(request));
      response.end();
    }
  });
  try {
    const peer = fetch(`${celld.url}/hold?hold=${server.url}/hold&report=${server.url}/report`);
    await held.promise;
    const exit = await fetch(`${celld.url}/exit`).then((r) => r.json());
    assert.match(exit.refused, /process\.exit\(\) is not supported in Python Workers on celld/);
    released.resolve();
    const answer = await peer;
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), 'completed:released');
    assert.deepEqual(reports, ['completed:released']);
    const next = await fetch(`${celld.url}/json`);
    assert.equal(next.status, 201);
  } finally {
    await server.close();
  }
});

test('work kept by waitUntil finishes after its client disconnects', async () => {
  const held = deferred();
  const released = deferred();
  const reported = deferred();
  const server = await loopback(async (request, response) => {
    if (request.url === '/hold') {
      held.resolve();
      await released.promise;
      response.end('released');
    } else {
      reported.resolve(await body(request));
      response.end();
    }
  });
  try {
    const controller = new AbortController();
    const client = fetch(
      `${celld.url}/hold?hold=${server.url}/hold&report=${server.url}/report`,
      { signal: controller.signal },
    ).catch((error) => error);
    await held.promise;
    controller.abort();
    assert.equal((await client).name, 'AbortError');
    released.resolve();
    assert.equal(await reported.promise, 'completed:released');
    const next = await fetch(`${celld.url}/json`);
    assert.equal(next.status, 201);
  } finally {
    await server.close();
  }
});

// celld's TransformStream applies no backpressure today, so the producer
// may finish by buffering the whole body; workerd holds it at the first
// unread write instead. Either way it must finish and leave the interpreter
// serving.
test('an unread streaming response does not wedge its producer or the interpreter', async () => {
  const reported = deferred();
  const server = await loopback(async (request, response) => {
    reported.resolve(JSON.parse(await body(request)));
    response.end();
  });
  try {
    const chunks = 256;
    const url = new URL(`${celld.url}/stream?chunks=${chunks}&report=${server.url}/report`);
    await new Promise((done, reject) => {
      const outgoing = httpRequest(url, (response) => {
        assert.equal(response.statusCode, 200);
        // Read one chunk, stop reading so the stream backs up, then leave.
        response.once('data', () => {
          response.pause();
          setTimeout(() => {
            outgoing.destroy();
            done();
          }, 500);
        });
      });
      outgoing.on('error', () => {});
      outgoing.once('error', reject);
      outgoing.end();
    });
    const report = await Promise.race([
      reported.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('producer never finished')), 30_000)),
    ]);
    assert.match(report.outcome, /^(closed|error:)/);
    assert.ok(report.written <= chunks);
    const next = await fetch(`${celld.url}/json`);
    assert.equal(next.status, 201);
  } finally {
    await server.close();
  }
});

test('a failed interpreter start fails every request with the same error', async () => {
  const broken = await project('broken');
  const server = await startCelld(broken);
  try {
    const first = await Promise.all(
      Array.from({ length: 4 }, () => fetch(server.url).then(async (r) => [r.status, await r.text()])),
    );
    const later = await fetch(server.url).then(async (r) => [r.status, await r.text()]);
    for (const [status, text] of [...first, later]) {
      assert.equal(status, 500);
      assert.match(text, /RuntimeError: broken at import/);
      assert.doesNotMatch(text, /unreachable/);
    }
  } finally {
    await server.close();
    await removeProject(broken);
  }
});

// Cloudflare aborts the isolate on a fatal interpreter error (workerd
// `abortIsolate`). celld cannot yet retire an isolate on the guest's
// request, so the interpreter refuses later entries itself. A later request
// is refused or served by another isolate; it never runs on the failed one.
test('a fatal interpreter error fails its request and refuses later entries', async () => {
  const fatal = await project('worker');
  const server = await startCelld(fatal);
  try {
    assert.equal((await fetch(`${server.url}/identity`)).status, 200);
    const started = Date.now();
    const failed = await fetch(`${server.url}/recurse`, { signal: AbortSignal.timeout(20_000) });
    assert.equal(failed.status, 500);
    assert.match(await failed.text(), /Python Worker fatal error: RangeError: Maximum call stack size exceeded/);
    assert.ok(Date.now() - started < 20_000);
    for (let index = 0; index < 5; index++) {
      const response = await fetch(`${server.url}/identity`, { signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      if (response.status !== 200) {
        assert.equal(response.status, 500);
        assert.match(text, /Python Worker fatal error/);
      }
    }
  } finally {
    await server.close();
    await removeProject(fatal);
  }
});
