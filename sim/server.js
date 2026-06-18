// Dev server: serves the UI (index.html, src/*.js) and the netlist.
// The netlist is NOT a static file — GET /netlist.json runs the importer (src/import.js -> kicad-cli),
// reading the KiCad schematic live. The result is cached and re-imported only when a .kicad_sch /
// .kicad_pcb (or src/import.js) changes, so reloads are instant unless the design actually changed.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importNetlist } from './src/import.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const KICAD = join(ROOT, '..', 'kicad');
const PORT = process.env.PORT || 8080;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };

let cache = null;
let cacheKey = 0; // newest mtime of the importer inputs at the time we cached

async function inputsMtime() {
  let newest = (await stat(join(ROOT, 'src', 'import.js'))).mtimeMs;
  for (const f of await readdir(KICAD)) {
    if (f.endsWith('.kicad_sch') || f.endsWith('.kicad_pcb')) newest = Math.max(newest, (await stat(join(KICAD, f))).mtimeMs);
  }
  return newest;
}

async function netlist() {
  const key = await inputsMtime();
  if (!cache || key > cacheKey) {
    cache = JSON.stringify(importNetlist()); // reads the KiCad files live (via kicad-cli)
    cacheKey = key;
    process.stderr.write(`[netlist] imported from KiCad (${(cache.length / 1024) | 0} KB)\n`);
  }
  return cache;
}

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (path === '/netlist.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(await netlist());
      return;
    }
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const data = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(path === '/netlist.json' ? 500 : 404);
    res.end(String(e.message || e));
  }
}).listen(PORT, () => console.log(`sim dev server → http://localhost:${PORT}  (netlist served live from ../kicad)`));
