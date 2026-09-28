import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startCelld } from './local-celld.mjs';

const MiB = 1024 * 1024;
const settings = {
  CELLD_MAX_ASSET_FILE_BYTES: undefined,
  CELLD_MAX_DYNAMIC_WORKER_CODE_BYTES: undefined,
  CELLD_V8_HEAP_LIMIT_MB: '512',
};

test('host module limits reject invalid configuration before serving', () => {
  assert.ok(process.env.CELLD_BIN, 'set CELLD_BIN to the candidate build');
  for (const name of ['CELLD_MAX_ASSET_FILE_BYTES', 'CELLD_MAX_DYNAMIC_WORKER_CODE_BYTES']) {
    for (const value of ['0', '-1', 'invalid', '18446744073709551616']) {
      const result = spawnSync(process.env.CELLD_BIN, ['--help'], {
        env: { ...process.env, ...settings, [name]: value }, encoding: 'utf8', timeout: 10000,
      });
      assert.notEqual(result.status, 0, `${name}=${value}`);
      assert.match(result.stderr, new RegExp(name));
    }
  }
});

const assetWorker = `export default {fetch(request, env) { return env.ASSETS.fetch(request); }};`;
const assetConfig = { assets: { directory: 'assets', binding: 'ASSETS' } };

test('large immutable assets require an explicit host build override', { timeout: 60000 }, async (t) => {
  const files = { 'index.js': assetWorker, 'assets/large.bin': Buffer.alloc(26 * MiB) };
  await assert.rejects(startCelld(files, assetConfig, settings), /26214400-byte file limit/);
  const server = await startCelld(files, assetConfig, {
    ...settings, CELLD_MAX_ASSET_FILE_BYTES: String(256 * MiB),
  });
  t.after(server.close);
  const response = await fetch(server.url + '/large.bin', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(26 * MiB));
});

test('configured asset byte boundary stays inclusive', { timeout: 60000 }, async (t) => {
  const environment = { ...settings, CELLD_MAX_ASSET_FILE_BYTES: '1024' };
  await assert.rejects(startCelld({
    'index.js': assetWorker, 'assets/boundary.bin': Buffer.alloc(1025),
  }, assetConfig, environment), /1024-byte file limit/);
  const server = await startCelld({
    'index.js': assetWorker, 'assets/boundary.bin': Buffer.alloc(1024),
  }, assetConfig, environment);
  t.after(server.close);
  const response = await fetch(server.url + '/boundary.bin', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '1024');
});

const loaderWorker = `export default {async fetch(request, env) {
  const bytes = Number(new URL(request.url).searchParams.get('bytes'));
  const base = "export default {fetch(){return new Response('loaded')}};";
  const source = base + ' '.repeat(bytes - base.length);
  try {
    const worker = env.LOADER.load({
      mainModule: 'worker.js', modules: {'worker.js': source},
      compatibilityDate: '2026-09-21', globalOutbound: null,
    });
    return await worker.getEntrypoint().fetch(request);
  } catch (error) { return new Response(error.message, {status: 400}); }
}};`;
const loaderConfig = { worker_loaders: [{ binding: 'LOADER' }] };

test('dynamic-worker default remains 64 MiB and a larger operator limit admits the same source',
  { timeout: 90000 }, async (t) => {
    const bytes = 65 * MiB;
    const baseline = await startCelld({ 'index.js': loaderWorker }, loaderConfig, settings);
    try {
      const response = await fetch(baseline.url + '/?bytes=' + bytes);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /maximum allowed size of 67108864 bytes/);
    } finally { await baseline.close(); }
    const server = await startCelld({ 'index.js': loaderWorker }, loaderConfig, {
      ...settings, CELLD_MAX_DYNAMIC_WORKER_CODE_BYTES: String(512 * MiB),
    });
    t.after(server.close);
    const response = await fetch(server.url + '/?bytes=' + bytes);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'loaded');
  });

test('configured dynamic-worker byte boundary stays inclusive', { timeout: 60000 }, async (t) => {
  const server = await startCelld({ 'index.js': loaderWorker }, loaderConfig, {
    ...settings, CELLD_MAX_DYNAMIC_WORKER_CODE_BYTES: '1024',
  });
  t.after(server.close);
  const accepted = await fetch(server.url + '/?bytes=1024');
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), 'loaded');
  const rejected = await fetch(server.url + '/?bytes=1025');
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /maximum allowed size of 1024 bytes/);
});
