// Discover scope recordings in the captures/runs/ directory — one subdir per recording.
//
// Each recording is a subdirectory of runs/ containing time-aligned channels:
//   ch<n>.csv        full true-voltage record (may be absent — large, often only .zst kept)
//   ch<n>.csv.zst    zstd-compressed CSV (the committed form)
//   ch<n>.wav        DC-removed, peak-normalized audio, sample-aligned 1:1 with the CSV
// plus per-recording preview.png (legacy overview), notes.md (analysis note), and
// meta.json (capture timestamp + acquisition params).

import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CH_RE = /^ch(\d+)\.(csv\.zst|csv|wav)$/;

// Scan the runs/ directory and return recordings, newest first. Pure file listing — no parsing.
export async function listRecordings(capturesDir) {
  const runsDir = join(capturesDir, 'runs');
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const basename = entry.name;
    const recDir = join(runsDir, basename);
    let files;
    try {
      files = await readdir(recDir);
    } catch {
      continue;
    }
    const channels = new Set();
    let hasPng = false, hasNote = false, hasMeta = false;
    for (const f of files) {
      const m = CH_RE.exec(f);
      if (m) {
        channels.add(Number(m[1]));
        continue;
      }
      if (f === 'preview.png') hasPng = true;
      else if (f === 'notes.md') hasNote = true;
      else if (f === 'meta.json') hasMeta = true;
    }
    if (!channels.size) continue;
    const sortedChannels = [...channels].sort((a, b) => a - b);

    // Read captured_at from meta.json for the date label and sort order.
    let date = null;
    let sortKey = basename;
    if (hasMeta) {
      try {
        const meta = JSON.parse(await readFile(join(recDir, 'meta.json'), 'utf8'));
        if (meta.captured_at) {
          date = meta.captured_at.replace('T', ' '); // "2026-06-22T20:31:53" -> "2026-06-22 20:31:53"
          sortKey = meta.captured_at;                // ISO sorts chronologically as a string
        }
      } catch {} // missing/garbled sidecar -> no date, sort by basename
    }

    out.push({
      basename,
      label: date ? `${basename}  ·  ${date}` : basename,
      name: basename,
      date,
      channels: sortedChannels,
      hasNote,
      hasPng,
      sortKey,
    });
  }
  out.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0)); // newest first
  return out;
}

// Resolve the on-disk source CSV for a channel: prefer the raw .csv (fast), else the .csv.zst.
// Returns { path, compressed } or null if neither exists.
export async function resolveCsvSource(capturesDir, basename, ch) {
  const recDir = join(capturesDir, 'runs', basename);
  const raw = join(recDir, `ch${ch}.csv`);
  const zst = join(recDir, `ch${ch}.csv.zst`);
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

export function wavPath(capturesDir, basename, ch) {
  return join(capturesDir, 'runs', basename, `ch${ch}.wav`);
}
export function pngPath(capturesDir, basename) {
  return join(capturesDir, 'runs', basename, 'preview.png');
}
export function notePath(capturesDir, basename) {
  return join(capturesDir, 'runs', basename, 'notes.md');
}
