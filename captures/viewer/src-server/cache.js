// Channel cache: in-memory LRU over parsed channels, backed by an on-disk binary cache so the
// multi-second parse of a multi-million-row recording is paid only once.
//
// Disk cache (gitignored .cache/):  <base>-ch<n>.f32   raw Float32 voltage bytes
//                                   <base>-ch<n>.json  { t0, dt, n, vmin, vmax, vmeanDC, srcMtimeMs, srcSize }
// A cache entry is valid when its recorded source mtime+size still match the live source file.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCsvSource } from './recordings.js';
import { parseChannelSource } from './csvstore.js';

const CAP_BYTES = (Number(process.env.OSCI_CACHE_MB) || 256) * 1024 * 1024;

const mem = new Map(); // key -> channel record (Map preserves insertion order → LRU)
const inflight = new Map(); // key -> Promise
let resident = 0;

const keyOf = (basename, ch) => `${basename}:ch${ch}`;

function touch(key, rec) {
  mem.delete(key);
  mem.set(key, rec); // re-insert → most-recently-used
}

function evictIfNeeded() {
  while (resident > CAP_BYTES && mem.size > 1) {
    const oldest = mem.keys().next().value;
    const rec = mem.get(oldest);
    mem.delete(oldest);
    resident -= rec.volts.byteLength;
    process.stderr.write(`[cache] evict ${oldest} (resident ${(resident / 1e6) | 0} MB)\n`);
  }
}

async function loadFromDisk(cacheDir, basename, ch, source) {
  const metaPath = join(cacheDir, `${basename}-ch${ch}.json`);
  const dataPath = join(cacheDir, `${basename}-ch${ch}.f32`);
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (meta.srcMtimeMs !== source.mtimeMs || meta.srcSize !== source.size) return null;
  let bytes;
  try {
    bytes = await readFile(dataPath);
  } catch {
    return null;
  }
  if (bytes.byteLength !== meta.n * 4) return null;
  const volts = new Float32Array(meta.n);
  // copy out of the (possibly larger / unaligned) Buffer into a fresh, aligned Float32Array
  new Uint8Array(volts.buffer).set(bytes);
  return { t0: meta.t0, dt: meta.dt, n: meta.n, volts, vmin: meta.vmin, vmax: meta.vmax, vmeanDC: meta.vmeanDC };
}

async function saveToDisk(cacheDir, basename, ch, source, rec) {
  await mkdir(cacheDir, { recursive: true });
  const metaPath = join(cacheDir, `${basename}-ch${ch}.json`);
  const dataPath = join(cacheDir, `${basename}-ch${ch}.f32`);
  await writeFile(dataPath, Buffer.from(rec.volts.buffer, rec.volts.byteOffset, rec.n * 4));
  await writeFile(
    metaPath,
    JSON.stringify({
      t0: rec.t0, dt: rec.dt, n: rec.n,
      vmin: rec.vmin, vmax: rec.vmax, vmeanDC: rec.vmeanDC,
      srcMtimeMs: source.mtimeMs, srcSize: source.size,
    }),
  );
}

// Load one parsed channel: memory → disk cache → parse (and backfill both caches).
export function loadChannel(capturesDir, cacheDir, basename, ch) {
  const key = keyOf(basename, ch);
  const hit = mem.get(key);
  if (hit) {
    touch(key, hit);
    return Promise.resolve(hit);
  }
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const source = await resolveCsvSource(capturesDir, basename, ch);
    if (!source) throw new Error(`no CSV for ${basename} ch${ch}`);

    let rec = await loadFromDisk(cacheDir, basename, ch, source);
    if (rec) {
      process.stderr.write(`[cache] hit ${key} (disk, ${rec.n} samples)\n`);
    } else {
      const t = Date.now();
      rec = await parseChannelSource(source);
      process.stderr.write(`[parse] ${key}: ${rec.n} samples in ${Date.now() - t} ms\n`);
      saveToDisk(cacheDir, basename, ch, source, rec).catch((e) =>
        process.stderr.write(`[cache] save failed ${key}: ${e.message}\n`),
      );
    }

    mem.set(key, rec);
    resident += rec.volts.byteLength;
    evictIfNeeded();
    return rec;
  })();

  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}
