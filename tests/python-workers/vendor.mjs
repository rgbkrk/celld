// Build the fixtures' `python_modules/` from pinned wheels.
//
// `uv run pywrangler sync` produces the same tree for the fixture's
// pyproject.toml (workers-py 1.17.4, uv 0.12.18): the wheels below, unpacked.
// Pinning them here keeps the tests free of uv and a Pyodide interpreter
// download, and every wheel is checked against its SHA-256 before use.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { cache, pythonModules } from './harness.mjs';

const here = new URL('.', import.meta.url).pathname;

const wheels = JSON.parse(await readFile(join(here, 'fixtures/wheels.json'), 'utf8'));

async function wheel({ url, sha256 }) {
  const path = join(cache, 'wheels', url.split('/').pop());
  const verified = (bytes) => createHash('sha256').update(bytes).digest('hex') === sha256;
  try {
    const bytes = await readFile(path);
    if (verified(bytes)) return bytes;
  } catch {}
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`wheel does not match its pinned SHA-256: ${url}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return bytes;
}

// Enough of the zip format for a wheel: the central directory, then stored
// or deflated entries.
function* entries(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip archive');
  let offset = zip.readUInt32LE(end + 16);
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad zip directory');
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe wheel path ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === 0) yield [name, data];
    else if (method === 8) yield [name, inflateRawSync(data)];
    else throw new Error(`unsupported zip method ${method} for ${name}`);
  }
}

export async function vendor() {
  await rm(pythonModules, { recursive: true, force: true });
  for (const pinned of wheels) {
    for (const [name, bytes] of entries(await wheel(pinned))) {
      const path = join(pythonModules, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  }
  await writeFile(join(pythonModules, 'pyvenv.cfg'), '');
  return pythonModules;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await vendor());
}
