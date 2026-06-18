// Dev server: serves the UI (index.html, src/*.js) and the netlist.
// The netlist is NOT a static file — GET /netlist.json runs the importer (src/import.js -> kicad-cli),
// reading the KiCad schematic live. The result is cached and re-imported only when a .kicad_sch /
// .kicad_pcb (or src/import.js) changes, so reloads are instant unless the design actually changed.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importNetlist, PROJECTS } from './src/import.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8080;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };

const cache = new Map(); // board -> { json, key }; key = newest mtime of that board's inputs when cached

async function inputsMtime(dir) {
  let newest = (await stat(join(ROOT, 'src', 'import.js'))).mtimeMs;
  for (const f of await readdir(dir)) {
    if (f.endsWith('.kicad_sch') || f.endsWith('.kicad_pcb') || f.endsWith('.sim'))
      newest = Math.max(newest, (await stat(join(dir, f))).mtimeMs);
  }
  return newest;
}

async function netlist(board) {
  const key = await inputsMtime(PROJECTS[board].dir);
  const c = cache.get(board);
  if (c && key <= c.key) return c.json;
  const json = JSON.stringify(importNetlist(board)); // reads the KiCad files live (via kicad-cli)
  cache.set(board, { json, key });
  process.stderr.write(`[netlist] ${board}: imported from KiCad (${(json.length / 1024) | 0} KB)\n`);
  return json;
}

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (path === '/netlist.json') {
      const board = new URLSearchParams(req.url.split('?')[1] || '').get('board') || 'doorbell';
      if (!PROJECTS[board]) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`unknown board "${board}" (have: ${Object.keys(PROJECTS).join(', ')})`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(await netlist(board));
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
}).listen(PORT, () =>
  console.log(`sim dev server → http://localhost:${PORT}  (netlist served live; boards: ${Object.keys(PROJECTS).join(', ')})`),
);
