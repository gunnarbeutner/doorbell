// ui.js — the browser front-end. Imports the sim engine + component registry and fetches the
// netlist live from the dev server (which reads the KiCad files); nothing is baked in.
import { createStepper, makeWave, parseVal, gndOf } from './engine.js';
import { allComponents, buildElements, defaultSwitchState } from './components/index.js';
import { buildTraceGraph, traceCurrents } from './traceflow.js';

async function boot() {
const BOARD = new URLSearchParams(location.search).get('board') || 'doorbell';
const NETLIST = await fetch('/netlist.json?board=' + encodeURIComponent(BOARD)).then((r) => r.json());
const PCB = NETLIST.pcb;
if (PCB) PCB.segments.forEach((s, i) => (s.idx = i)); // segment index for per-segment flow lookup
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
  flowPhase = 0; // advances each drawn frame -> marching dashes
let selectedNets = new Set(),
  hoveredNet = null;
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
  d.innerHTML = `<div class="srow"><button class="tog"></button><select class="n"></select><span class="x">✕</span></div>
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
  const s = { net: GNDdef, type: 'dc', v1: 5, v2: 0, freq: 1000, t1: 1 };
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
  const rc = els.find((e) => e.ref === ref && e.type === 'RC');
  if (rc) return !!rc.coilOn;

  return c.energized(voltageAt(k));
}

function updateRelayStates() {
  document.querySelectorAll('#relays .rstate').forEach((el) => {
    const en = relayEnergized(el.dataset.ref, tIndex);

    el.textContent = en == null ? '— drive coil' : en ? '● energized' : '○ idle';
    el.style.color = en ? '#3fb950' : '#7d8590';
  });
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
      row.innerHTML =
        `<b>${c.ref}</b> <span class="hint">relay</span> ` +
        `<span class="rstate hint" data-ref="${c.ref}">—</span>`;
      box.appendChild(row);
      continue;
    }

    // a switch or solder bridge is a manual toggle
    const bridge = c.role === 'bridge';
    const on = !!switchState[c.ref];

    const label = document.createElement('span');
    label.innerHTML = `<b>${c.ref}</b> <span class="hint">${bridge ? 'solder bridge' : 'switch'}</span> `;
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
  const cw = $('#mid').clientWidth - 2,
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
      cv.addEventListener('click', () => {
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
    g.beginPath();
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
  }
  g.globalAlpha = 1;
  // vias
  for (const v of viasOn(L)) {
    g.fillStyle = hoveredNet && v.net === hoveredNet ? '#fff' : '#8b949e';
    g.beginPath();
    g.arc(TF.W(v.x), TF.H(v.y), Math.max(1.5, v.r * TF.sc), 0, 7);
    g.fill();
  }
}
function drawAll() {
  if (!TF) return;
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
function onHover(ev, cv, L) {
  const r = cv.getBoundingClientRect();
  const px = ev.clientX - r.left,
    py = ev.clientY - r.top;
  let best = null,
    bd = 8,
    bestRef = null;
  for (const s of segsOn(L)) {
    const d = distToSeg(px, py, s);
    if (d < bd + (s.w * TF.sc) / 2) {
      bd = d;
      best = s.net;
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
  if (best !== hoveredNet) {
    hoveredNet = best;
    drawAll();
  }
  const tip = $('#tip');
  if (best) {
    let txt = best;
    if (bestRef && devClass(bestRef) === 'bad') txt = `${bestRef} (${refKind(bestRef)} — unsupported) · ${best}`;
    if (RES && RES.floating && RES.floating[best]) txt += '  (floating)';
    else if (RES && RES.v[best]) txt += `  ${RES.v[best][tIndex].toFixed(3)} V`;
    else txt += '  (not in sim)';
    tip.textContent = txt;
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
// The sim runs continuously: each animation frame advances sim-time (targeting real time, but capped
// so the UI stays responsive — it slips into slow-motion rather than freezing) and appends to a
// rolling buffer that the board + scopes draw. Start/Pause/Reset drive it. Editing a source / switch /
// element rebuilds the stepper *seeded from the current state*, so the change takes effect mid-run
// (or, while paused, several edits stage up and take effect together on resume).
let stepper = null,
  running = false,
  simT = 0,
  els = [],
  rafId = 0,
  lastWall = 0,
  lastDraw = 0,
  ratio = 1;
const MAXSTEPS = 150; // per-frame compute cap (~25 ms at this circuit's tick cost)

const dtSec = () => +$('#dt').value / 1e6;
const winLen = () => Math.max(2, Math.round((+$('#dur').value / 1000) / dtSec())); // rolling window, samples

function buildSrcs() {
  const byNet = {}; // sources on one net superpose (sum); disabled ones are left out (net floats)
  for (const s of sources) {
    if (s.off) continue;
    (byNet[s.net] = byNet[s.net] || []).push(makeWave(s));
  }
  return Object.keys(byNet).map((net) => {
    const ws = byNet[net];
    return { net, vf: (t) => ws.reduce((a, w) => a + w(t), 0) };
  });
}

function buildEls() {
  const extra = []; // hand-added "Extra elements" become raw sim elements alongside the modeled parts
  for (const e of elements) {
    if (e.kind === 'short') extra.push({ type: 'R', a: e.a, b: e.b, value: 1e-3 });
    else if (e.kind === 'switch') extra.push({ type: 'SW', a: e.a, b: e.b, closed: !!e.closed });
    else extra.push({ type: e.kind, a: e.a, b: e.b, value: parseVal(e.value) });
  }
  return buildElements(NETLIST, { switchState, extra });
}

// (re)build the stepper for the current config; `seed` carries the physical state across the change
function rebuildStepper(seed) {
  els = buildEls();
  try {
    stepper = createStepper(els, buildSrcs(), $('#gnd').value, dtSec(), seed);
  } catch (err) {
    $('#status').textContent = 'sim error: ' + err.message;
    console.error(err);
    return;
  }
  if (!RES) RES = { t: [], v: {}, floating: {} };
  for (const n of stepper.nodes)
    if (!RES.v[n]) RES.v[n] = new Array(RES.t.length).fill(stepper.vn[stepper.ni[n]]); // backfill new nets
  if (!RES.v[stepper.gnd]) RES.v[stepper.gnd] = new Array(RES.t.length).fill(0);
  RES.floating = stepper.floatingMap();
}

function pushSample() {
  RES.t.push(simT);
  for (const n of stepper.nodes) (RES.v[n] = RES.v[n] || []).push(stepper.vn[stepper.ni[n]]);
  (RES.v[stepper.gnd] = RES.v[stepper.gnd] || []).push(0);
  const drop = RES.t.length - winLen();
  if (drop > 0) {
    RES.t.splice(0, drop);
    for (const n in RES.v) RES.v[n].splice(0, drop);
  }
}

function redraw() {
  const tc = $('#tcur');
  tc.max = Math.max(0, RES.t.length - 1);
  if (running) tc.value = tIndex;
  // per-segment flow — but only while something is actually powering the board. With no live source
  // the only currents are decaying transients off charged caps (and an unanchored powered island can
  // drift numerically); the user reasonably expects "no source -> no flow", so suppress it.
  if (stepper) flowSeg = sources.some((s) => !s.off) ? traceCurrents(traceGraph, stepper.padInjections()) : {};
  flowPhase = (flowPhase + 1) % 1e6; // advance the marching dashes one drawn frame
  updTcur();
  drawAll();
  updateRelayStates();
  document.querySelectorAll('#scopes canvas').forEach((cv, i) => drawScope(cv, [...selectedNets][i]));
}

function status(stepsThisFrame) {
  const revb = []; // polarized (electrolytic) caps biased backwards anywhere in the window
  for (const e of els)
    if (e.polar && RES.v[e.plus] && RES.v[e.minus]) {
      let mn = 1e9;
      const vp = RES.v[e.plus],
        vm = RES.v[e.minus];
      for (let i = 0; i < vp.length; i++) mn = Math.min(mn, vp[i] - vm[i]);
      if (mn < -0.3) revb.push(`${e.ref} ${mn.toFixed(1)}V`);
    }
  const warn = revb.length ? `⚠ reverse-biased: ${revb.join(', ')} · ` : '';
  const pace = running
    ? `· ${stepsThisFrame}/frame · ${ratio >= 0.99 ? 'real time' : '~' + ratio.toFixed(2) + '× (slow-mo)'} `
    : '';
  $('#status').textContent =
    `${warn}${running ? '▶ running' : '⏸ paused'} · t = ${(simT * 1e3).toFixed(1)} ms ${pace}· ${els.length} elements`;
}

function frame(ts) {
  if (!running) return;
  const dt = dtSec();
  const realEl = lastWall ? (ts - lastWall) / 1000 : dt;
  lastWall = ts;
  const want = Math.max(1, Math.round(realEl / dt)); // steps needed to stay at wall-clock speed
  const n = Math.min(want, MAXSTEPS); // cap → slow-mo instead of a frozen UI when it can't keep up
  for (let i = 0; i < n; i++) {
    simT += dt;
    stepper.step(simT);
    pushSample();
  }
  tIndex = RES.t.length - 1;
  ratio = (n * dt) / Math.max(realEl, 1e-6);
  RES.floating = stepper.floatingMap();
  if (ts - lastDraw > 32) {
    redraw(); // throttle the redraw to ~30 Hz; keep stepping on every animation frame
    status(n);
    lastDraw = ts;
  }
  rafId = requestAnimationFrame(frame);
}

function setPlay() {
  const b = $('#play');
  b.textContent = running ? '⏸ Pause' : '▶ Start';
  b.classList.toggle('primary', !running);
}

function start() {
  if (running) return;
  running = true;
  lastWall = 0;
  lastDraw = 0;
  setPlay();
  rafId = requestAnimationFrame(frame);
}

function pause() {
  running = false;
  cancelAnimationFrame(rafId);
  setPlay();
  status(0);
}

function reset() {
  running = false;
  cancelAnimationFrame(rafId);
  simT = 0;
  RES = { t: [], v: {}, floating: {} };
  rebuildStepper(null);
  stepper.step(0); // show the t = 0 operating point
  pushSample();
  tIndex = 0;
  setPlay();
  buildScopes();
  redraw();
  status(0);
}

// an edit to a source / switch / element while live: continue from the current state (a mid-run event)
function applyChange() {
  rebuildStepper(stepper ? stepper.extractState() : null);
  if (!running) {
    redraw(); // paused: floating/topology updates now; the waveform continues when you resume
    status(0);
  }
}

function updTcur() {
  if (RES && RES.t.length) $('#tcurv').textContent = (RES.t[tIndex] * 1e3).toFixed(2) + ' ms';
}

$('#play').onclick = () => (running ? pause() : start());
$('#reset').onclick = reset;
$('#gnd').onchange = applyChange; // reference change rebuilds the stepper (seeded)
$('#dt').onchange = applyChange; // dt is baked into the stepper, so a change rebuilds it
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
window.addEventListener('resize', () => buildStack());

// init: seed the default sources from the board's .sim config, then show the operating point (paused)
buildRelays();
for (const c of NETLIST.config?.sources || []) {
  const s = { net: c.net, type: c.type || 'dc', v1: c.v1 ?? 0, v2: c.v2 ?? 0, freq: c.freq ?? 1000, t1: c.t1 ?? 1 };
  sources.push(s);
  srcRow(s);
}
buildStack();
reset();
start(); // run live from the start
}
boot().catch((e) => {
  document.body.innerHTML = '<pre style="color:#f85149;padding:16px">sim failed to load:\n' + (e.stack || e) + '</pre>';
  console.error(e);
});
