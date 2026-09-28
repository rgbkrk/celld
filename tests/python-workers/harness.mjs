// Test-owned celld and workerd servers for the Python Workers tests.
//
// Every server listens on loopback, every project and its storage live in a
// temporary directory, and `close()` stops only the processes this harness
// started.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const here = new URL('.', import.meta.url).pathname;
const require = createRequire(import.meta.url);

export const cache = join(here, '.cache');
/// Where `vendor.mjs` unpacks the fixtures' packages.
export const pythonModules = join(cache, 'python_modules');

export const celldBin = process.env.CELLD_BIN || join(here, '../../target/debug/celld');
const toolEnv = () => ({
  CELLD_ESBUILD: process.env.CELLD_ESBUILD || join(here, 'node_modules/.bin/esbuild'),
  CELLD_PYTHON_RUNTIME_DIR:
    process.env.CELLD_PYTHON_RUNTIME_DIR || join(cache, 'pyodide-0.28.3'),
});

/// A private copy of a fixture with the vendored packages beside it.
export async function project(fixture, { modules = true } = {}) {
  await mkdir(join(cache, 'projects'), { recursive: true });
  const directory = await mkdtemp(join(cache, 'projects', `${fixture}-`));
  await cp(join(here, 'fixtures', fixture), directory, { recursive: true });
  if (modules) await cp(pythonModules, join(directory, 'python_modules'), { recursive: true });
  return directory;
}

export async function deploy(directory, ...args) {
  const { stdout } = await promisify(execFile)(
    celldBin,
    ['deploy', directory, '--dry-run', '--json', ...args],
    { env: { ...process.env, ...toolEnv() }, timeout: 120_000 },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// `celld dev` runs its node in a separate process group, so stop every
// descendant of the supervisor, not only the group.
function descendants(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  return owned;
}

export async function startCelld(directory, { env = {} } = {}) {
  const port = await freePort();
  let logs = '';
  const child = spawn(celldBin, ['dev', directory, '--port', String(port), '--no-watch', '--logs'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...toolEnv(), ...env },
  });
  const exited = new Promise((done) => child.once('exit', done));
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`celld dev did not start\n${logs}`)), 120_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`celld dev exited ${code}\n${logs}`));
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (data) => {
        logs += data;
        if (logs.includes('ready  http://')) {
          clearTimeout(timer);
          done();
        }
      });
    }
  });
  let closing;
  return {
    url: `http://127.0.0.1:${port}`,
    logs: () => logs,
    close: () => closing ??= (async () => {
      const owned = descendants(child.pid);
      for (const pid of owned) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      const timer = setTimeout(() => {
        for (const pid of owned) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }, 5000);
      await exited;
      clearTimeout(timer);
      const deadline = Date.now() + 5000;
      for (;;) {
        const live = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' })
          .trim().split('\n').map((line) => line.trim().split(/\s+/))
          .filter(([pid, state]) => owned.has(Number(pid)) && !state.startsWith('Z'));
        if (live.length === 0) break;
        if (Date.now() > deadline) throw new Error(`celld processes did not stop: ${JSON.stringify(live)}`);
        await new Promise((done) => setTimeout(done, 50));
      }
    })(),
  };
}

async function files(directory, prefix = directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__pycache__') out.push(...await files(path, prefix));
    } else {
      out.push(relative(prefix, path));
    }
  }
  return out.sort();
}

/// The same project on workerd, through Miniflare, with the module layout
/// Wrangler uploads: sources relative to the entry directory, and
/// `python_modules/` as Python and Data modules.
export async function startReference(directory, { compatibilityDate = '2026-09-01' } = {}) {
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const source = join(directory, 'src');
  const modules = [];
  for (const path of await files(source)) {
    if (path.endsWith('.py')) {
      modules.push({ type: 'PythonModule', path, contents: await readFile(join(source, path)) });
    }
  }
  modules.sort((a, b) => (b.path === 'entry.py') - (a.path === 'entry.py'));
  for (const path of await files(join(directory, 'python_modules'))) {
    modules.push({
      type: path.endsWith('.py') ? 'PythonModule' : 'Data',
      path: `python_modules/${path}`,
      contents: await readFile(join(directory, 'python_modules', path)),
    });
  }
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules,
    compatibilityDate,
    compatibilityFlags: ['python_workers'],
    kvNamespaces: ['KV'],
  }));
  const url = String(await miniflare.ready).replace(/\/$/, '');
  return { url, close: () => miniflare.dispose() };
}

/// A loopback HTTP server whose handler the test supplies.
export async function loopback(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    }),
  };
}

export async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

export const removeProject = (directory) => rm(directory, { recursive: true, force: true });
