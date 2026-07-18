// ui.js — remote browser front-end. It fetches the live KiCad netlist for rendering and creates one
// server-owned circuit session; all electrical steps and firmware execution stay off the browser.
import { gndOf } from './engine.js';
import { allComponents, defaultSwitchState } from './components/index.js';
import { buildTraceGraph, traceCurrents } from './traceflow.js';

async function boot() {
const BOARD = new URLSearchParams(location.search).get('board') || 'doorbell';
async function requestJson(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `${response.status} ${response.statusText}`);
  return value;
}
const [NETLIST, SESSION] = await Promise.all([
  requestJson('/netlist.json?board=' + encodeURIComponent(BOARD)),
  requestJson('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board: BOARD }) }),
]);
const PCB = NETLIST.pcb;
if (PCB) PCB.segments.forEach((s, i) => (s.idx = i)); // segment index for per-segment flow lookup
// nets with a copper pour/plane: a pad on one of these sinks its current into the plane (which has no
// trace to animate), so its per-pad ripple must NOT be suppressed just because a short stub-to-via lands
// on the pad — that stub is the pour entry, not a competing trace that already shows the current.
const POUR_NETS = new Set((PCB?.zones || []).map((z) => z.net));
const traceGraph = PCB ? buildTraceGraph(PCB) : { nets: {} };
const $ = (s) => document.querySelector(s);
const nets = NETLIST.nets;
const GNDdef = gndOf(NETLIST); // GND / configured / P1, per the board's .sim

// classify every part once via the registry; COMP[ref] is its component instance
const COMP = {};
for (const c of allComponents(NETLIST)) COMP[c.ref] = c;

const refKind = (r) => COMP[r]?.kind || 'unknown';

// 'ok' = a recognized/modeled part (incl. ports); 'bad' = no model (a real IC)
const devClass = (r) => (COMP[r] && COMP[r].modeled ? 'ok' : 'bad');

/* ---------- value parsing ---------- */
/* per-part device models — parameters derived from the part type/value, not from global knobs */
/* ---------- neutral auto-models ---------- */
/* ---------- linear solve ---------- */

/* ---------- net colours ---------- */
function netColor(n) {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},70%,60%)`;
}
function voltColor(v, lo, hi) {
  if (hi - lo < 1e-9) return '#888';
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const r = Math.round(40 + t * 200),
    b = Math.round(240 - t * 200);
  return `rgb(${r},${Math.round(80 + Math.abs(0.5 - t) * -80 + 80)},${b})`;
}

/* ---------- UI state ---------- */
let sources = [],
  elements = [],
  RES = null,
  tIndex = 0,
  flowSeg = {}, // per-segment current (signed) for the trace flow animation
  padCur = new Map(), // per-pad injection current (signed; +ve = out of the pad into the copper)
  flowPhase = 0; // advances each drawn frame -> marching dashes
let selectedNets = new Set(),
  hoveredNet = null,
  hoveredRef = null,
  violByRef = {}, // ref -> [events active at the cursor] (drives the bright badges)
  stickyRefs = new Set(), // refs flagged at any point this run (drives the dimmed "was-flagged" badges)
  eventLog = [], // persistent fault record (survives the rolling window): each checkSafe onset->resolution
  activeEv = new Map(), // "ref.pin" -> the ongoing event for that pin
  breakOnFault = false, // trigger: auto-pause the instant a NEW fault opens
  pendingBreak = null, // the event that tripped the trigger (seek here after pausing)
  evId = 0,
  lastEvCount = -1; // so the events panel only re-renders when the log changes
const hideLayers = new Set(NETLIST.config?.hideLayers || []); // default-off layers, per the board's .sim
const visLayers = new Set((PCB ? PCB.layers : []).filter((L) => !hideLayers.has(L)));
$('#srcname').textContent = NETLIST.source;
// board toggle: reload with the chosen project (the importer + whole UI re-init off the new netlist)
$('#board').value = BOARD;
$('#board').onchange = (e) => (location.search = '?board=' + encodeURIComponent(e.target.value));
function netOpts(sel, cur) {
  sel.innerHTML = '';
  for (const n of nets) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    if (n === cur) o.selected = true;
    sel.appendChild(o);
  }
}
netOpts($('#gnd'), GNDdef);

// layer toggles
(function () {
  const box = $('#layers');
  (PCB ? PCB.layers : []).forEach((L) => {
    const l = document.createElement('label');
    l.className = 'lt';
    l.innerHTML = `<input type="checkbox"${visLayers.has(L) ? ' checked' : ''}> ${L}`;
    l.querySelector('input').onchange = (e) => {
      e.target.checked ? visLayers.add(L) : visLayers.delete(L);
      buildStack();
    };
    box.appendChild(l);
  });
})();

// sources / elements rows
function srcRow(s) {
  const d = document.createElement('div');
  d.className = 'src';
  // line 1: enable toggle + net + delete (the row-level controls); line 2: the wave parameters
  d.innerHTML = `<div class="srow"><button class="tog"></button><select class="n"></select><label>Z <input class="z" type="number" min="0" value="${s.impedance ?? 0}">Ω</label><span class="x">✕</span></div>
   <div class="srow"><select class="t"><option>dc</option><option>sine</option><option>square</option><option>step</option><option>pulse</option></select><input class="v1" type="number" value="${s.v1}"><input class="v2" type="number" value="${s.v2}"><input class="f" type="number" value="${s.freq}"><input class="t1" type="number" value="${s.t1}"></div>`;
  netOpts(d.querySelector('.n'), s.net);
  d.querySelector('.t').value = s.type;
  const tog = d.querySelector('.tog'),
    paint = () => {
      tog.textContent = s.off ? '○' : '●';
      tog.title = s.off ? 'off — net floats' : 'on';
      tog.className = 'tog' + (s.off ? '' : ' on');
      d.style.opacity = s.off ? 0.45 : 1;
    };
  paint();
  tog.onclick = () => {
    s.off = !s.off;
    paint();
    applyChange();
  }; // off = source disconnected (net floats), not driven to 0
  const sy = () => {
    s.net = d.querySelector('.n').value;
    s.impedance = d.querySelector('.z').value;
    s.type = d.querySelector('.t').value;
    s.v1 = d.querySelector('.v1').value;
    s.v2 = d.querySelector('.v2').value;
    s.freq = d.querySelector('.f').value;
    s.t1 = d.querySelector('.t1').value;
    applyChange();
  };
  d.querySelectorAll('select,input').forEach((e) => (e.onchange = sy));
  d.querySelector('.x').onclick = () => {
    sources = sources.filter((z) => z !== s);
    d.remove();
    applyChange();
  };
  $('#sources').appendChild(d);
}
$('#addSrc').onclick = () => {
  const s = { net: GNDdef, type: 'dc', v1: 5, v2: 0, freq: 1000, t1: 1, impedance: 0 };
  sources.push(s);
  srcRow(s);
};
function elRow(e) {
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<select class="k"><option>R</option><option>C</option><option>L</option><option>D</option><option>short</option><option>switch</option></select>
   <select class="a"></select><select class="b"></select><input class="v" type="text" value="${e.value || ''}" style="width:60px"><label class="sw" style="display:none"><input type="checkbox" class="cl" checked> cl</label><span class="x">✕</span>`;
  netOpts(d.querySelector('.a'), e.a);
  netOpts(d.querySelector('.b'), e.b);
  d.querySelector('.k').value = e.kind;
  const swl = d.querySelector('.sw'),
    upd = () => (swl.style.display = d.querySelector('.k').value === 'switch' ? 'inline' : 'none');
  const sy = () => {
    e.kind = d.querySelector('.k').value;
    e.a = d.querySelector('.a').value;
    e.b = d.querySelector('.b').value;
    e.value = d.querySelector('.v').value;
    e.closed = d.querySelector('.cl').checked;
    upd();
    applyChange();
  };
  d.querySelectorAll('select,input').forEach((x) => (x.onchange = sy));
  upd();
  d.querySelector('.x').onclick = () => {
    elements = elements.filter((z) => z !== e);
    d.remove();
    applyChange();
  };
  $('#elements').appendChild(d);
}
$('#addEl').onclick = () => {
  const e = { kind: 'short', a: nets[0], b: GNDdef, value: '', closed: true };
  elements.push(e);
  elRow(e);
};

/* relays & switches — the pin-outs live in the component classes (no config UI here) */
const switchState = defaultSwitchState(NETLIST); // solder bridges default closed

// the voltage on a net at a given time index of the last run
const voltageAt = (k) => (net) => (RES && RES.v[net] ? RES.v[net][k] : null);

function relayEnergized(ref, k) {
  const c = COMP[ref];

  if (!c || c.role !== 'relay' || !RES) return null;

  // prefer the actual latched contact state (hysteretic) from the live elements; fall back to a
  // coil-voltage check if this relay has no modeled contacts
  if (remoteState?.relays && ref in remoteState.relays) return !!remoteState.relays[ref];

  return c.energized(voltageAt(k));
}

function updateRelayStates() {
  document.querySelectorAll('#relays .rstate').forEach((el) => {
    const en = relayEnergized(el.dataset.ref, tIndex);

    el.textContent = en == null ? '— drive coil' : en ? '● energized' : '○ idle';
    el.style.color = en ? '#3fb950' : '#7d8590';
  });
}

// a "· <Value>" hint span (e.g. SW3 → "Tueroeffner (door release)") so the row says which part it is.
// textContent, not innerHTML, so a free-form Value can't inject markup; empty span when there is none.
function valueHint(value) {
  const v = document.createElement('span');
  if (value) {
    v.className = 'hint';
    v.textContent = '· ' + value + ' ';
  }
  return v;
}

function buildRelays() {
  const box = $('#relays');
  box.innerHTML = '';

  for (const c of Object.values(COMP)) {
    if (!c.role) continue;

    const row = document.createElement('div');
    row.className = 'row';

    // a relay is read-only: it follows its coil
    if (c.role === 'relay') {
      const label = document.createElement('span');
      label.innerHTML = `<b>${c.ref}</b> <span class="hint">relay</span> `;
      label.appendChild(valueHint(c.value));
      row.appendChild(label);

      const st = document.createElement('span');
      st.className = 'rstate hint';
      st.dataset.ref = c.ref;
      st.textContent = '—';
      row.appendChild(st);

      box.appendChild(row);
      continue;
    }

    // a switch or solder bridge is a manual toggle
    const bridge = c.role === 'bridge';
    const on = !!switchState[c.ref];

    const label = document.createElement('span');
    label.innerHTML = `<b>${c.ref}</b> <span class="hint">${bridge ? 'solder bridge' : 'switch'}</span> `;
    label.appendChild(valueHint(c.value));
    row.appendChild(label);

    const toggle = document.createElement('button');
    toggle.textContent = bridge ? (on ? '● bridged' : '○ open') : on ? '● pressed' : '○ released';
    toggle.className = on ? 'on' : '';
    toggle.onclick = () => {
      switchState[c.ref] = !switchState[c.ref];
      buildRelays();
      applyChange();
    };
    row.appendChild(toggle);

    box.appendChild(row);
  }

  updateRelayStates();
}

/* ---------- PCB stack + transform ---------- */
let TF = null; // world->screen
function computeTF(cw, ch) {
  if (!PCB) return null;
  const [mnx, mny, mxx, mxy] = PCB.bbox;
  const bw = mxx - mnx,
    bh = mxy - mny,
    pad = 10;
  const sc = Math.min((cw - 2 * pad) / bw, (ch - 2 * pad) / bh);
  const ox = (cw - bw * sc) / 2,
    oy = (ch - bh * sc) / 2;
  return {
    sc,
    ox,
    oy,
    mnx,
    mny,
    W: (x) => (x - mnx) * sc + ox,
    H: (y) => (y - mny) * sc + oy,
    inv: (sx, sy) => [(sx - ox) / sc + mnx, (sy - oy) / sc + mny],
  };
}
function buildStack() {
  const st = $('#stack');
  st.innerHTML = '';
  if (!PCB) {
    st.innerHTML = '<div class="hint" style="padding:10px">no PCB geometry in netlist.json</div>';
    return;
  }
  const cw = $('#stack').clientWidth - 2,
    ch = Math.max(180, Math.round((cw * (PCB.bbox[3] - PCB.bbox[1])) / (PCB.bbox[2] - PCB.bbox[0])) + 10);
  TF = computeTF(cw, ch);
  PCB.layers
    .filter((L) => visLayers.has(L))
    .forEach((L) => {
      const p = document.createElement('div');
      p.className = 'layerpanel';
      p.innerHTML = `<div class="lab">${L}</div>`;
      const cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      cv.dataset.layer = L;
      p.appendChild(cv);
      st.appendChild(p);
      cv.addEventListener('mousemove', (ev) => onHover(ev, cv, L));
      cv.addEventListener('mouseleave', () => {
        hoveredNet = null;
        $('#tip').style.display = 'none';
        drawAll();
      });
      cv.addEventListener('click', (ev) => {
        if (hoveredNet) {
          selectedNets.has(hoveredNet) ? selectedNets.delete(hoveredNet) : selectedNets.add(hoveredNet);
          buildScopes();
          drawAll();
        }
      });
    });
  drawAll();
}
function segsOn(L) {
  return PCB.segments.filter((s) => s.layer === L);
}
function viasOn(L) {
  return PCB.vias.filter((v) => v.layers.includes(L) || !v.layers.length);
}
function padsOn(L) {
  return PCB.pads.filter((p) => p.layers.includes(L) || p.layers.includes('*'));
}
// Layers on which a pad has a trace landing on it (a same-net segment endpoint on the pad). Used to
// suppress the per-pad flow animation where a trace already shows the current — so it only fires for
// pads whose current goes into a pour/plane (no trace to animate). Static geometry; computed once.
let _padTraced = null;
function padTracedLayers(p) {
  if (!_padTraced) {
    _padTraced = new Map();
    for (const pad of PCB.pads) {
      const eps = Math.max(0.25, Math.max(pad.w, pad.h) / 2); // a segment endpoint anywhere on the pad counts
      const got = new Set();
      for (const s of PCB.segments) {
        if (s.net !== pad.net) continue;
        if (Math.min(Math.hypot(s.x1 - pad.x, s.y1 - pad.y), Math.hypot(s.x2 - pad.x, s.y2 - pad.y)) <= eps)
          got.add(s.layer);
      }
      _padTraced.set(pad, got);
    }
  }
  return _padTraced.get(p);
}
function vRange() {
  return [0, +($('#vmax') || {}).value || 12];
} // fixed display scale 0..Vmax (default 12 V), not data-dependent
function colorFor(net) {
  if ($('#cmode').value === 'volt' && RES && RES.v[net]) {
    const [lo, hi] = vRange();
    return voltColor(RES.v[net][tIndex], lo, hi);
  }
  return netColor(net);
}
// the silkscreen side that prints on a given copper layer (only the two outer layers have silk)
function silkLayerFor(L) {
  return L === 'F.Cu' ? 'F.SilkS' : L === 'B.Cu' ? 'B.SilkS' : null;
}
// circle through 3 points -> { center, radius, start/end angle, anticlockwise } for canvas arc(); the TF
// is a uniform scale (no flip/rotation), so board-space angles carry over to the canvas unchanged.
function arc3(x1, y1, xm, ym, x2, y2) {
  const d = 2 * (x1 * (ym - y2) + xm * (y2 - y1) + x2 * (y1 - ym));
  if (Math.abs(d) < 1e-9) return null; // collinear
  const s1 = x1 * x1 + y1 * y1,
    sm = xm * xm + ym * ym,
    s2 = x2 * x2 + y2 * y2;
  const cx = (s1 * (ym - y2) + sm * (y2 - y1) + s2 * (y1 - ym)) / d,
    cy = (s1 * (x2 - xm) + sm * (x1 - x2) + s2 * (xm - x1)) / d;
  const a1 = Math.atan2(y1 - cy, x1 - cx),
    am = Math.atan2(ym - cy, xm - cx),
    a2 = Math.atan2(y2 - cy, x2 - cx);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // sweep a1->a2 the way that passes through the mid point
  return { cx, cy, r: Math.hypot(x1 - cx, y1 - cy), a1, a2, acw: norm(am - a1) > norm(a2 - a1) };
}
// silkscreen for layer L, painted under the copper. Faithful to the board: lines/rects/circles/arcs are
// stroked, filled polys (polarity dots/arrows) filled, and text drawn at its stored size/rotation.
function drawSilk(g, L) {
  const sl = silkLayerFor(L);
  if (!sl || !PCB.silk || !($('#silk') && $('#silk').checked)) return;
  g.save();
  g.strokeStyle = 'rgba(214,221,230,0.5)';
  g.fillStyle = 'rgba(214,221,230,0.5)';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.setLineDash([]);
  for (const it of PCB.silk) {
    if (it.layer !== sl) continue;
    g.lineWidth = Math.max(0.5, it.w * TF.sc);
    if (it.type === 'line') {
      g.beginPath();
      g.moveTo(TF.W(it.x1), TF.H(it.y1));
      g.lineTo(TF.W(it.x2), TF.H(it.y2));
      g.stroke();
    } else if (it.type === 'circle') {
      g.beginPath();
      g.arc(TF.W(it.cx), TF.H(it.cy), it.r * TF.sc, 0, 2 * Math.PI);
      g.stroke();
    } else if (it.type === 'arc') {
      const c = arc3(it.x1, it.y1, it.xm, it.ym, it.x2, it.y2);
      g.beginPath();
      if (c) g.arc(TF.W(c.cx), TF.H(c.cy), c.r * TF.sc, c.a1, c.a2, c.acw);
      else {
        g.moveTo(TF.W(it.x1), TF.H(it.y1));
        g.lineTo(TF.W(it.xm), TF.H(it.ym));
        g.lineTo(TF.W(it.x2), TF.H(it.y2));
      }
      g.stroke();
    } else if (it.type === 'poly') {
      g.beginPath();
      it.pts.forEach((p, i) => (i ? g.lineTo(TF.W(p[0]), TF.H(p[1])) : g.moveTo(TF.W(p[0]), TF.H(p[1]))));
      g.closePath();
      g.fill();
    } else if (it.type === 'text' && it.h * TF.sc >= 4) {
      g.save();
      g.translate(TF.W(it.x), TF.H(it.y));
      g.rotate((-it.rot * Math.PI) / 180);
      g.font = `${it.h * TF.sc}px ui-monospace, Menlo, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(it.str, 0, 0);
      g.restore();
    }
  }
  g.restore();
}
function drawLayer(cv, L) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#05070a';
  g.fillRect(0, 0, cv.width, cv.height);
  // outline
  g.strokeStyle = '#243042';
  g.lineWidth = 1;
  g.beginPath();
  for (const o of PCB.outline) {
    g.moveTo(TF.W(o[0]), TF.H(o[1]));
    g.lineTo(TF.W(o[2]), TF.H(o[3]));
  }
  g.stroke();
  drawSilk(g, L); // silkscreen under the copper
  // traces (round caps/joins so segment bends fill in, like real copper; fully opaque so
  // overlapping caps at a bend don't read brighter than the trace body)
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.globalAlpha = 1;
  const flowOn = !!($('#flow') && $('#flow').checked);
  for (const s of segsOn(L)) {
    const hot = hoveredNet && s.net === hoveredNet,
      sel = selectedNets.has(s.net),
      flt = RES && RES.floating && RES.floating[s.net];
    const lw = Math.max(1, s.w * TF.sc) * (hot ? 1.7 : sel ? 1.3 : 1);
    g.lineWidth = lw;
    g.strokeStyle = hot ? '#fff' : flt ? '#475569' : colorFor(s.net);
    // dashes must scale with width (a fixed [4,3] vanishes under wide round caps), and use butt
    // caps so the gaps actually show on thick traces
    if (flt && !hot) {
      g.setLineDash([Math.max(5, lw * 1.8), Math.max(4, lw * 1.4)]);
      g.lineCap = 'butt';
    } else {
      g.setLineDash([]);
      g.lineCap = 'round';
    }
    g.lineDashOffset = 0; // static base trace — without this, a floating net's dashes inherit the animated
    g.beginPath(); // offset left over from a previous segment's flow beads and appear to "march" (phantom flow)
    g.moveTo(TF.W(s.x1), TF.H(s.y1));
    g.lineTo(TF.W(s.x2), TF.H(s.y2));
    g.stroke();
    // current "trickle": white beads marching along the trace in the actual current direction,
    // faster the more current this segment carries (true per-trace current from the mesh solve, so
    // dead-end stubs to a cap / open contact read ~0 and don't animate)
    const Iseg = flowOn && !flt && !hot ? flowSeg[s.idx] || 0 : 0;
    const I = Math.abs(Iseg);
    if (I > 1e-5) {
      const dot = Math.max(2, lw * 0.4), // short dash + round cap -> a round bead ~the trace width
        gap = Math.max(11, lw * 3), // wide gaps so the beads read as distinct dots
        spd = Math.max(0.25, Math.min(2, 0.45 * (Math.log10(I) + 6.5))), // px/frame: slow, log-scaled
        dir = Iseg >= 0 ? 1 : -1; // march along the real current direction (segment x1,y1 -> x2,y2)
      g.setLineDash([dot, gap]);
      g.lineDashOffset = -dir * ((flowPhase * spd) % (dot + gap));
      g.lineCap = 'round';
      g.lineWidth = lw; // full-width white beads; the gaps still show the trace's voltage colour
      g.strokeStyle = '#ffffff';
      g.beginPath();
      g.moveTo(TF.W(s.x1), TF.H(s.y1));
      g.lineTo(TF.W(s.x2), TF.H(s.y2));
      g.stroke();
    }
  }
  g.setLineDash([]);
  g.lineDashOffset = 0;
  g.lineCap = 'round';
  // pads
  for (const p of padsOn(L)) {
    const dc = devClass(p.ref),
      flt = RES && RES.floating && RES.floating[p.net];
    g.fillStyle =
      hoveredNet && p.net === hoveredNet ? '#fff' : dc === 'bad' ? '#f85149' : flt ? '#475569' : colorFor(p.net);
    g.globalAlpha = 0.9;
    const w = Math.max(2, p.w * TF.sc),
      h = Math.max(2, p.h * TF.sc),
      x = TF.W(p.x),
      y = TF.H(p.y);
    if (p.shape === 'circle') {
      g.beginPath();
      g.arc(x, y, Math.max(1.5, w / 2), 0, 7);
      g.fill();
    } else {
      g.save();
      g.translate(x, y);
      g.rotate(((p.rot || 0) * Math.PI) / 180);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.restore();
    }
    // per-pad flow — for a pad whose current sinks into a pour/plane (e.g. a GND return) there's no trace
    // to animate, so show a confined white ripple *inside* the pad (same look as the trace beads:
    // expanding = current out into the copper, contracting = in). Suppress it only on a non-pour net where
    // a real same-layer trace already carries the current; pour nets always show (the stub-to-via landing
    // on the pad is the pour entry, not a competing trace).
    const Ipad = flowOn && (POUR_NETS.has(p.net) || !padTracedLayers(p)?.has(L)) ? padCur.get(p) || 0 : 0;
    if (Math.abs(Ipad) > 1e-5) {
      const padR = Math.max(1.5, Math.min(w, h) / 2),
        spd = Math.max(0.25, Math.min(2, 0.45 * (Math.log10(Math.abs(Ipad)) + 6.5))),
        ph = ((flowPhase * spd) % 40) / 40;
      g.globalAlpha = 1;
      g.lineCap = 'round';
      for (let k = 0; k < 2; k++) {
        const fr = (ph + 0.5 * k) % 1,
          grow = Ipad >= 0 ? fr : 1 - fr;
        g.strokeStyle = 'rgba(255,255,255,' + 0.45 * (1 - fr) + ')';
        g.lineWidth = Math.max(0.5, padR * 0.25);
        g.beginPath();
        g.arc(x, y, grow * padR * 0.82, 0, 7); // radius 0..0.82*padR -> stays within the pad
        g.stroke();
      }
    }
  }
  g.globalAlpha = 1;
  // vias
  for (const v of viasOn(L)) {
    g.fillStyle = hoveredNet && v.net === hoveredNet ? '#fff' : '#8b949e';
    g.beginPath();
    g.arc(TF.W(v.x), TF.H(v.y), Math.max(1.5, v.r * TF.sc), 0, 7);
    g.fill();
  }
  // affordances: ⚙ on programmable ICs (where to click), ⚠ asterisk-in-triangle on abs-max violations
  for (const ref in COMP) {
    if (!isProgrammable(ref)) continue;
    const bb = compBBox(ref);
    if (bb && bb.layers.includes(L)) drawGearBadge(g, TF.W(bb.cx), TF.H(bb.cy), hoveredRef === ref);
  }
  const drawFault = (ref, dim) => {
    const bb = compBBox(ref);
    if (!bb || !bb.layers.includes(L)) return;
    const bx = TF.W(bb.cx),
      by = TF.H(bb.cy) - (isProgrammable(ref) ? 14 : 0);
    if (COMP[ref] && COMP[ref].kind === 'fuse') drawBlownFuseBadge(g, bx, by, dim);
    else drawWarnBadge(g, bx, by, dim);
  };
  for (const ref of stickyRefs) if (!violByRef[ref]) drawFault(ref, true); // dimmed: flagged earlier this run
  for (const ref in violByRef) drawFault(ref, false); // bright: a fault active at the cursor
}
function drawAll() {
  if (!TF) return;
  computeViolations(); // refresh abs-max badges for the displayed sample
  document.querySelectorAll('#stack canvas').forEach((cv) => drawLayer(cv, cv.dataset.layer));
}
function distToSeg(px, py, s) {
  const x1 = TF.W(s.x1),
    y1 = TF.H(s.y1),
    x2 = TF.W(s.x2),
    y2 = TF.H(s.y2);
  const dx = x2 - x1,
    dy = y2 - y1,
    L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function fmtA(a) {
  const x = Math.abs(a);
  if (x >= 1) return a.toFixed(2) + ' A';
  if (x >= 1e-3) return (a * 1e3).toFixed(2) + ' mA';
  if (x >= 1e-6) return (a * 1e6).toFixed(1) + ' µA';
  return (a * 1e9).toFixed(0) + ' nA';
}
function onHover(ev, cv, L) {
  const r = cv.getBoundingClientRect();
  const px = ev.clientX - r.left,
    py = ev.clientY - r.top;
  let best = null,
    bd = 8,
    bestRef = null,
    bestSeg = null;
  for (const s of segsOn(L)) {
    const d = distToSeg(px, py, s);
    if (d < bd + (s.w * TF.sc) / 2) {
      bd = d;
      best = s.net;
      bestSeg = s;
    }
  }
  if (!best)
    for (const p of padsOn(L)) {
      const x = TF.W(p.x),
        y = TF.H(p.y),
        w = (p.w * TF.sc) / 2 + 3,
        h = (p.h * TF.sc) / 2 + 3;
      if (Math.abs(px - x) < w && Math.abs(py - y) < h) {
        best = p.net;
        bestRef = p.ref;
        break;
      }
    }
  // the WHOLE footprint of a programmable IC is a click target (its pads are tiny) — and so is a flagged
  // component's badge. Fall back to a bbox hit-test when no trace/pad was under the cursor.
  if (!bestRef)
    for (const ref in COMP) {
      if (!isProgrammable(ref)) continue;
      const bb = compBBox(ref);
      if (!bb || !bb.layers.includes(L)) continue;
      const xa = TF.W(bb.x0), xb = TF.W(bb.x1), ya = TF.H(bb.y0), yb = TF.H(bb.y1);
      if (px >= Math.min(xa, xb) - 2 && px <= Math.max(xa, xb) + 2 && py >= Math.min(ya, yb) - 2 && py <= Math.max(ya, yb) + 2) {
        bestRef = ref;
        break;
      }
    }
  if (!(bestRef && violByRef[bestRef]))
    for (const ref in violByRef) {
      const bb = compBBox(ref);
      if (bb && bb.layers.includes(L) && Math.hypot(px - TF.W(bb.cx), py - TF.H(bb.cy)) < 11) {
        bestRef = ref;
        break;
      }
    }
  const refChanged = hoveredRef !== bestRef;
  hoveredRef = bestRef;
  if (best !== hoveredNet || refChanged) {
    hoveredNet = best;
    drawAll();
  }
  const tip = $('#tip');
  const viol = bestRef && violByRef[bestRef];
  if (viol) {
    // the badge's popup. A blown fuse is a fail-safe disconnect, not an abs-max overstress — say so.
    const isFuse = COMP[bestRef] && COMP[bestRef].kind === 'fuse';
    const col = isFuse ? '#f85149' : '#f0b429';
    const head = isFuse ? `${bestRef} — fuse blown / open` : `⚠ ${bestRef} — absolute-maximum violation`;
    tip.innerHTML =
      `<b style="color:${col}">${head}</b><br>` +
      viol
        .map(
          (v) =>
            isFuse
              ? `<span style="color:#9aa3b2">${v.why}</span>`
              : `pin ${v.pin} (${v.net}) peaked <b>${v.peak.toFixed(2)} V</b> ∉ [${v.lo}, ${v.hi}] @ ${(v.peakT * 1e3).toFixed(2)} ms<br><span style="color:#9aa3b2">${v.why}</span>`,
        )
        .join('<br>');
    tip.style.whiteSpace = 'normal';
    tip.style.maxWidth = '300px';
    tip.style.borderColor = col;
    tip.style.display = 'block';
    tip.style.left = ev.clientX + 12 + 'px';
    tip.style.top = ev.clientY + 12 + 'px';
  } else if (best) {
    let txt = best;
    if (bestRef && devClass(bestRef) === 'bad') txt = `${bestRef} (${refKind(bestRef)} — unsupported) · ${best}`;
    if (RES && RES.floating && RES.floating[best]) txt += '  (floating)';
    else if (RES && RES.v[best]) txt += `  ${RES.v[best][tIndex].toFixed(3)} V`;
    else txt += '  (not in sim)';
    // per point-to-point connection current: the actual current in the hovered trace segment (from the
    // mesh solve), so a dead-end stub reads ~0 while a supply trace shows its full draw
    if (bestSeg && RES && !(RES.floating && RES.floating[best])) {
      const I = Math.abs(flowSeg[bestSeg.idx] || 0);
      txt += `  ·  ${I < 1e-7 ? '≈0 A' : fmtA(I)}`;
    }
    if (bestRef && isProgrammable(bestRef)) txt += '  ·  click to program';
    tip.textContent = txt;
    tip.style.whiteSpace = 'nowrap';
    tip.style.maxWidth = 'none';
    tip.style.borderColor = '';
    tip.style.display = 'block';
    tip.style.left = ev.clientX + 12 + 'px';
    tip.style.top = ev.clientY + 12 + 'px';
  } else if (bestRef && isProgrammable(bestRef)) {
    // hovering the IC body (no net under the cursor): show the click-to-program affordance
    tip.textContent = `⚙ ${bestRef} (${COMP[bestRef].lib.split(':').pop()}) · click to program`;
    tip.style.whiteSpace = 'nowrap';
    tip.style.maxWidth = 'none';
    tip.style.borderColor = '#1f6feb';
    tip.style.display = 'block';
    tip.style.left = ev.clientX + 12 + 'px';
    tip.style.top = ev.clientY + 12 + 'px';
  } else tip.style.display = 'none';
}

/* ---------- scopes (right) ---------- */
function buildScopes() {
  const box = $('#scopes');
  box.innerHTML = '';
  if (!selectedNets.size) {
    box.innerHTML = '<div class="hint">no nets selected — click a trace</div>';
    return;
  }
  [...selectedNets].forEach((net) => {
    const d = document.createElement('div');
    d.className = 'scopebox';
    const flt = RES && RES.floating && RES.floating[net];
    d.innerHTML = `<div class="sh"><span style="color:${flt ? '#7d8590' : netColor(net)}">${net}${flt ? ' <span class="hint">(floating — value indeterminate)</span>' : ''}</span><span class="x">✕</span></div>`;
    const cv = document.createElement('canvas');
    cv.width = 360;
    cv.height = 120;
    d.appendChild(cv);
    box.appendChild(d);
    d.querySelector('.x').onclick = () => {
      selectedNets.delete(net);
      buildScopes();
      drawAll();
    };
    drawScope(cv, net);
  });
}
function drawScope(cv, net) {
  const g = cv.getContext('2d'),
    W = cv.width,
    H = cv.height;
  g.fillStyle = '#07090d';
  g.fillRect(0, 0, W, H);
  if (!RES || !RES.v[net]) {
    g.fillStyle = '#7d8590';
    g.fillText('run sim', 8, H / 2);
    return;
  }
  const a = RES.v[net],
    flt = RES.floating && RES.floating[net];
  let lo = Math.min(...a),
    hi = Math.max(...a);
  // A floating net carries only Gmin-level numerical noise; autoscaling into it draws a phantom
  // waveform on a degenerate axis (0.00 to -0.00). Show it flat in a fixed window instead.
  if (flt || hi - lo < 1e-9) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  const m = (hi - lo) * 0.1;
  lo -= m;
  hi += m;
  // map over the buffered window [t0, tEnd] so a rolling live capture fills the scope (t0 = 0 in batch)
  const t0 = RES.t[0] || 0,
    tEnd = RES.t[RES.t.length - 1] ?? 1,
    tspan = tEnd - t0 || 1,
    X = (t) => 40 + ((t - t0) / tspan) * (W - 50),
    Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 24);
  // tick precision tracks the span, and we strip "-0" so the axis never reads "-0.00"
  const dec = hi - lo >= 10 ? 1 : hi - lo >= 1 ? 2 : hi - lo >= 0.1 ? 3 : 4,
    fmtV = (v) => {
      const s = v.toFixed(dec);
      return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
    };
  g.strokeStyle = '#161b22';
  for (let i = 0; i <= 4; i++) {
    const y = 8 + (i * (H - 24)) / 4;
    g.beginPath();
    g.moveTo(40, y);
    g.lineTo(W - 10, y);
    g.stroke();
    g.fillStyle = '#7d8590';
    g.font = '9px monospace';
    g.fillText(fmtV(hi - ((hi - lo) * i) / 4), 2, y + 3);
  }
  // abs-max band + peak-hold for a net that has faulted: shade the danger zones, dash the limits, and
  // mark the worst excursion — so the spike reads against its limit even after it leaves the live window.
  const nevs = eventLog.filter((e) => e.net === net);
  if (nevs.length) {
    const elo = Math.max(...nevs.map((e) => e.lo)),
      ehi = Math.min(...nevs.map((e) => e.hi));
    const pk = nevs.reduce((m, e) => (Math.abs(e.peak) > Math.abs(m.peak) ? e : m));
    const cY = (v) => Math.max(8, Math.min(H - 16, Y(v)));
    g.fillStyle = 'rgba(248,81,73,0.10)';
    if (isFinite(ehi)) g.fillRect(40, 8, W - 50, cY(ehi) - 8); // above the upper limit
    if (isFinite(elo)) g.fillRect(40, cY(elo), W - 50, H - 16 - cY(elo)); // below the lower limit
    g.strokeStyle = 'rgba(248,81,73,0.55)';
    g.setLineDash([3, 3]);
    g.lineWidth = 1;
    for (const lim of [elo, ehi])
      if (isFinite(lim)) {
        g.beginPath();
        g.moveTo(40, Y(lim));
        g.lineTo(W - 10, Y(lim));
        g.stroke();
      }
    g.setLineDash([]);
    const yp = cY(pk.peak); // peak-hold marker
    g.strokeStyle = '#f85149';
    g.beginPath();
    g.moveTo(40, yp);
    g.lineTo(W - 10, yp);
    g.stroke();
    g.fillStyle = '#f85149';
    g.fillText('peak ' + pk.peak.toFixed(2) + 'V', W - 82, yp - 2);
  }
  g.strokeStyle = RES.floating && RES.floating[net] ? '#475569' : netColor(net);
  g.lineWidth = 1.3;
  g.beginPath();
  for (let k = 0; k < a.length; k++) {
    const x = X(RES.t[k]),
      y = Y(a[k]);
    k ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  // time cursor
  const cx = X(RES.t[tIndex]);
  g.strokeStyle = '#f0883e';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx, 8);
  g.lineTo(cx, H - 16);
  g.stroke();
  g.fillStyle = '#f0883e';
  const cur = a[tIndex].toFixed(3).replace(/^-0\.?0*$/, '0.000');
  g.fillText(cur + 'V @' + (RES.t[tIndex] * 1e3).toFixed(2) + 'ms', 44, H - 4);
}

/* ---------- live simulation ---------- */
// Electrical state arrives from the isolated server worker. For the doorbell board that worker is
// paced by ESPHome's ADVANCE requests; the browser never has a second local execution path.
let running = true,
  simT = 0,
  remoteState = null,
  firmwareState = null,
  activeSpeed = 1,
  drawQueued = false;

// badges reflect the cursor: bright = a fault active at the displayed time (from the log); the dimmed
// "was-flagged" badges come from stickyRefs. Cheap — just a scan of the event list at the cursor time.
function computeViolations() {
  violByRef = {};
  if (!RES || !RES.t.length) return;
  const tc = RES.t[Math.min(tIndex, RES.t.length - 1)];
  for (const ev of eventLog)
    if (ev.t0 <= tc && tc <= (ev.end ?? Infinity)) (violByRef[ev.ref] ||= []).push(ev);
}

// the events side panel — newest first; click a row to scrub the cursor to that fault's peak.
function buildEventLog() {
  const box = $('#events');
  if (!box) return;
  if (!eventLog.length) {
    box.innerHTML = '<div class="hint">no faults — run the sim</div>';
    return;
  }
  box.innerHTML = '';
  for (const ev of eventLog.slice(-200).reverse()) {
    const icon = ev.kind === 'fuse' ? '⌁' : '⚠';
    const col = ev.kind === 'fuse' ? '#f85149' : '#f0b429';
    const dur = ev.end == null ? 'ongoing' : `${((ev.end - ev.t0) * 1e3).toFixed(2)} ms`;
    const d = document.createElement('div');
    d.className = 'evrow' + (ev.end == null ? ' ongoing' : '');
    d.style.borderLeftColor = col;
    d.innerHTML =
      `<span style="color:${col}">${icon} ${ev.ref}</span> ${ev.pin} · <b>${ev.peak.toFixed(2)} V</b> ` +
      `· @ ${(ev.peakT * 1e3).toFixed(2)} ms · ${dur}<br><span class="hint">${ev.why}</span>`;
    d.onclick = () => seekToEvent(ev);
    box.appendChild(d);
  }
}

// scrub the cursor to a fault's peak (pausing first), select its net, and light its badge.
function seekToEvent(ev) {
  if (running) pause();
  if (!RES.t.length) return;
  let best = 0, bd = Infinity;
  for (let i = 0; i < RES.t.length; i++) {
    const dd = Math.abs(RES.t[i] - ev.peakT);
    if (dd < bd) { bd = dd; best = i; }
  }
  tIndex = best;
  $('#tcur').value = best;
  updTcur();
  selectedNets.add(ev.net);
  buildScopes();
  drawAll();
  const off = ev.peakT < (RES.t[0] || 0) ? ' (scrolled out of the window)' : '';
  $('#status').textContent = `↳ ${ev.ref} ${ev.pin} peaked ${ev.peak.toFixed(2)} V @ ${(ev.peakT * 1e3).toFixed(2)} ms${off}`;
}

// U1 and U3 are never manually programmable in the interactive simulator: their only behavioural
// drivers come from the host firmware session.
const isProgrammable = () => false;

// an "asterisk in a triangle" warning marker, drawn at an affected component's centroid.
function drawWarnBadge(g, x, y, dim) {
  const r = 8;
  g.save();
  g.globalAlpha = dim ? 0.32 : 1;
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r * 0.92, y + r * 0.62);
  g.lineTo(x - r * 0.92, y + r * 0.62);
  g.closePath();
  g.fillStyle = '#f0b429';
  g.strokeStyle = '#1a1300';
  g.lineWidth = 1.3;
  g.fill();
  g.stroke();
  g.fillStyle = '#1a1300';
  g.font = 'bold 12px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('*', x, y + r * 0.28);
  g.restore();
}

// footprint bounding box (board coords) from a component's pads — for click/hover over the whole body.
const _bbox = {};
function compBBox(ref) {
  if (ref in _bbox) return _bbox[ref];
  const ps = PCB ? PCB.pads.filter((p) => p.ref === ref) : [];
  if (!ps.length) return (_bbox[ref] = null);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const layers = new Set();
  for (const p of ps) {
    const hw = (p.w || 0) / 2 + 0.2, hh = (p.h || 0) / 2 + 0.2;
    x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw);
    y0 = Math.min(y0, p.y - hh); y1 = Math.max(y1, p.y + hh);
    (p.layers || []).forEach((L) => layers.add(L));
  }
  return (_bbox[ref] = { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, layers: [...layers] });
}

// a little gear, marking a footprint you can click to program the IC.
function drawGearBadge(g, x, y, hot) {
  const col = hot ? '#79c0ff' : '#1f6feb';
  g.save();
  g.translate(x, y);
  g.strokeStyle = col;
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * 4.6, Math.sin(a) * 4.6);
    g.lineTo(Math.cos(a) * 7.8, Math.sin(a) * 7.8);
    g.stroke();
  }
  g.beginPath();
  g.arc(0, 0, 5, 0, 7);
  g.fillStyle = col;
  g.fill();
  g.beginPath();
  g.arc(0, 0, 2, 0, 7);
  g.fillStyle = '#0b1220';
  g.fill();
  g.restore();
}

// a blown fuse: a red holder with a melted (broken) filament — distinct from the abs-max ⚠, because the
// protection *worked* (a fail-safe disconnect), it isn't a part being overstressed.
function drawBlownFuseBadge(g, x, y, dim) {
  const w = 17, h = 10, r = 3.5;
  g.save();
  g.globalAlpha = dim ? 0.32 : 1;
  g.translate(x, y);
  g.beginPath();
  g.moveTo(-w / 2 + r, -h / 2);
  g.arcTo(w / 2, -h / 2, w / 2, 0, r);
  g.arcTo(w / 2, h / 2, 0, h / 2, r);
  g.arcTo(-w / 2, h / 2, -w / 2, 0, r);
  g.arcTo(-w / 2, -h / 2, 0, -h / 2, r);
  g.closePath();
  g.fillStyle = '#2a1010';
  g.strokeStyle = '#f85149';
  g.lineWidth = 1.4;
  g.fill();
  g.stroke();
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-w / 2 + 2.5, 0); // filament from the left lead...
  g.lineTo(-2.5, 0);
  g.moveTo(2.5, 0); // ...and from the right, with a melted gap between
  g.lineTo(w / 2 - 2.5, 0);
  g.moveTo(-2.5, 0); // two singed stubs angled away from the break
  g.lineTo(-1, -2.2);
  g.moveTo(2.5, 0);
  g.lineTo(1, 2.2);
  g.stroke();
  g.restore();
}

// Map each pad object to its (signed) injection current for the per-pad flow animation. +ve = current
// leaving the pad into the copper net — so a GND/return pad shows its outflow into the pour, which has
// no trace to animate. Same (ref, pin) / (ref, net) matching that traceCurrents uses.
function padCurrents(inj) {
  const m = new Map();
  for (const it of inj) {
    // pins are strings throughout — PCB pads and every device model's pinout — so a plain === matches.
    // An injection with no pin (the galvanically-isolated opto / SSR / MOS, modelled per-net) matches by net.
    const pad = PCB.pads.find(
      (p) => p.ref === it.ref && (it.pin === undefined ? p.net === it.net : p.pin === it.pin),
    );
    if (pad) m.set(pad, (m.get(pad) || 0) + it.I);
  }
  return m;
}
function redraw() {
  if (!RES || !RES.t.length) return;
  const tc = $('#tcur');
  tc.max = Math.max(0, RES.t.length - 1);
  if (running) tc.value = tIndex;
  // per-segment flow — but only while something is actually powering the board. With no live source
  // the only currents are decaying transients off charged caps (and an unanchored powered island can
  // drift numerically); the user reasonably expects "no source -> no flow", so suppress it.
  if (remoteState) {
    const inj = sources.some((s) => !s.off) ? remoteState.injections || [] : [];
    flowSeg = inj.length ? traceCurrents(traceGraph, inj) : {};
    padCur = padCurrents(inj);
  }
  flowPhase = (flowPhase + 1) % 1e6; // advance the marching dashes one drawn frame
  updTcur();
  drawAll();
  updateRelayStates();
  if (eventLog.length !== lastEvCount || activeEv.size) {
    lastEvCount = eventLog.length; // refresh the events panel on a new/closed fault (or live peak/duration)
    buildEventLog();
  }
  document.querySelectorAll('#scopes canvas').forEach((cv, i) => drawScope(cv, [...selectedNets][i]));
}

function status(detail = '') {
  const pace = activeSpeed === 'max' ? 'max' : `${activeSpeed}×`;
  const fw = BOARD === 'doorbell' ? ` · firmware ${firmwareState?.crashed ? 'crashed' : firmwareState?.connected ? 'connected' : 'starting'}` : '';
  $('#status').textContent = `${running ? '▶ running ' + pace : '⏸ paused'} · t = ${(simT * 1e3).toFixed(1)} ms${fw}${detail ? ' · ' + detail : ''}`;
}

async function action(message) {
  try {
    return await requestJson(`/api/sessions/${SESSION.id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  } catch (error) {
    status(`request failed: ${error.message}`);
    throw error;
  }
}

function paintSpeed() {
  document.querySelectorAll('.speed').forEach((button) =>
    button.classList.toggle('primary', running && String(activeSpeed) === button.dataset.speed));
  $('#pause').classList.toggle('primary', !running);
  $('#step').disabled = running;
}

function setSpeed(value) {
  activeSpeed = value;
  running = value !== 0;
  paintSpeed();
  status();
  return action({ type: 'speed', value });
}

function pause() {
  return setSpeed(0);
}

function clearRun() {
  RES = { t: [], v: {}, floating: {} };
  remoteState = null;
  simT = 0;
  tIndex = 0;
  eventLog = [];
  activeEv.clear();
  stickyRefs.clear();
  pendingBreak = null;
  evId = 0;
  lastEvCount = -1;
  timelineRows.length = 0;
  $('#timeline').innerHTML = '<div class="hint">waiting for firmware…</div>';
  firmwareState = null;
  buildEventLog();
  buildScopes();
}

async function reset() {
  running = false;
  activeSpeed = 0;
  paintSpeed();
  clearRun();
  loadConfig(SESSION.config);
  for (const id of ['fwHa', 'fwAuto', 'fwSuppress', 'fwForce']) $('#' + id).checked = false;
  $('#fwGreeting').value = 'None';
  $('#fwFault').value = 'normal';
  status('full reset in progress');
  await action({ type: 'reset' });
}

function circuitConfig() {
  return { sources, elements, switches: switchState, gnd: $('#gnd').value,
    dtUs: Number($('#dt').value) };
}

function applyChange() {
  action({ type: 'configure', config: circuitConfig() });
}

function appendSample(sample) {
  remoteState = sample;
  simT = sample.at / 1000;
  if (!RES) RES = { t: [], v: {}, floating: {} };
  const replace = RES.t.length && Math.abs(RES.t.at(-1) - simT) < 1e-12;
  const oldLength = RES.t.length;
  if (replace) RES.t[oldLength - 1] = simT;
  else RES.t.push(simT);
  for (const [net, value] of Object.entries(sample.voltages || {})) {
    if (!RES.v[net]) RES.v[net] = new Array(oldLength).fill(value);
    if (replace) RES.v[net][oldLength - 1] = value;
    else RES.v[net].push(value);
  }
  for (const net in RES.v) {
    if (net in (sample.voltages || {})) continue;
    const values = RES.v[net];
    if (!replace) values.push(values.at(-1) ?? Number.NaN);
  }
  RES.floating = sample.floating || {};
  const cutoff = simT - Math.max(0.001, Number($('#dur').value) / 1000);
  let drop = 0;
  while (drop < RES.t.length - 2 && RES.t[drop] < cutoff) drop++;
  if (drop) {
    RES.t.splice(0, drop);
    for (const net in RES.v) RES.v[net].splice(0, drop);
  }
  if (running || tIndex >= RES.t.length - 2) tIndex = RES.t.length - 1;
  scheduleDraw();
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    redraw();
    status();
  });
}

function receiveFault(fault) {
  const existing = eventLog.find((item) => item.id === fault.id);
  if (existing) Object.assign(existing, fault);
  else {
    eventLog.push(fault);
    stickyRefs.add(fault.ref);
    if (breakOnFault) {
      pause();
      status(`broke on ${fault.kind}: ${fault.ref} ${fault.pin}`);
    }
  }
  if (fault.end == null) activeEv.set(fault.id, fault);
  else activeEv.delete(fault.id);
  lastEvCount = -1;
  scheduleDraw();
}

const timelineRows = [];
function receiveTimeline(item) {
  timelineRows.push(item);
  if (timelineRows.length > 200) timelineRows.shift();
  const box = $('#timeline');
  box.innerHTML = '';
  for (const entry of timelineRows.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'tl';
    const at = Number(entry.at || 0).toFixed(0);
    let text = entry.type;
    if (entry.type === 'write') text = `${entry.signal} = ${entry.value ? 1 : 0}`;
    else if (entry.type === 'entity') text = `${entry.name} = ${entry.value ? 'on' : 'off'}`;
    else if (entry.type === 'media') text = `media ${entry.state.toLowerCase()} ${entry.name}`;
    else if (entry.type === 'command') text = entry.command;
    row.textContent = `${at} ms · ${text}`;
    box.appendChild(row);
  }
}

function updateFirmware(state) {
  firmwareState = state;
  if (BOARD !== 'doorbell') return;
  const outputs = Object.entries(state.outputs || {}).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
  const entities = Object.entries(state.entities || {}).filter(([, value]) => value).map(([name]) => name).join(', ') || 'none';
  const media = state.media?.active ? `${state.media.name} (${state.media.duration} ms)` : 'idle';
  $('#fwState').textContent = `${state.crashed ? 'CRASHED' : state.connected ? 'connected' : 'starting'} · ${outputs} · events: ${entities} · media: ${media}`;
}

function loadConfig(next) {
  sources = next.sources.map((item) => ({ ...item }));
  elements = next.elements.map((item) => ({ ...item }));
  for (const key of Object.keys(switchState)) delete switchState[key];
  Object.assign(switchState, next.switches);
  $('#gnd').value = next.gnd;
  $('#dt').value = next.dtUs;
  $('#sources').innerHTML = '';
  $('#elements').innerHTML = '';
  sources.forEach(srcRow);
  elements.forEach(elRow);
  buildRelays();
}

function updTcur() {
  if (RES && RES.t.length) $('#tcurv').textContent = (RES.t[tIndex] * 1e3).toFixed(2) + ' ms';
}

$('#reset').onclick = reset;
$('#pause').onclick = pause;
document.querySelectorAll('.speed').forEach((button) => button.onclick = () =>
  setSpeed(button.dataset.speed === 'max' ? 'max' : Number(button.dataset.speed)));
$('#step').onclick = () => action({ type: 'step' });
$('#crash').onclick = () => action({ type: 'crash' });
$('#reboot').onclick = () => action({ type: 'reboot' });
$('#gnd').onchange = applyChange;
$('#dt').onchange = applyChange;
$('#tcur').oninput = (e) => {
  if (running) return; // the live loop owns the cursor while running; scrub only when paused
  tIndex = +e.target.value;
  updTcur();
  drawAll();
  updateRelayStates();
  document.querySelectorAll('#scopes canvas').forEach((cv, i) => drawScope(cv, [...selectedNets][i]));
};
$('#cmode').onchange = drawAll;
$('#vmax').oninput = drawAll; // re-color on scale change (no re-sim needed)
$('#flow').onchange = drawAll; // show/hide the current-flow animation
$('#silk').onchange = drawAll; // show/hide the silkscreen underlay
$('#brk').onchange = (e) => (breakOnFault = e.target.checked); // auto-pause on the next new fault
$('#clrEv').onclick = () => {
  eventLog = [];
  activeEv.clear();
  stickyRefs.clear();
  pendingBreak = null;
  lastEvCount = -1;
  buildEventLog();
  drawAll();
};
window.addEventListener('resize', () => buildStack());
window.addEventListener('beforeunload', () => fetch(`/api/sessions/${SESSION.id}`, { method: 'DELETE', keepalive: true }));

function firmwareCommand(command) {
  return action({ type: 'command', command });
}
$('#fwHa').onchange = (event) => firmwareCommand(`SET:ha:${event.target.checked ? 1 : 0}`);
$('#fwAuto').onchange = (event) => firmwareCommand(`SET:auto_open:${event.target.checked ? 1 : 0}`);
$('#fwSuppress').onchange = (event) => firmwareCommand(`SET:suppress_chime:${event.target.checked ? 1 : 0}`);
$('#fwForce').onchange = (event) => firmwareCommand(`SET:force_chime:${event.target.checked ? 1 : 0}`);
$('#fwGreeting').onchange = (event) => firmwareCommand(`SELECT:${event.target.value}`);
$('#fwPlay').onclick = () => firmwareCommand('PRESS:play');
$('#fwWelcomeOpen').onclick = () => firmwareCommand('PRESS:welcome_open');
$('#fwDoor').onclick = () => firmwareCommand('PRESS:door');
$('#fwFault').onchange = (event) => {
  const command = { normal: 'MEDIA_FAULT:normal', delayed: 'MEDIA_FAULT:delayed_start:1000',
    idle: 'MEDIA_FAULT:synthetic_idle', never: 'MEDIA_FAULT:never' }[event.target.value];
  firmwareCommand(command);
};

// Initialize from the worker's authoritative configuration, then subscribe before starting time.
RES = { t: [], v: {}, floating: {} };
loadConfig(SESSION.config);
buildStack();
if (BOARD !== 'doorbell') {
  $('#firmwareControls').style.display = 'none';
  $('#lifecycle').style.display = 'none';
  $('#timeline').previousElementSibling.style.display = 'none';
  $('#timeline').style.display = 'none';
} else {
  $('#gnd').disabled = true;
  $('#gnd').title = 'HEAD firmware sessions require the board GND reference';
  $('#dt').disabled = true;
  $('#dt').title = 'HEAD firmware sessions use adaptive electrical timesteps';
}
const events = new EventSource(`/api/sessions/${SESSION.id}/events`);
events.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === 'sample') {
    updateFirmware(message.firmware);
    appendSample(message.sample);
  } else if (message.type === 'firmware') updateFirmware(message.firmware);
  else if (message.type === 'fault') receiveFault(message.fault);
  else if (message.type === 'timeline') receiveTimeline(message.item);
  else if (message.type === 'ready' && message.config && !RES.t.length) loadConfig(message.config);
  else if (message.type === 'status') status(message.detail || message.status);
  else if (message.type === 'error') {
    running = false;
    activeSpeed = 0;
    paintSpeed();
    status(`simulation error: ${message.message}`);
    console.error(message.stack || message.message);
  }
};
events.onerror = () => status('session event stream disconnected');
paintSpeed();
setSpeed(1);
}
boot().catch((e) => {
  document.body.innerHTML = '<pre style="color:#f85149;padding:16px">sim failed to load:\n' + (e.stack || e) + '</pre>';
  console.error(e);
});
