// import.js — KiCad schematic -> netlist object (node only; used by server.js and the tests).
// Connectivity comes from KiCad's own netlister (`kicad-cli sch export netlist`); everything else
// (values, lib_ids, PCB geometry) is parsed here from the .kicad_sch / .kicad_pcb s-expressions.
// Nothing is written to disk — callers get the object and serve/consume it live.
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  // Silkscreen graphics (F.SilkS / B.SilkS) — component outlines, polarity marks and labels, so the viewer
  // can paint the silk under the copper. Footprint-local graphics are placed by the footprint's
  // position+rotation (same transform as pads); board-level gr_* are already in board coordinates.
  const silk = [];
  const isSilk = (l) => l === 'F.SilkS' || l === 'B.SilkS';
  const lyOf = (b) => {
    const m = b.match(/\(layer "([^"]+)"\)/);
    return m ? m[1] : '';
  };
  const swOf = (b) => {
    const w = b.match(/\(width ([-\d.]+)\)/);
    return w ? +w[1] : 0.12;
  };
  function collectSilk(scope, pfx, TX, fref) {
    for (const b of sexprBlocks(scope, pfx + '_line')) {
      const L = lyOf(b);
      const a = b.match(/\(start ([-\d.]+) ([-\d.]+)\)/),
        e = b.match(/\(end ([-\d.]+) ([-\d.]+)\)/);
      if (!isSilk(L) || !(a && e)) continue;
      const p = TX(+a[1], +a[2]),
        q = TX(+e[1], +e[2]);
      silk.push({ type: 'line', layer: L, w: swOf(b), x1: p[0], y1: p[1], x2: q[0], y2: q[1] });
    }
    for (const b of sexprBlocks(scope, pfx + '_rect')) {
      const L = lyOf(b);
      const a = b.match(/\(start ([-\d.]+) ([-\d.]+)\)/),
        e = b.match(/\(end ([-\d.]+) ([-\d.]+)\)/);
      if (!isSilk(L) || !(a && e)) continue;
      const c = [[+a[1], +a[2]], [+e[1], +a[2]], [+e[1], +e[2]], [+a[1], +e[2]]].map(([x, y]) => TX(x, y));
      for (let i = 0; i < 4; i++)
        silk.push({ type: 'line', layer: L, w: swOf(b), x1: c[i][0], y1: c[i][1], x2: c[(i + 1) % 4][0], y2: c[(i + 1) % 4][1] });
    }
    for (const b of sexprBlocks(scope, pfx + '_circle')) {
      const L = lyOf(b);
      const c = b.match(/\(center ([-\d.]+) ([-\d.]+)\)/),
        e = b.match(/\(end ([-\d.]+) ([-\d.]+)\)/);
      if (!isSilk(L) || !(c && e)) continue;
      const ctr = TX(+c[1], +c[2]);
      silk.push({ type: 'circle', layer: L, w: swOf(b), cx: ctr[0], cy: ctr[1], r: Math.hypot(+e[1] - +c[1], +e[2] - +c[2]) });
    }
    for (const b of sexprBlocks(scope, pfx + '_arc')) {
      const L = lyOf(b);
      const a = b.match(/\(start ([-\d.]+) ([-\d.]+)\)/),
        m = b.match(/\(mid ([-\d.]+) ([-\d.]+)\)/),
        e = b.match(/\(end ([-\d.]+) ([-\d.]+)\)/);
      if (!isSilk(L) || !(a && m && e)) continue;
      const p = TX(+a[1], +a[2]),
        q = TX(+m[1], +m[2]),
        r = TX(+e[1], +e[2]);
      silk.push({ type: 'arc', layer: L, w: swOf(b), x1: p[0], y1: p[1], xm: q[0], ym: q[1], x2: r[0], y2: r[1] });
    }
    for (const b of sexprBlocks(scope, pfx + '_poly')) {
      const L = lyOf(b);
      if (!isSilk(L)) continue;
      const pts = [...b.matchAll(/\(xy ([-\d.]+) ([-\d.]+)\)/g)].map((m) => TX(+m[1], +m[2]));
      if (pts.length >= 2) silk.push({ type: 'poly', layer: L, w: swOf(b), pts });
    }
    for (const b of sexprBlocks(scope, pfx + '_text')) {
      const L = lyOf(b);
      if (!isSilk(L) || /\(hide yes\)/.test(b)) continue;
      const tm = b.match(/^\((?:fp|gr)_text(?: \w+)? "([^"]*)"/),
        at = b.match(/\(at ([-\d.]+) ([-\d.]+)(?: (-?[\d.]+))?\)/),
        sz = b.match(/\(size ([-\d.]+) ([-\d.]+)\)/);
      if (!(tm && at)) continue;
      const str = tm[1].replace(/\$\{REFERENCE\}/g, fref || '');
      if (!str || /\$\{/.test(str)) continue; // skip unresolved field placeholders (VALUE, NET, …)
      const p = TX(+at[1], +at[2]);
      silk.push({ type: 'text', layer: L, x: p[0], y: p[1], rot: +at[3] || 0, h: sz ? +sz[1] : 1, str });
    }
  }

  const pads = [];
  for (const fp of sexprBlocks(s, 'footprint')) {
    const fat = fp.match(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/);
    if (!fat) continue;
    const frefM = fp.match(/\(property "Reference" "([^"]+)"/);
    const fref = frefM ? frefM[1] : '?';
    const fx = +fat[1], fy = +fat[2], fa = ((+fat[3] || 0) * Math.PI) / 180;
    const TX = (lx, ly) => [fx + lx * Math.cos(fa) + ly * Math.sin(fa), fy - lx * Math.sin(fa) + ly * Math.cos(fa)];
    collectSilk(fp, 'fp', TX, frefM ? frefM[1] : '');
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
  collectSilk(s, 'gr', (x, y) => [x, y], ''); // board-level silk (labels, logos) — already in board coords
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
  return { layers, segments, vias, pads, outline, bbox, zones, silk };
}

export function importNetlist(project = 'doorbell') {
  const P = PROJECTS[project];
  if (!P) throw new Error(`unknown project "${project}" (have: ${Object.keys(PROJECTS).join(', ')})`);
  const sch = join(P.dir, P.sch);
  const pcb = join(P.dir, P.pcb);

  // connectivity from KiCad's own netlister
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  const out = join(dir, 'nl.net');
  const r = spawnSync('kicad-cli', ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch]);
  if (r.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error('kicad-cli failed: ' + (r.stderr || r.error)); }
  const nl = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });

  // value, footprint and lib_id per ref, from the netlist's (comp (ref ...) ...) records. kicad-cli
  // expands the project's real sheet hierarchy from the root .kicad_sch — it never globs sibling files
  // on disk, so a stray/orphaned .kicad_sch in the same directory can't bleed its symbols in here. (We
  // take all three from the same record so a part can be classified by its footprint — e.g. the PhotoMOS
  // SSRs — and not only by lib_id / value.) Match the "(comp" records specifically (not the enclosing
  // "(components" / "(comment" blocks, which also start with that prefix); each opens "(comp\n\t...(ref".
  const fps = {}, values = {}, libmap = {};
  for (const cm of nl.matchAll(/\(comp\s+\(ref "([^"]+)"\)([\s\S]*?)(?=\n\t*\(comp\s|\n\t*\)\s*\(libparts)/g)) {
    const ref = cm[1], body = cm[2];
    const fm = body.match(/\(footprint "([^"]+)"\)/);
    if (fm) fps[ref] = fm[1];
    const vm = body.match(/\(value "([^"]*)"\)/);
    if (vm) values[ref] = vm[1];
    const lm = body.match(/\(libsource\s+\(lib "([^"]*)"\)\s+\(part "([^"]*)"\)/);
    if (lm) libmap[ref] = lm[1] + ':' + lm[2];
  }

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
    components: Object.keys(comps).sort().map((r) => ({ ref: r, lib: libmap[r] || '', footprint: fps[r] || '', ...comps[r] })),
    nets: [...nets].sort(),
    pcb: parsePcb(pcb),
  };
}
