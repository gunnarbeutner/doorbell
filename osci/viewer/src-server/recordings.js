// Discover scope recordings in the osci/ directory and group them by basename.
//
// Each recording is a set of time-aligned channels. On disk every channel is up to three files:
//   <basename>-ch<n>.csv        full true-voltage record (may be absent — large, often only .zst kept)
//   <basename>-ch<n>.csv.zst    zstd-compressed CSV (the committed form)
//   <basename>-ch<n>.wav        DC-removed, peak-normalized audio, sample-aligned 1:1 with the CSV
// plus per-recording <basename>.png (legacy overview) and <basename>.md (analysis note).

import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CH_RE = /^(.+)-ch(\d+)\.(csv\.zst|csv|wav)$/;
// optional trailing  -YYYYMMDD-HHMMSS  in a basename, e.g. some-capture-20260621-135809
// (current captures carry no timestamp — then name = full basename, date = null)
const TS_RE = /^(.*?)-(\d{8})-(\d{6})$/;

// "some-capture-20260621-135809" -> { name: "some-capture", date: "2026-06-21 13:58:09", sortKey }
function describe(basename) {
  const m = TS_RE.exec(basename);
  if (!m) return { name: basename, date: null, sortKey: basename };
  const [, name, d, t] = m;
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  return { name, date, sortKey: `${d}${t}` };
}

// Scan the directory once and return recordings, newest first. Pure file listing — no parsing.
export async function listRecordings(osciDir) {
  const recs = new Map(); // basename -> { channels:Set, exts:Map<ch, Set<ext>> }
  const extras = new Set(); // basenames that have a .png or .md
  let names;
  try {
    names = await readdir(osciDir);
  } catch {
    return [];
  }
  for (const f of names) {
    const m = CH_RE.exec(f);
    if (m) {
      const [, base, chStr, ext] = m;
      const ch = Number(chStr);
      let r = recs.get(base);
      if (!r) recs.set(base, (r = { exts: new Map() }));
      let e = r.exts.get(ch);
      if (!e) r.exts.set(ch, (e = new Set()));
      e.add(ext);
      continue;
    }
    if (f.endsWith('.png')) extras.add(`png:${f.slice(0, -4)}`);
    else if (f.endsWith('.md')) extras.add(`md:${f.slice(0, -3)}`);
    else if (f.endsWith('.json')) extras.add(`json:${f.slice(0, -5)}`);
  }

  const out = [];
  for (const [basename, r] of recs) {
    const channels = [...r.exts.keys()].sort((a, b) => a - b);
    if (!channels.length) continue;
    let { name, date, sortKey } = describe(basename);
    // No timestamp in the filename? Take captured_at from the per-recording JSON sidecar.
    if (!date && extras.has(`json:${basename}`)) {
      try {
        const meta = JSON.parse(await readFile(join(osciDir, `${basename}.json`), 'utf8'));
        if (meta.captured_at) {
          date = meta.captured_at.replace('T', ' '); // "2026-06-22T20:31:53" -> "2026-06-22 20:31:53"
          sortKey = meta.captured_at;                // ISO sorts chronologically as a string
        }
      } catch {} // missing/garbled sidecar -> no date, sort by basename (describe's fallback)
    }
    out.push({
      basename,
      label: date ? `${name}  ·  ${date}` : name,
      name,
      date,
      channels,
      hasNote: extras.has(`md:${basename}`),
      hasPng: extras.has(`png:${basename}`),
      sortKey,
    });
  }
  out.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0)); // newest first
  return out;
}

// Resolve the on-disk source CSV for a channel: prefer the raw .csv (fast), else the .csv.zst.
// Returns { path, compressed } or null if neither exists.
export async function resolveCsvSource(osciDir, basename, ch) {
  const raw = join(osciDir, `${basename}-ch${ch}.csv`);
  const zst = join(osciDir, `${basename}-ch${ch}.csv.zst`);
  try {
    const s = await stat(raw);
    return { path: raw, compressed: false, mtimeMs: s.mtimeMs, size: s.size };
  } catch {}
  try {
    const s = await stat(zst);
    return { path: zst, compressed: true, mtimeMs: s.mtimeMs, size: s.size };
  } catch {}
  return null;
}

export function wavPath(osciDir, basename, ch) {
  return join(osciDir, `${basename}-ch${ch}.wav`);
}
export function pngPath(osciDir, basename) {
  return join(osciDir, `${basename}.png`);
}
export function notePath(osciDir, basename) {
  return join(osciDir, `${basename}.md`);
}
