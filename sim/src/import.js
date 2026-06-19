// import.js — KiCad schematic -> netlist object (node only; used by server.js and the tests).
// Connectivity comes from KiCad's own netlister (`kicad-cli sch export netlist`); everything else
// (values, lib_ids, PCB geometry) is parsed here from the .kicad_sch / .kicad_pcb s-expressions.
// Nothing is written to disk — callers get the object and serve/consume it live.
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // sim/src
const ROOT = join(HERE, '..', '..'); // repo root

// Loadable projects: each is a directory of .kicad_sch files (root + hierarchical sub-sheets) + a .kicad_pcb.
export const PROJECTS = {
  doorbell: { dir: join(ROOT, 'kicad'), sch: 'doorbell.kicad_sch', pcb: 'doorbell.kicad_pcb' },
  wf26: { dir: join(ROOT, 'wf26'), sch: 'wf26.kicad_sch', pcb: 'wf26.kicad_pcb' },
};

// (Classification — which device class models a symbol — lives in src/components/, not here.
//  The importer just produces raw components: ref, lib, value, pins, pinfn.)

// optional per-board sim config (e.g. layers to hide by default) in a JSON file next to the board:
// <board>.sim alongside <board>.kicad_sch / .kicad_pcb. Missing or malformed -> empty config.
function readConfig(dir, sch) {
  const f = join(dir, sch.replace(/\.kicad_sch$/, '.sim'));
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

// JLCPCB part names often carry the value when the Value field is blank (e.g. "0603,100Ω")
function valueFromLibname(lib) {
  if (!lib) return '';
  const name = lib.split(':').pop();
  const m = name.match(/([0-9][0-9.]*\s*[pnuµmkKMGR]?)\s*(?:Ω|ohm|F|H)/i);
  return m ? m[1].replace(/µ/g, 'u').replace(/\s/g, '') : '';
}

// return every top-level "(tag ...)" s-expression block in `s` (brace-balanced)
function sexprBlocks(s, tag) {
  const out = [];
  let i = 0;
  while (true) {
    i = s.indexOf('(' + tag, i);
    if (i < 0) break;
    let d = 0, j = i;
    for (; j < s.length; j++) {
      if (s[j] === '(') d++;
      else if (s[j] === ')') { d--; if (d === 0) break; }
    }
    out.push(s.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

function netName(block, nummap) {
  let m = block.match(/\(net (\d+) "([^"]*)"\)/);
  if (m) return m[2];
  m = block.match(/\(net "([^"]*)"\)/);
  if (m) return m[1];
  m = block.match(/\(net (\d+)\)/);
  if (m) return nummap[m[1]] ?? '';
  return '';
}

function parsePcb(pcb) {
  if (!existsSync(pcb)) return null;
  const s = readFileSync(pcb, 'utf8');
  const nummap = {};
  for (const m of s.matchAll(/\(net (\d+) "([^"]*)"\)/g)) nummap[m[1]] = m[2];
  const layers = [...s.matchAll(/\((\d+) "([^"]+)" (?:signal|mixed|power|user)/g)]
    .map((m) => m[2]).filter((n) => n.endsWith('.Cu'));

  const segments = [];
  for (const b of sexprBlocks(s, 'segment')) {
    const st = b.match(/\(start ([-\d.]+) ([-\d.]+)\)/), en = b.match(/\(end ([-\d.]+) ([-\d.]+)\)/);
    const w = b.match(/\(width ([-\d.]+)\)/), ly = b.match(/\(layer "([^"]+)"\)/);
    if (!(st && en && ly)) continue;
    segments.push({ x1: +st[1], y1: +st[2], x2: +en[1], y2: +en[2], w: w ? +w[1] : 0.2, layer: ly[1], net: netName(b, nummap) });
  }
  const vias = [];
  for (const b of sexprBlocks(s, 'via')) {
    const at = b.match(/\(at ([-\d.]+) ([-\d.]+)\)/), sz = b.match(/\(size ([-\d.]+)\)/);
    if (!at) continue;
    vias.push({ x: +at[1], y: +at[2], r: (sz ? +sz[1] : 0.6) / 2, layers: [...b.matchAll(/"([FB]\.Cu|In\d\.Cu)"/g)].map((m) => m[1]), net: netName(b, nummap) });
  }
  const pads = [];
  for (const fp of sexprBlocks(s, 'footprint')) {
    const fat = fp.match(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/);
    if (!fat) continue;
    const frefM = fp.match(/\(property "Reference" "([^"]+)"/);
    const fref = frefM ? frefM[1] : '?';
    const fx = +fat[1], fy = +fat[2], fa = ((+fat[3] || 0) * Math.PI) / 180;
    for (const p of sexprBlocks(fp, 'pad')) {
      const pat = p.match(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/);
      const sz = p.match(/\(size ([-\d.]+) ([-\d.]+)\)/);
      if (!(pat && sz)) continue;
      const pinM = p.match(/^\(pad\s+"([^"]*)"/); // pad number (component pin), e.g. (pad "5" smd ...)
      const px = +pat[1], py = +pat[2];
      const ax = fx + px * Math.cos(fa) + py * Math.sin(fa); // KiCad footprint rotation [cos +sin; -sin cos]
      const ay = fy - px * Math.sin(fa) + py * Math.cos(fa);
      const lys = [...p.matchAll(/"([FB]\.Cu|In\d\.Cu|\*\.Cu)"/g)].map((m) => m[1]);
      pads.push({
        x: ax, y: ay, w: +sz[1], h: +sz[2],
        shape: p.slice(0, 60).includes('circle ') ? 'circle' : 'rect',
        ref: fref, pin: pinM ? pinM[1] : '', rot: +pat[3] || 0,
        layers: lys.includes('*.Cu') ? ['*'] : lys, net: netName(p, nummap),
      });
    }
  }
  const outline = [];
  for (const b of [...sexprBlocks(s, 'gr_line'), ...sexprBlocks(s, 'gr_rect')]) {
    if (!b.includes('"Edge.Cuts"')) continue;
    const st = b.match(/\(start ([-\d.]+) ([-\d.]+)\)/), en = b.match(/\(end ([-\d.]+) ([-\d.]+)\)/);
    if (!(st && en)) continue;
    const [x1, y1, x2, y2] = [+st[1], +st[2], +en[1], +en[2]];
    if (b.trimStart().startsWith('(gr_rect')) outline.push([x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]);
    else outline.push([x1, y1, x2, y2]);
  }
  // Copper zones (pours/planes). Capture each zone's net, copper layer(s) and outline polygon — the trace
  // graph needs them because a plane is the real conductor on power/ground nets (e.g. the +3V3 inner plane),
  // not the thin stubs the importer would otherwise see. We take the drawn outline, not the filled_polygon:
  // the fill carves clearance holes around pads, but connect_pads ties those pads to the pour anyway.
  const zones = [];
  for (const z of sexprBlocks(s, 'zone')) {
    const net = netName(z, nummap);
    if (!net) continue; // no-net rule areas / keepouts
    const multi = z.match(/\(layers ([^)]+)\)/);
    const single = z.match(/\(layer "([^"]+)"\)/);
    const lys = (multi ? [...multi[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : single ? [single[1]] : []).filter((l) => l.endsWith('.Cu'));
    if (!lys.length) continue;
    const poly = sexprBlocks(z, 'polygon')[0]; // (polygon ...), not (filled_polygon ...)
    if (!poly) continue;
    const pts = [...poly.matchAll(/\(xy ([-\d.]+) ([-\d.]+)\)/g)].map((m) => [+m[1], +m[2]]);
    if (pts.length >= 3) zones.push({ net, layers: lys, poly: pts });
  }

  const xs = outline.flatMap((o) => [o[0], o[2]]).concat(segments.flatMap((s) => [s.x1, s.x2]));
  const ys = outline.flatMap((o) => [o[1], o[3]]).concat(segments.flatMap((s) => [s.y1, s.y2]));
  const bbox = xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 100, 100];
  return { layers, segments, vias, pads, outline, bbox, zones };
}

// walk instance symbols across the root sheet + hierarchical sub-sheets; cb(symBlock, refsSet)
function walkSymbols(dir, cb) {
  for (const fn of readdirSync(dir)) {
    if (!fn.endsWith('.kicad_sch')) continue;
    const s = readFileSync(join(dir, fn), 'utf8');
    for (const sym of sexprBlocks(s, 'symbol')) {
      if (!/^\(symbol\s*\(lib_id/.test(sym)) continue; // instance symbols only (skip lib cache)
      const refs = new Set([...sym.matchAll(/\(reference "([^"]+)"\)/g)].map((m) => m[1]));
      const pr = sym.match(/\(property "Reference" "([^"]+)"/);
      if (pr) refs.add(pr[1]);
      cb(sym, new Set([...refs].filter((r) => !r.endsWith('?'))));
    }
  }
}

export function importNetlist(project = 'doorbell') {
  const P = PROJECTS[project];
  if (!P) throw new Error(`unknown project "${project}" (have: ${Object.keys(PROJECTS).join(', ')})`);
  const sch = join(P.dir, P.sch);
  const pcb = join(P.dir, P.pcb);

  // values + lib_ids across all sheets
  const values = {}, libmap = {};
  walkSymbols(P.dir, (sym, refs) => {
    const lib = sym.match(/^\(symbol\s*\(lib_id "([^"]+)"\)/);
    const val = sym.match(/\(property "Value" "([^"]*)"/);
    for (const r of refs) {
      if (lib) libmap[r] = lib[1];
      if (val) values[r] = val[1];
    }
  });

  // connectivity from KiCad's own netlister
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  const out = join(dir, 'nl.net');
  const r = spawnSync('kicad-cli', ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch]);
  if (r.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error('kicad-cli failed: ' + (r.stderr || r.error)); }
  const nl = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });

  const comps = {}, nets = new Set();
  for (const m of nl.matchAll(/\(net\s+\(code "\d+"\)\s+\(name "([^"]+)"\)([\s\S]*?)(?=\(net\s+\(code|$)/g)) {
    const net = m[1];
    nets.add(net);
    for (const pm of m[2].matchAll(/\(ref "([^"]+)"\)\s+\(pin "([^"]+)"\)(?:\s+\(pinfunction "([^"]*)"\))?/g)) {
      const [, ref, pin, fn] = pm;
      const c = comps[ref] || (comps[ref] = { value: values[ref] ?? '', pins: {}, pinfn: {} });
      c.pins[pin] = net;
      if (fn) c.pinfn[pin] = fn;
    }
  }

  for (const ref in comps) {
    if (!comps[ref].value) {
      const v = valueFromLibname(libmap[ref] || ''); // recover a blank Value from the part name
      if (v) comps[ref].value = v;
    }
  }

  return {
    source: P.sch,
    config: readConfig(P.dir, P.sch),
    components: Object.keys(comps).sort().map((r) => ({ ref: r, lib: libmap[r] || '', ...comps[r] })),
    nets: [...nets].sort(),
    pcb: parsePcb(pcb),
  };
}
