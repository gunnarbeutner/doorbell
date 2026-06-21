// Dev server for the osci recording viewer.
//   /api/recordings          list recordings in osci/ (scan only)
//   /api/meta?rec=           per-channel metadata (lazy parse / disk cache)
//   /api/samples?rec=&ch=&t0=&t1=&px=   min/max-envelope (or raw) samples, binary body + X-Osci-Meta
//   /api/wav?rec=&ch=        the channel WAV, with HTTP Range support
//   /api/note?rec=           the recording's .md analysis note
//   /osci-asset/<base>.png   the legacy overview PNG
//   everything else          static files from public/
//
// Zero runtime dependencies: node:http + node:zlib (native zstd) + a vanilla-JS canvas frontend.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, basename as pathBasename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecordings, resolveCsvSource, notePath, pngPath } from './src-server/recordings.js';
import { loadChannel } from './src-server/cache.js';
import { decimate } from './src-server/decimate.js';
import { packSamples } from './src-server/binio.js';
import { serveWav, wavInfo } from './src-server/wav.js';
import { detectEvents } from './src-server/events.js';
import { detectHighLevel } from './src-server/highlevel.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const OSCI_DIR = process.env.OSCI_DIR ? process.env.OSCI_DIR : join(ROOT, '..');
const CACHE_DIR = join(ROOT, '.cache');
const PORT = process.env.PORT || 8137; // not 8080 — sim/ already uses that

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.md': 'text/markdown',
  '.ico': 'image/x-icon',
};

// Bus-pin names per channel (grounds on P1). CH1 reads line 4 (IN_P4 bridged to P4).
// CH4 (P5 / Etagenruf) is optional — only the 4-channel recordings carry it; 3-channel
// recordings just omit it. Any further channel falls back to a generic CH<n> label.
const DEFAULT_LABELS = { 1: 'P4', 2: 'P2', 3: 'P3', 4: 'P5' };

const sendJson = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const fail = (res, status, msg) => {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(msg);
};

// Confirm a recording exists (and which channels it has) before touching it.
async function recordingChannels(rec) {
  if (!rec || /[/\\]/.test(rec)) return null;
  const all = await listRecordings(OSCI_DIR);
  return all.find((r) => r.basename === rec) || null;
}

async function handleMeta(rec, res) {
  const info = await recordingChannels(rec);
  if (!info) return fail(res, 404, `unknown recording "${rec}"`);
  const channels = [];
  let tStart = Infinity;
  let tEnd = -Infinity;
  for (const ch of info.channels) {
    const c = await loadChannel(OSCI_DIR, CACHE_DIR, rec, ch);
    const wav = await wavInfo(OSCI_DIR, rec, ch);
    const t1 = c.t0 + c.dt * (c.n - 1);
    tStart = Math.min(tStart, c.t0);
    tEnd = Math.max(tEnd, t1);
    channels.push({
      ch, label: DEFAULT_LABELS[ch] || `CH${ch}`,
      t0: c.t0, dt: c.dt, n: c.n, vmin: c.vmin, vmax: c.vmax, vmeanDC: c.vmeanDC,
      wavSampleRate: wav?.sampleRate || null,
    });
  }
  sendJson(res, { basename: rec, name: info.name, date: info.date, channels, tStart, tEnd, hasNote: info.hasNote, hasPng: info.hasPng });
}

async function handleSamples(params, res) {
  const rec = params.get('rec');
  const info = await recordingChannels(rec);
  if (!info) return fail(res, 404, `unknown recording "${rec}"`);
  const chs = (params.get('ch') || info.channels.join(','))
    .split(',').map((s) => Number(s.trim())).filter((n) => info.channels.includes(n));
  const tA = parseFloat(params.get('t0'));
  const tB = parseFloat(params.get('t1'));
  const px = Math.min(8192, Math.max(1, parseInt(params.get('px') || '1600', 10)));
  if (!chs.length || Number.isNaN(tA) || Number.isNaN(tB) || tB <= tA) return fail(res, 400, 'bad params');

  const blocks = [];
  for (const ch of chs) {
    const c = await loadChannel(OSCI_DIR, CACHE_DIR, rec, ch);
    const { meta, data } = decimate(c, tA, tB, px);
    blocks.push({ ch, meta, data });
  }
  const { meta, body } = packSamples(blocks);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'X-Osci-Meta': JSON.stringify(meta),
    'content-length': body.length,
  });
  res.end(body);
}

async function handleEvents(rec, res) {
  const info = await recordingChannels(rec);
  if (!info) return fail(res, 404, `unknown recording "${rec}"`);
  const items = [];
  for (const ch of info.channels) {
    const c = await loadChannel(OSCI_DIR, CACHE_DIR, rec, ch);
    items.push({ ch, label: DEFAULT_LABELS[ch] || `CH${ch}`, rec: c });
  }
  sendJson(res, { events: detectEvents(items), highlevel: detectHighLevel(items) });
}

async function handleNote(rec, res) {
  const info = await recordingChannels(rec);
  if (!info) return fail(res, 404, 'unknown recording');
  try {
    const md = await readFile(notePath(OSCI_DIR, rec), 'utf8');
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
    res.end(md);
  } catch {
    fail(res, 404, 'no note');
  }
}

async function handlePng(file, res) {
  const base = pathBasename(file, '.png');
  if (/[/\\]/.test(base)) return fail(res, 400, 'bad asset');
  try {
    const data = await readFile(pngPath(OSCI_DIR, base));
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(data);
  } catch {
    fail(res, 404, 'no png');
  }
}

async function serveStatic(path, res) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const data = await readFile(join(PUBLIC, rel));
  res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
  res.end(data);
}

createServer(async (req, res) => {
  const [pathRaw, query] = req.url.split('?');
  const path = decodeURIComponent(pathRaw);
  const params = new URLSearchParams(query || '');
  try {
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (path === '/api/recordings') return sendJson(res, { recordings: await listRecordings(OSCI_DIR) });
    if (path === '/api/meta') return await handleMeta(params.get('rec'), res);
    if (path === '/api/samples') return await handleSamples(params, res);
    if (path === '/api/wav') {
      const rec = params.get('rec');
      const ch = Number(params.get('ch'));
      if (!(await recordingChannels(rec)) || /[/\\]/.test(rec || '') || !Number.isInteger(ch)) return fail(res, 400, 'bad wav request');
      return await serveWav(OSCI_DIR, rec, ch, req, res);
    }
    if (path === '/api/events') return await handleEvents(params.get('rec'), res);
    if (path === '/api/note') return await handleNote(params.get('rec'), res);
    if (path.startsWith('/osci-asset/')) return await handlePng(path.slice('/osci-asset/'.length), res);
    return await serveStatic(path, res);
  } catch (e) {
    fail(res, path.startsWith('/api/') ? 500 : 404, String(e?.message || e));
  }
}).listen(PORT, () => {
  console.log(`osci viewer → http://localhost:${PORT}   (data: ${OSCI_DIR})`);
});
