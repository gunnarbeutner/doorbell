// App controller: loads recordings, owns the data-fetch reactions, builds the toolbar, and exposes
// the `app` methods that interactions.js + the buttons call. Rendering is explicit (call draw());
// the store has no auto-subscribers, so there are no redraw storms.

import { store, elapsed, valueAt, activeEvents } from './viewstate.js';
import { hlMeta } from './scope.js';
import { getRecordings, getMeta, getNote, getSamples, getEvents, pngUrl } from './api.js';
import { Scope } from './scope.js';
import { attachInteractions } from './interactions.js';
import { AudioEngine } from './audio.js';
import { SpectrogramPanel } from './spectrogram.js';
import { renderMarkdown } from './notes.js';
import { labelFor, setLabel } from './labels.js';
import { debounce, clamp, fmtTime, fmtVolt, fmtFreq } from './util.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scope');
const tip = $('tip');

const scope = new Scope(canvas);
const audio = new AudioEngine({ redraw: () => scope.draw(), onState: updateTransport });
const spectro = new SpectrogramPanel({ canvas: $('spectro'), peaksEl: $('peaks'), audioEngine: audio });

let fetchAbort = null;
const scheduleFetch = debounce(fetchSamples, 90);
const scheduleSpectro = debounce(() => spectro.update(), 250);

const minDt = () => Math.min(...store.get().channels.map((c) => c.dt));

function draw() {
  scope.draw();
  updateStatus();
}

function updateStatus() {
  const st = store.get();
  const el = $('status');
  if (!st.rec) { el.textContent = 'Select a recording.'; return; }
  if (st.loading) { el.textContent = `parsing ${st.rec} … (first load of a large recording can take a few seconds)`; return; }
  const span = st.window.t1 - st.window.t0;
  const block = st.samples && Object.values(st.samples.channels)[0];
  const mode = block ? (block.mode === 'raw' ? `raw ${block.buckets} samples` : `envelope ${block.buckets}px`) : '—';
  el.textContent = `${st.rec}  ·  window ${fmtTime(span)}  [${fmtTime(elapsed(st.window.t0))} – ${fmtTime(elapsed(st.window.t1))}]  ·  ${mode}`;
}

async function fetchSamples() {
  const st = store.get();
  if (!st.rec) return;
  const chs = st.channels.filter((c) => c.visible).map((c) => c.ch);
  if (!chs.length) { store.update((s) => { s.samples = null; }); draw(); return; }
  fetchAbort?.abort();
  fetchAbort = new AbortController();
  const win = { ...st.window };
  const px = Math.max(300, Math.round(canvas.clientWidth));
  try {
    const res = await getSamples(st.rec, chs, win.t0, win.t1, px, fetchAbort.signal);
    if (store.get().rec !== st.rec) return;
    store.update((s) => { s.samples = res; s.loading = false; });
    draw();
  } catch (e) {
    if (e.name !== 'AbortError') { console.warn('samples', e); store.update((s) => { s.loading = false; }); draw(); }
  }
}

const app = {
  setWindow(t0, t1) {
    const { dataRange } = store.get();
    const lo = dataRange.t0, hi = dataRange.t1;
    const minSpan = 8 * minDt();
    if (t1 - t0 < minSpan) { const c = (t0 + t1) / 2; t0 = c - minSpan / 2; t1 = c + minSpan / 2; }
    if (t0 < lo) { t1 += lo - t0; t0 = lo; }
    if (t1 > hi) { t0 -= t1 - hi; t1 = hi; }
    t0 = clamp(t0, lo, hi); t1 = clamp(t1, lo, hi);
    if (t1 <= t0) return;
    store.update((s) => { s.window = { t0, t1 }; });
    draw();
    scheduleFetch();
    scheduleSpectro();
  },
  zoomAbout(t, factor) {
    const { t0, t1 } = store.get().window;
    app.setWindow(t - (t - t0) * factor, t + (t1 - t) * factor);
  },
  panBy(dt) {
    const { t0, t1 } = store.get().window;
    app.setWindow(t0 + dt, t1 + dt);
  },
  resetView() {
    const { dataRange } = store.get();
    app.setWindow(dataRange.t0, dataRange.t1);
  },
  placeCursor(which, t) {
    store.update((s) => { s.cursors[which] = t; });
    updateCursorReadout();
    draw();
    scheduleSpectro();
  },
  clearCursors() {
    store.update((s) => { s.cursors = { a: null, b: null }; });
    updateCursorReadout();
    draw();
    scheduleSpectro();
  },
  toggleAC() {
    store.update((s) => { s.acMode = !s.acMode; });
    $('acdc').textContent = store.get().acMode ? 'AC' : 'DC';
    $('acdc').classList.toggle('on', store.get().acMode);
    updateCursorReadout();
    draw();
  },
  setListen(ch) {
    if (!store.get().channels.some((c) => c.ch === ch)) return;
    store.update((s) => { s.listenCh = ch; });
    updateTransport();
    scheduleSpectro();
  },
  togglePlay() { audio.toggle(); },
  playFromCursor() { audio.play(store.get().cursors.a ?? store.get().window.t0); },
  playWindow() { const w = store.get().window; audio.play(w.t0, w.t1); },
  toggleFFT() { setSpectroMode('fft'); },
  toggleSpectrogram() { setSpectroMode('spectrogram'); },
  toggleTimeline() {
    store.update((s) => { s.showTimeline = !s.showTimeline; });
    $('tl').classList.toggle('on', store.get().showTimeline);
    draw();
  },
  focusEvent(i) {
    const e = activeEvents()[i];
    if (!e) return;
    store.update((s) => { s.activeEvent = i; });
    if (e.tEnd != null) {
      const pad = Math.max(0.05, (e.tEnd - e.t) * 0.25);
      app.setWindow(e.t - pad, e.tEnd + pad);
    } else {
      app.setWindow(e.t - 0.075, e.t + 0.075);
    }
    renderEventList();
  },
  setTimelineMode(mode) {
    store.update((s) => { s.timelineMode = mode; s.activeEvent = null; });
    $('mHigh').classList.toggle('on', mode === 'high');
    $('mRaw').classList.toggle('on', mode === 'raw');
    renderEventList();
    draw();
  },
  draw,
  refreshHud() { updateTooltip(); scope.draw(); },
};

const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f0883e'];

// short title for an event of either shape (high-level or primitive)
function eventTitle(e) {
  if (e.kind === 'hl') return e.title;
  if (e.kind === 'burst') return `${e.label} tone`;
  return `${e.label} ${e.dir > 0 ? '▲' : '▼'} ${fmtVolt(e.fromV)} → ${fmtVolt(e.toV)}`;
}
function eventDetail(e) {
  if (e.kind === 'hl') return e.detail || '';
  if (e.kind === 'burst') return `${fmtTime(e.tEnd - e.t, 2)} · pk ${fmtVolt(e.peak)}`;
  return '';
}
function eventColorGlyph(e) {
  if (e.kind === 'hl') return hlMeta(e.type);
  if (e.kind === 'burst') return [COLORS[e.ch % 5], '◍'];
  return [COLORS[e.ch % 5], e.dir > 0 ? '▲' : '▼'];
}

function renderEventList() {
  const st = store.get();
  const list = activeEvents();
  const el = $('eventList');
  if (!list.length) { el.innerHTML = '<div class="hint">no events detected</div>'; return; }
  el.innerHTML = list.map((e, i) => {
    const [col, glyph] = eventColorGlyph(e);
    const detail = eventDetail(e);
    return `<div class="evrow${i === st.activeEvent ? ' active' : ''}" data-i="${i}">` +
      `<span class="evt">${fmtTime(elapsed(e.t), 2)}</span>` +
      `<span class="evi" style="color:${col}">${glyph}</span>` +
      `<span class="evx"><b>${eventTitle(e)}</b>${detail ? ` <span class="evd">${detail}</span>` : ''}</span></div>`;
  }).join('');
  el.querySelectorAll('.evrow').forEach((r) => { r.onclick = () => app.focusEvent(Number(r.dataset.i)); });
}

function setSpectroMode(m) {
  spectro.mode = m;
  $('mFFT').classList.toggle('on', m === 'fft');
  $('mSpec').classList.toggle('on', m === 'spectrogram');
  spectro.update();
}

function updateTooltip() {
  const st = store.get();
  let text = null, cx = 0, cy = 0;
  if (st.hoverEvent != null) {
    const e = activeEvents()[st.hoverEvent.i];
    if (e) {
      const d = eventDetail(e);
      text = `${fmtTime(elapsed(e.t), 3)}  ·  ${eventTitle(e)}${d ? `\n${d}` : ''}`;
      cx = st.hoverEvent.clientX; cy = st.hoverEvent.clientY;
    }
  } else if (st.hover) {
    const lines = [`t = ${fmtTime(elapsed(st.hover.t), 4)}`];
    for (const c of st.channels) {
      if (!c.visible) continue;
      const v = valueAt(st.samples?.channels?.[c.ch], c.ch, st.meta, st.hover.t);
      if (!Number.isNaN(v)) lines.push(`${c.label} ${fmtVolt(st.acMode ? v - c.vmeanDC : v)}`);
    }
    text = lines.join('\n'); cx = st.hover.clientX; cy = st.hover.clientY;
  }
  if (text == null) { tip.style.display = 'none'; return; }
  tip.textContent = text;
  tip.style.display = 'block';
  const pad = 14;
  let x = cx + pad, y = cy + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = cx - r.width - pad;
  if (y + r.height > window.innerHeight) y = cy - r.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function vAt(ch, t) {
  const st = store.get();
  const v = valueAt(st.samples?.channels?.[ch], ch, st.meta, t);
  const c = st.channels.find((x) => x.ch === ch);
  return Number.isNaN(v) ? NaN : (st.acMode && c ? v - c.vmeanDC : v);
}

function updateCursorReadout() {
  const st = store.get();
  const { a, b } = st.cursors;
  const el = $('cursorReadout');
  if (a == null && b == null) { el.innerHTML = '<div class="hint">No cursors set.</div>'; return; }
  let html = '<table>';
  if (a != null) html += `<tr><td class="k">A</td><td>${fmtTime(elapsed(a), 4)}</td></tr>`;
  if (b != null) html += `<tr><td class="k">B</td><td>${fmtTime(elapsed(b), 4)}</td></tr>`;
  if (a != null && b != null) {
    const dt = Math.abs(b - a);
    html += `<tr><td class="k">Δt</td><td class="big">${fmtTime(dt, 4)}</td></tr>`;
    html += `<tr><td class="k">1/Δt</td><td class="big">${fmtFreq(1 / dt)}</td></tr>`;
  }
  html += '</table>';
  // per-channel values
  html += '<table style="margin-top:6px">';
  html += `<tr><td class="k">ch</td>${a != null ? '<td class="k">A</td>' : ''}${b != null ? '<td class="k">B</td>' : ''}${a != null && b != null ? '<td class="k">ΔV</td>' : ''}</tr>`;
  for (const c of st.channels) {
    if (!c.visible) continue;
    const va = a != null ? vAt(c.ch, a) : NaN;
    const vb = b != null ? vAt(c.ch, b) : NaN;
    html += `<tr><td>${c.label}</td>`;
    if (a != null) html += `<td>${Number.isNaN(va) ? '—' : fmtVolt(va)}</td>`;
    if (b != null) html += `<td>${Number.isNaN(vb) ? '—' : fmtVolt(vb)}</td>`;
    if (a != null && b != null) html += `<td>${Number.isNaN(va) || Number.isNaN(vb) ? '—' : fmtVolt(vb - va)}</td>`;
    html += '</tr>';
  }
  html += '</table>';
  el.innerHTML = html;
}

function updateTransport() {
  $('play').textContent = store.get().audio.playing ? '⏸' : '▶';
  $('play').classList.toggle('on', store.get().audio.playing);
  const sel = $('listen');
  if (sel.value !== String(store.get().listenCh)) sel.value = String(store.get().listenCh);
}

function buildChannelToggles() {
  const st = store.get();
  const host = $('chans');
  host.innerHTML = '';
  for (const c of st.channels) {
    const el = document.createElement('span');
    el.className = 'chtog' + (c.visible ? '' : ' off');
    el.innerHTML = `<span class="sw" style="background:${['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f0883e'][c.ch % 5]}"></span>${c.label} <span class="lbl">CH${c.ch}</span>`;
    el.title = `CH${c.ch} · click: show/hide · double-click: rename`;
    el.onclick = () => {
      store.update((s) => { const cc = s.channels.find((x) => x.ch === c.ch); cc.visible = !cc.visible; });
      el.classList.toggle('off');
      fetchSamples();
    };
    el.ondblclick = (e) => {
      e.preventDefault();
      const name = prompt(`Bus-pin name for CH${c.ch}`, c.label);
      if (name != null) {
        setLabel(st.rec, c.ch, name);
        store.update((s) => { s.channels.find((x) => x.ch === c.ch).label = name; });
        buildChannelToggles();
        draw();
      }
    };
    host.appendChild(el);
  }
}

function buildListenOptions() {
  const sel = $('listen');
  sel.innerHTML = '';
  for (const c of store.get().channels) {
    const o = document.createElement('option');
    o.value = String(c.ch);
    o.textContent = `${c.label} (CH${c.ch})`;
    sel.appendChild(o);
  }
  sel.value = String(store.get().listenCh);
}

async function loadNoteAndPng(rec, meta) {
  $('noteName').textContent = meta.date ? `${meta.name} · ${meta.date}` : meta.name;
  if (meta.hasNote) {
    const md = await getNote(rec);
    $('note').innerHTML = renderMarkdown(md || '');
  } else {
    $('note').innerHTML = '<div class="hint">no note for this recording</div>';
  }
  const png = $('png');
  if (meta.hasPng) { png.src = pngUrl(rec); png.hidden = false; } else { png.hidden = true; }
}

async function selectRecording(basename) {
  audio.stop();
  store.update((s) => {
    s.rec = basename; s.samples = null; s.meta = null; s.channels = [];
    s.cursors = { a: null, b: null }; s.hover = null; s.loading = true;
    s.audio.headTime = null;
    s.events = []; s.highlevel = []; s.activeEvent = null; s.hoverEvent = null;
  });
  updateStatus();
  updateCursorReadout();
  renderEventList();
  spectro.message('—');
  let meta;
  try {
    meta = await getMeta(basename);
  } catch (e) {
    $('status').textContent = `failed to load ${basename}: ${e.message}`;
    return;
  }
  const channels = meta.channels.map((c) => ({ ...c, visible: true, label: labelFor(basename, c.ch, c.label) }));
  store.update((s) => {
    s.meta = meta; s.channels = channels;
    s.dataRange = { t0: meta.tStart, t1: meta.tEnd };
    s.window = { t0: meta.tStart, t1: meta.tEnd };
    s.listenCh = channels[0]?.ch;
    s.loading = false;
  });
  buildChannelToggles();
  buildListenOptions();
  updateTransport();
  loadNoteAndPng(basename, meta);
  getEvents(basename).then(({ events, highlevel }) => {
    if (store.get().rec !== basename) return;
    store.update((s) => { s.events = events; s.highlevel = highlevel; });
    renderEventList();
    draw();
  });
  await fetchSamples();
  draw();
  scheduleSpectro();
}

// --- wiring ---
function wire() {
  $('rec').onchange = (e) => selectRecording(e.target.value);
  $('acdc').onclick = () => app.toggleAC();
  $('tl').onclick = () => app.toggleTimeline();
  $('reset').onclick = () => app.resetView();
  $('play').onclick = () => app.togglePlay();
  $('playCursor').onclick = () => app.playFromCursor();
  $('playWin').onclick = () => app.playWindow();
  $('listen').onchange = (e) => app.setListen(Number(e.target.value));
  $('mFFT').onclick = () => setSpectroMode('fft');
  $('mSpec').onclick = () => setSpectroMode('spectrogram');
  $('mHigh').onclick = () => app.setTimelineMode('high');
  $('mRaw').onclick = () => app.setTimelineMode('raw');
  $('png').onclick = () => $('png').classList.toggle('big');

  attachInteractions(canvas, scope, app);

  const onResize = debounce(() => { draw(); fetchSamples(); scheduleSpectro(); }, 150);
  window.addEventListener('resize', onResize);
}

async function init() {
  wire();
  let recs;
  try {
    recs = await getRecordings();
  } catch (e) {
    $('status').textContent = `failed to list recordings: ${e.message}`;
    return;
  }
  store.update((s) => { s.recordings = recs; });
  const sel = $('rec');
  for (const r of recs) {
    const o = document.createElement('option');
    o.value = r.basename;
    o.textContent = r.label;
    sel.appendChild(o);
  }
  if (recs.length) { sel.value = recs[0].basename; await selectRecording(recs[0].basename); }
  else $('status').textContent = 'no recordings found in osci/';
}

init();
