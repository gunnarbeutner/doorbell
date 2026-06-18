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
  vias.forEach((v) => {
    const ls = v.layers && v.layers.length ? v.layers : ['F.Cu', 'B.Cu'];
    for (let i = 1; i < ls.length; i++) union(key(v.x, v.y, ls[0]), key(v.x, v.y, ls[i]));
  });

  // segment endpoints per layer, for snapping pads to the nearest copper
  const epByLayer = {};
  segs.forEach((s) => {
    (epByLayer[s.layer] = epByLayer[s.layer] || []).push([s.x1, s.y1], [s.x2, s.y2]);
  });
  const padNode = pads.map((p) => {
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
    return find(own);
  });

  // per-net node set, edges (segments), and pad nodes
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
    const net = g(p.net);
    net.nodes.add(padNode[i]);
    net.pads.push({ ref: p.ref, pin: p.pin, node: padNode[i] });
  });
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

    const nodeList = [...gn.nodes],
      idx = {};
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

    // the net's source/connector supplies the KCL residual; put it at a board connector pad if there
    // is one (the bus feed), else at the node already carrying the most current (a strong driver)
    let feedNode = (gn.pads.find((p) => /^J/.test(p.ref)) || {}).node;
    if (feedNode == null) {
      let bi = 0;
      for (let i = 1; i < N; i++) if (Math.abs(cur[i]) > Math.abs(cur[bi])) bi = i;
      feedNode = nodeList[bi];
    }
    if (idx[feedNode] !== undefined) cur[idx[feedNode]] -= total;

    // conductance Laplacian, weakly grounded everywhere so it's non-singular (floating islands -> 0)
    const A = Array.from({ length: N }, () => new Array(N).fill(1e-6));
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) A[i][j] = 0;
    for (const e of gn.edges) {
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
