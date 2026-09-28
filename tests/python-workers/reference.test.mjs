// The same Python Worker and the same vendored packages on celld and on
// workerd. Each case compares status, the headers it names, and the body.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { body, loopback, project, removeProject, startCelld, startReference } from './harness.mjs';

let directory, celld, reference, upstream;

before(async () => {
  directory = await project('worker');
  upstream = await loopback(async (request, response) => {
    const received = await body(request);
    response.writeHead(200, { 'x-upstream': request.headers['x-from'] ?? 'none' });
    response.end(`${request.method} ${received}`);
  });
  [celld, reference] = await Promise.all([startCelld(directory), startReference(directory)]);
});

after(async () => {
  await Promise.all([celld?.close(), reference?.close(), upstream?.close()]);
  await removeProject(directory);
});

async function both(path, init = {}) {
  const results = [];
  for (const server of [celld, reference]) {
    const response = await fetch(server.url + path, init);
    results.push({
      status: response.status,
      headers: response.headers,
      bytes: Buffer.from(await response.arrayBuffer()),
    });
  }
  return results;
}

const json = (result) => JSON.parse(result.bytes.toString());

test('interpreter environment matches', async () => {
  const [a, b] = await both('/env');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(json(a), json(b));
  assert.equal(json(a).sdk, '1.9.0');
});

test('JSON response status, headers and body match', async () => {
  const [a, b] = await both('/json');
  assert.equal(a.status, 201);
  assert.equal(a.status, b.status);
  assert.equal(a.headers.get('x-kind'), b.headers.get('x-kind'));
  assert.equal(a.headers.get('content-type'), b.headers.get('content-type'));
  assert.deepEqual(json(a), json(b));
});

test('binary response bytes match', async () => {
  const [a, b] = await both('/bytes');
  assert.equal(a.bytes.length, 256);
  assert.deepEqual(a.bytes, b.bytes);
  assert.equal(a.headers.get('content-type'), b.headers.get('content-type'));
});

test('request body passes through as a stream', async () => {
  const payload = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251));
  const init = { method: 'PUT', body: payload, headers: { 'content-type': 'application/x-test' } };
  const [a, b] = await both('/echo', init);
  assert.equal(a.status, 200);
  assert.deepEqual(a.bytes, payload);
  assert.deepEqual(b.bytes, payload);
  for (const name of ['x-method', 'content-type']) {
    assert.equal(a.headers.get(name), b.headers.get(name));
  }
});

test('request text and headers match', async () => {
  const [a, b] = await both('/text', { method: 'POST', body: 'héllo wörld' });
  assert.equal(a.bytes.toString(), 'dlröw olléh');
  assert.deepEqual(a.bytes, b.bytes);
  assert.equal(a.headers.get('x-length'), b.headers.get('x-length'));
  const [c, d] = await both('/headers', { headers: { 'x-list': 'one, two' } });
  assert.deepEqual(json(c), json(d));
  assert.equal(c.headers.get('x-reply'), d.headers.get('x-reply'));
});

test('KV binding through the SDK wrapper matches', async () => {
  const [a, b] = await both('/kv');
  assert.equal(a.status, 200);
  assert.deepEqual(json(a), json(b));
  assert.deepEqual(json(a), { names: ['alpha', 'beta'], beta: { n: 2 }, alpha_after_delete: null });
});

test('outbound fetch to a loopback server matches', async () => {
  const [a, b] = await both(`/fetch?target=${encodeURIComponent(upstream.url + '/x')}`);
  assert.deepEqual(json(a), { status: 200, body: 'POST ping', header: 'python' });
  assert.deepEqual(json(a), json(b));
});

test('vendored package with a local module matches', async () => {
  const [a, b] = await both('/soup');
  assert.deepEqual(json(a), { text: 'hi there', bold: 'there', count: 2 });
  assert.deepEqual(json(a), json(b));
});

test('an exception fails its request and the next request succeeds', async () => {
  const [a, b] = await both('/error');
  assert.equal(a.status, 500);
  assert.equal(b.status, 500);
  // Both runtimes carry the Python traceback; the page around it differs.
  for (const result of [a, b]) {
    assert.match(result.bytes.toString(), /ValueError: boom from python/);
    assert.match(result.bytes.toString(), /\/session\/metadata\/entry\.py/);
  }
  const [c, d] = await both('/json');
  assert.equal(c.status, 201);
  assert.equal(d.status, 201);
});

test('waitUntil keeps background work running after the response', async () => {
  const key = `k${Date.now()}`;
  const [a, b] = await both(`/wait?key=${key}`);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  for (const server of [celld, reference]) {
    let value = null;
    for (let attempt = 0; attempt < 50 && value === null; attempt++) {
      const response = await fetch(`${server.url}/kv-get?key=waited-${key}`);
      value = (await response.json()).value;
      if (value === null) await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(value, 'done');
  }
});
