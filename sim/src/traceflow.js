// traceflow.js — point-to-point trace currents.
//
// A node simulator collapses each net to a single potential, so it can't say how current splits
// among that net's traces. Here we model each net's copper as a resistive mesh — every trace segment
// is a resistor (conductance ~ width/length), vias merge the layers, pads are nodes — and solve that
// mesh with the per-pad injection currents from the device models (plus each net's source/connector
// residual). The output is the current in every individual segment, so dead-end stubs (a DC-blocked
// cap, an open contact) come out at ~0 and the bead only flows on the real pad-to-pad path.
import { solve } from './engine.js';

const Q = 100; // 0.01 mm grid: coincident endpoints / pad anchors merge into one node

const key = (x, y, layer) => Math.round(x * Q) + ',' + Math.round(y * Q) + ',' + layer;

// Build the static per-net mesh from PCB geometry (geometry is fixed, so do this once per board).
export function buildTraceGraph(pcb) {
  if (!pcb) return { nets: {} };
  const segs = pcb.segments || [],
    vias = pcb.vias || [],
    pads = pcb.pads || [];

  // union-find so vias merge their layers and pads snap onto nearby copper
  const parent = {};
  const find = (k) => {
    if (parent[k] === undefined) parent[k] = k;
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]];
      k = parent[k];
    }
    return k;
  };
  const union = (a, b) => (parent[find(a)] = find(b));

  segs.forEach((s) => {
    find(key(s.x1, s.y1, s.layer));
    find(key(s.x2, s.y2, s.layer));
  });
  const cuLayers = (pcb.layers && pcb.layers.length ? pcb.layers : ['F.Cu', 'B.Cu']).filter((l) => l.endsWith('.Cu'));
  const viaLayers = (v) => {
    const ls = v.layers && v.layers.length ? v.layers : ['F.Cu', 'B.Cu'];
    // a through-hole via (top+bottom) connects every copper layer it passes, including the inner planes
    return ls.includes('F.Cu') && ls.includes('B.Cu') ? cuLayers : ls;
  };
  vias.forEach((v) => {
    const ls = viaLayers(v);
    for (let i = 1; i < ls.length; i++) union(key(v.x, v.y, ls[0]), key(v.x, v.y, ls[i]));
  });

  // Traces are stored as zero-width centerlines, so we only catch a junction when two endpoints land on
  // the exact same grid point. But finite-width copper connects whenever the conductors overlap: e.g. the
  // +5V LDO-input trace ends 0.31 mm from D4's trace and the two 0.5 mm-wide tracks overlap, so KiCad
  // treats it as one net while we'd split it into two pieces. Merge same-net, same-layer endpoints whose
  // copper actually overlaps (centre distance < half the sum of widths) so those near-miss junctions join.
  const epByNetLayer = {};
  segs.forEach((s) => {
    const g = (epByNetLayer[s.net + ' ' + s.layer] = epByNetLayer[s.net + ' ' + s.layer] || []);
    g.push({ x: s.x1, y: s.y1, w: s.w || 0.2, layer: s.layer }, { x: s.x2, y: s.y2, w: s.w || 0.2, layer: s.layer });
  });
  for (const grp of Object.values(epByNetLayer)) {
    for (let i = 0; i < grp.length; i++)
      for (let j = i + 1; j < grp.length; j++) {
        const a = grp[i],
          b = grp[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.w + b.w) / 2) union(key(a.x, a.y, a.layer), key(b.x, b.y, b.layer));
      }
  }

  // A trace lands on a via by ending anywhere on its pad, not exactly at the centre, so an endpoint ~0.1 mm
  // off-centre wouldn't merge. Snap each via to the same-net segment endpoints within its radius (on every
  // layer it spans). Without this a decoupling cap or the ESP that reaches an inner plane through its own
  // via stays an island, and its plane current vanishes into the pour-hub instead of showing on the stub.
  vias.forEach((v) => {
    for (const L of viaLayers(v))
      for (const e of epByNetLayer[v.net + ' ' + L] || [])
        if (Math.hypot(e.x - v.x, e.y - v.y) <= v.r + 0.1) union(key(v.x, v.y, L), key(e.x, e.y, L));
  });

  // segment endpoints per layer, for snapping pads to the nearest copper
  const epByLayer = {};
  segs.forEach((s) => {
    (epByLayer[s.layer] = epByLayer[s.layer] || []).push([s.x1, s.y1], [s.x2, s.y2]);
  });
  const padOwn = pads.map((p) => {
    const layers = p.layers.includes('*') ? Object.keys(epByLayer) : p.layers;
    const reach = Math.max(p.w, p.h) / 2 + 0.15;
    let best = null,
      bestD = reach;
    for (const L of layers)
      for (const [ex, ey] of epByLayer[L] || []) {
        const d = Math.hypot(ex - p.x, ey - p.y);
        if (d <= bestD) {
          bestD = d;
          best = key(ex, ey, L);
        }
      }
    const own = key(p.x, p.y, layers[0] || 'F.Cu');
    if (best) union(own, best);
    return own;
  });

  // Tie each copper zone (pour/plane) into one equipotential mesh node. A plane is the real conductor on
  // its net, so any of the net's segment endpoints / via layers / pads that sit on the zone's layer inside
  // its outline join the zone's representative. A device on another layer still reaches an inner plane only
  // through its (through-)via, so its stub keeps carrying its own current; dead-end taps on the plane stay
  // at 0. Multiple same-net zones (GND on F/B/inner) are separate reps, stitched by the through-vias.
  const inPoly = (x, y, poly) => {
    let inside = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const xi = poly[a][0],
        yi = poly[a][1],
        xj = poly[b][0],
        yj = poly[b][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  (pcb.zones || []).forEach((z, zi) => {
    const rep = '__zone__' + zi;
    const onLayer = (L) => z.layers.includes(L);
    segs.forEach((sg) => {
      if (sg.net !== z.net || !onLayer(sg.layer)) return;
      if (inPoly(sg.x1, sg.y1, z.poly)) union(rep, key(sg.x1, sg.y1, sg.layer));
      if (inPoly(sg.x2, sg.y2, z.poly)) union(rep, key(sg.x2, sg.y2, sg.layer));
    });
    vias.forEach((v) => {
      if (v.net !== z.net || !inPoly(v.x, v.y, z.poly)) return;
      for (const L of viaLayers(v)) if (onLayer(L)) union(rep, key(v.x, v.y, L));
    });
    pads.forEach((p, i) => {
      if (p.net !== z.net || !inPoly(p.x, p.y, z.poly)) return;
      const pls = p.layers.includes('*') ? z.layers : p.layers;
      if (pls.some(onLayer)) union(rep, padOwn[i]);
    });
  });

  // A connector's pins on the same net are tied together externally (USB-C's redundant VBUS / GND /
  // shield pins), so the source/return enters/exits there at a single point. Merge them into one mesh
  // node — otherwise the residual splits across the pins and the leftover loops between them and around
  // the shield ring as phantom inter-pin current (beads appearing to come "out of" the GND pins).
  const merge = {};
  pads.forEach((p, i) => {
    if (!p.net || !/^J/i.test(p.ref || '')) return;
    const k = p.ref + ' ' + p.net;
    if (k in merge) union(merge[k], padOwn[i]);
    else merge[k] = padOwn[i];
  });

  // per-net node set, edges (segments), and pad nodes (all find()s resolve after the merges above)
  const nets = {};
  const g = (n) => (nets[n] = nets[n] || { nodes: new Set(), edges: [], pads: [] });
  segs.forEach((s, i) => {
    const net = g(s.net),
      n1 = find(key(s.x1, s.y1, s.layer)),
      n2 = find(key(s.x2, s.y2, s.layer));
    net.nodes.add(n1);
    net.nodes.add(n2);
    if (n1 !== n2) {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1e-3;
      net.edges.push({ n1, n2, G: (s.w || 0.2) / len, seg: i });
    }
  });
  pads.forEach((p, i) => {
    if (!p.net) return;
    const net = g(p.net),
      node = find(padOwn[i]);
    net.nodes.add(node);
    net.pads.push({ ref: p.ref, pin: p.pin, node });
  });

  // The importer doesn't capture copper pours, so power/ground nets fragment into many disconnected pieces
  // here (+3V3 is ~20 stub-per-device pieces tied only by the pour, +5V splits into a D4-source piece and a
  // U2/LDO-load piece). Each piece's injections then don't balance, the weak ground blows its mesh potential
  // up, and phantom current leaks through dead-end pads. The pieces are one net electrically (the pour), so
  // they need stitching back together. We record the pieces here (static geometry) and add a virtual "pour
  // hub" link per piece in traceCurrents, where the injections are known — the link attaches at the node
  // that actually sources/sinks the inter-piece current, not an arbitrary one (see there for why).
  for (const name in nets) {
    const net = nets[name];
    if (net.edges.length === 0) continue;
    const par = {};
    const f = (k) => {
      if (par[k] === undefined) par[k] = k;
      while (par[k] !== k) k = par[k] = par[par[k]];
      return k;
    };
    for (const e of net.edges) par[f(e.n1)] = f(e.n2);
    const groups = {};
    for (const n of net.nodes) (groups[f(n)] = groups[f(n)] || []).push(n);
    const pieces = Object.values(groups);
    if (pieces.length < 2) continue;
    net.hub = '__pour__' + name;
    net.pieces = pieces;
  }
  return { nets };
}

// Solve each net's mesh with the given pad injections; returns { segmentIndex: signed current }
// (sign follows the segment's stored x1,y1 -> x2,y2 direction). `injections` = [{ ref, pin, net, I }].
export function traceCurrents(graph, injections) {
  const out = {};
  const byNet = {};
  for (const inj of injections) (byNet[inj.net] = byNet[inj.net] || []).push(inj);

  for (const net in graph.nets) {
    const gn = graph.nets[net];
    if (!gn.edges.length) continue;

    const nodeList = [...gn.nodes];
    if (gn.hub) nodeList.push(gn.hub); // virtual pour node tying the net's fragmented pieces together
    const idx = {};
    nodeList.forEach((n, i) => (idx[n] = i));
    const N = nodeList.length;

    const padNodeOf = (ref, pin) => {
      let m = gn.pads.find((p) => p.ref === ref && (pin === undefined || p.pin === pin));
      if (!m && pin !== undefined) m = gn.pads.find((p) => p.ref === ref);
      return m ? m.node : null;
    };

    const cur = new Array(N).fill(0);
    let total = 0;
    for (const inj of byNet[net] || []) {
      const node = padNodeOf(inj.ref, inj.pin);
      if (node != null && idx[node] !== undefined) {
        cur[idx[node]] += inj.I;
        total += inj.I;
      }
    }
    if (cur.every((c) => Math.abs(c) < 1e-12)) continue; // nothing flowing on this net

    // The net's current enters/exits the board through its connector, so the KCL residual goes there.
    // Spread it across *all* of that connector's pads on the net — a multi-pin power/GND connector
    // (e.g. USB-C's four GND pins) shares the current in parallel; funnelling it through one pad forces
    // the return to loop through whatever copper reaches that single point (the USB shield ring was
    // carrying the whole 80 mA return for exactly this reason). Shield/shell pads (pin "SH") are
    // excluded — they're chassis tie-points, not the supply return.
    const conn = (gn.pads.find((p) => /^J/.test(p.ref)) || {}).ref;
    let feedNodes = [];
    if (conn) {
      let cp = gn.pads.filter((p) => p.ref === conn && !/^SH/i.test(p.pin || ''));
      if (!cp.length) cp = gn.pads.filter((p) => p.ref === conn);
      feedNodes = [...new Set(cp.map((p) => p.node))].filter((n) => idx[n] !== undefined);
    }
    if (!feedNodes.length) {
      let bi = 0;
      for (let i = 1; i < N; i++) if (Math.abs(cur[i]) > Math.abs(cur[bi])) bi = i;
      feedNodes = [nodeList[bi]];
    }
    const share = total / feedNodes.length;
    for (const fn of feedNodes) cur[idx[fn]] -= share;

    // Stitch the net's fragmented pieces to the pour hub. The inter-piece current (a piece sources/sinks
    // -sum(its injections) to the rest of the net) has to enter/leave each piece at one node; attach the
    // hub link at the node that already carries that current — the piece's largest injection — so it flows
    // straight in/out there. Attaching anywhere else (an arbitrary union-find root, a dead-end tap like a
    // flyback diode's +5V pad or an EN pullup) forces the whole inter-piece current to thread through that
    // pad's traces as phantom flow ("into D2 pin 1 but not out", current funnelling through R10).
    const hubEdges = [];
    if (gn.hub) {
      for (const piece of gn.pieces) {
        let best = piece[0],
          bestAbs = -1;
        for (const n of piece) {
          const a = Math.abs(cur[idx[n]] || 0);
          if (a > bestAbs) {
            bestAbs = a;
            best = n;
          }
        }
        hubEdges.push({ n1: best, n2: gn.hub, G: 1, seg: -1 });
      }
    }

    // conductance Laplacian, weakly grounded everywhere so it's non-singular (floating islands -> 0). The
    // ground must be TINY: it only sets the reference (injections already sum to ~0 via the residual). At
    // 1e-6 the per-node leak (Gmin*V) summed over a few hundred nodes on a powered plane reached mA and
    // routed through pads as phantom current (e.g. "into" relay coils); 1e-10 keeps the total leak sub-uA.
    const GND_REF = 1e-10;
    const A = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let i = 0; i < N; i++) A[i][i] = GND_REF;
    for (const e of gn.edges.concat(hubEdges)) {
      const i = idx[e.n1],
        j = idx[e.n2];
      A[i][i] += e.G;
      A[j][j] += e.G;
      A[i][j] -= e.G;
      A[j][i] -= e.G;
    }
    const v = solve(A, cur);
    for (const e of gn.edges) out[e.seg] = e.G * (v[idx[e.n1]] - v[idx[e.n2]]);
  }
  return out;
}
