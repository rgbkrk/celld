// Body streams are ReadableStreams to guest code. The Python Workers SDK
// accepts a JS body only when its constructor is named ReadableStream.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loopback, project, removeProject, startCelld } from './harness.mjs';

const require = createRequire(import.meta.url);

test('body streams report ReadableStream as their constructor, as on workerd', async () => {
  const upstream = await loopback((request, response) => response.end('upstream'));
  const directory = await project('body-stream', { modules: false });
  const celld = await startCelld(directory);
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const reference = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: await readFile(new URL('fixtures/body-stream/index.js', import.meta.url), 'utf8'),
    compatibilityDate: '2026-09-01',
  }));
  try {
    const results = [];
    for (const url of [celld.url, String(await reference.ready).replace(/\/$/, '')]) {
      const response = await fetch(`${url}/?upstream=${upstream.url}`, { method: 'POST', body: 'body' });
      results.push(await response.json());
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], {
      request: 'ReadableStream',
      response: 'ReadableStream',
      constructed: 'ReadableStream',
      isReadableStream: true,
    });
  } finally {
    await Promise.all([celld.close(), reference.dispose(), upstream.close()]);
    await removeProject(directory);
  }
});
