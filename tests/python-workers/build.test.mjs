// The Python build path of `celld deploy`: reproducible identity and the
// configurations it refuses. Every run is a dry run.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deploy, project, removeProject } from './harness.mjs';

const projects = [];
after(() => Promise.all(projects.map(removeProject)));

async function fixture(name = 'worker', options) {
  const directory = await project(name, options);
  projects.push(directory);
  return directory;
}

async function configure(directory, change) {
  const path = join(directory, 'wrangler.jsonc');
  const config = JSON.parse(await readFile(path, 'utf8'));
  change(config);
  await writeFile(path, JSON.stringify(config));
}

async function refused(directory) {
  try {
    await deploy(directory);
  } catch (error) {
    return error.stderr;
  }
  assert.fail('deploy succeeded');
}

test('identical sources and packages deploy as one version', async () => {
  const [a, b] = [await fixture(), await fixture()];
  const [first, second] = [await deploy(a), await deploy(b)];
  assert.equal(first.version, second.version);

  await appendFile(join(b, 'python_modules/bs4/__init__.py'), '\n# changed\n');
  const packages = await deploy(b);
  assert.notEqual(packages.version, first.version);

  await appendFile(join(b, 'src/app/markup.py'), '\n# changed\n');
  const sources = await deploy(b);
  assert.notEqual(sources.version, packages.version);
});

test('compatibility settings outside the Pyodide 0.28 envelope are refused', async () => {
  const cases = [
    [(c) => { c.compatibility_date = '2026-09-08'; }, /selects Pyodide 314/],
    [(c) => { c.compatibility_flags.push('python_workers_314'); }, /remove the `python_workers_314`/],
    [(c) => { c.compatibility_date = '2026-03-01'; }, /vendored Workers SDK/],
    [(c) => { c.compatibility_flags.push('disable_python_no_global_handlers'); }, /`Default` entrypoint classes/],
    [(c) => { c.compatibility_flags = []; }, /python_workers compatibility flag/],
  ];
  for (const [change, message] of cases) {
    const directory = await fixture();
    await configure(directory, change);
    assert.match(await refused(directory), message);
  }
  const opted = await fixture();
  await configure(opted, (c) => {
    c.compatibility_date = '2026-09-10';
    c.compatibility_flags.push('no_python_workers_314');
  });
  assert.ok((await deploy(opted)).version);
});

test('events other than fetch are refused', async () => {
  const cases = [
    [(c) => { c.durable_objects = { bindings: [{ name: 'D', class_name: 'Counter' }] }; }, /Durable Objects/],
    [(c) => { c.triggers = { crons: ['* * * * *'] }; }, /Cron Triggers/],
    [(c) => { c.no_bundle = true; }, /do not support `no_bundle`/],
  ];
  for (const [change, message] of cases) {
    const directory = await fixture();
    await configure(directory, change);
    assert.match(await refused(directory), message);
  }
});

test('packages must be vendored, pure-Python files', async () => {
  const missing = await fixture('worker', { modules: false });
  assert.match(await refused(missing), /pywrangler sync/);

  const compiled = await fixture();
  await mkdir(join(compiled, 'python_modules/native'), { recursive: true });
  await writeFile(join(compiled, 'python_modules/native/_speedups.cpython-313-wasm32-emscripten.so'), '');
  assert.match(await refused(compiled), /compiled extension/);

  const withoutSdk = await fixture();
  await rm(join(withoutSdk, 'python_modules/workers'), { recursive: true });
  assert.match(await refused(withoutSdk), /Workers SDK/);
});
